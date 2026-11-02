/**
 * Pure helpers shared by the bridge and its tests: wait knobs, network
 * summaries and text clipping. No I/O here.
 */

export const DEFAULT_WAIT_MS = 10000
export const DEFAULT_NET_LIMIT = 200

/**
 * Turn the flat tool arguments (`waitForSelector` / `waitForUrl` / `timeoutMs`)
 * into the nested `wait` object the extension expects.
 *
 * @param {Record<string, unknown>} [args]
 * @returns {{ selector?: string, urlIncludes?: string, timeoutMs: number } | undefined}
 */
export function waitOf(args) {
  if (!args?.waitForSelector && !args?.waitForUrl) return undefined
  return {
    selector: args?.waitForSelector ? String(args.waitForSelector) : undefined,
    urlIncludes: args?.waitForUrl ? String(args.waitForUrl) : undefined,
    timeoutMs: positiveOr(args?.timeoutMs, DEFAULT_WAIT_MS),
  }
}

/**
 * Accept only a positive finite number, else fall back.
 *
 * @param {unknown} value
 * @param {number} fallback
 */
export function positiveOr(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback
}

/**
 * Collapse duplicate URLs while preserving first-seen order, and annotate each
 * row with how many times it was requested.
 *
 * @param {readonly { url: string }[]} entries
 * @returns {Array<Record<string, unknown> & { count: number }>}
 */
export function dedupeByUrl(entries) {
  const seen = new Map()
  for (const entry of entries || []) {
    if (!entry?.url) continue
    const existing = seen.get(entry.url)
    if (existing) existing.count += 1
    else seen.set(entry.url, { ...entry, count: 1 })
  }
  return [...seen.values()]
}

/**
 * Group network rows by path so a report reads like an API surface instead of a
 * request log. Uses the URL's pathname when it parses, otherwise the raw string.
 *
 * @param {readonly { url: string, status?: number | null, duration?: number }[]} entries
 */
export function groupByPath(entries) {
  const groups = new Map()
  for (const entry of entries || []) {
    let key = entry.url
    try {
      key = new URL(entry.url).pathname
    } catch {}
    const group = groups.get(key) || { path: key, count: 0, statuses: new Set(), maxDuration: 0 }
    group.count += entry.count || 1
    if (entry.status != null) group.statuses.add(entry.status)
    group.maxDuration = Math.max(group.maxDuration, Number(entry.duration) || 0)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => ({
    path: group.path,
    count: group.count,
    statuses: [...group.statuses],
    maxDuration: group.maxDuration,
  }))
}

/**
 * Clip a string for chat-shaped output, keeping an explicit marker.
 *
 * @param {unknown} text
 * @param {number} [max]
 */
export function clip(text, max = 12000) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 20))}\n…(内容过长,已截断)`
}
