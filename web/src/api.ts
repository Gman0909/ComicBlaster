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
  progress?: { last_page: number; last_cfi?: string; updated_at: string }
  labels: Label[]
  collections: Collection[]
}

export interface User {
  id: number
  username: string
  email: string
  role: 'admin' | 'user'
}

export interface ComicsPage {
  comics: Comic[]
  total: number
  page: number
  per_page: number
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw Object.assign(new Error(err.error ?? res.statusText), { status: res.status })
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  // auth
  setupStatus: () => req<{ setup_needed: boolean }>('GET', '/api/auth/setup'),
  setup: (username: string, password: string, email = '') =>
    req<User>('POST', '/api/auth/setup', { username, password, email }),
  login: (username: string, password: string) =>
    req<User>('POST', '/api/auth/login', { username, password }),
  logout: () => req<void>('POST', '/api/auth/logout'),
  me: () => req<User>('GET', '/api/auth/me'),
  changePassword: (current: string, next: string) =>
    req<void>('POST', '/api/auth/password', { current, new: next }),

  // comics
  comics: (params: Record<string, string | number>) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
    ).toString()
    return req<ComicsPage>('GET', `/api/comics?${qs}`)
  },
  comic: (id: number) => req<Comic>('GET', `/api/comics/${id}`),
  progress: (id: number) => req<{ last_page: number; updated_at: string } | null>('GET', `/api/comics/${id}/progress`),
  saveProgress: (id: number, last_page: number, last_cfi?: string) =>
    req<void>('POST', `/api/comics/${id}/progress`, { last_page, last_cfi: last_cfi ?? '' }),
  setCover: (id: number, page: number) =>
    req<void>('POST', `/api/comics/${id}/cover`, { page }),
  uploadCover: async (id: number, blob: Blob) => {
    const res = await fetch(`/api/comics/${id}/cover/upload`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
    })
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
  removeComic: (id: number, opts: { ignore?: boolean; deleteFile?: boolean } = {}) => {
    const params = new URLSearchParams()
    if (opts.ignore === false) params.set('ignore', '0')
    if (opts.deleteFile) params.set('delete_file', '1')
    const qs = params.toString()
    return req<void>('DELETE', `/api/admin/comics/${id}${qs ? `?${qs}` : ''}`)
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

  // scan
  triggerScan: () => req<void>('POST', '/api/scan'),
  scanStatus: () => req<{ running: boolean; processed: number; current: string; last_scan: string; last_count: number }>('GET', '/api/scan/status'),

  // URL helpers (not fetched via api — used directly by img/canvas/pdf.js)
  coverUrl: (id: number) => `/api/comics/${id}/cover`,
  pageUrl: (id: number, n: number, width?: number) =>
    `/api/comics/${id}/pages/${n}${width ? `?width=${width}` : ''}`,
  fileUrl: (id: number) => `/api/comics/${id}/file`,
}
