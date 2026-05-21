// Thin facade over the Wails-injected Go bridge. Used by main.tsx +
// the discovery picker + the Settings → Connection panel.
//
// Wails v2 injects bound methods on App as globals at window.go.main.App
// (this is set by the runtime before our bundle loads). The bindings
// directory under client/bindings/ is regenerated each `wails build`,
// but we deliberately don't import from there — that file is gitignored
// and only exists locally after a Wails build. Instead we use this
// facade so the web app type-checks + runs as a pure browser bundle when
// no native shell is wrapping it.

export interface ServerInfo {
  name: string
  url: string         // http(s)://host:port (no /api)
  version: string
  source: 'mdns' | 'tailscale' | 'manual'
  latency_ms: number
}

export interface ConnectionState {
  url: string
  name?: string
  token?: string
  version?: string
}

interface Bridge {
  GetSavedConnection(): Promise<ConnectionState | null>
  SaveConnection(s: ConnectionState): Promise<void>
  SetToken(t: string): Promise<void>
  ClearConnection(): Promise<void>
  Discover(): Promise<ServerInfo[]>
  ProbeURL(url: string): Promise<ServerInfo>
  RestartServer(): Promise<void>
  Version(): Promise<string>
  Ping(): Promise<string>
}

declare global {
  interface Window {
    go?: { main?: { App?: Bridge } }
  }
}

export function bridge(): Bridge | null {
  if (typeof window === 'undefined') return null
  return window.go?.main?.App ?? null
}

export function isNative(): boolean {
  return bridge() !== null
}

// Module-level token state. Lives here (not in zustand) because:
//   - The persistence story is "keyring on the Go side"; React doesn't
//     need to know about reload semantics.
//   - getToken() is called on every fetch; reading from zustand on each
//     call adds re-render churn that doesn't buy us anything.
//   - It's strictly a runtime cache — never serialised to localStorage.
let currentToken: string | null = null

export function getCurrentToken(): string | null {
  return currentToken
}

export function setCurrentToken(t: string | null): void {
  currentToken = t
}
