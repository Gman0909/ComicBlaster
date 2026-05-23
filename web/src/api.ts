export interface Label {
  id: number
  name: string
  color: string
}

export interface Collection {
  id: number
  name: string
  created_at?: string
  comic_count?: number
  unread_count?: number
  preview_ids?: number[]
}

export interface LibraryPath {
  id: number
  path: string
  added_at: string
}

export interface IgnoredPath {
  path: string
  added_at: string
}

export interface BrowseEntry {
  name: string
  path: string
  is_dir: boolean
}

export interface BrowseResponse {
  path: string                 // canonicalised current directory on the server
  separator: string            // "/" or "\\" — the server's native one
  parent?: string              // omitted at filesystem root
  entries: BrowseEntry[]       // sub-directories of `path`
  roots?: string[]             // Windows drive letters, or ["/"] on POSIX
}

export interface Comic {
  id: number
  title: string
  series?: string
  volume?: number
  issue?: number
  format: string
  page_count: number
  file_size: number
  cover_url: string
  custom_cover: boolean
  date_added: string
  // Set by the scanner when the file wasn't observed during a
  // successful scan of its root. Empty/undefined while the file
  // is present. Used by the library overlay + Settings missing-files
  // section.
  missing_since?: string
  progress?: { last_page: number; last_cfi?: string; updated_at: string }
  labels: Label[]
  collections: Collection[]
}

export interface MissingComic {
  id: number
  path: string
  title: string
  missing_since: string
}

// Returned by api.removeComic when the file delete step couldn't
// complete. The DB row is still gone (removed: true), the path has
// been added to the ignore list as a safety net (ignored: true), but
// the file itself is still on disk — surface file_warn to the user.
export interface RemoveComicResult {
  removed: boolean
  file_warn?: string
  file_delete?: boolean
  ignored?: boolean
}

export interface UserPreferences {
  /** Sort field for the library. Mirrors LibraryUiState.sort. */
  sort?: string
  /** Sort direction. Mirrors LibraryUiState.order. */
  order?: 'asc' | 'desc'
}

export interface User {
  id: number
  username: string
  email: string
  role: 'admin' | 'user'
  /** Server-stored opaque preferences blob. Today: { sort, order }
   *  for cross-client library-view sync. */
  preferences?: UserPreferences
}

export interface ComicsPage {
  comics: Comic[]
  total: number
  page: number
  per_page: number
}

// Default JSON request timeout. Without it, a hung server / dropped Wi-Fi
// would leave fetch() pending forever and React Query would never fall back
// to its error state — that's the underlying cause of "stuck on Loading".
const DEFAULT_TIMEOUT_MS = 15_000

// Two deployment shapes are supported by the same API module:
//
//   1. Browser (default) — UI is served by the Go server from the same
//      origin; auth uses an httpOnly cb_token cookie; URLs are relative.
//   2. Native client (Wails / Tauri / etc.) — UI is loaded from a non-HTTP
//      origin (wails://, app://, file://) so cookies can't reach the
//      remote server. Auth uses Authorization: Bearer with the JWT held
//      in the OS keyring; URLs are absolute against the discovered server.
//
// The native runtime calls configureApi() before mounting React. The
// browser does NOT call it, and the zero-value defaults reproduce the
// pre-Phase-2 behaviour byte-for-byte (cookie creds, relative URLs).
interface ApiConfig {
  baseUrl: string                         // '' for same-origin web
  auth: 'cookie' | 'bearer'
  getToken: () => string | null           // only used when auth='bearer'
  onToken: (token: string | null) => void // login fires once on success, logout once on success
}

const apiConfig: ApiConfig = {
  baseUrl: '',
  auth: 'cookie',
  getToken: () => null,
  onToken: () => {},
}

export function configureApi(cfg: Partial<ApiConfig>): void {
  Object.assign(apiConfig, cfg)
}

// Public read-only view of the current config, mostly so the native shell
// can confirm what it set + so debug surfaces (Settings → Connection) can
// show what's in effect.
export function getApiConfig(): Readonly<ApiConfig> {
  return apiConfig
}

// Build the absolute (or same-origin) URL for an API path. Centralised so
// the URL helpers (coverUrl / pageUrl / fileUrl) and the fetch wrappers
// agree on prefixing, including the case where pathOrUrl already starts
// with http(s):// (don't double-prefix).
function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return apiConfig.baseUrl + path
}

// applyAuth mutates the headers + credentials of a fetch init based on
// the active auth mode. Bearer mode never sends cookies — the native
// client's origin doesn't have any, and turning credentials off avoids
// CORS preflight surprises.
function applyAuth(init: RequestInit & { headers: Record<string, string> }): RequestInit {
  if (apiConfig.auth === 'bearer') {
    init.credentials = 'omit'
    const t = apiConfig.getToken()
    if (t) init.headers['Authorization'] = `Bearer ${t}`
  } else {
    init.credentials = 'include'
  }
  return init
}

// Offline progress queue. While the native client is in offline
// mode (server unreachable but cached library shown — see
// AuthGuard), reader page-turn saves bypass the network and write
// to a coalesced localStorage queue keyed by comic ID. AuthGuard
// drains the queue when /api/auth/me starts succeeding again.
//
// Coalescing: only the highest-seq payload per comic survives. The
// server's seq-based upsert means we can replay in any order — only
// the freshest position per comic matters.
const PROGRESS_QUEUE_KEY = 'cb-progress-queue-v1'

interface QueuedProgress {
  comic_id: number
  last_page: number
  last_cfi: string
  seq: number
}

let offlineModeGetter: () => boolean = () => false
export function setOfflineModeGetter(fn: () => boolean): void {
  offlineModeGetter = fn
}

// Network-failure hook. Triggered by the `req` helper when a fetch
// throws (no HTTP status, i.e. real network error). App.tsx wires
// this to a debounced "if we have downloads, flip to offlineMode"
// transition — so a connection that drops while the app is already
// open swaps to the cached library + downloaded comics path instead
// of leaving the UI stuck on failed requests.
let onNetworkError: () => void = () => {}
export function setNetworkErrorHandler(fn: () => void): void {
  onNetworkError = fn
}

function queueProgress(comicID: number, payload: { last_page: number; last_cfi: string; seq: number }): void {
  try {
    const raw = localStorage.getItem(PROGRESS_QUEUE_KEY)
    const list: QueuedProgress[] = raw ? JSON.parse(raw) : []
    const next: QueuedProgress = { comic_id: comicID, ...payload }
    const idx = list.findIndex((e) => e.comic_id === comicID)
    if (idx >= 0) {
      if (list[idx].seq < next.seq) list[idx] = next
    } else {
      list.push(next)
    }
    localStorage.setItem(PROGRESS_QUEUE_KEY, JSON.stringify(list))
  } catch { /* localStorage full / quotaExceeded — silently drop */ }
}

/** finalSaveProgress is the unmount / beforeunload safety net for
 *  the reader. Two differences from the regular saveProgress:
 *
 *    1. Uses fetch(keepalive: true) instead of navigator.sendBeacon.
 *       sendBeacon is fire-and-forget, doesn't support custom
 *       headers, and resolves the URL against the page's origin —
 *       in the native client that origin is wails://wails.localhost,
 *       so a relative /api/comics/N/progress path would 404.
 *       fetch(keepalive: true) survives unload + lets us prefix the
 *       configured baseUrl + attach the Bearer header.
 *
 *    2. When offlineMode is set, the payload is queued locally
 *       instead of attempted — same wrapper as saveProgress.
 *
 *  Synchronous from the caller's perspective; the network attempt
 *  is fire-and-forget but the queue write (the offline path) is
 *  done before return. */
export function finalSaveProgress(comicId: number, last_page: number, last_cfi: string, seq: number): void {
  const payload = { last_page, last_cfi, seq }
  if (offlineModeGetter()) {
    queueProgress(comicId, payload)
    return
  }
  const url = apiUrl(`/api/comics/${comicId}/progress`)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiConfig.auth === 'bearer') {
    const t = apiConfig.getToken()
    if (t) headers['Authorization'] = `Bearer ${t}`
  }
  fetch(url, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers,
    keepalive: true,
    credentials: apiConfig.auth === 'bearer' ? 'omit' : 'include',
  }).catch(() => {
    // Network failed between our offlineMode check and the call —
    // queue locally so the next drain catches it. Async catch so
    // even though we returned, the localStorage write still happens.
    queueProgress(comicId, payload)
  })
}

/** Drain the queue by POSTing every pending entry. Called by
 *  AuthGuard on the offline→online transition. Returns the count of
 *  entries that successfully reached the server. */
export async function drainProgressQueue(): Promise<number> {
  let list: QueuedProgress[]
  try {
    const raw = localStorage.getItem(PROGRESS_QUEUE_KEY)
    list = raw ? JSON.parse(raw) : []
  } catch { return 0 }
  if (list.length === 0) return 0
  let ok = 0
  const remaining: QueuedProgress[] = []
  for (const e of list) {
    try {
      await req<void>('POST', `/api/comics/${e.comic_id}/progress`, {
        last_page: e.last_page,
        last_cfi: e.last_cfi,
        seq: e.seq,
      })
      ok++
    } catch {
      remaining.push(e) // keep for next retry
    }
  }
  if (remaining.length === 0) localStorage.removeItem(PROGRESS_QUEUE_KEY)
  else localStorage.setItem(PROGRESS_QUEUE_KEY, JSON.stringify(remaining))
  return ok
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {}
    if (body) headers['Content-Type'] = 'application/json'
    const init = applyAuth({
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    const res = await fetch(apiUrl(path), init)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw Object.assign(new Error(err.error ?? res.statusText), { status: res.status })
    }
    if (res.status === 204) return undefined as T
    return await res.json()
  } catch (e) {
    // No HTTP status → real network error (DNS, refused, dropped
    // mid-request, TLS, timeout). Notify the app so it can flip to
    // offline mode if appropriate. We notify on every such error;
    // App.tsx debounces the actual transition to avoid flipping on
    // a single transient hiccup.
    const status = (e as any)?.status
    if (!status) {
      try { onNetworkError() } catch { /* never let the hook break the throw */ }
    }
    if ((e as any)?.name === 'AbortError') {
      throw new Error('Request timed out')
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// In bearer mode, opt in to the server's "?token=1" path so the JWT
// comes back in the response body. Stash it via onToken before returning
// the user data, so subsequent requests pick up the Authorization header
// on the very next call.
async function loginAndCaptureToken(path: string, body: unknown): Promise<User> {
  if (apiConfig.auth !== 'bearer') {
    return req<User>('POST', path, body)
  }
  const withToken = path + (path.includes('?') ? '&' : '?') + 'token=1'
  const data = await req<User & { token?: string }>('POST', withToken, body)
  if (data.token) apiConfig.onToken(data.token)
  // Don't leak the token into downstream callers; the keyring owns it now.
  const { token: _ignored, ...rest } = data
  return rest as User
}

export const api = {
  // auth
  setupStatus: () => req<{ setup_needed: boolean }>('GET', '/api/auth/setup'),
  setup: (username: string, password: string, email = '') =>
    loginAndCaptureToken('/api/auth/setup', { username, password, email }),
  login: (username: string, password: string) =>
    loginAndCaptureToken('/api/auth/login', { username, password }),
  logout: async () => {
    await req<void>('POST', '/api/auth/logout')
    if (apiConfig.auth === 'bearer') apiConfig.onToken(null)
  },
  me: () => req<User>('GET', '/api/auth/me'),
  changePassword: (current: string, next: string) =>
    req<void>('POST', '/api/auth/password', { current, new: next }),
  // Opaque-to-the-server JSON blob keyed on the calling user. Today
  // carries library sort+order so they roam across browsers + the
  // native client. Future settings can extend the same blob without
  // schema churn.
  setPreferences: (prefs: UserPreferences) =>
    req<void>('PUT', '/api/auth/preferences', prefs),

  // comics
  comics: (params: Record<string, string | number>) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
    ).toString()
    return req<ComicsPage>('GET', `/api/comics?${qs}`)
  },
  comic: (id: number) => req<Comic>('GET', `/api/comics/${id}`),
  progress: (id: number) => req<{ last_page: number; updated_at: string } | null>('GET', `/api/comics/${id}/progress`),
  saveProgress: async (id: number, last_page: number, last_cfi?: string, seq?: number) => {
    const payload = {
      last_page,
      last_cfi: last_cfi ?? '',
      // Date.now() is monotonic enough for ordering concurrent writes from a
      // single client. The server only accepts writes whose seq exceeds the
      // currently stored value, so out-of-order arrivals can't clobber a
      // newer position with an older one.
      seq: seq ?? Date.now(),
    }
    if (offlineModeGetter()) {
      queueProgress(id, payload)
      return
    }
    try {
      await req<void>('POST', `/api/comics/${id}/progress`, payload)
    } catch (err) {
      // Network failure — queue locally so the write isn't lost.
      // (HTTP errors like 401/403/500 still propagate.) Covers the
      // gap between "connection drops" and "offlineMode flips":
      // saveProgress calls in that window would otherwise vanish.
      if (!(err as any)?.status) queueProgress(id, payload)
      throw err
    }
  },
  // Exposed on the api object for callers who already pull `api`
  // in; the underlying function is also exported standalone.
  finalSaveProgress,
  // Backfill page_count for formats the scanner can't enumerate server-side
  // (PDF reports its real numPages once pdf.js opens the doc; ePub posts 100
  // so the existing pct formula doubles as a percentage display).
  setPageCount: (id: number, page_count: number) =>
    req<void>('POST', `/api/comics/${id}/pagecount`, { page_count }),
  setCover: (id: number, page: number) =>
    req<void>('POST', `/api/comics/${id}/cover`, { page }),
  uploadCover: async (id: number, blob: Blob) => {
    const init = applyAuth({
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
    })
    const res = await fetch(apiUrl(`/api/comics/${id}/cover/upload`), init)
    if (!res.ok) throw new Error(res.statusText)
  },
  clearCover: (id: number) =>
    req<void>('DELETE', `/api/comics/${id}/cover`),

  // admin
  users: () => req<User[]>('GET', '/api/admin/users'),
  createUser: (username: string, password: string, email: string, role: string) =>
    req<User>('POST', '/api/admin/users', { username, password, email, role }),
  deleteUser: (id: number) => req<void>('DELETE', `/api/admin/users/${id}`),
  resetPassword: (id: number, password: string) =>
    req<void>('POST', `/api/admin/users/${id}/reset-password`, { password }),

  // library management (admin)
  libraryPaths: () => req<LibraryPath[]>('GET', '/api/admin/library/paths'),
  addLibraryPath: (path: string) =>
    req<LibraryPath>('POST', '/api/admin/library/paths', { path }),
  removeLibraryPath: (id: number) =>
    req<void>('DELETE', `/api/admin/library/paths/${id}`),
  ignoredPaths: () => req<IgnoredPath[]>('GET', '/api/admin/library/ignored'),
  unignorePath: (path: string) =>
    req<void>('POST', '/api/admin/library/unignore', { path }),
  // The scanner flags rows with missing_since when files aren't observed
  // under an available root; this lists just those rows for the
  // Settings → Missing files section.
  missingComics: () => req<MissingComic[]>('GET', '/api/admin/library/missing'),

  // Server-side filesystem browser (admin). Path can be omitted; the
  // server picks a sensible starting directory (the service user's
  // home, or `/` if that doesn't exist). Always reflects the SERVER's
  // filesystem regardless of where the client is running, which is
  // what we want for picking library paths on a remote machine.
  browse: (path?: string) =>
    req<BrowseResponse>('GET', `/api/admin/browse${path ? '?path=' + encodeURIComponent(path) : ''}`),
  mkdir: (parent: string, name: string) =>
    req<{ path: string }>('POST', '/api/admin/browse/mkdir', { path: parent, name }),
  // Returns undefined (HTTP 204) for a clean delete, OR a partial-
  // success object when delete_file was requested but the file
  // couldn't be removed (sandbox / permission / EROFS). In that
  // case the DB row is gone, the path is auto-added to the ignore
  // list as a safety net (so the next scan doesn't re-add the
  // comic), and the caller is expected to surface file_warn to
  // the user.
  removeComic: (id: number, opts: { ignore?: boolean; deleteFile?: boolean } = {}) => {
    const params = new URLSearchParams()
    if (opts.ignore === false) params.set('ignore', '0')
    if (opts.deleteFile) params.set('delete_file', '1')
    const qs = params.toString()
    return req<RemoveComicResult | undefined>('DELETE', `/api/admin/comics/${id}${qs ? `?${qs}` : ''}`)
  },

  // labels
  labels: () => req<Label[]>('GET', '/api/labels'),
  createLabel: (name: string, color: string) =>
    req<Label>('POST', '/api/labels', { name, color }),
  updateLabel: (id: number, name: string, color: string) =>
    req<void>('PUT', `/api/labels/${id}`, { name, color }),
  deleteLabel: (id: number) => req<void>('DELETE', `/api/labels/${id}`),
  assignLabel: (comicId: number, labelId: number) =>
    req<void>('POST', `/api/comics/${comicId}/labels/${labelId}`),
  unassignLabel: (comicId: number, labelId: number) =>
    req<void>('DELETE', `/api/comics/${comicId}/labels/${labelId}`),

  // collections
  collections: () => req<Collection[]>('GET', '/api/collections'),
  createCollection: (name: string) =>
    req<Collection>('POST', '/api/collections', { name }),
  updateCollection: (id: number, name: string) =>
    req<void>('PUT', `/api/collections/${id}`, { name }),
  deleteCollection: (id: number) =>
    req<void>('DELETE', `/api/collections/${id}`),
  addToCollection: (collectionId: number, comicId: number) =>
    req<void>('POST', `/api/collections/${collectionId}/comics/${comicId}`),
  removeFromCollection: (collectionId: number, comicId: number) =>
    req<void>('DELETE', `/api/collections/${collectionId}/comics/${comicId}`),
  reorderCollection: (id: number, comicIds: number[]) =>
    req<void>('PUT', `/api/collections/${id}/order`, { comic_ids: comicIds }),

  // version (public)
  version: () => req<{ version: string }>('GET', '/api/version'),

  // scan
  triggerScan: () => req<void>('POST', '/api/scan'),
  scanStatus: () => req<{ running: boolean; processed: number; current: string; last_scan: string; last_count: number }>('GET', '/api/scan/status'),

  // URL helpers (not fetched via api — used directly by img/canvas/pdf.js).
  // Two things happen here:
  //   1. Prefix with the configured baseUrl so the native client points
  //      at the remote Pi instead of its own (empty) origin.
  //   2. In bearer mode, append ?token=<jwt> to the URL. <img>, <canvas>,
  //      and pdf.js subresource loads can't carry an Authorization
  //      header, but they can ride a query string. The server's
  //      requireAuth accepts ?token= as a third fallback on GET only.
  // Cookie mode skips step 2 — the cookie already authenticates these.
  coverUrl: (id: number) => mediaUrl(`/api/comics/${id}/cover`),
  pageUrl: (id: number, n: number, width?: number) =>
    mediaUrl(`/api/comics/${id}/pages/${n}${width ? `?width=${width}` : ''}`),
  fileUrl: (id: number) => mediaUrl(`/api/comics/${id}/file`),

  // Offline variants — same-origin paths served by the Wails
  // AssetServer (see client/spa.go). Used by the readers when a
  // comic has been downloaded for offline reading. Width is
  // intentionally ignored: serving the natural-size image is fine
  // because the bytes never leave the local machine.
  offlineFileUrl: (id: number) => `/_offline/${id}`,
  offlinePageUrl: (id: number, n: number) => `/_offline/${id}/pages/${n}`,
}

// mediaUrl builds the URL for a subresource that the browser (not our fetch
// wrapper) will load — <img src=>, <canvas src=>, pdf.js worker, epub.js
// resource pulls. Per the comment above, this is where ?token= is appended
// in bearer mode.
//
// Exported because some media URLs come from the SERVER as JSON fields
// (e.g. comic.cover_url already includes a ?v=<mtime> cache-buster) and
// the consumers — ComicCard <img>, etc. — need to project them through
// the same rewrite. resolveServerMediaUrl below is the inbound path for
// those cases; mediaUrl here is the outbound for client-built URLs.
function mediaUrl(path: string): string {
  const url = apiUrl(path)
  if (apiConfig.auth !== 'bearer') return url
  const t = apiConfig.getToken()
  if (!t) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}token=${encodeURIComponent(t)}`
}

// resolveServerMediaUrl rewrites a media URL that the SERVER constructed
// (e.g. comic.cover_url = "/api/comics/12/cover?v=…") so it works in the
// native client. In browser/cookie mode this is a no-op — the relative
// path resolves to the same origin and the cookie authenticates it. In
// bearer mode we prepend the discovered baseUrl and append ?token=.
//
// Idempotent: handing it an already-absolute http(s):// URL leaves it
// alone (just the token append). Handing it an empty string returns
// empty. Used by api.comics / api.comic just before returning data.
export function resolveServerMediaUrl(u: string): string {
  if (!u) return u
  let url = u
  if (!/^https?:\/\//i.test(url)) url = apiConfig.baseUrl + url
  if (apiConfig.auth !== 'bearer') return url
  const t = apiConfig.getToken()
  if (!t) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}token=${encodeURIComponent(t)}`
}
