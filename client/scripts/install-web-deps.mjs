// install-web-deps.mjs
//
// Wails' frontend:install hook. Runs `npm install` in ../../web only if
// node_modules isn't already there — keeps repeated builds fast and
// makes the hook a no-op for developers who manage the web dir
// themselves.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, '..', '..', 'web')

if (existsSync(resolve(webRoot, 'node_modules'))) {
  process.stdout.write('[install-web-deps] node_modules present; skipping\n')
  process.exit(0)
}

process.stdout.write(`[install-web-deps] npm install in ${webRoot}\n`)
const r = spawnSync('npm', ['install'], { cwd: webRoot, stdio: 'inherit', shell: true })
process.exit(r.status ?? 1)
