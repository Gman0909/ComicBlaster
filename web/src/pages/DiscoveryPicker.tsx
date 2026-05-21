// DiscoveryPicker is the first screen the native client shows when
// there's no saved server selection. Runs Discover() on the Go side,
// lists what comes back (mDNS + Tailscale + manual entry), lets the
// user pick one or paste a URL, then saves the choice + configures the
// API base URL so the rest of the app (AuthGuard, Login) takes over.
//
// Only ever rendered in native mode — NativeBootstrap in App.tsx gates
// it on isNative() + no saved baseUrl.

import { useEffect, useState, useCallback } from 'react'
import { Search, RefreshCw, Plug, Loader2, Wifi, Server, Globe } from 'lucide-react'
import { configureApi } from '../api'
import {
  bridge,
  getCurrentToken,
  setCurrentToken,
  type ServerInfo,
} from '../native'

interface Props {
  onConnected: () => void
}

export default function DiscoveryPicker({ onConnected }: Props) {
  const br = bridge()!
  const [servers, setServers] = useState<ServerInfo[]>([])
  const [scanning, setScanning] = useState(true)
  const [manualUrl, setManualUrl] = useState('')
  const [manualError, setManualError] = useState('')
  const [manualLoading, setManualLoading] = useState(false)
  const [connecting, setConnecting] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setScanning(true)
    try {
      const found = await br.Discover()
      setServers(found ?? [])
    } finally {
      setScanning(false)
    }
  }, [br])

  useEffect(() => { refresh() }, [refresh])

  // Commit to a discovered or manually-entered server. URL gets saved
  // immediately (so a reload skips the picker); the token half is
  // populated by Login.tsx via the api.ts onToken callback once the
  // user authenticates.
  async function commit(info: ServerInfo) {
    setConnecting(info.url)
    try {
      // Fresh API config — token starts as null; Login.tsx will
      // populate it via onToken. CRITICAL: getToken must read from the
      // module-level currentToken (not a literal null), otherwise the
      // very first request after login still sends without an
      // Authorization header — onToken updates currentToken but a
      // closure that always returns null is blind to that update.
      setCurrentToken(null)
      configureApi({
        baseUrl: info.url,
        auth: 'bearer',
        getToken: getCurrentToken,
        onToken: async (t) => {
          setCurrentToken(t)
          if (t) await br.SetToken(t)
          else await br.ClearConnection()
        },
      })
      await br.SaveConnection({
        url: info.url,
        name: info.name,
        version: info.version,
      })
      onConnected()
    } catch (e: unknown) {
      setManualError((e as Error)?.message ?? 'Could not save selection')
      setConnecting(null)
    }
  }

  async function tryManual(e: React.FormEvent) {
    e.preventDefault()
    setManualError('')
    setManualLoading(true)
    try {
      const info = await br.ProbeURL(manualUrl)
      await commit(info)
    } catch (e: unknown) {
      setManualError((e as Error)?.message ?? 'Could not reach that server')
    } finally {
      setManualLoading(false)
    }
  }

  const sourceIcon = (s: ServerInfo['source']) => {
    if (s === 'mdns') return <Wifi size={14} aria-hidden />
    if (s === 'tailscale') return <Globe size={14} aria-hidden />
    return <Server size={14} aria-hidden />
  }
  const sourceLabel: Record<ServerInfo['source'], string> = {
    mdns: 'Local network',
    tailscale: 'Tailscale',
    manual: 'Manual',
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-[var(--color-surface)] px-4 py-8">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-[var(--color-text)]">
            Comic<span className="text-[var(--color-accent)]">Blaster</span>
          </h1>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            Pick a server to connect to
          </p>
        </div>

        {/* Auto-discovered servers */}
        <section className="rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-border)] overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)]">
            <span className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              On your network
            </span>
            <button
              type="button"
              onClick={refresh}
              disabled={scanning}
              className="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-50 transition-colors"
              aria-label="Refresh discovery"
              title="Refresh"
            >
              <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} aria-hidden />
            </button>
          </div>
          {scanning && servers.length === 0 && (
            <div className="px-3 py-6 flex items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]">
              <Loader2 size={14} className="animate-spin" aria-hidden />
              Searching…
            </div>
          )}
          {!scanning && servers.length === 0 && (
            <div className="px-3 py-6 text-sm text-[var(--color-text-muted)] text-center">
              No servers found nearby. Enter one manually below.
            </div>
          )}
          {servers.map((s) => (
            <button
              key={s.url}
              type="button"
              onClick={() => commit(s)}
              disabled={connecting !== null}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-[var(--color-surface-overlay)] focus-visible:outline-none focus-visible:bg-[var(--color-surface-overlay)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] disabled:opacity-50 transition-colors border-t border-[var(--color-border)] first:border-t-0"
            >
              <span className="flex items-center justify-center w-8 h-8 rounded-md bg-[var(--color-surface-overlay)] text-[var(--color-text-muted)] shrink-0">
                {sourceIcon(s.source)}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-[var(--color-text)] truncate">{s.name}</span>
                <span className="block text-xs text-[var(--color-text-muted)] truncate">{s.url} · {sourceLabel[s.source]} · {s.latency_ms}ms</span>
              </span>
              {connecting === s.url
                ? <Loader2 size={14} className="animate-spin text-[var(--color-text-muted)]" aria-hidden />
                : <Plug size={14} className="text-[var(--color-text-muted)]" aria-hidden />
              }
            </button>
          ))}
        </section>

        {/* Manual entry */}
        <section className="mt-5 rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-border)] p-3">
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Connect manually
          </span>
          <form onSubmit={tryManual} className="mt-2 flex flex-col gap-2">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" aria-hidden />
              <input
                type="text"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                placeholder="http://pi.local:8082"
                aria-label="Server URL"
                className="w-full rounded-lg bg-[var(--color-surface-overlay)] border border-[var(--color-border)] pl-8 pr-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] transition-colors"
                required
              />
            </div>
            {manualError && (
              <p className="text-xs text-red-400" role="alert">{manualError}</p>
            )}
            <button
              type="submit"
              disabled={!manualUrl || manualLoading || connecting !== null}
              className="rounded-lg bg-[var(--color-accent-strong)] hover:bg-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] text-white font-medium py-2 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {manualLoading
                ? <><Loader2 size={14} className="animate-spin" aria-hidden /> Checking…</>
                : <>Connect</>
              }
            </button>
          </form>
        </section>
      </div>
    </div>
  )
}
