import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ScanLine, Plus, Trash2, Check, X, BookmarkPlus, Folder, EyeOff, Eye, Loader2, Power, RotateCw, Server, AlertTriangle, FileQuestion, HardDriveDownload } from 'lucide-react'
import { api, configureApi, type User, type Label, type Collection, type MissingComic } from '../api'
import { useStore } from '../store'
import { useScan } from '../hooks/useScan'
import { bridge, isNative, setCurrentToken, type ConnectionState } from '../native'
import BrowsePathModal from '../components/BrowsePathModal'
import { useOffline } from '../hooks/useOffline'

// ── shared input style ──────────────────────────────────────────────────────
const inp = 'w-full rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-border)] px-4 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] transition-colors'
const btn = 'rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
const btnPrimary = `${btn} bg-[var(--color-accent-strong)] hover:bg-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] text-white`
const btnGhost   = `${btn} bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-overlay)] text-[var(--color-text)]`

// ── Password section ─────────────────────────────────────────────────────────
function PasswordSection() {
  const [current, setCurrent] = useState('')
  const [next, setNext]       = useState('')
  const [confirm, setConfirm] = useState('')
  const [msg, setMsg]         = useState<{ ok: boolean; text: string } | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setMsg(null)
    if (next !== confirm) { setMsg({ ok: false, text: 'Passwords do not match' }); return }
    if (next.length < 8)  { setMsg({ ok: false, text: 'Password must be at least 8 characters' }); return }
    try {
      await api.changePassword(current, next)
      setMsg({ ok: true, text: 'Password updated' })
      setCurrent(''); setNext(''); setConfirm('')
    } catch (err: any) {
      setMsg({ ok: false, text: err.message ?? 'Failed to update password' })
    }
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Change password</h2>
      <form onSubmit={submit} className="space-y-3 max-w-sm">
        <input className={inp} type="password" placeholder="Current password" autoComplete="current-password"
          value={current} onChange={(e) => setCurrent(e.target.value)} required />
        <input className={inp} type="password" placeholder="New password" autoComplete="new-password"
          value={next} onChange={(e) => setNext(e.target.value)} required />
        <input className={inp} type="password" placeholder="Confirm new password" autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        {msg && (
          <p className={`text-sm ${msg.ok ? 'text-green-400' : 'text-red-400'}`}>{msg.text}</p>
        )}
        <button type="submit" className={btnPrimary}>Update password</button>
      </form>
    </section>
  )
}

// ── Scan section ─────────────────────────────────────────────────────────────
function ScanSection() {
  const { status, trigger } = useScan()
  const running = status?.running ?? false

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Library</h2>
      <button onClick={trigger} disabled={running} className={`${btnGhost} flex items-center gap-2`}>
        <ScanLine size={15} className={running ? 'animate-spin' : ''} />
        {running ? 'Scanning…' : 'Rescan library'}
      </button>

      {running && (
        <div className="mt-3 max-w-sm space-y-1.5">
          <div className="flex justify-between text-xs text-[var(--color-text-muted)]">
            <span className="truncate max-w-[240px]">{status?.current ?? '…'}</span>
            <span className="tabular-nums shrink-0 ml-2">{status?.processed ?? 0} files</span>
          </div>
          <div className="h-1 rounded-full bg-[var(--color-surface-overlay)] overflow-hidden">
            <div className="h-full bg-[var(--color-accent)] animate-[scan-progress_1.5s_ease-in-out_infinite]" style={{ width: '40%' }} />
          </div>
        </div>
      )}

      {!running && status?.last_scan && (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          Last scan: {new Date(status.last_scan).toLocaleString()} · {status.last_count} comics
        </p>
      )}
    </section>
  )
}

// ── User row ─────────────────────────────────────────────────────────────────
function UserRow({ user, self, onDelete, onResetPw }: {
  user: User
  self: User
  onDelete: (u: User) => void
  onResetPw: (u: User) => void
}) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-[var(--color-border)] last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[var(--color-text)] truncate">{user.username}</p>
        {user.email && <p className="text-xs text-[var(--color-text-muted)] truncate">{user.email}</p>}
      </div>
      <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
        user.role === 'admin'
          ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]'
          : 'bg-[var(--color-surface-overlay)] text-[var(--color-text-muted)]'
      }`}>
        {user.role}
      </span>
      <button onClick={() => onResetPw(user)}
        className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors px-2 py-1 rounded hover:bg-[var(--color-surface-overlay)]">
        Reset pw
      </button>
      <button
        onClick={() => onDelete(user)}
        disabled={user.id === self.id}
        title={user.id === self.id ? "Can't delete yourself" : `Delete ${user.username}`}
        aria-label={user.id === self.id ? "Can't delete yourself" : `Delete user ${user.username}`}
        className="p-1.5 rounded text-[var(--color-text-muted)] hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-30 transition-colors hover:bg-[var(--color-surface-overlay)]">
        <Trash2 size={14} aria-hidden />
      </button>
    </div>
  )
}

// ── Add user form ─────────────────────────────────────────────────────────────
function AddUserForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen]         = useState(false)
  const [username, setUsername] = useState('')
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole]         = useState('user')
  const [error, setError]       = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError('')
    try {
      await api.createUser(username, password, email, role)
      setUsername(''); setEmail(''); setPassword(''); setRole('user')
      setOpen(false); onCreated()
    } catch (err: any) {
      setError(err.message ?? 'Failed to create user')
    }
  }

  if (!open) return (
    <button onClick={() => setOpen(true)} className={`${btnGhost} flex items-center gap-2 mt-2`}>
      <Plus size={14} /> Add user
    </button>
  )

  return (
    <form onSubmit={submit} className="mt-3 p-4 rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-border)] space-y-3">
      <h3 className="text-sm font-semibold text-[var(--color-text)]">New user</h3>
      <div className="grid grid-cols-2 gap-3">
        <input className={inp} placeholder="Username" required value={username}
          onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        <input className={inp} placeholder="Email (optional)" type="email" value={email}
          onChange={(e) => setEmail(e.target.value)} />
        <input className={inp} placeholder="Password" type="password" required value={password}
          onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        <select className={inp} value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className={btnPrimary}>Create</button>
        <button type="button" onClick={() => setOpen(false)} className={btnGhost}>Cancel</button>
      </div>
    </form>
  )
}

// ── Reset password modal ──────────────────────────────────────────────────────
function ResetPasswordModal({ user, onClose }: { user: User; onClose: () => void }) {
  const [pw, setPw]   = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setMsg(null)
    try {
      await api.resetPassword(user.id, pw)
      setMsg({ ok: true, text: 'Password reset' })
      setPw('')
    } catch (err: any) {
      setMsg({ ok: false, text: err.message ?? 'Failed' })
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-[var(--color-surface-raised)] rounded-xl p-6 w-full max-w-sm border border-[var(--color-border)] space-y-4"
           onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-[var(--color-text)]">
          Reset password for <span className="text-[var(--color-accent)]">{user.username}</span>
        </h3>
        <form onSubmit={submit} className="space-y-3">
          <input className={inp} type="password" placeholder="New password" required
            autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          {msg && <p className={`text-sm ${msg.ok ? 'text-green-400' : 'text-red-400'}`}>{msg.text}</p>}
          <div className="flex gap-2">
            <button type="submit" className={btnPrimary}>Reset</button>
            <button type="button" onClick={onClose} className={btnGhost}>Close</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Labels section ──────────────────────────────────────────────────────────
const LABEL_PALETTE = ['#6366f1', '#ec4899', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#a855f7', '#ef4444']

function LabelRow({ label, onSave, onDelete }: {
  label: Label
  onSave: (name: string, color: string) => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(label.name)
  const [color, setColor] = useState(label.color)

  if (editing) {
    return (
      <div className="flex items-center gap-2 py-2.5 border-b border-[var(--color-border)] last:border-0">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 min-w-0 bg-[var(--color-surface-overlay)] border border-[var(--color-border)] rounded px-2 py-1 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
        <div className="flex gap-1 shrink-0">
          {LABEL_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`w-5 h-5 rounded-full transition-transform ${color === c ? 'ring-2 ring-offset-2 ring-offset-[var(--color-surface)] ring-[var(--color-text)] scale-110' : ''}`}
              style={{ backgroundColor: c }}
              aria-label={`Set color ${c}`}
            />
          ))}
        </div>
        <button
          onClick={() => { onSave(name.trim() || label.name, color); setEditing(false) }}
          className="p-2.5 rounded-md text-green-400 hover:bg-[var(--color-surface-overlay)] transition-colors"
          aria-label="Save"
        >
          <Check size={14} />
        </button>
        <button
          onClick={() => { setName(label.name); setColor(label.color); setEditing(false) }}
          className="p-2.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-overlay)] transition-colors"
          aria-label="Cancel"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-[var(--color-border)] last:border-0">
      <span
        className="w-3 h-3 rounded-full shrink-0"
        style={{ backgroundColor: label.color }}
      />
      <button
        onClick={() => setEditing(true)}
        className="flex-1 min-w-0 text-left text-sm text-[var(--color-text)] truncate hover:text-[var(--color-accent)] transition-colors"
      >
        {label.name}
      </button>
      <button
        onClick={onDelete}
        className="p-2.5 rounded-md text-[var(--color-text-muted)] hover:text-red-400 transition-colors hover:bg-[var(--color-surface-overlay)]"
        aria-label="Delete label"
      >
        <Trash2 size={14} />
      </button>
    </div>
  )
}

function LabelsSection() {
  const qc = useQueryClient()
  const { data: labels = [] } = useQuery({ queryKey: ['labels'], queryFn: api.labels })
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(LABEL_PALETTE[0])
  const [error, setError] = useState('')

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['labels'] })
    qc.invalidateQueries({ queryKey: ['comics'] })
  }

  const create = useMutation({
    mutationFn: () => api.createLabel(newName.trim(), newColor),
    onSuccess: () => { setNewName(''); setNewColor(LABEL_PALETTE[0]); setAdding(false); setError(''); invalidate() },
    onError: (e: any) => setError(e.message ?? 'Failed to create label'),
  })
  const update = useMutation({
    mutationFn: ({ id, name, color }: { id: number; name: string; color: string }) =>
      api.updateLabel(id, name, color),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteLabel(id),
    onSuccess: invalidate,
  })

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Labels</h2>
      {labels.length > 0 && (
        <div className="max-w-lg rounded-lg border border-[var(--color-border)] px-4 py-1">
          {labels.map((l) => (
            <LabelRow
              key={l.id}
              label={l}
              onSave={(name, color) => update.mutate({ id: l.id, name, color })}
              onDelete={() => { if (confirm(`Delete label "${l.name}"?`)) remove.mutate(l.id) }}
            />
          ))}
        </div>
      )}

      {adding ? (
        <div className="mt-3 p-4 max-w-lg rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-border)] space-y-3">
          <input
            autoFocus
            placeholder="Label name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className={inp}
          />
          <div className="flex flex-wrap gap-2">
            {LABEL_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setNewColor(c)}
                className={`w-7 h-7 rounded-full transition-transform ${newColor === c ? 'ring-2 ring-offset-2 ring-offset-[var(--color-surface-raised)] ring-[var(--color-text)] scale-110' : ''}`}
                style={{ backgroundColor: c }}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!newName.trim()}
              onClick={() => create.mutate()}
              className={btnPrimary}
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setNewName(''); setError('') }}
              className={btnGhost}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className={`${btnGhost} flex items-center gap-2 mt-2`}>
          <Plus size={14} /> Add label
        </button>
      )}
    </section>
  )
}

// ── Collections section ─────────────────────────────────────────────────────
function CollectionRow({ collection, onSave, onDelete }: {
  collection: Collection
  onSave: (name: string) => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(collection.name)

  if (editing) {
    return (
      <div className="flex items-center gap-2 py-2.5 border-b border-[var(--color-border)] last:border-0">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 min-w-0 bg-[var(--color-surface-overlay)] border border-[var(--color-border)] rounded px-2 py-1 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
        <button
          onClick={() => { onSave(name.trim() || collection.name); setEditing(false) }}
          className="p-2.5 rounded-md text-green-400 hover:bg-[var(--color-surface-overlay)] transition-colors"
          aria-label="Save"
        >
          <Check size={14} />
        </button>
        <button
          onClick={() => { setName(collection.name); setEditing(false) }}
          className="p-2.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-overlay)] transition-colors"
          aria-label="Cancel"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-[var(--color-border)] last:border-0">
      <BookmarkPlus size={14} className="text-[var(--color-text-muted)] shrink-0" />
      <button
        onClick={() => setEditing(true)}
        className="flex-1 min-w-0 text-left text-sm text-[var(--color-text)] truncate hover:text-[var(--color-accent)] transition-colors"
      >
        {collection.name}
      </button>
      <span className="text-xs text-[var(--color-text-muted)] tabular-nums shrink-0">
        {collection.comic_count ?? 0}
      </span>
      <button
        onClick={onDelete}
        className="p-2.5 rounded-md text-[var(--color-text-muted)] hover:text-red-400 transition-colors hover:bg-[var(--color-surface-overlay)]"
        aria-label="Delete collection"
      >
        <Trash2 size={14} />
      </button>
    </div>
  )
}

function CollectionsSection() {
  const qc = useQueryClient()
  const { data: collections = [] } = useQuery({ queryKey: ['collections'], queryFn: api.collections })
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['collections'] })
    qc.invalidateQueries({ queryKey: ['comics'] })
  }

  const create = useMutation({
    mutationFn: () => api.createCollection(newName.trim()),
    onSuccess: () => { setNewName(''); setAdding(false); setError(''); invalidate() },
    onError: (e: any) => setError(e.message ?? 'Failed to create collection'),
  })
  const update = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => api.updateCollection(id, name),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteCollection(id),
    onSuccess: invalidate,
  })

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Collections</h2>
      {collections.length > 0 && (
        <div className="max-w-lg rounded-lg border border-[var(--color-border)] px-4 py-1">
          {collections.map((c) => (
            <CollectionRow
              key={c.id}
              collection={c}
              onSave={(name) => update.mutate({ id: c.id, name })}
              onDelete={() => { if (confirm(`Delete collection "${c.name}"?`)) remove.mutate(c.id) }}
            />
          ))}
        </div>
      )}

      {adding ? (
        <div className="mt-3 p-4 max-w-lg rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-border)] space-y-3">
          <input
            autoFocus
            placeholder="Collection name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className={inp}
            onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) create.mutate() }}
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!newName.trim()}
              onClick={() => create.mutate()}
              className={btnPrimary}
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setNewName(''); setError('') }}
              className={btnGhost}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className={`${btnGhost} flex items-center gap-2 mt-2`}>
          <Plus size={14} /> Add collection
        </button>
      )}
    </section>
  )
}

// ── Library paths (admin) ───────────────────────────────────────────────────
//
// Two ways to add a path:
//   1. The Browse button opens BrowsePathModal — a server-side
//      filesystem picker. This is the primary path because it shows
//      the SERVER's filesystem, which is what we need to point the
//      scanner at (the alternative — a native OS folder dialog —
//      shows the CLIENT's filesystem, which is useless when the
//      client and server are on different machines).
//   2. Power-user fallback: type a path directly. Useful for paths
//      the admin already has memorised, or NFS / SMB mounts that
//      appear under the same name on every host.
function LibraryPathsSection() {
  const qc = useQueryClient()
  const { data: paths = [] } = useQuery({ queryKey: ['libraryPaths'], queryFn: api.libraryPaths })
  const [adding, setAdding]       = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false)
  const [newPath, setNewPath]     = useState('')
  const [error, setError]         = useState('')

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['libraryPaths'] })
    qc.invalidateQueries({ queryKey: ['comics'] })
  }
  const create = useMutation({
    mutationFn: (p: string) => api.addLibraryPath(p),
    onSuccess: () => { setNewPath(''); setAdding(false); setError(''); invalidate() },
    onError: (e: any) => setError(e.message ?? 'Failed to add path'),
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.removeLibraryPath(id),
    onSuccess: invalidate,
  })

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-1">Library paths</h2>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">Folders on the server that the scanner reads. Removing a path also removes its comics from the library.</p>
      {paths.length > 0 ? (
        <div className="max-w-lg rounded-lg border border-[var(--color-border)] px-4 py-1">
          {paths.map((p) => (
            <div key={p.id} className="flex items-center gap-3 py-2.5 border-b border-[var(--color-border)] last:border-0">
              <Folder size={14} className="text-[var(--color-text-muted)] shrink-0" />
              <span className="flex-1 min-w-0 text-sm text-[var(--color-text)] font-mono truncate" title={p.path}>{p.path}</span>
              <button
                onClick={() => { if (confirm(`Remove "${p.path}" and all its comics from the library?`)) remove.mutate(p.id) }}
                className="p-2.5 rounded-md text-[var(--color-text-muted)] hover:text-red-400 transition-colors hover:bg-[var(--color-surface-overlay)]"
                aria-label="Remove path"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-[var(--color-text-muted)] italic">No library paths. Browse the server's filesystem to add one.</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setBrowseOpen(true)}
          className={`${btnPrimary} flex items-center gap-2`}
        >
          <Folder size={14} aria-hidden /> Browse server
        </button>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className={`${btnGhost} flex items-center gap-2`}
        >
          <Plus size={14} aria-hidden /> {adding ? 'Cancel manual entry' : 'Type path manually'}
        </button>
      </div>

      {adding && (
        <div className="mt-3 p-4 max-w-lg rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-border)] space-y-3">
          <input
            autoFocus
            placeholder="/mnt/comics or C:\Comics"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            className={`${inp} font-mono`}
            onKeyDown={(e) => { if (e.key === 'Enter' && newPath.trim()) create.mutate(newPath.trim()) }}
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button type="button" disabled={!newPath.trim()} onClick={() => create.mutate(newPath.trim())} className={btnPrimary}>Add</button>
            <button type="button" onClick={() => { setAdding(false); setNewPath(''); setError('') }} className={btnGhost}>Cancel</button>
          </div>
        </div>
      )}

      {browseOpen && (
        <BrowsePathModal
          onClose={() => setBrowseOpen(false)}
          onSelect={(p) => { setBrowseOpen(false); create.mutate(p) }}
        />
      )}
    </section>
  )
}

// ── Ignored items (admin) ───────────────────────────────────────────────────
function IgnoredSection() {
  const qc = useQueryClient()
  const { data: ignored = [] } = useQuery({ queryKey: ['ignoredPaths'], queryFn: api.ignoredPaths })
  const unignore = useMutation({
    mutationFn: (path: string) => api.unignorePath(path),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ignoredPaths'] })
      qc.invalidateQueries({ queryKey: ['comics'] })
    },
  })

  if (ignored.length === 0) {
    return (
      <section>
        <h2 className="text-sm font-semibold text-[var(--color-text)] mb-1">Ignored items</h2>
        <p className="text-xs text-[var(--color-text-muted)]">No items are hidden. Comics you remove with "hide" appear here.</p>
      </section>
    )
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-1">Ignored items</h2>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">Files skipped by the scanner. Click <span className="text-[var(--color-accent)]">Restore</span> to re-add to the library on next scan.</p>
      <div className="max-w-lg rounded-lg border border-[var(--color-border)] px-4 py-1">
        {ignored.map((p) => {
          const base = p.path.split(/[\\/]/).pop() ?? p.path
          return (
            <div key={p.path} className="flex items-center gap-3 py-2.5 border-b border-[var(--color-border)] last:border-0">
              <EyeOff size={14} className="text-[var(--color-text-muted)] shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[var(--color-text)] truncate">{base}</p>
                <p className="text-[11px] text-[var(--color-text-muted)] font-mono truncate" title={p.path}>{p.path}</p>
              </div>
              <button
                onClick={() => unignore.mutate(p.path)}
                className="text-xs text-[var(--color-accent)] hover:underline shrink-0"
              >
                Restore
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ── Offline storage (native client only; auto-hides when empty) ────────────
//
// Inventory + management UI for the offline-reading feature. Lists
// every downloaded comic with size + downloaded-at + a Remove
// button, plus a single Remove-all action and total / free-disk
// readouts.
//
// Auto-hides entirely when:
//   - we're not in the native client (offline reading is desktop-only), or
//   - no comics are downloaded
// This keeps the browser deployment clean and doesn't surface an
// empty section to native users who haven't downloaded anything yet.
function OfflineStorageSection() {
  const off = useOffline()
  const [storage, setStorage] = useState<{ total_bytes: number; free_bytes: number } | null>(null)
  const [search, setSearch] = useState('')
  const [confirmAllOpen, setConfirmAllOpen] = useState(false)

  // Fetch StorageInfo whenever the entries set changes so total
  // bytes + free disk stay accurate after downloads / removals.
  useEffect(() => {
    if (!off.available) return
    const br = bridge()
    if (!br) return
    let cancelled = false
    br.StorageInfo()
      .then((info) => { if (!cancelled) setStorage({ total_bytes: info.total_bytes, free_bytes: info.free_bytes }) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [off.entries.size, off.available])

  if (!off.available || off.entries.size === 0) return null

  const entries = Array.from(off.entries.values())
    .sort((a, b) => (b.downloaded_at || '').localeCompare(a.downloaded_at || ''))
  const filtered = search
    ? entries.filter((e) => e.title.toLowerCase().includes(search.toLowerCase()))
    : entries
  const totalBytes = entries.reduce((sum, e) => sum + e.size_bytes, 0)

  async function removeOne(comicId: number, title: string) {
    if (!confirm(`Remove “${title}” from this device? You can re-download it any time.`)) return
    await off.remove(comicId).catch(() => {})
  }

  async function removeAll() {
    const br = bridge()
    if (!br) return
    await br.RemoveAllDownloads().catch(() => {})
    await off.refresh()
    setConfirmAllOpen(false)
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-1 flex items-center gap-2">
        <HardDriveDownload size={14} className="text-[var(--color-accent)]" aria-hidden />
        Offline storage
        <span className="text-[var(--color-text-muted)] font-normal tabular-nums">
          ({off.entries.size} · {formatBytes(totalBytes)})
        </span>
      </h2>
      <p className="text-xs text-[var(--color-text-muted)] mb-3 max-w-lg">
        Comics stored on this device. Available to read without a server connection.
        {storage && storage.free_bytes > 0 && (
          <span> · {formatBytes(storage.free_bytes)} free on disk</span>
        )}
      </p>

      <div className="max-w-lg space-y-3">
        {entries.length > 6 && (
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by title"
            className={inp}
          />
        )}
        <div className="rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] max-h-72 overflow-y-auto">
          {filtered.length === 0 && (
            <p className="px-3 py-3 text-xs text-[var(--color-text-muted)] italic text-center">
              No matches.
            </p>
          )}
          {filtered.map((e) => (
            <div key={e.comic_id} className="flex items-center gap-3 px-3 py-2.5">
              <HardDriveDownload size={14} className="text-[var(--color-accent)] shrink-0" aria-hidden />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[var(--color-text)] truncate" title={e.title}>{e.title}</p>
                <p className="text-[11px] text-[var(--color-text-muted)] tabular-nums">
                  {formatBytes(e.size_bytes)} · {relativeDate(e.downloaded_at)}
                </p>
              </div>
              <button
                onClick={() => removeOne(e.comic_id, e.title)}
                className="p-2.5 rounded-md text-[var(--color-text-muted)] hover:text-red-400 hover:bg-[var(--color-surface-overlay)] transition-colors"
                aria-label={`Remove ${e.title} from this device`}
                title="Remove from this device"
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setConfirmAllOpen(true)}
          className={`${btn} bg-red-600 hover:bg-red-500 text-white flex items-center gap-2`}
        >
          <Trash2 size={14} aria-hidden /> Remove all from this device
        </button>
      </div>

      {confirmAllOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setConfirmAllOpen(false)}
        >
          <div
            className="bg-[var(--color-surface-raised)] rounded-xl shadow-2xl w-full max-w-sm flex flex-col gap-4 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-[var(--color-text)] flex items-center gap-2">
              <AlertTriangle size={14} className="text-red-400" aria-hidden />
              Remove all {entries.length} downloads?
            </h2>
            <p className="text-sm text-[var(--color-text-muted)] leading-snug">
              This will free {formatBytes(totalBytes)} of disk space. The comics stay in your library —
              you can re-download them any time.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmAllOpen(false)} className="flex-1 rounded-lg border border-[var(--color-border)] py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
                Cancel
              </button>
              <button onClick={removeAll} className="flex-1 rounded-lg bg-red-600 hover:bg-red-500 py-2 text-sm font-medium text-white transition-colors">
                Remove all
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function relativeDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const seconds = (Date.now() - d.getTime()) / 1000
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
  if (seconds < 86400 * 14) return `${Math.floor(seconds / 86400)} days ago`
  return d.toLocaleDateString()
}

// ── Missing files (admin only; auto-hides when empty) ───────────────────────
//
// The scanner flags rows it can't observe under an available library
// root with missing_since instead of hard-deleting them, so reading
// progress / labels / collection memberships survive a NAS hiccup.
// This section is the only place the user can permanently get rid of
// genuinely-gone files. Toggle controls whether they show up in the
// library view (greyed out + non-clickable) or stay hidden.
function MissingFilesSection() {
  const qc = useQueryClient()
  const { data: missing = [], isLoading } = useQuery({
    queryKey: ['missingComics'],
    queryFn: api.missingComics,
  })
  const showMissing = useStore((s) => s.showMissing)
  const setShowMissing = useStore((s) => s.setShowMissing)
  const [confirmOpen, setConfirmOpen] = useState(false)

  // Auto-hide the whole section when there's nothing missing. Loading
  // state also collapses to nothing so the page doesn't flash empty
  // headers on first render.
  if (isLoading || missing.length === 0) return null

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-1 flex items-center gap-2">
        <FileQuestion size={14} className="text-red-400" aria-hidden />
        Missing files
        <span className="text-[var(--color-text-muted)] font-normal tabular-nums">({missing.length})</span>
      </h2>
      <p className="text-xs text-[var(--color-text-muted)] mb-3 max-w-lg">
        Files the scanner couldn't observe last time it ran their library root. Reading progress, labels, and collection memberships are preserved until you remove them here.
      </p>

      <div className="max-w-lg space-y-3">
        <label className="flex items-start gap-3 cursor-pointer select-none p-3 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-surface-overlay)] transition-colors">
          <input
            type="checkbox"
            checked={showMissing}
            onChange={(e) => {
              setShowMissing(e.target.checked)
              qc.invalidateQueries({ queryKey: ['comics'] })
            }}
            className="mt-0.5 w-4 h-4 accent-[var(--color-accent)] shrink-0"
          />
          <div className="min-w-0">
            <p className="text-sm text-[var(--color-text)] flex items-center gap-1.5">
              {showMissing ? <Eye size={14} className="text-[var(--color-text-muted)]" aria-hidden /> : <EyeOff size={14} className="text-[var(--color-text-muted)]" aria-hidden />}
              Show missing files in the library
            </p>
            <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
              When on, they appear greyed-out and can't be opened.
            </p>
          </div>
        </label>

        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          className={`${btn} bg-red-600 hover:bg-red-500 text-white flex items-center gap-2`}
        >
          <Trash2 size={14} aria-hidden /> Remove missing files…
        </button>
      </div>

      {confirmOpen && (
        <RemoveMissingModal
          missing={missing}
          onClose={() => setConfirmOpen(false)}
          onDone={() => {
            qc.invalidateQueries({ queryKey: ['missingComics'] })
            qc.invalidateQueries({ queryKey: ['comics'] })
            qc.invalidateQueries({ queryKey: ['collections'] })
            setConfirmOpen(false)
          }}
        />
      )}
    </section>
  )
}

// Bulk-removal confirmation for missing files. Mirrors RemoveComicModal's
// shape (red destructive button, plain confirm text) but doesn't offer
// the "also delete from disk" checkbox — the files are already missing,
// so the disk-deletion would be a no-op (and ignore-listing the path
// would just block re-discovery if the file ever comes back, which the
// user probably doesn't want for an unintentional outage).
function RemoveMissingModal({ missing, onClose, onDone }: {
  missing: MissingComic[]
  onClose: () => void
  onDone: () => void
}) {
  const [working, setWorking] = useState(false)
  const [err, setErr] = useState('')

  async function confirm() {
    setWorking(true); setErr('')
    try {
      // ignore=false so a file that comes back later is re-discovered
      // (e.g. user restored from backup). deleteFile=false because the
      // file is already missing — trying to os.Remove a path that
      // doesn't exist would just log a soft warning.
      await Promise.all(missing.map((m) =>
        api.removeComic(m.id, { ignore: false, deleteFile: false }).catch(() => {})
      ))
      onDone()
    } catch (e: any) {
      setErr(e.message ?? 'Failed to remove')
      setWorking(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-[var(--color-surface-raised)] rounded-xl shadow-2xl w-full max-w-md flex flex-col gap-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-text)] flex items-center gap-2">
            <AlertTriangle size={14} className="text-red-400" aria-hidden />
            Remove {missing.length} missing file{missing.length === 1 ? '' : 's'}?
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 p-2 -m-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)] transition-colors"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <p className="text-sm text-[var(--color-text-muted)] leading-snug">
          Reading progress, labels, and collection memberships for these {missing.length} item{missing.length === 1 ? '' : 's'} will be permanently lost. This cannot be undone.
        </p>

        <div className="max-h-40 overflow-y-auto rounded border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
          {missing.slice(0, 50).map((m) => (
            <div key={m.id} className="px-3 py-1.5 text-xs">
              <p className="text-[var(--color-text)] truncate" title={m.title}>{m.title}</p>
              <p className="font-mono text-[10px] text-[var(--color-text-muted)] truncate" title={m.path}>{m.path}</p>
            </div>
          ))}
          {missing.length > 50 && (
            <p className="px-3 py-1.5 text-[11px] text-[var(--color-text-muted)] italic text-center">
              …and {missing.length - 50} more
            </p>
          )}
        </div>

        {err && <p className="text-sm text-red-400" role="alert">{err}</p>}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={working}
            className="flex-1 rounded-lg border border-[var(--color-border)] py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={working}
            className="flex-1 rounded-lg py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] bg-red-600 hover:bg-red-500 flex items-center justify-center gap-2"
          >
            {working
              ? <><Loader2 size={14} className="animate-spin" aria-hidden /> Removing…</>
              : <>Remove {missing.length}</>
            }
          </button>
        </div>
      </div>
    </div>
  )
}

// ── User management section (admin only) ────────────────────────────────────
function UsersSection({ self }: { self: User }) {
  const qc = useQueryClient()
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: api.users })
  const [resetting, setResetting] = useState<User | null>(null)

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteUser(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Users</h2>
      <div className="max-w-lg rounded-lg border border-[var(--color-border)] px-4 py-1">
        {users.map((u) => (
          <UserRow key={u.id} user={u} self={self}
            onDelete={(u) => { if (confirm(`Delete user "${u.username}"?`)) deleteMutation.mutate(u.id) }}
            onResetPw={setResetting}
          />
        ))}
      </div>
      <AddUserForm onCreated={() => qc.invalidateQueries({ queryKey: ['users'] })} />
      {resetting && <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} />}
    </section>
  )
}

// ── Connection section (native client only) ─────────────────────────────────
//
// Shows what server the user is connected to and offers the two actions
// the original spec called out: Disconnect (forget this server entirely
// and return to the picker) and Restart server (admin only; calls
// POST /api/admin/restart and polls /api/discover until the server
// comes back). Browser deployment never renders this — isNative() is
// false there, so the section short-circuits in the Settings page.
function ConnectionSection({ self }: { self: User }) {
  const br = bridge()
  const [conn, setConn]               = useState<ConnectionState | null>(null)
  const [clientVersion, setClientVersion] = useState<string>('')
  const [latency, setLatency]         = useState<number | null>(null)
  const [refreshing, setRefreshing]   = useState(false)
  const [restarting, setRestarting]   = useState(false)
  const [error, setError]             = useState('')

  // Load saved connection + client version on mount.
  useEffect(() => {
    if (!br) return
    let cancelled = false
    Promise.all([br.GetSavedConnection(), br.Version()])
      .then(([s, v]) => {
        if (cancelled) return
        setConn(s)
        setClientVersion(v)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [br])

  // Re-probe the configured server to refresh version + latency. Used
  // by the Refresh button + as the polling step during a restart so the
  // panel reflects the new version once the server reappears.
  async function refresh() {
    if (!br || !conn) return
    setRefreshing(true)
    setError('')
    try {
      const info = await br.ProbeURL(conn.url)
      setLatency(info.latency_ms)
      setConn({ ...conn, name: info.name, version: info.version })
    } catch (e: unknown) {
      setError((e as Error)?.message ?? 'Could not reach server')
      setLatency(null)
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => { if (conn) refresh() }, [conn?.url]) // eslint-disable-line react-hooks/exhaustive-deps

  const setUser = useStore((s) => s.setUser)
  const navigate = useNavigate()
  async function disconnect() {
    if (!br) return
    if (!confirm('Disconnect from this server? You will need to re-discover or re-enter the URL next launch.')) return
    await br.ClearConnection()
    // In-process reset (no window.location.reload — see App.tsx's
    // NativeBootstrap for why a reload mis-routes us to /login). The
    // order matters:
    //   1. Drop the in-memory bearer token + reset api config so any
    //      stray fetch from a still-mounted component fails closed.
    //   2. Clear the zustand user so AuthGuard won't render
    //      children if it briefly remounts before the picker takes
    //      over.
    //   3. Navigate back to / so when the picker commits and routes
    //      remount, we land on the library, not the now-stale
    //      /settings.
    //   4. Fire cb-disconnect — NativeBootstrap listens and sets
    //      hasServer=false, swapping in the picker.
    setCurrentToken(null)
    configureApi({
      baseUrl: '',
      auth: 'cookie',
      getToken: () => null,
      onToken: () => {},
    })
    setUser(null)
    navigate('/', { replace: true })
    window.dispatchEvent(new CustomEvent('cb-disconnect'))
  }

  async function restartServer() {
    if (!br || !conn) return
    if (!confirm(`Restart ${conn.name || 'the server'}? The reading session may briefly drop.`)) return
    setRestarting(true)
    setError('')
    try {
      await br.RestartServer()
      // The server exit(1)s after a 250ms grace, then systemd brings it
      // back. Poll until /api/discover answers again, up to ~30s.
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500))
        try {
          const info = await br.ProbeURL(conn.url)
          setLatency(info.latency_ms)
          setConn({ ...conn, name: info.name, version: info.version })
          setRestarting(false)
          return
        } catch { /* still down — keep polling */ }
      }
      setError('Server did not come back within 30 seconds. Check the service.')
    } catch (e: unknown) {
      setError((e as Error)?.message ?? 'Restart request failed')
    } finally {
      setRestarting(false)
    }
  }

  if (!isNative()) return null
  if (!conn) {
    // Shouldn't happen — Settings is only reachable behind AuthGuard
    // which itself only runs once a connection is configured — but be
    // defensive.
    return null
  }

  // Pick a small icon for the discovery source. We don't have the
  // source recorded on the saved connection (it was discarded after
  // commit), so default to a generic server glyph. Could be added in
  // a follow-up if it turns out to be useful.
  const sourceIcon = <Server size={16} aria-hidden />

  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Connection</h2>
      <div className="max-w-lg rounded-lg border border-[var(--color-border)] p-4 space-y-3">
        <div className="flex items-start gap-3">
          <span className="flex items-center justify-center w-10 h-10 rounded-md bg-[var(--color-surface-overlay)] text-[var(--color-text-muted)] shrink-0">
            {sourceIcon}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[var(--color-text)] truncate">{conn.name || conn.url}</p>
            <p className="text-xs text-[var(--color-text-muted)] truncate font-mono">{conn.url}</p>
            <p className="text-xs text-[var(--color-text-muted)] mt-1">
              Server <span className="font-mono">{conn.version ?? '…'}</span>
              <span className="mx-1">·</span>
              Client <span className="font-mono">{clientVersion || '…'}</span>
              {latency !== null && (
                <>
                  <span className="mx-1">·</span>
                  {latency}ms
                </>
              )}
            </p>
          </div>
        </div>

        {error && (
          <p className="text-xs text-red-400" role="alert">{error}</p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing || restarting}
            className={`${btnGhost} flex items-center gap-2`}
          >
            {refreshing
              ? <Loader2 size={14} className="animate-spin" aria-hidden />
              : <RotateCw size={14} aria-hidden />
            }
            Refresh
          </button>
          {self.role === 'admin' && (
            <button
              type="button"
              onClick={restartServer}
              disabled={restarting}
              className={`${btnGhost} flex items-center gap-2`}
            >
              {restarting
                ? <><Loader2 size={14} className="animate-spin" aria-hidden /> Restarting…</>
                : <><RotateCw size={14} aria-hidden /> Restart server</>
              }
            </button>
          )}
          <button
            type="button"
            onClick={disconnect}
            disabled={restarting}
            className={`${btnGhost} flex items-center gap-2 text-red-400 hover:text-red-300`}
          >
            <Power size={14} aria-hidden />
            Disconnect
          </button>
        </div>
      </div>
    </section>
  )
}

// ── About section ───────────────────────────────────────────────────────────
function AboutSection() {
  const { data } = useQuery({
    queryKey: ['version'],
    queryFn: () => api.version(),
    staleTime: 60_000,
  })
  // In the native client, also read the client-side build tag via
  // the Wails bridge. Otherwise the About section only shows the
  // server version, and a freshly-upgraded client still reads as
  // whatever the connected server's version is — which surprised
  // users testing native releases.
  const [clientVersion, setClientVersion] = useState<string>('')
  useEffect(() => {
    const br = bridge()
    if (!br) return
    let cancelled = false
    br.Version().then((v) => { if (!cancelled) setClientVersion(v) }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-1">About</h2>
      <p className="text-xs text-[var(--color-text-muted)]">
        Server <span className="font-mono text-[var(--color-text)]">{data?.version ?? '…'}</span>
        {clientVersion && (
          <>
            {' · '}
            Client <span className="font-mono text-[var(--color-text)]">{clientVersion}</span>
          </>
        )}
        {' · '}
        <a
          href="https://github.com/Gman0909/ComicBlaster"
          target="_blank"
          rel="noreferrer"
          className="text-[var(--color-accent)] underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] rounded"
        >
          source
        </a>
      </p>
    </section>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function Settings() {
  const navigate = useNavigate()
  const user = useStore((s) => s.user)

  if (!user) return null

  return (
    <div className="min-h-dvh bg-[var(--color-surface)]">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface-raised)]">
        <button onClick={() => navigate(-1)} aria-label="Back"
          className="p-2 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)] transition-colors">
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-sm font-semibold text-[var(--color-text)]">Settings</h1>
        <span className="ml-auto flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
          <span className="hidden sm:inline">Signed in as</span>
          <span className="px-2 py-0.5 rounded-full bg-[var(--color-surface-overlay)] text-[var(--color-text)] font-medium max-w-[10rem] truncate">
            {user.username}
          </span>
          {user.role === 'admin' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-accent)]/20 text-[var(--color-accent)] font-medium">admin</span>
          )}
        </span>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-8 space-y-10">
        {/* Connection — native client only; renders null in browser */}
        <ConnectionSection self={user} />
        <OfflineStorageSection />
        <PasswordSection />
        <ScanSection />
        <LabelsSection />
        <CollectionsSection />
        {user.role === 'admin' && <LibraryPathsSection />}
        {user.role === 'admin' && <IgnoredSection />}
        {user.role === 'admin' && <MissingFilesSection />}
        {user.role === 'admin' && <UsersSection self={user} />}
        <AboutSection />
      </div>
    </div>
  )
}
