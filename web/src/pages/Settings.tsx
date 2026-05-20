import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ScanLine, Plus, Trash2, Check, X, BookmarkPlus, Folder, EyeOff } from 'lucide-react'
import { api, type User, type Label, type Collection } from '../api'
import { useStore } from '../store'
import { useScan } from '../hooks/useScan'

// ── shared input style ──────────────────────────────────────────────────────
const inp = 'w-full rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-border)] px-4 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] transition-colors'
const btn = 'rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
const btnPrimary = `${btn} bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white`
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
      <button onClick={() => onDelete(user)} disabled={user.id === self.id}
        className="p-1.5 rounded text-[var(--color-text-muted)] hover:text-red-400 disabled:opacity-30 transition-colors hover:bg-[var(--color-surface-overlay)]">
        <Trash2 size={14} />
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
function LibraryPathsSection() {
  const qc = useQueryClient()
  const { data: paths = [] } = useQuery({ queryKey: ['libraryPaths'], queryFn: api.libraryPaths })
  const [adding, setAdding] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [error, setError] = useState('')

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['libraryPaths'] })
    qc.invalidateQueries({ queryKey: ['comics'] })
  }
  const create = useMutation({
    mutationFn: () => api.addLibraryPath(newPath.trim()),
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
      <p className="text-xs text-[var(--color-text-muted)] mb-3">Folders the scanner reads. Removing a path also removes its comics from the library.</p>
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
        <p className="text-xs text-[var(--color-text-muted)] italic">No library paths. Add one below to start scanning comics.</p>
      )}

      {adding ? (
        <div className="mt-3 p-4 max-w-lg rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-border)] space-y-3">
          <input
            autoFocus
            placeholder="/path/to/comics"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            className={`${inp} font-mono`}
            onKeyDown={(e) => { if (e.key === 'Enter' && newPath.trim()) create.mutate() }}
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button type="button" disabled={!newPath.trim()} onClick={() => create.mutate()} className={btnPrimary}>Add</button>
            <button type="button" onClick={() => { setAdding(false); setNewPath(''); setError('') }} className={btnGhost}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className={`${btnGhost} flex items-center gap-2 mt-2`}>
          <Plus size={14} /> Add path
        </button>
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

// ── About section ───────────────────────────────────────────────────────────
function AboutSection() {
  const { data } = useQuery({
    queryKey: ['version'],
    queryFn: () => api.version(),
    staleTime: 60_000,
  })
  return (
    <section>
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-1">About</h2>
      <p className="text-xs text-[var(--color-text-muted)]">
        ComicBlaster <span className="font-mono text-[var(--color-text)]">{data?.version ?? '…'}</span>
        {' · '}
        <a
          href="https://github.com/Gman0909/ComicBlaster"
          target="_blank"
          rel="noreferrer"
          className="text-[var(--color-accent)] hover:underline"
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
        <PasswordSection />
        <ScanSection />
        <LabelsSection />
        <CollectionsSection />
        {user.role === 'admin' && <LibraryPathsSection />}
        {user.role === 'admin' && <IgnoredSection />}
        {user.role === 'admin' && <UsersSection self={user} />}
        <AboutSection />
      </div>
    </div>
  )
}
