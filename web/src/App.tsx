import { useEffect, useState, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { api, getApiConfig } from './api'
import { useStore } from './store'
import { isNative } from './native'
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
  const { data: comic, isError, error, refetch } = useQuery({
    queryKey: ['comic', comicId],
    queryFn: () => api.comic(comicId),
    retry: 2,
    retryDelay: 800,
  })
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
  const { user, setUser } = useStore()
  const navigate = useNavigate()

  useEffect(() => {
    if (!user) {
      api.me()
        .then(setUser)
        .catch(() => navigate('/login', { replace: true }))
    }
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
  if (isNative() && !hasServer) {
    return <DiscoveryPicker onConnected={() => setHasServer(true)} />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeSync />
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
