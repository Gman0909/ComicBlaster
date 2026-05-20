import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// During `npm run dev`, /api requests are proxied to the running Go server.
// Set CB_API_TARGET to point at a Pi/remote box; defaults to localhost so a
// brand-new clone Just Works when you also `go run` the server locally.
const apiTarget = process.env.CB_API_TARGET ?? 'http://localhost:8082'

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
