import { useEffect, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { api } from './api'
import { useStore } from './store'
import Login from './pages/Login'
import Library from './pages/Library'
import Reader from './pages/Reader'
import Settings from './pages/Settings'

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
  const { data: comic } = useQuery({
    queryKey: ['comic', comicId],
    queryFn: () => api.comic(comicId),
  })
  if (!comic) return (
    <div className="min-h-dvh bg-black flex items-center justify-center text-white/30 text-sm">
      Loading…
    </div>
  )
  if (comic.format === 'epub') return (
    <Suspense fallback={null}>
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

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeSync />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<AuthGuard><Library /></AuthGuard>} />
          <Route path="/read/:id" element={<AuthGuard><ReaderDispatch /></AuthGuard>} />
          <Route path="/settings" element={<AuthGuard><Settings /></AuthGuard>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
