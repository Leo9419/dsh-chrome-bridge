// DSH Chrome Bridge — service worker.
//
// Pulls commands from the DSH host over a localhost long poll and runs them in
// the user's own browser: chrome.tabs / chrome.scripting by default, plus
// chrome.debugger (CDP) when the user opts into trusted input events.

import {
  attach,
  clickPoint,
  detach,
  detachAll,
  insertText,
  isAttached,
  networkRecords,
  pressKey as cdpPress,
} from './lib/cdp.js'

const DEFAULTS = { port: 47311, token: '', cdp: false }
const POLL_WAIT_MS = 25000

let running = false

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- config

async function config() {
  const stored = await chrome.storage.local.get('cfg')
  return { ...DEFAULTS, ...(stored.cfg || {}) }
}

async function saveConfig(patch) {
  const next = { ...(await config()), ...patch }
  await chrome.storage.local.set({ cfg: next })
  return next
}

function badge(text, color) {
  chrome.action.setBadgeText({ text }).catch(() => {})
  if (color) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {})
}

// ---------------------------------------------------------------- tabs

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab
}

async function activeTabId() {
  return (await activeTab())?.id
}

async function windowTabIds(windowId) {
  const tabs = await chrome.tabs.query(windowId ? { windowId } : {})
  return tabs.map((tab) => tab.id).filter((id) => id != null)
}

/**
 * Run a function in every frame of the tab, falling back to the main frame when
 * a frame is not scriptable (e.g. sandboxed or a chrome:// document).
 */
async function runFrames(tabId, func, args = []) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func,
      args,
    })
    return results
  } catch {
    try {
      return await chrome.scripting.executeScript({ target: { tabId }, func, args })
    } catch {
      return []
    }
  }
}

/** Find a target element by CSS selector or visible text; optionally click it. */
const FINDER = (selector, text, clickNow) => {
  let el = selector ? document.querySelector(selector) : null
  if (!el && text) {
    const wanted = String(text).trim().toLowerCase()
    const candidates = Array.from(
      document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"]'),
    )
    el =
      candidates.find((node) => (node.innerText || node.value || '').trim().toLowerCase() === wanted) ||
      candidates.find((node) => (node.innerText || node.value || '').trim().toLowerCase().includes(wanted)) ||
      null
  }
  if (!el) return { ok: false }
  el.scrollIntoView({ block: 'center', behavior: 'instant' })
  const rect = el.getBoundingClientRect()
  const meta = {
    ok: true,
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 200),
    rect: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height },
  }
  if (clickNow) {
    el.focus?.()
    el.click()
    return { ...meta, clicked: true }
  }
  return meta
}

function pick(results) {
  return results.map((entry) => entry?.result).find((result) => result && result.ok)
}

// ---------------------------------------------------------------- waiting

/**
 * Poll until the tab finished loading and the requested selector / URL fragment
 * is present. Follows a newly opened tab (target=_blank) when one appears.
 */
async function waitFor(tabId, wait = {}, options = {}) {
  const timeoutMs = Number(wait.timeoutMs) || 10000
  const deadline = Date.now() + timeoutMs
  const before = options.beforeTabIds || null
  const originUrl = options.originUrl
  let target = tabId
  let follow = Boolean(before)
  let lastUrl = ''
  let lastError = ''

  while (Date.now() < deadline) {
    try {
      if (follow && before) {
        const ids = await windowTabIds(options.windowId)
        const fresh = ids.find((id) => !before.includes(id))
        if (fresh) target = fresh
      }
      const tab = await chrome.tabs.get(target)
      lastUrl = tab.url || lastUrl
      if (!follow && originUrl && lastUrl !== originUrl) follow = false
      if (tab.status === 'complete') {
        if (wait.urlIncludes && !lastUrl.includes(wait.urlIncludes)) {
          await sleep(200)
          continue
        }
        if (wait.selector) {
          const results = await runFrames(target, (sel) => Boolean(document.querySelector(sel)), [wait.selector])
          if (!results.some((entry) => entry?.result)) {
            await sleep(200)
            continue
          }
        }
        return { waited: true, url: lastUrl, title: tab.title, tabId: target }
      }
    } catch (error) {
      lastError = String(error?.message || error)
    }
    await sleep(200)
  }
  throw new Error(
    `等待超时(${timeoutMs}ms):url=${lastUrl}` +
      `${wait.selector ? ` selector=${wait.selector}` : ''}${lastError ? ` err=${lastError}` : ''}`,
  )
}

// ---------------------------------------------------------------- commands

async function clickAction(params, cfg) {
  const tabId = params.tabId || (await activeTabId())
  if (!tabId) throw new Error('没有可操作的标签页')

  const before = await windowTabIds((await chrome.tabs.get(tabId)).windowId)
  const origin = (await chrome.tabs.get(tabId)).url

  if (cfg.cdp) {
    const hit = pick(await runFrames(tabId, FINDER, [params.selector || '', params.text || '', false]))
    if (!hit) throw new Error(`找不到元素:${params.selector || params.text}`)
    await clickPoint(tabId, hit.rect.x, hit.rect.y)
    const result = { ok: true, tag: hit.tag, text: hit.text, mode: 'cdp' }
    if (params.wait) {
      Object.assign(result, await waitFor(tabId, params.wait, { beforeTabIds: before, originUrl: origin }))
    }
    return result
  }

  const hit = pick(await runFrames(tabId, FINDER, [params.selector || '', params.text || '', true]))
  if (!hit) throw new Error(`找不到元素:${params.selector || params.text}`)
  const result = { ok: true, tag: hit.tag, text: hit.text, mode: 'synthetic' }
  if (params.wait) {
    Object.assign(result, await waitFor(tabId, params.wait, { beforeTabIds: before, originUrl: origin }))
  }
  return result
}

async function typeAction(params, cfg) {
  const tabId = params.tabId || (await activeTabId())
  if (!tabId) throw new Error('没有可操作的标签页')

  if (cfg.cdp) {
    const focused = pick(
      await runFrames(
        tabId,
        (selector) => {
          const el = document.querySelector(selector)
          if (!el) return { ok: false }
          el.scrollIntoView({ block: 'center', behavior: 'instant' })
          el.focus?.()
          if ('value' in el) {
            el.value = ''
            el.dispatchEvent(new Event('input', { bubbles: true }))
          }
          return { ok: true, tag: el.tagName.toLowerCase() }
        },
        [params.selector],
      ),
    )
    if (!focused) throw new Error(`找不到元素:${params.selector}`)
    if (params.text) await insertText(tabId, params.text)
    if (params.submit) await cdpPress(tabId, 'Enter')
    const result = { ok: true, mode: 'cdp', value: params.text }
    if (params.wait) Object.assign(result, await waitFor(tabId, params.wait))
    return result
  }

  const filled = pick(
    await runFrames(
      tabId,
      (selector, text, submit) => {
        const el = document.querySelector(selector)
        if (!el) return { ok: false }
        el.scrollIntoView({ block: 'center', behavior: 'instant' })
        el.focus?.()
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(el, text)
        else el.value = text
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        if (submit) {
          const form = el.form
          if (form?.requestSubmit) form.requestSubmit()
          else {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }))
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }))
          }
        }
        return { ok: true, value: el.value?.slice(0, 200) }
      },
      [params.selector, params.text, Boolean(params.submit)],
    ),
  )
  if (!filled) throw new Error(`找不到元素:${params.selector}`)
  const result = { ok: true, mode: 'synthetic', value: filled.value }
  if (params.wait) Object.assign(result, await waitFor(tabId, params.wait))
  return result
}

async function pressAction(params, cfg) {
  const tabId = params.tabId || (await activeTabId())
  if (!tabId) throw new Error('没有可操作的标签页')

  if (cfg.cdp) {
    if (params.selector) {
      const focused = pick(
        await runFrames(
          tabId,
          (selector) => {
            const el = document.querySelector(selector)
            if (!el) return { ok: false }
            el.focus?.()
            return { ok: true }
          },
          [params.selector],
        ),
      )
      if (!focused) throw new Error(`找不到元素:${params.selector}`)
    }
    await cdpPress(tabId, params.key)
    const result = { ok: true, key: params.key, mode: 'cdp' }
    if (params.wait) Object.assign(result, await waitFor(tabId, params.wait))
    return result
  }

  const sent = pick(
    await runFrames(
      tabId,
      (key, selector) => {
        const el = selector ? document.querySelector(selector) : document.activeElement || document.body
        if (!el) return { ok: false }
        el.focus?.()
        for (const type of ['keydown', 'keyup']) {
          el.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true }))
        }
        // Synthetic Enter has no default action, so submit explicitly.
        if (key === 'Enter') {
          if (el.tagName === 'BUTTON' || el.type === 'submit') el.click()
          else if (el.form?.requestSubmit) el.form.requestSubmit()
        }
        return { ok: true, key }
      },
      [params.key, params.selector || ''],
    ),
  )
  if (!sent) throw new Error(`找不到元素:${params.selector || '(active element)'}`)
  const result = { ok: true, key: params.key, mode: 'synthetic' }
  if (params.wait) Object.assign(result, await waitFor(tabId, params.wait))
  return result
}

async function netAction(params, cfg) {
  const tabId = params.tabId || (await activeTabId())
  if (!tabId) throw new Error('没有可操作的标签页')

  const perf = pickMeta(
    await runFrames(
      tabId,
      (onlyApi) => {
        const apiTypes = new Set(['fetch', 'xmlhttprequest'])
        const raw = performance.getEntriesByType('resource') || []
        const rows = raw
          .filter((item) => (onlyApi ? apiTypes.has(item.initiatorType) : true))
          .map((item) => ({
            url: item.name,
            source: 'performance',
            type: item.initiatorType,
            start: Math.round(item.startTime),
            duration: Math.round(item.duration),
            size: item.transferSize || 0,
            status: item.responseStatus || null,
          }))
        return { total: raw.length, rows }
      },
      [params.onlyApi !== false],
    ),
  )

  const rows = perf?.rows || []
  const cdpOn = Boolean(cfg.cdp) && isAttached(tabId)
  if (!cdpOn) {
    return { cdp: false, total: perf?.total ?? rows.length, apiCount: rows.length, entries: rows }
  }

  const merged = new Map()
  for (const row of rows) merged.set(row.url, row)
  for (const record of networkRecords(tabId)) {
    if (!record?.url) continue
    if (params.onlyApi !== false && record.type && !['XHR', 'Fetch'].includes(record.type)) continue
    const existing = merged.get(record.url)
    merged.set(record.url, {
      ...(existing || {}),
      url: record.url,
      method: record.method,
      status: record.status ?? existing?.status ?? null,
      size: record.size || existing?.size || 0,
      postData: record.postData,
      source: 'cdp',
    })
  }
  const entries = [...merged.values()]
  return { cdp: true, total: entries.length, apiCount: entries.length, entries }
}

function pickMeta(results) {
  return results.map((entry) => entry?.result).find((result) => result && (result.ok || result.rows))
}

async function runCommand(command, cfg) {
  const { type, params = {} } = command
  switch (type) {
    case 'list_tabs': {
      const tabs = await chrome.tabs.query({})
      return tabs
        .filter((tab) => /^(https?|file):/.test(tab.url || ''))
        .map((tab) => ({
          id: tab.id,
          title: tab.title,
          url: tab.url,
          active: tab.active,
          windowId: tab.windowId,
          pinned: tab.pinned,
        }))
    }
    case 'open': {
      const tab = await chrome.tabs.create({ url: params.url, active: true })
      return { tabId: tab.id, url: tab.pendingUrl || tab.url, title: tab.title }
    }
    case 'activate': {
      const tab = await chrome.tabs.update(params.tabId, { active: true })
      if (tab?.windowId) await chrome.windows.update(tab.windowId, { focused: true })
      return { tabId: params.tabId, url: tab?.url, title: tab?.title }
    }
    case 'navigate': {
      const tab = await chrome.tabs.update(params.tabId, { url: params.url })
      return { tabId: tab.id, url: params.url }
    }
    case 'close': {
      await chrome.tabs.remove(params.tabId)
      return { closed: params.tabId }
    }
    case 'read_text': {
      const tabId = params.tabId || (await activeTabId())
      if (!tabId) throw new Error('没有可操作的标签页')
      const results = await runFrames(tabId, () => document.body?.innerText ?? '')
      const texts = results
        .map((entry) => String(entry?.result ?? ''))
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
      const text = texts.join('\n\n')
      const max = Number(params.maxChars) || 12000
      return { text: text.length > max ? `${text.slice(0, max)}\n…(截断)` : text }
    }
    case 'query': {
      const max = Number(params.max) || 200
      const tabId = params.tabId || (await activeTabId())
      if (!tabId) throw new Error('没有可操作的标签页')
      const results = await runFrames(tabId, QUERY, [max])
      const merged = []
      const seen = new Set()
      for (const entry of results) {
        for (const row of entry?.result || []) {
          if (seen.has(row.selector)) continue
          seen.add(row.selector)
          merged.push(row)
          if (merged.length >= max) break
        }
      }
      return { elements: merged }
    }
    case 'screenshot': {
      let windowId
      if (params.tabId) {
        const tab = await chrome.tabs.update(params.tabId, { active: true })
        windowId = tab?.windowId
        if (windowId) await chrome.windows.update(windowId, { focused: true })
        await sleep(250)
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId ?? chrome.windows.WINDOW_ID_CURRENT, {
        format: 'png',
      })
      return { dataUrl }
    }
    case 'wait': {
      const tabId = params.tabId || (await activeTabId())
      if (!tabId) throw new Error('没有可操作的标签页')
      return waitFor(tabId, params)
    }
    case 'click':
      return clickAction(params, cfg)
    case 'type':
      return typeAction(params, cfg)
    case 'press':
      return pressAction(params, cfg)
    case 'net':
      return netAction(params, cfg)
    case 'eval': {
      const tabId = params.tabId || (await activeTabId())
      if (!tabId) throw new Error('没有可操作的标签页')
      const results = await runFrames(
        tabId,
        (code) => {
          try {
            const value = (0, eval)(code)
            return { ok: true, value: JSON.parse(JSON.stringify(value ?? null)) }
          } catch (error) {
            return { ok: false, error: String(error) }
          }
        },
        [params.expression],
      )
      const result = results.map((entry) => entry?.result).find((item) => item?.ok) ||
        results.map((entry) => entry?.result).find(Boolean)
      if (!result?.ok) {
        const message = String(result?.error || '执行失败')
        if (/Content Security Policy|unsafe-eval/i.test(message)) {
          throw new Error('该站点的 CSP 禁止 eval(不是权限问题)。改用 chrome_query / chrome_read_text 等结构化工具。')
        }
        throw new Error(message)
      }
      return result.value
    }
    case 'cdp': {
      if (typeof params.enabled === 'boolean') {
        await saveConfig({ cdp: params.enabled })
        if (!params.enabled) await detachAll()
        else {
          const tabId = await activeTabId()
          if (tabId) await attach(tabId).catch(() => {})
        }
      }
      const next = await config()
      return { enabled: Boolean(next.cdp), attached: Boolean(await activeTabId().then((id) => id && isAttached(id))) }
    }
    default:
      throw new Error(`未知命令:${type}`)
  }
}

const QUERY = (max) => {
  const seen = new Set()
  const out = []
  const build = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`
    const parts = []
    let node = el
    let level = 0
    while (node && node.nodeType === 1 && level < 6) {
      let part = node.tagName.toLowerCase()
      const parent = node.parentElement
      if (parent) part += `:nth-child(${Array.from(parent.children).indexOf(node) + 1})`
      parts.unshift(part)
      if (node.id) {
        parts[0] = `#${CSS.escape(node.id)}`
        break
      }
      node = node.parentElement
      level += 1
    }
    return parts.join(' > ')
  }
  const nodes = document.querySelectorAll(
    'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]',
  )
  for (const el of nodes) {
    if (out.length >= max) break
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue
    const selector = build(el)
    if (seen.has(selector)) continue
    seen.add(selector)
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 120)
    out.push({
      selector,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      role: el.getAttribute('role') || undefined,
      text: label || undefined,
      href: el.getAttribute('href') || undefined,
      name: el.getAttribute('name') || undefined,
      disabled: el.disabled || undefined,
      inViewport: rect.top < innerHeight && rect.bottom > 0,
    })
  }
  return out
}

// ---------------------------------------------------------------- transport

async function poll(cfg) {
  const base = `http://127.0.0.1:${cfg.port}`
  const res = await fetch(`${base}/poll?token=${encodeURIComponent(cfg.token)}&wait=${POLL_WAIT_MS}`, {
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`poll ${res.status}`)
  return res.json()
}

async function report(cfg, id, payload) {
  const base = `http://127.0.0.1:${cfg.port}`
  await fetch(`${base}/result?token=${encodeURIComponent(cfg.token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, ...payload }),
  })
}

async function loop() {
  if (running) return
  running = true
  while (running) {
    let cfg
    try {
      cfg = await config()
      if (!cfg.token) {
        badge('SET', '#b8860b')
        await sleep(3000)
        continue
      }
      const { command } = await poll(cfg)
      badge(cfg.cdp ? 'CDP' : 'ON', cfg.cdp ? '#7c3aed' : '#1e8e3e')
      if (!command) continue
      try {
        const data = await runCommand(command, cfg)
        await report(cfg, command.id, { ok: true, data })
      } catch (error) {
        await report(cfg, command.id, { ok: false, error: String(error?.message || error) })
      }
    } catch {
      badge('OFF', '#c5221f')
      await sleep(2000)
    }
  }
}

chrome.runtime.onInstalled.addListener(() => loop())
chrome.runtime.onStartup.addListener(() => loop())
chrome.alarms.create('dsh-bridge-watchdog', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dsh-bridge-watchdog') loop()
})
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage())
chrome.tabs.onRemoved.addListener((tabId) => {
  void detach(tabId).catch(() => {})
})

loop()
