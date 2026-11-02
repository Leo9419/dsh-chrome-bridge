import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_WAIT_MS, clip, dedupeByUrl, groupByPath, waitOf } from '../lib/protocol.js'

test('waitOf returns undefined when no wait was requested', () => {
  assert.equal(waitOf({}), undefined)
  assert.equal(waitOf(undefined), undefined)
})

test('waitOf maps flat arguments onto the nested wait object', () => {
  assert.deepEqual(waitOf({ waitForSelector: '#main' }), {
    selector: '#main',
    urlIncludes: undefined,
    timeoutMs: DEFAULT_WAIT_MS,
  })
  assert.deepEqual(waitOf({ waitForUrl: '/done', timeoutMs: 2500 }), {
    selector: undefined,
    urlIncludes: '/done',
    timeoutMs: 2500,
  })
})

test('waitOf ignores a nonsense timeout', () => {
  assert.equal(waitOf({ waitForUrl: 'x', timeoutMs: 'abc' }).timeoutMs, DEFAULT_WAIT_MS)
  assert.equal(waitOf({ waitForUrl: 'x', timeoutMs: -5 }).timeoutMs, DEFAULT_WAIT_MS)
})

test('dedupeByUrl keeps first-seen order and counts repeats', () => {
  const rows = dedupeByUrl([
    { url: 'https://a/1', status: 200 },
    { url: 'https://a/2', status: 200 },
    { url: 'https://a/1', status: 500 },
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].url, 'https://a/1')
  assert.equal(rows[0].count, 2)
  assert.equal(rows[0].status, 200, 'first occurrence wins')
  assert.equal(rows[1].count, 1)
})

test('dedupeByUrl skips entries without a url', () => {
  assert.deepEqual(dedupeByUrl([{ status: 200 }, { url: 'https://a/1' }]).length, 1)
})

test('groupByPath groups by pathname and tracks statuses', () => {
  const groups = groupByPath([
    { url: 'https://api.example.com/v1/users?a=1', status: 200, duration: 120 },
    { url: 'https://api.example.com/v1/users?a=2', status: 500, duration: 300, count: 2 },
    { url: 'https://api.example.com/v1/rooms', status: 200, duration: 90 },
  ])
  assert.equal(groups.length, 2)
  const users = groups.find((group) => group.path === '/v1/users')
  assert.equal(users.count, 3)
  assert.deepEqual(users.statuses.sort(), [200, 500])
  assert.equal(users.maxDuration, 300)
})

test('groupByPath falls back to the raw url when it does not parse', () => {
  const groups = groupByPath([{ url: 'weird://thing' }])
  assert.equal(groups.length, 1)
})

test('clip leaves short text alone and marks truncation', () => {
  assert.equal(clip('abcdef', 10), 'abcdef')
  const clipped = clip('x'.repeat(100), 40)
  assert.ok(clipped.length <= 40)
  assert.match(clipped, /截断/)
})
