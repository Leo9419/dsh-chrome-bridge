const portEl = document.getElementById('port')
const tokenEl = document.getElementById('token')
const cdpEl = document.getElementById('cdp')
const modeEl = document.getElementById('mode')
const statusEl = document.getElementById('status')

function say(text) {
  statusEl.textContent = text
}

function renderMode(cdp) {
  modeEl.hidden = !cdp
}

async function load() {
  const { cfg } = await chrome.storage.local.get('cfg')
  portEl.value = cfg?.port ?? 47311
  tokenEl.value = cfg?.token ?? ''
  cdpEl.checked = Boolean(cfg?.cdp)
  renderMode(Boolean(cfg?.cdp))
  if (!cfg?.token) say('还没有配置 token。先在 DSH 侧加载 chrome-bridge 插件,再从 ~/.dsh/storages/chrome-bridge/config.json 复制。')
}

async function save() {
  const cfg = { ...(await chrome.storage.local.get('cfg')).cfg, port: Number(portEl.value) || 47311, token: tokenEl.value.trim() }
  await chrome.storage.local.set({ cfg })
  say(`已保存:127.0.0.1:${cfg.port}。后台会自动重连。`)
}

async function test() {
  const port = Number(portEl.value) || 47311
  const token = tokenEl.value.trim()
  if (!token) return say('请先填 token。')
  try {
    const res = await fetch(`http://127.0.0.1:${port}/hello?token=${encodeURIComponent(token)}`, {
      cache: 'no-store',
    })
    const body = await res.json()
    if (res.ok && body.ok) say(`连接成功 ✅\n端口 ${port},桥版本 ${body.version},扩展连接状态:${body.connected}`)
    else say(`桥拒绝了请求:${JSON.stringify(body)}`)
  } catch (error) {
    say(`连不上 127.0.0.1:${port}\n${String(error)}\n\n检查:DSH 里 chrome-bridge 插件是否已加载、端口是否一致。`)
  }
}

async function toggleCdp() {
  const enabled = cdpEl.checked
  const cfg = { ...(await chrome.storage.local.get('cfg')).cfg, cdp: enabled }
  await chrome.storage.local.set({ cfg })
  renderMode(enabled)
  say(
    enabled
      ? 'CDP 模式已开启。下次操作时会挂载调试器,浏览器顶部会出现提示条;切回标签页操作一次即可生效。'
      : 'CDP 模式已关闭,调试器会立即解除挂载,提示条消失。',
  )
}

document.getElementById('save').addEventListener('click', save)
document.getElementById('test').addEventListener('click', test)
cdpEl.addEventListener('change', toggleCdp)
load()
