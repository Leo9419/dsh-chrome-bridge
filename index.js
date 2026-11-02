/**
 * dsh-plugin-chrome-bridge
 *
 * Lets the agent drive the user's OWN Chrome browser through a paired MV3
 * extension — the same architecture other browser integrations use:
 *
 *   agent tool  ->  this plugin (localhost HTTP bridge)  ->  long poll
 *                                                            |
 *                                              Chrome extension (MV3)
 *                                                            |
 *                                   chrome.tabs / chrome.scripting / captureVisibleTab
 *                                       (+ optional chrome.debugger for trusted input)
 *                                                            |
 *                                              the user's visible window
 *
 * Nothing runs headless: every action happens in the browser window the user is
 * looking at, so they can watch it and stop it.
 */
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

import { assertUrlAllowed } from './lib/policy.js'
import { DEFAULT_NET_LIMIT, clip, dedupeByUrl, groupByPath, waitOf } from './lib/protocol.js'

const PLUGIN = 'chrome-bridge'
const VERSION = 1
const COMMAND_TIMEOUT_MS = 45000
const POLL_WAIT_MS = 25000
/** A client counts as connected while it polled within this window. */
const ALIVE_WINDOW_MS = 70000
const MAX_BODY_BYTES = 32 * 1024 * 1024

const DEFAULTS = {
  autoStart: true,
  port: 47311,
  captureDir: '',
  allowedHosts: [],
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const stateDir = join(dshHome(), 'storages', PLUGIN)
  const stateFile = join(stateDir, 'config.json')
  const log = makeLogger(ctx)

  const fileLog = (level, message) => {
    const line = `${new Date().toISOString()} ${level} ${message}\n`
    try {
      mkdirSync(stateDir, { recursive: true })
      appendFileSync(join(stateDir, 'bridge.log'), line)
    } catch {}
  }

  const state = loadState(stateFile)
  if (!state.token) state.token = randomBytes(16).toString('hex')
  const token = state.token

  /** command id -> { resolve, reject, timer } */
  const pending = new Map()
  /** commands waiting for the next poll */
  const queue = []
  /** open long-poll responses */
  const waiters = []

  let server = null
  let port = 0
  let lastPollAt = 0
  let disposed = false

  fileLog('info', `apply v${VERSION}: port=${cfg.port} hosts=${JSON.stringify(cfg.allowedHosts || [])}`)

  // ------------------------------------------------------------------ bridge

  function connected() {
    return Date.now() - lastPollAt < ALIVE_WINDOW_MS
  }

  function sendCommand(type, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    if (!connected()) {
      return Promise.reject(
        new Error(
          'Chrome 扩展未连接。请在 chrome://extensions 里加载本仓库 extension/ 目录,并在扩展选项里填入端口和 token。',
        ),
      )
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Chrome 命令超时(${type}, ${timeoutMs}ms)`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      queue.push({ id, type, params })
      flushWaiters()
    })
  }

  function flushWaiters() {
    while (waiters.length > 0 && queue.length > 0) {
      respond(waiters.shift(), 200, { command: queue.shift() })
    }
  }

  function settle(message) {
    const entry = pending.get(message?.id)
    if (!entry) return false
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok) entry.resolve(message.data)
    else entry.reject(new Error(message.error || 'Chrome 执行失败'))
    return true
  }

  function respond(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    })
    res.end(payload)
  }

  function authorize(req) {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      return url.searchParams.get('token') === token ? url : null
    } catch {
      return null
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  const httpHandler = async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      })
      res.end()
      return
    }
    const url = authorize(req)
    if (!url) {
      respond(res, 403, { ok: false, error: 'token 不匹配' })
      return
    }
    try {
      if (url.pathname === '/hello' && req.method === 'GET') {
        respond(res, 200, { ok: true, version: VERSION, connected: connected() })
        return
      }
      if (url.pathname === '/poll' && req.method === 'GET') {
        lastPollAt = Date.now()
        if (queue.length > 0) {
          respond(res, 200, { command: queue.shift() })
          return
        }
        const waiter = res
        waiters.push(waiter)
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          respond(waiter, 200, { command: null })
        }, POLL_WAIT_MS)
        res.on('close', () => {
          clearTimeout(timer)
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
        })
        return
      }
      if (url.pathname === '/result' && req.method === 'POST') {
        const message = JSON.parse((await readBody(req)) || '{}')
        if (!settle(message)) fileLog('warn', `result for unknown command ${message?.id}`)
        respond(res, 200, { ok: true })
        return
      }
      respond(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      fileLog('error', `http ${url.pathname}: ${error?.message || error}`)
      try {
        respond(res, 500, { ok: false, error: String(error?.message || error) })
      } catch {}
    }
  }

  function start() {
    if (disposed || server) return
    listenOn(cfg.port)
  }

  function listenOn(target) {
    if (disposed) return
    const instance = createServer(httpHandler)
    server = instance
    instance.on('error', (error) => {
      fileLog('error', `listen ${target} failed: ${error?.code || error}`)
      if (error?.code === 'EADDRINUSE' && target !== 0) {
        server = null
        listenOn(0)
      }
    })
    instance.once('listening', () => {
      port = instance.address().port
      state.port = port
      persistState()
      fileLog('info', `listening on http://127.0.0.1:${port}`)
      log.info(`chrome bridge ready on 127.0.0.1:${port}`)
    })
    instance.listen(target, '127.0.0.1')
  }

  function persistState() {
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch (error) {
      fileLog('warn', `cannot persist state: ${error?.message || error}`)
    }
  }

  ctx.effect(() => {
    if (cfg.autoStart) start()
    return () => {
      disposed = true
      for (const [, entry] of pending) clearTimeout(entry.timer)
      pending.clear()
      for (const waiter of waiters.splice(0)) {
        try {
          respond(waiter, 503, { command: null })
        } catch {}
      }
      if (server) {
        try {
          server.close()
        } catch {}
        server = null
      }
    }
  })

  // ------------------------------------------------------------------- tools

  const textOutput = (schema = { type: 'object' }) => ({
    schema,
    render: (args, value) => [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  })

  const tabParam = {
    type: 'integer',
    description: '目标标签页 id;省略则用当前活动标签页。先用 chrome_list_tabs 查看。',
  }

  const waitProps = {
    waitForSelector: { type: 'string', description: '动作后等待该 CSS 选择器出现再返回' },
    waitForUrl: { type: 'string', description: '动作后等待 URL 包含该片段' },
    timeoutMs: { type: 'integer', description: '等待超时毫秒数,默认 10000' },
  }

  function guardUrl(url) {
    assertUrlAllowed(url, cfg.allowedHosts || [])
  }

  function saveCapture(dataUrl) {
    const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(String(dataUrl || ''))
    if (!match) throw new Error('扩展没有返回有效的截图数据')
    const dir = cfg.captureDir || join(stateDir, 'captures')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `shot-${Date.now()}.${match[1] === 'png' ? 'png' : 'jpg'}`)
    const bytes = Buffer.from(match[2], 'base64')
    writeFileSync(file, bytes)
    return { path: file, bytes: bytes.length }
  }

  const tools = [
    {
      name: 'chrome_status',
      description: '查看 Chrome 扩展是否已连接、桥接端口、CDP 模式,以及当前打开了多少个标签页。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: textOutput(),
      execute: async () => {
        const info = { connected: connected(), port, bridgeVersion: VERSION, lastPollAt }
        if (!connected()) return info
        const tabs = await sendCommand('list_tabs')
        return { ...info, tabs: tabs.length }
      },
    },
    {
      name: 'chrome_list_tabs',
      description: '列出用户 Chrome 里所有普通标签页(标题、URL、是否活动)。操作前先用它选目标标签。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: textOutput({ type: 'array' }),
      execute: async () => sendCommand('list_tabs'),
    },
    {
      name: 'chrome_query',
      description:
        '列出页面上可交互的元素(链接/按钮/输入框),带可直接使用的 CSS 选择器和可见文本。点或填之前先用它挑目标,不要凭猜写选择器。',
      parameters: {
        type: 'object',
        properties: {
          tabId: tabParam,
          max: { type: 'integer', description: '最多返回多少个元素,默认 200' },
        },
        additionalProperties: false,
      },
      output: textOutput({ type: 'array' }),
      execute: async (args) => {
        const result = await sendCommand('query', {
          tabId: args?.tabId ? Number(args.tabId) : undefined,
          max: Number(args?.max) || 200,
        })
        return result.elements
      },
    },
    {
      name: 'chrome_open',
      description: '在用户 Chrome 里新开一个标签页并加载 URL(用户可见)。返回新标签页 id。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要打开的 http(s) 地址' } },
        required: ['url'],
        additionalProperties: false,
      },
      output: textOutput(),
      execute: async (args) => {
        const url = String(args?.url || '')
        guardUrl(url)
        return sendCommand('open', { url })
      },
    },
    {
      name: 'chrome_activate',
      description: '把某个标签页切到前台并聚焦窗口(用户能立刻看到)。',
      parameters: {
        type: 'object',
        properties: { tabId: tabParam },
        required: ['tabId'],
        additionalProperties: false,
      },
      output: textOutput(),
      execute: async (args) => sendCommand('activate', { tabId: Number(args.tabId) }),
    },
    {
      name: 'chrome_navigate',
      description: '让指定标签页(或活动标签页)跳转到新 URL。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' }, tabId: tabParam },
        required: ['url'],
        additionalProperties: false,
      },
      output: textOutput(),
      execute: async (args) => {
        const url = String(args?.url || '')
        guardUrl(url)
        return sendCommand('navigate', { url, tabId: args?.tabId ? Number(args.tabId) : undefined })
      },
    },
    {
      name: 'chrome_read_text',
      description: '读取页面的可见文本(innerText),用于理解当前页面内容。',
      parameters: {
        type: 'object',
        properties: {
          tabId: tabParam,
          maxChars: { type: 'integer', description: '最多返回多少字符,默认 12000' },
        },
        additionalProperties: false,
      },
      output: textOutput({ type: 'string' }),
      execute: async (args) => {
        const result = await sendCommand('read_text', {
          tabId: args?.tabId ? Number(args.tabId) : undefined,
          maxChars: Number(args?.maxChars) || 12000,
        })
        return result.text
      },
    },
    {
      name: 'chrome_click',
      description:
        '点击页面元素(真实点击,用户看得见)。用 selector(CSS)或 text(可见文本)指定目标;优先用 text,它比长 CSS 路径稳。CDP 模式开启时走真实鼠标事件。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS 选择器,例如 button[type=submit];与 text 二选一' },
          text: { type: 'string', description: '按可见文本点击(包含匹配,忽略大小写)' },
          tabId: tabParam,
          ...waitProps,
        },
        additionalProperties: false,
      },
      output: textOutput(),
      execute: async (args) =>
        sendCommand('click', {
          selector: args?.selector ? String(args.selector) : '',
          text: args?.text ? String(args.text) : undefined,
          tabId: args?.tabId ? Number(args.tabId) : undefined,
          wait: waitOf(args),
        }),
    },
    {
      name: 'chrome_type',
      description: '往输入框填内容(触发 input/change 事件),可选回车提交。CDP 模式开启时逐字符真实输入。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: '输入框的 CSS 选择器' },
          text: { type: 'string', description: '要填入的文本' },
          submit: { type: 'boolean', description: '是否回车提交,默认 false' },
          tabId: tabParam,
          ...waitProps,
        },
        required: ['selector', 'text'],
        additionalProperties: false,
      },
      output: textOutput(),
      execute: async (args) =>
        sendCommand('type', {
          selector: String(args?.selector || ''),
          text: String(args?.text ?? ''),
          submit: Boolean(args?.submit),
          tabId: args?.tabId ? Number(args.tabId) : undefined,
          wait: waitOf(args),
        }),
    },
    {
      name: 'chrome_press',
      description: '向当前焦点元素(或指定元素)发送一个按键,如 Enter / Escape / Tab / ArrowDown。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '按键名,例如 Enter、Escape、Tab、ArrowDown' },
          selector: { type: 'string', description: '目标元素;省略则用当前焦点元素' },
          tabId: tabParam,
          ...waitProps,
        },
        required: ['key'],
        additionalProperties: false,
      },
      output: textOutput(),
      execute: async (args) =>
        sendCommand('press', {
          key: String(args?.key || ''),
          selector: args?.selector ? String(args.selector) : undefined,
          tabId: args?.tabId ? Number(args.tabId) : undefined,
          wait: waitOf(args),
        }),
    },
    {
      name: 'chrome_wait',
      description:
        '等待页面加载完成(可选等某个选择器出现 / URL 包含某片段)。动作后需要确认页面真的变了时用它,别靠猜。',
      parameters: {
        type: 'object',
        properties: {
          tabId: tabParam,
          selector: { type: 'string', description: '等到该 CSS 选择器出现' },
          urlIncludes: { type: 'string', description: '等到 URL 包含该片段' },
          timeoutMs: { type: 'integer', description: '超时毫秒数,默认 10000' },
        },
        additionalProperties: false,
      },
      output: textOutput(),
      execute: async (args) =>
        sendCommand(
          'wait',
          {
            tabId: args?.tabId ? Number(args.tabId) : undefined,
            selector: args?.selector ? String(args.selector) : undefined,
            urlIncludes: args?.urlIncludes ? String(args.urlIncludes) : undefined,
            timeoutMs: Number(args?.timeoutMs) || 10000,
          },
          (Number(args?.timeoutMs) || 10000) + 5000,
        ),
    },
    {
      name: 'chrome_net',
      description:
        '读取页面已发出的网络请求,用来查这个页面调用了哪些后端接口。CDP 模式开启时额外含 method / 请求体 / 响应体摘要与状态码。',
      parameters: {
        type: 'object',
        properties: {
          tabId: tabParam,
          onlyApi: { type: 'boolean', description: '只要 fetch/xhr,默认 true' },
          limit: { type: 'integer', description: `最多返回多少条,默认 ${DEFAULT_NET_LIMIT}` },
        },
        additionalProperties: false,
      },
      output: textOutput({ type: 'object' }),
      execute: async (args) => {
        const raw = await sendCommand('net', {
          tabId: args?.tabId ? Number(args.tabId) : undefined,
          onlyApi: args?.onlyApi !== false,
        })
        const limit = Number(args?.limit) || DEFAULT_NET_LIMIT
        const entries = dedupeByUrl(raw.entries || []).slice(0, limit)
        return {
          cdp: Boolean(raw.cdp),
          total: raw.total ?? entries.length,
          apiCount: raw.apiCount ?? entries.length,
          entries,
          grouped: groupByPath(entries),
        }
      },
    },
    {
      name: 'chrome_screenshot',
      description: '截取当前可见区域并保存为 PNG,返回文件路径(可用 read_image 查看)。',
      parameters: {
        type: 'object',
        properties: { tabId: tabParam },
        additionalProperties: false,
      },
      output: textOutput(),
      execute: async (args) => {
        const result = await sendCommand('screenshot', {
          tabId: args?.tabId ? Number(args.tabId) : undefined,
        })
        return saveCapture(result.dataUrl)
      },
    },
    {
      name: 'chrome_eval',
      description: '在页面上下文执行一段 JavaScript 并返回 JSON 结果。仅用于读取/调试,不要用它绕过页面逻辑。',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: '要执行的 JS 表达式' },
          tabId: tabParam,
        },
        required: ['expression'],
        additionalProperties: false,
      },
      output: textOutput(),
      execute: async (args) =>
        sendCommand('eval', {
          expression: String(args?.expression || ''),
          tabId: args?.tabId ? Number(args.tabId) : undefined,
        }),
    },
    {
      name: 'chrome_close',
      description: '关闭指定标签页。',
      parameters: {
        type: 'object',
        properties: { tabId: tabParam },
        required: ['tabId'],
        additionalProperties: false,
      },
      output: textOutput(),
      execute: async (args) => sendCommand('close', { tabId: Number(args.tabId) }),
    },
    {
      name: 'chrome_cdp',
      description:
        '查看或切换 CDP 模式。开启后点击/输入走真实事件(能触发默认行为,如回车提交),网络请求能拿到 method 与请求体;代价是 Chrome 顶部会出现"正在被调试"提示条,关闭后消失。',
      parameters: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', description: 'true 开启、false 关闭;省略则只查询当前状态' },
        },
        additionalProperties: false,
      },
      output: textOutput(),
      execute: async (args) =>
        sendCommand('cdp', typeof args?.enabled === 'boolean' ? { enabled: args.enabled } : {}),
    },
  ]

  let registered = false
  function registerTools() {
    if (registered || disposed) return
    const registry = safeGet('tools')
    if (!registry || typeof registry.register !== 'function') return
    for (const tool of tools) {
      try {
        registry.register(tool)
      } catch (error) {
        fileLog('error', `register ${tool.name} failed: ${error?.message || error}`)
      }
    }
    registered = true
    fileLog('info', `registered ${tools.length} tools`)
  }

  function safeGet(name) {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  registerTools()
  let attempts = 0
  const timer = setInterval(() => {
    if (registered || disposed) {
      clearInterval(timer)
      return
    }
    registerTools()
    if (++attempts > 40) {
      clearInterval(timer)
      fileLog('error', 'tools service never became available')
    }
  }, 500)
  ctx.effect(() => () => clearInterval(timer))
}

// -------------------------------------------------------------------- helpers

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function loadState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function makeLogger(ctx) {
  const fallback = (level) => (...args) => {
    const line = args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    sink(`[chrome-bridge] ${line}`)
  }
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('chrome-bridge') : undefined
    if (logger && typeof logger.info === 'function') {
      return {
        info: (...a) => logger.info(...a),
        warn: (...a) => logger.warn?.(...a),
        error: (...a) => logger.error?.(...a),
      }
    }
  } catch {}
  return { info: fallback('info'), warn: fallback('warn'), error: fallback('error') }
}

export { PLUGIN, VERSION, clip }
