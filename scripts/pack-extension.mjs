#!/usr/bin/env node
// Zip the unpacked extension so a release can attach it. Chrome's "load
// unpacked" wants a directory, so unzip before installing.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const outDir = join(root, 'dist')
const target = join(outDir, `dsh-chrome-bridge-extension-${pkg.version}.zip`)

mkdirSync(outDir, { recursive: true })
rmSync(target, { force: true })

try {
  execFileSync('zip', ['-r', '-q', target, 'extension', '-x', '*.DS_Store', '-x', '*__MACOSX*'], {
    cwd: root,
    stdio: 'inherit',
  })
  console.log(`packed ${target}`)
} catch (error) {
  console.error('zip failed — install the `zip` CLI or archive extension/ manually')
  console.error(String(error?.message || error))
  process.exitCode = 1
}
