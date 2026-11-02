import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('manifest is MV3 with a module service worker', () => {
  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.background?.type, 'module')
  assert.ok(manifest.background?.service_worker)
})

test('every file the manifest points at exists', () => {
  for (const relative of [
    manifest.background.service_worker,
    manifest.options_page,
    'lib/cdp.js',
    ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
  ]) {
    assert.ok(existsSync(join(root, 'extension', relative)), `missing extension/${relative}`)
  }
})

test('the extension version follows the package version', () => {
  assert.equal(manifest.version, pkg.version)
})

test('required permissions are declared', () => {
  for (const permission of ['tabs', 'scripting', 'storage', 'debugger']) {
    assert.ok(manifest.permissions.includes(permission), `missing permission ${permission}`)
  }
  assert.ok(
    manifest.host_permissions.some((pattern) => pattern.includes('127.0.0.1')),
    'the extension must be able to reach the local bridge',
  )
})

test('the package declares the bundle patch and ships the extension', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(existsSync(join(root, 'cordis.patch.yml')))
  assert.ok(pkg.files.includes('extension/'))
  assert.ok(pkg.files.includes('lib/'))
})

test('the plugin entry exports apply and declares no static inject', () => {
  const source = readFileSync(join(root, 'index.js'), 'utf8')
  assert.match(source, /export function apply\(/)
  assert.doesNotMatch(source, /export const inject\s*=\s*\[/)
})
