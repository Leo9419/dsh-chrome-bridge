// Chrome DevTools Protocol helpers for the bridge.
//
// Everything here is optional at runtime: the bridge only attaches the debugger
// when the user turns CDP mode on. While attached, Chrome shows its
// "being debugged" infobar — that is the honest price of trusted input events.

const attached = new Set()
/** tabId -> Map<requestId, record> */
const netByTab = new Map()
let listenerInstalled = false

const KEYMAP = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
}

function ensureListener() {
  if (listenerInstalled) return
  listenerInstalled = true
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source?.tabId
    if (tabId == null) return
    if (method === 'Network.requestWillBeSent') {
      const map = records(tabId)
      map.set(params.requestId, {
        url: params.request?.url,
        method: params.request?.method,
        type: params.type,
        start: params.timestamp,
        postData: clipBody(params.request?.postData),
      })
      if (map.size > 800) map.delete(map.keys().next().value)
      return
    }
    if (method === 'Network.responseReceived') {
      const record = records(tabId).get(params.requestId)
      if (record) {
        record.status = params.response?.status ?? null
        record.mime = params.response?.mimeType
      }
      return
    }
    if (method === 'Network.loadingFinished') {
      const record = records(tabId).get(params.requestId)
      if (record) record.size = params.encodedDataLength
    }
  })
  chrome.debugger.onDetach.addListener((source) => {
    if (source?.tabId != null) attached.delete(source.tabId)
  })
}

function records(tabId) {
  let map = netByTab.get(tabId)
  if (!map) {
    map = new Map()
    netByTab.set(tabId, map)
  }
  return map
}

function clipBody(body) {
  if (!body) return undefined
  const text = String(body)
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text
}

export function isAttached(tabId) {
  return attached.has(tabId)
}

export async function attach(tabId) {
  ensureListener()
  if (attached.has(tabId)) return
  await chrome.debugger.attach({ tabId }, '1.3')
  attached.add(tabId)
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {})
  } catch {
    // Network domain is best-effort; input actions still work without it.
  }
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return
  try {
    await chrome.debugger.detach({ tabId })
  } catch {}
  attached.delete(tabId)
  netByTab.delete(tabId)
}

export async function detachAll() {
  for (const tabId of [...attached]) await detach(tabId)
}

export function attachedTabs() {
  return [...attached]
}

/** Trusted mouse click at viewport CSS coordinates. */
export async function clickPoint(tabId, x, y) {
  await attach(tabId)
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...base })
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...base,
    buttons: 1,
  })
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...base,
    buttons: 0,
  })
}

/** Trusted key press (this is what makes Enter actually submit a form). */
export async function pressKey(tabId, key) {
  await attach(tabId)
  const spec = KEYMAP[key] || { key, code: key, keyCode: 0 }
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: spec.text ? 'keyDown' : 'rawKeyDown',
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    ...(spec.text ? { text: spec.text } : {}),
  })
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
  })
}

/** Trusted text insertion into the focused element. */
export async function insertText(tabId, text) {
  await attach(tabId)
  await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text })
}

export function networkRecords(tabId) {
  return [...(records(tabId).values() || [])].map((record) => ({
    url: record.url,
    method: record.method,
    status: record.status ?? null,
    type: record.type,
    size: record.size ?? 0,
    postData: record.postData,
    mime: record.mime,
  }))
}

export function clearNetwork(tabId) {
  netByTab.delete(tabId)
}
