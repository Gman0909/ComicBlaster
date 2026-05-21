import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { configureApi } from './api'
import { bridge, isNative, getCurrentToken, setCurrentToken } from './native'

// Native boot path
// ================
//
// When running inside the Wails shell, the bridge tells us whether the
// user has previously chosen a server. If yes, configure the api
// module to talk to it (absolute URLs + Authorization: Bearer) BEFORE
// mounting React so the very first /api/auth/me call goes to the
// right place. If no, the api stays in its zero-config browser default
// state — App.tsx's NativeBootstrap notices the baseUrl is empty and
// renders the DiscoveryPicker instead of the normal routes.
async function bootNative(): Promise<void> {
  const br = bridge()
  if (!br) return
  const saved = await br.GetSavedConnection().catch(() => null)
  if (!saved?.url) return
  if (saved.token) setCurrentToken(saved.token)
  configureApi({
    baseUrl: saved.url,
    auth: 'bearer',
    getToken: getCurrentToken,
    onToken: async (t) => {
      setCurrentToken(t)
      if (t) await br.SetToken(t)
      else await br.ClearConnection()
    },
  })
}

async function boot() {
  if (isNative()) await bootNative()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

boot()
