import { useEffect, useState, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api, getApiConfig, setOfflineModeGetter, setNetworkErrorHandler, drainProgressQueue, type User } from './api'
import { useComic } from './hooks/useComic'
import { useStore } from './store'
import { isNative, bridge } from './native'
import Login from './pages/Login'
import Library from './pages/Library'
import Reader from './pages/Reader'
import Settings from './pages/Settings'
import DiscoveryPicker from './pages/DiscoveryPicker'
import { FullPageSpinner } from './components/Spinner'

const ReaderEpub = lazy(() => import('./pages/ReaderEpub'))

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

function ThemeSync() {
  const theme = useStore((s) => s.theme)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])
  return null
}

// Picks the right reader for the comic's format — ePub uses a separate
// component because reflowable text doesn't fit the page-by-page Reader.
function ReaderDispatch() {
  const { id } = useParams<{ id: string }>()
  const comicId = Number(id)
  const { data: comic, isError, error, refetch } = useComic(comicId)
  if (isError) {
    return (
      <div className="min-h-dvh w-full bg-black flex items-center justify-center px-6">
        <div className="max-w-sm w-full text-center space-y-4">
          <p className="text-white/90 text-base font-medium">Couldn't load this comic</p>
          <p className="text-white/50 text-xs font-mono break-all">
            {(error as Error)?.message ?? 'Unknown error'}
          </p>
          <div className="flex justify-center gap-2 pt-2">
            <button
              onClick={() => refetch()}
              className="px-4 py-2 rounded-md bg-[var(--color-accent-strong)] text-white text-sm font-medium hover:bg-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] transition-colors"
            >
              Retry
            </button>
            <button
              onClick={() => history.back()}
              className="px-4 py-2 rounded-md border border-white/15 text-white/80 text-sm hover:bg-white/10 transition-colors"
            >
              Back
            </button>
          </div>
        </div>
      </div>
    )
  }
  if (!comic) return <FullPageSpinner />
  if (comic.format === 'epub') return (
    <Suspense fallback={<FullPageSpinner label="Preparing reader" />}>
      <ReaderEpub />
    </Suspense>
  )
  return <Reader />
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, setUser, offlineMode, setOfflineMode } = useStore()
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    api.me()
      .then((u) => {
        if (cancelled) return
        setUser(u)
        // Server-stored preferences (sort, order, etc.) are the
        // source of truth across clients. Hydrate the local store
        // from them so opening the app on a new device picks up
        // the user's choices instead of starting from defaults.
        // Subsequent changes in the store push back via
        // useStore.subscribe (wired below in App).
        hydratePreferencesFromUser(u)
        // We just heard from the server — clear any prior
        // offline-mode flag so the library re-fetches live data
        // and the offline banner disappears. Also drain the
        // progress queue (reader page-turns saved while offline)
        // so the server learns the user's latest position. The
        // seq-based upsert on the server makes replay order-
        // insensitive.
        if (offlineMode) {
          setOfflineMode(false)
          drainProgressQueue().catch(() => {})
        }
        resetNetworkErrorCounter()
      })
      .catch(async (err: any) => {
        if (cancelled) return
        // 401 / 403 = the server actively rejected us. Token
        // expired or revoked → re-login. Anything WITHOUT a status
        // code is a network / DNS / TLS error: the server
        // probably isn't reachable. In the native client we'd
        // rather show the cached library + downloaded comics than
        // bounce the user to a login they can't complete.
        const status = err?.status
        if (status === 401 || status === 403) {
          navigate('/login', { replace: true })
          return
        }
        if (!status && isNative()) {
          const br = bridge()
          if (br) {
            try {
              const downloads = await br.ListDownloads()
              if (downloads && downloads.length > 0) {
                setOfflineMode(true)
                // The persisted user (zustand partialize) is the
                // last-known login; if missing entirely we fall
                // back to a placeholder so AuthGuard's `if (!user)`
                // guard doesn't block the cached library from
                // rendering.
                if (!user) setUser({ id: 0, username: 'offline', role: 'user' } as any)
                return
              }
            } catch { /* fall through to /login */ }
          }
        }
        navigate('/login', { replace: true })
      })
    return () => { cancelled = true }
  // user is intentionally excluded — we only run this guard once
  // per AuthGuard mount; re-running on user changes would loop
  // when setUser fires below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!user) return null
  return <>{children}</>
}

// NativeBootstrap gates the routed app behind a server-picker in the
// Wails shell. The browser deployment short-circuits: isNative() is
// false, so we go straight to the routes. In native mode we check
// whether main.tsx already configured a baseUrl from the saved
// connection state — if yes, jump into the routes (AuthGuard will run
// /api/auth/me and bounce to /login if the token is gone). If no, show
// the discovery picker until the user commits to a server.
function NativeBootstrap({ children }: { children: React.ReactNode }) {
  const [hasServer, setHasServer] = useState(() => {
    if (!isNative()) return true
    return getApiConfig().baseUrl !== ''
  })
  // Settings → Connection → Disconnect fires a 'cb-disconnect' window
  // event. Listening here (rather than reloading the page) avoids a
  // Wails-specific quirk: window.location.reload() re-evaluates the
  // bundle but the Go-side bindings global isn't always re-injected,
  // so isNative() can briefly return false right after a reload —
  // which routed the user to /login instead of the picker.
  useEffect(() => {
    const handler = () => setHasServer(false)
    window.addEventListener('cb-disconnect', handler)
    return () => window.removeEventListener('cb-disconnect', handler)
  }, [])
  if (isNative() && !hasServer) {
    return <DiscoveryPicker onConnected={() => setHasServer(true)} />
  }
  return <>{children}</>
}

// Wire api.ts to read offlineMode from the zustand store. Done once
// at module load — useStore.getState is reactive-free and safe to
// call from a non-React context.
setOfflineModeGetter(() => useStore.getState().offlineMode)

// hydratePreferencesFromUser copies the server-stored sort/order
// into the local store. Called from AuthGuard on every successful
// /auth/me — fresh server values take precedence over whatever was
// persisted locally last time. (A user switching machines wants
// their previous device's settings, not this device's stale ones.)
function hydratePreferencesFromUser(u: User): void {
  const prefs = u.preferences
  if (!prefs) return
  const state = useStore.getState()
  const next = { ...state.library }
  if (prefs.sort && prefs.sort !== state.library.sort) next.sort = prefs.sort
  if (prefs.order && prefs.order !== state.library.order) next.order = prefs.order
  if (next.sort !== state.library.sort || next.order !== state.library.order) {
    // Mark as hydrated FIRST so the subscribe-pushback below
    // doesn't immediately PUT the same values back to the server.
    hydratedFromServerRef.value = true
    useStore.setState({ library: next })
  } else {
    hydratedFromServerRef.value = true
  }
}

// Latch + debounce for pushing sort/order back to the server. The
// store fires on every change including programmatic ones (e.g.
// switching to last_read auto-flips order to desc); we only push
// after hydration so the very first cold-load doesn't immediately
// echo the default values to the server.
const hydratedFromServerRef = { value: false }
let pushTimer: ReturnType<typeof setTimeout> | undefined
useStore.subscribe((state, prev) => {
  if (!hydratedFromServerRef.value) return
  if (!state.user) return
  if (state.library.sort === prev.library.sort && state.library.order === prev.library.order) return
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    api.setPreferences({ sort: state.library.sort, order: state.library.order }).catch(() => {})
  }, 500)
})

// Network-failure → offline-mode transition. When a connection
// drops while the app is already open, the existing AuthGuard
// bootstrap (api.me() once at mount) doesn't re-run, so the UI
// gets stuck on failed background fetches. This hook flips
// offlineMode true after a couple of consecutive network errors
// in the native client — same UX as cold-start offline: banner +
// cached library + downloaded-comic reading still works. Real
// HTTP errors (401/403/500) don't fire this — only fetch throws.
let consecutiveNetErrors = 0
const NET_ERROR_THRESHOLD = 2  // flip after the second consecutive failure
setNetworkErrorHandler(() => {
  if (!isNative()) return
  const state = useStore.getState()
  if (state.offlineMode) return  // already there; ignore
  consecutiveNetErrors++
  if (consecutiveNetErrors < NET_ERROR_THRESHOLD) return
  // Only flip if there's something to fall back to. No downloads =
  // offline mode is pointless; let the user see the actual error
  // and decide.
  const br = bridge()
  if (!br) return
  br.ListDownloads().then((dl) => {
    if (dl && dl.length > 0 && !useStore.getState().offlineMode) {
      state.setOfflineMode(true)
    }
  }).catch(() => {})
})
// Successful api.me() in AuthGuard clears offlineMode AND the
// counter, so a brief blip followed by a recovery doesn't leave a
// stale increment lying around.
// (counter reset done in AuthGuard below, just below the
//  setOfflineMode(false) call.)
export function resetNetworkErrorCounter(): void { consecutiveNetErrors = 0 }

// OnlineProbe — while offlineMode is true, polls /api/auth/me every
// 30 seconds. The first success flips offlineMode back to false,
// drains the local progress queue to the server, and invalidates
// the comic / comics queries so the UI reflects any state the user
// changed while disconnected (or any state OTHER clients pushed
// while we were offline — the server's seq-gated upsert keeps the
// most-recent value of either side).
//
// This is what makes the offline → online transition feel
// automatic: the user doesn't have to click Retry; as soon as the
// network is back, progress reconciles within ≤ 30 seconds. The
// manual Retry on the OfflineBanner does the same work
// immediately when the user is impatient.
function OnlineProbe() {
  const offlineMode = useStore((s) => s.offlineMode)
  const setOfflineMode = useStore((s) => s.setOfflineMode)
  const setUser = useStore((s) => s.setUser)
  useEffect(() => {
    if (!offlineMode) return
    const probe = async () => {
      try {
        const me = await api.me()
        setUser(me)
        setOfflineMode(false)
        resetNetworkErrorCounter()
        await drainProgressQueue().catch(() => 0)
        queryClient.invalidateQueries({ queryKey: ['comics'] })
        queryClient.invalidateQueries({ queryKey: ['comic'] })
      } catch { /* still offline; try again on next tick */ }
    }
    // First probe fires after a short delay so we don't race with
    // whatever just put us into offline mode; subsequent every 30s.
    const first = setTimeout(probe, 5_000)
    const interval = setInterval(probe, 30_000)
    return () => { clearTimeout(first); clearInterval(interval) }
  }, [offlineMode, setOfflineMode, setUser])
  return null
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeSync />
      <OnlineProbe />
      <NativeBootstrap>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<AuthGuard><Library /></AuthGuard>} />
            <Route path="/read/:id" element={<AuthGuard><ReaderDispatch /></AuthGuard>} />
            <Route path="/settings" element={<AuthGuard><Settings /></AuthGuard>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </NativeBootstrap>
    </QueryClientProvider>
  )
}
