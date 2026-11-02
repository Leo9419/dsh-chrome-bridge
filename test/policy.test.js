import assert from 'node:assert/strict'
import test from 'node:test'

import { assertUrlAllowed, hostAllowed } from '../lib/policy.js'

test('hostAllowed allows everything when the allowlist is empty', () => {
  assert.equal(hostAllowed('https://example.com/a', []), true)
  assert.equal(hostAllowed('http://any.host/path'), true)
})

test('hostAllowed matches exact hosts and subdomains, not suffixes', () => {
  const allow = ['example.com']
  assert.equal(hostAllowed('https://example.com/x', allow), true)
  assert.equal(hostAllowed('https://api.example.com/x', allow), true)
  assert.equal(hostAllowed('https://notexample.com/x', allow), false)
  assert.equal(hostAllowed('https://example.com.evil.test/x', allow), false)
})

test('hostAllowed is case-insensitive and tolerates a leading dot', () => {
  assert.equal(hostAllowed('https://API.Example.COM', ['.example.com']), true)
})

test('hostAllowed rejects unparseable urls when an allowlist is set', () => {
  assert.equal(hostAllowed('not a url', ['example.com']), false)
})

test('assertUrlAllowed rejects non-http schemes', () => {
  assert.throws(() => assertUrlAllowed('file:///etc/passwd'), /只允许 http\(s\)/)
  assert.throws(() => assertUrlAllowed('javascript:alert(1)'), /只允许 http\(s\)/)
})

test('assertUrlAllowed enforces the allowlist', () => {
  assert.throws(() => assertUrlAllowed('https://evil.test', ['example.com']), /白名单/)
  assert.doesNotThrow(() => assertUrlAllowed('https://example.com', ['example.com']))
})
