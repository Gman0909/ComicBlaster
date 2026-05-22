// BrowsePathModal — server-side filesystem browser for Settings →
// Library paths. Always shows the SERVER's filesystem (via the
// /api/admin/browse endpoint), so it works the same whether the
// client is in a browser on the Pi itself or in a Wails window on a
// laptop talking to the Pi over Tailscale.
//
// A native folder picker would show the CLIENT's filesystem, which
// is meaningless when the server lives on a different machine. This
// is the same approach Jellyfin / Plex / *arr use.

import { useEffect, useMemo, useState, useCallback } from 'react'
import { ChevronRight, Folder, FolderPlus, HardDrive, Home, Loader2, RefreshCw, X } from 'lucide-react'
import { api, type BrowseResponse } from '../api'

interface Props {
  /** Path to land on when the modal first opens. Empty/undefined →
   *  server picks a sensible default (service user's home, then /). */
  initialPath?: string
  onSelect: (path: string) => void
  onClose: () => void
}

export default function BrowsePathModal({ initialPath, onSelect, onClose }: Props) {
  const [data, setData]             = useState<BrowseResponse | null>(null)
  const [loading, setLoading]       = useState(true)
  const [err, setErr]               = useState('')
  const [mkdirOpen, setMkdirOpen]   = useState(false)
  const [newName, setNewName]       = useState('')
  const [mkdirBusy, setMkdirBusy]   = useState(false)

  const load = useCallback(async (path?: string) => {
    setLoading(true); setErr('')
    try {
      const res = await api.browse(path)
      setData(res)
    } catch (e: unknown) {
      setErr((e as Error)?.message ?? 'Could not read directory')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(initialPath) }, [initialPath, load])

  // Split the current path into breadcrumb segments using the SERVER's
  // separator. Each segment is a clickable jump-up target.
  const crumbs = useMemo(() => {
    if (!data) return []
    const sep = data.separator
    // Strip a trailing separator (e.g. "C:\" → "C:") before splitting, so
    // the drive letter stays as its own bone-fide segment with the
    // trailing slash re-added for the click target.
    const trimmed = data.path.endsWith(sep) && data.path.length > sep.length
      ? data.path.slice(0, -sep.length)
      : data.path
    const parts = trimmed.split(sep)
    const segs: { label: string; path: string }[] = []
    let cur = ''
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (i === 0) {
        // POSIX leading "/" → first part is ""; substitute a slash glyph.
        if (part === '') { cur = sep; segs.push({ label: sep, path: sep }); continue }
        cur = part
      } else {
        cur = cur + sep + part
      }
      segs.push({ label: part || sep, path: cur })
    }
    return segs
  }, [data])

  async function doMkdir(e: React.FormEvent) {
    e.preventDefault()
    if (!data) return
    const name = newName.trim()
    if (!name) return
    setMkdirBusy(true); setErr('')
    try {
      const { path: created } = await api.mkdir(data.path, name)
      setMkdirOpen(false); setNewName('')
      await load(created)
    } catch (e: unknown) {
      setErr((e as Error)?.message ?? 'Could not create folder')
    } finally {
      setMkdirBusy(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Browse server filesystem"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-[var(--color-surface-raised)] rounded-xl shadow-2xl w-full max-w-xl flex flex-col gap-3 p-5 max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Browse server filesystem</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 p-2 -m-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)] transition-colors"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        {/* Roots strip — Windows drives or POSIX root, plus a Home shortcut */}
        <div className="flex items-center gap-1 flex-wrap">
          <button
            type="button"
            onClick={() => load()}
            title="Home"
            aria-label="Home"
            className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)] transition-colors"
          >
            <Home size={12} aria-hidden /> Home
          </button>
          {data?.roots?.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => load(r)}
              className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)] transition-colors"
            >
              <HardDrive size={12} aria-hidden /> {r}
            </button>
          ))}
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => data && load(data.path)}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh"
            className="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)] disabled:opacity-50 transition-colors"
          >
            {loading
              ? <Loader2 size={14} className="animate-spin" aria-hidden />
              : <RefreshCw size={14} aria-hidden />
            }
          </button>
        </div>

        {/* Breadcrumb of the current path */}
        <div className="flex items-center gap-1 flex-wrap text-xs text-[var(--color-text-muted)] font-mono">
          {crumbs.map((c, i) => (
            <span key={c.path + i} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => load(c.path)}
                className="px-1.5 py-0.5 rounded hover:bg-[var(--color-surface-overlay)] hover:text-[var(--color-text)] transition-colors max-w-[14ch] truncate"
                title={c.path}
              >
                {c.label}
              </button>
              {i < crumbs.length - 1 && <ChevronRight size={10} aria-hidden />}
            </span>
          ))}
        </div>

        {/* Listing */}
        <div className="flex-1 min-h-[14rem] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-y-auto">
          {data?.parent !== undefined && (
            <button
              type="button"
              onClick={() => load(data!.parent)}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-surface-overlay)] hover:text-[var(--color-text)] border-b border-[var(--color-border)] transition-colors"
            >
              <Folder size={14} aria-hidden /> ..
            </button>
          )}
          {data?.entries?.length === 0 && !loading && (
            <p className="px-3 py-4 text-xs text-[var(--color-text-muted)] text-center italic">
              No sub-folders here. Pick this folder, navigate up, or create a new folder.
            </p>
          )}
          {data?.entries?.map((e) => (
            <button
              key={e.path}
              type="button"
              onClick={() => load(e.path)}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)] focus-visible:outline-none focus-visible:bg-[var(--color-surface-overlay)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] transition-colors"
            >
              <Folder size={14} className="text-[var(--color-text-muted)] shrink-0" aria-hidden />
              <span className="truncate">{e.name}</span>
            </button>
          ))}
        </div>

        {err && <p className="text-xs text-red-400" role="alert">{err}</p>}

        {/* New folder form, collapsed by default */}
        {mkdirOpen ? (
          <form onSubmit={doMkdir} className="flex items-center gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New folder name"
              aria-label="New folder name"
              autoFocus
              className="flex-1 rounded-lg bg-[var(--color-surface-overlay)] border border-[var(--color-border)] px-2.5 py-1.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] transition-colors"
            />
            <button
              type="button"
              onClick={() => { setMkdirOpen(false); setNewName('') }}
              disabled={mkdirBusy}
              className="px-2.5 py-1.5 rounded-lg text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mkdirBusy || !newName.trim()}
              className="px-3 py-1.5 rounded-lg bg-[var(--color-accent-strong)] hover:bg-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] text-white text-xs font-medium disabled:opacity-50 transition-colors"
            >
              {mkdirBusy ? 'Creating…' : 'Create'}
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setMkdirOpen(true)}
            className="self-start flex items-center gap-1.5 px-2 py-1 rounded text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)] transition-colors"
          >
            <FolderPlus size={12} aria-hidden /> New folder
          </button>
        )}

        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-[var(--color-border)] py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => data && onSelect(data.path)}
            disabled={!data || loading}
            className="flex-1 rounded-lg bg-[var(--color-accent-strong)] hover:bg-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] text-white py-2 text-sm font-medium disabled:opacity-50 transition-colors"
          >
            Use this folder
          </button>
        </div>
      </div>
    </div>
  )
}
