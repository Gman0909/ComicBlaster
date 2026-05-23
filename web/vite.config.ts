import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// During `npm run dev`, /api requests are proxied to the running Go server.
// Set CB_API_TARGET to point at a Pi/remote box; defaults to localhost so a
// brand-new clone Just Works when you also `go run` the server locally.
const apiTarget = process.env.CB_API_TARGET ?? 'http://localhost:8082'

// pdf.js needs auxiliary wasm files (openjpeg.wasm for JPEG 2000 images,
// jbig2.wasm, qcms_bg.wasm, etc.) at runtime. They live in
// node_modules/pdfjs-dist/wasm/. Without them, PDFs that use JPEG 2000
// compression (e.g. the Batman: The Dark Knight Returns set) render blank.
// We surface the directory at /pdfjs-wasm/ so PDFPage.tsx can point
// wasmUrl at it.
function pdfjsWasmPlugin(): Plugin {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const wasmDir = resolve(here, 'node_modules/pdfjs-dist/wasm')
  return {
    name: 'pdfjs-wasm',
    configureServer(server) {
      server.middlewares.use('/pdfjs-wasm', (req, res, next) => {
        const name = (req.url ?? '/').split('?')[0].replace(/^\//, '')
        if (!name || name.includes('..') || name.includes('/')) return next()
        const file = join(wasmDir, name)
        try {
          const buf = statSync(file)
          if (!buf.isFile()) return next()
        } catch { return next() }
        const ext = name.endsWith('.wasm') ? 'application/wasm'
          : name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'
        res.setHeader('Content-Type', ext)
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        import('node:fs').then(({ createReadStream }) => createReadStream(file).pipe(res))
      })
    },
    closeBundle() {
      // Copy the wasm/ directory verbatim into dist/pdfjs-wasm/ so
      // production builds (served by the Go binary, or wails-embedded
      // for the native client) have the files at the same path the
      // pdf.js getDocument({ wasmUrl }) call expects.
      const outDir = resolve(here, 'dist/pdfjs-wasm')
      mkdirSync(outDir, { recursive: true })
      for (const f of readdirSync(wasmDir)) {
        copyFileSync(join(wasmDir, f), join(outDir, f))
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsWasmPlugin()],
  server: {
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        // Forward cookies so auth works during dev
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.headers.cookie) {
              proxyReq.setHeader('cookie', req.headers.cookie)
            }
          })
        },
      },
    },
  },
})
