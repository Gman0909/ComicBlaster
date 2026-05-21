// dev-watcher.mjs
//
// Wails' frontend:dev:watcher hook. Runs the React/Vite dev server in
// the shared web/ directory so `wails dev` gets hot-reload while the
// Go backend rebuilds independently. Cross-platform replacement for
// the original PowerShell one-liner.

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, '..', '..', 'web')

process.stdout.write(`[dev-watcher] npm run dev in ${webRoot}\n`)
const child = spawn('npm', ['run', 'dev'], { cwd: webRoot, stdio: 'inherit', shell: true })
child.on('exit', (code) => process.exit(code ?? 0))
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
