/**
 * URL policy for the bridge: which origins the agent is allowed to drive.
 *
 * Kept dependency-free and pure so it can be unit tested without a browser.
 */

/**
 * Decide whether `url` may be opened or navigated to.
 *
 * @param {string} url absolute URL
 * @param {readonly string[]} [allowedHosts] hostnames (or `.suffix` matches) when non-empty
 * @returns {boolean}
 */
export function hostAllowed(url, allowedHosts = []) {
  const list = Array.isArray(allowedHosts) ? allowedHosts.filter(Boolean) : []
  if (list.length === 0) return true
  let host
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return list.some((allowed) => {
    const needle = String(allowed).toLowerCase().replace(/^\./, '')
    return host === needle || host.endsWith(`.${needle}`)
  })
}

/**
 * Throw a user-facing error when the URL is outside the allowlist.
 *
 * @param {string} url
 * @param {readonly string[]} [allowedHosts]
 */
export function assertUrlAllowed(url, allowedHosts = []) {
  if (!/^https?:\/\//i.test(String(url))) {
    throw new Error(`只允许 http(s) 地址:${url}`)
  }
  if (!hostAllowed(url, allowedHosts)) {
    throw new Error(`域名不在白名单内:${url}`)
  }
}
