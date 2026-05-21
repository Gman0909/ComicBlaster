import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useStore } from '../store'

export default function Login() {
  const navigate = useNavigate()
  const setUser = useStore((s) => s.setUser)
  const [mode, setMode] = useState<'login' | 'setup'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    api.setupStatus().then(({ setup_needed }) => {
      if (setup_needed) setMode('setup')
    })
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const user = mode === 'setup'
        ? await api.setup(username, password, email)
        : await api.login(username, password)
      setUser(user)
      navigate('/')
    } catch (err: any) {
      setError(err.message ?? 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-[var(--color-surface)] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-[var(--color-text)]">
            Comic<span className="text-[var(--color-accent)]">Blaster</span>
          </h1>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            {mode === 'setup' ? 'Create your admin account to get started' : 'Sign in to your library'}
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <input
            className="w-full rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-border)] px-4 py-3 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] transition-colors"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
          {mode === 'setup' && (
            <input
              className="w-full rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-border)] px-4 py-3 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] transition-colors"
              placeholder="Email (optional)"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          )}
          <input
            className="w-full rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-border)] px-4 py-3 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] transition-colors"
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
            required
          />

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[var(--color-accent-strong)] hover:bg-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] text-white font-medium py-3 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Please wait…' : mode === 'setup' ? 'Create account' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
