// prepare-frontend.mjs
//
// Wails' frontend:build hook. Cross-platform (Node) so the same project
// builds on Windows, macOS, and Linux without per-OS shell scripts.
//
// What it does:
//   1. Run `npm run build` in ../../web (vite → web/dist/)
//   2. Mirror web/dist into client/frontend/dist so Go's //go:embed can
//      pick it up — embed can't traverse '..' so we need the assets to
//      live under the client/ tree.
//
// Wails invokes this from inside client/frontend/ (its working dir when
// running the frontend:build hook), so paths are resolved relative to
// the script's own location rather than process.cwd().

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))     // .../client/scripts
const clientRoot = resolve(here, '..')                   // .../client
const webRoot = resolve(clientRoot, '..', 'web')         // .../web
const src = resolve(webRoot, 'dist')
const dst = resolve(clientRoot, 'frontend', 'dist')

function log(msg) { process.stdout.write(`[prepare-frontend] ${msg}\n`) }

log(`building web bundle in ${webRoot}`)
// Use npm.cmd on Windows; on POSIX it's just npm. spawnSync with shell:true
// papers over the difference without us having to detect the OS.
const build = spawnSync('npm', ['run', 'build'], {
  cwd: webRoot,
  stdio: 'inherit',
  shell: true,
})
if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

log(`mirroring ${src} -> ${dst}`)
if (existsSync(dst)) rmSync(dst, { recursive: true, force: true })
mkdirSync(dst, { recursive: true })
cpSync(src, dst, { recursive: true })
log('done')
