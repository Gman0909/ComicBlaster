import { useState } from 'react'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import { Tag, Bookmark, Trash2, X, AlertTriangle, Plus } from 'lucide-react'
import { api, type Comic, type Collection } from '../api'

// Mirror of the palette used in Settings → Labels. Used to pick a default
// colour for labels created from the bulk-action bar.
const LABEL_PALETTE = ['#6366f1', '#ec4899', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#a855f7', '#ef4444']

interface Props {
  selected: Comic[]
  selectedCollections?: Collection[]
  canHide: boolean       // admin only
  onClear: () => void
}

type Popover = 'labels' | 'collections' | 'hide' | null

// Fetch every comic ID inside the given collections. Used at action time so
// label/hide operations from the collections view affect every contained comic.
async function expandCollectionComicIds(cols: Collection[]): Promise<number[]> {
  const ids = new Set<number>()
  for (const col of cols) {
    try {
      const data = await api.comics({ collection_id: col.id, per_page: 1000 })
      for (const c of data.comics) ids.add(c.id)
    } catch {}
  }
  return [...ids]
}

export default function BulkActionBar({ selected, selectedCollections = [], canHide, onClear }: Props) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState<Popover>(null)
  const [busy, setBusy] = useState(false)

  const { data: labels = [] } = useQuery({ queryKey: ['labels'], queryFn: () => api.labels() })
  const { data: collections = [] } = useQuery({ queryKey: ['collections'], queryFn: () => api.collections() })

  const ids = selected.map((c) => c.id)
  // True when the selection is only collections — used to swap UI semantics.
  const isCollectionMode = selectedCollections.length > 0 && selected.length === 0

  async function resolveTargetIds(): Promise<number[]> {
    if (isCollectionMode) return await expandCollectionComicIds(selectedCollections)
    return ids
  }

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ['comics'] })
    queryClient.invalidateQueries({ queryKey: ['collections'] })
    queryClient.invalidateQueries({ queryKey: ['ignoredPaths'] })
  }

  // For each label, count how many of the selected comics have it.
  function labelCoverage(labelId: number) {
    let n = 0
    for (const c of selected) {
      if (c.labels.some((l) => l.id === labelId)) n++
    }
    return n
  }
  function collectionCoverage(collectionId: number) {
    let n = 0
    for (const c of selected) {
      if (c.collections.some((col) => col.id === collectionId)) n++
    }
    return n
  }

  async function toggleLabel(labelId: number) {
    setBusy(true)
    try {
      const targets = await resolveTargetIds()
      // Coverage check only meaningful for direct comic selection; for
      // collection-mode we always assign.
      if (!isCollectionMode && labelCoverage(labelId) === selected.length) {
        await Promise.all(targets.map((id) => api.unassignLabel(id, labelId).catch(() => {})))
      } else {
        await Promise.all(targets.map((id) => api.assignLabel(id, labelId).catch(() => {})))
      }
      invalidateAll()
    } finally {
      setBusy(false)
    }
  }

  async function toggleCollection(collectionId: number) {
    setBusy(true)
    try {
      const targets = await resolveTargetIds()
      if (!isCollectionMode && collectionCoverage(collectionId) === selected.length) {
        await Promise.all(targets.map((id) => api.removeFromCollection(collectionId, id).catch(() => {})))
      } else {
        await Promise.all(targets.map((id) => api.addToCollection(collectionId, id).catch(() => {})))
      }
      invalidateAll()
    } finally {
      setBusy(false)
    }
  }

  const [newLabelName, setNewLabelName] = useState('')
  const [newCollectionName, setNewCollectionName] = useState('')

  // Pick a palette colour that isn't already used by another label, so new
  // labels stay visually distinct without needing the user to pick.
  function nextLabelColor(): string {
    const used = new Set(labels.map((l) => l.color))
    const fresh = LABEL_PALETTE.find((c) => !used.has(c))
    return fresh ?? LABEL_PALETTE[labels.length % LABEL_PALETTE.length]
  }

  async function createAndApplyLabel() {
    const name = newLabelName.trim()
    if (!name) return
    setBusy(true)
    try {
      const created = await api.createLabel(name, nextLabelColor())
      const targets = await resolveTargetIds()
      await Promise.all(targets.map((id) => api.assignLabel(id, created.id).catch(() => {})))
      queryClient.invalidateQueries({ queryKey: ['labels'] })
      invalidateAll()
      setNewLabelName('')
    } catch {} finally {
      setBusy(false)
    }
  }

  async function createAndApplyCollection() {
    const name = newCollectionName.trim()
    if (!name) return
    setBusy(true)
    try {
      const created = await api.createCollection(name)
      const targets = await resolveTargetIds()
      await Promise.all(targets.map((id) => api.addToCollection(created.id, id).catch(() => {})))
      queryClient.invalidateQueries({ queryKey: ['collections'] })
      invalidateAll()
      setNewCollectionName('')
    } catch {} finally {
      setBusy(false)
    }
  }

  const [hideDeleteFile, setHideDeleteFile] = useState(false)
  async function bulkHide() {
    setBusy(true)
    try {
      const targets = await resolveTargetIds()
      await Promise.all(targets.map((id) =>
        api.removeComic(id, { ignore: true, deleteFile: hideDeleteFile }).catch(() => {})
      ))
      invalidateAll()
      setOpen(null)
      onClear()
    } finally {
      setBusy(false)
    }
  }

  const hasSelection = selected.length > 0 || selectedCollections.length > 0
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 px-3 pb-safe-3 sm:pb-safe-4 pointer-events-none">
      <div className="max-w-2xl mx-auto bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded-2xl shadow-2xl pointer-events-auto">
        <div className="flex items-center gap-1 px-2 py-2">
          <span className="text-sm font-medium px-2 tabular-nums">
            {hasSelection ? (
              <span className="text-[var(--color-text)]">
                {isCollectionMode
                  ? `${selectedCollections.length} collection${selectedCollections.length === 1 ? '' : 's'}`
                  : `${selected.length} selected`}
              </span>
            ) : (
              <span className="text-[var(--color-text-muted)]">Tap to select</span>
            )}
          </span>
          <div className="flex-1" />
          <ActionButton
            icon={<Tag size={18} />}
            label="Labels"
            active={open === 'labels'}
            disabled={!hasSelection}
            onClick={() => setOpen(open === 'labels' ? null : 'labels')}
          />
          {!isCollectionMode && (
            <ActionButton
              icon={<Bookmark size={18} />}
              label="Collections"
              active={open === 'collections'}
              disabled={!hasSelection}
              onClick={() => setOpen(open === 'collections' ? null : 'collections')}
            />
          )}
          {canHide && (
            <ActionButton
              icon={<Trash2 size={18} />}
              label="Hide"
              active={open === 'hide'}
              danger
              disabled={!hasSelection}
              onClick={() => setOpen(open === 'hide' ? null : 'hide')}
            />
          )}
          <button
            onClick={onClear}
            aria-label="Done"
            title="Done (Esc)"
            className="p-2.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)] transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {open === 'labels' && (
          <div className="border-t border-[var(--color-border)]">
            <CreateRow
              placeholder="Create new label…"
              value={newLabelName}
              onChange={setNewLabelName}
              onSubmit={createAndApplyLabel}
              disabled={busy || !hasSelection}
              icon={<span className="w-3.5 h-3.5 rounded-full shrink-0" style={{ backgroundColor: nextLabelColor() }} />}
            />
            {labels.length === 0 ? null : (
              <div className="p-2 max-h-72 overflow-y-auto border-t border-[var(--color-border)]">
                {labels.map((l) => {
              const n = labelCoverage(l.id)
              const state: 'none' | 'some' | 'all' = n === 0 ? 'none' : n === selected.length ? 'all' : 'some'
              return (
                <button
                  key={l.id}
                  onClick={() => toggleLabel(l.id)}
                  disabled={busy}
                  className="flex w-full items-center gap-2.5 px-3 py-2 rounded text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)] disabled:opacity-50 transition-colors"
                >
                  <span
                    className="w-3.5 h-3.5 rounded-full shrink-0"
                    style={{ backgroundColor: l.color }}
                  />
                  <span className="flex-1 text-left truncate">{l.name}</span>
                  {!isCollectionMode && (
                    <span className="text-xs text-[var(--color-text-muted)] shrink-0 tabular-nums">
                      {state === 'all' && '✓ all'}
                      {state === 'some' && `${n}/${selected.length}`}
                      {state === 'none' && ''}
                    </span>
                  )}
                </button>
              )
            })}
              </div>
            )}
          </div>
        )}

        {open === 'collections' && (
          <div className="border-t border-[var(--color-border)]">
            <CreateRow
              placeholder="Create new collection…"
              value={newCollectionName}
              onChange={setNewCollectionName}
              onSubmit={createAndApplyCollection}
              disabled={busy || !hasSelection}
              icon={<Bookmark size={14} className="text-[var(--color-text-muted)] shrink-0" />}
            />
            {collections.length > 0 && (
              <div className="p-2 max-h-72 overflow-y-auto border-t border-[var(--color-border)]">
                {collections.map((c) => {
                  const n = collectionCoverage(c.id)
                  const state: 'none' | 'some' | 'all' = n === 0 ? 'none' : n === selected.length ? 'all' : 'some'
                  return (
                    <button
                      key={c.id}
                      onClick={() => toggleCollection(c.id)}
                      disabled={busy}
                      className="flex w-full items-center gap-2.5 px-3 py-2 rounded text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)] disabled:opacity-50 transition-colors"
                    >
                      <Bookmark size={14} className="text-[var(--color-text-muted)] shrink-0" />
                      <span className="flex-1 text-left truncate">{c.name}</span>
                      <span className="text-xs text-[var(--color-text-muted)] shrink-0 tabular-nums">
                        {state === 'all' && '✓ all'}
                        {state === 'some' && `${n}/${selected.length}`}
                        {state === 'none' && ''}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {open === 'hide' && (
          <div className="p-3 border-t border-[var(--color-border)] space-y-3">
            <p className="text-sm text-[var(--color-text-muted)] leading-snug">
              {isCollectionMode ? (
                <>
                  Hide every comic in{' '}
                  <span className="text-[var(--color-text)] font-medium">
                    {selectedCollections.length} collection{selectedCollections.length === 1 ? '' : 's'}
                  </span>{' '}
                  from the library. The collections themselves stay; only their comics are added to the ignore list.
                </>
              ) : (
                <>
                  Hide <span className="text-[var(--color-text)] font-medium">{selected.length} comic{selected.length === 1 ? '' : 's'}</span> from the library. They'll be added to the ignore list so future scans skip them.
                </>
              )}
            </p>
            <label className="flex items-start gap-3 cursor-pointer select-none p-2.5 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-surface-overlay)] transition-colors">
              <input
                type="checkbox"
                checked={hideDeleteFile}
                onChange={(e) => setHideDeleteFile(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-red-500 shrink-0"
              />
              <p className="text-sm text-[var(--color-text)] flex items-center gap-1.5">
                {hideDeleteFile && <AlertTriangle size={14} className="text-red-400 shrink-0" />}
                Also delete files from disk
              </p>
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setOpen(null)}
                disabled={busy}
                className="flex-1 rounded-lg border border-[var(--color-border)] py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={bulkHide}
                disabled={busy}
                className={`flex-1 rounded-lg py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${hideDeleteFile ? 'bg-red-600 hover:bg-red-500' : 'bg-[var(--color-accent-strong)] hover:bg-[var(--color-accent-hover)]'}`}
              >
                {busy
                  ? 'Working…'
                  : isCollectionMode
                    ? (hideDeleteFile ? 'Delete contents forever' : 'Hide contents')
                    : (hideDeleteFile ? `Delete ${selected.length} forever` : `Hide ${selected.length}`)}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ActionButton({ icon, label, active, danger, disabled, onClick }: {
  icon: React.ReactNode
  label: string
  active: boolean
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`flex items-center gap-1.5 px-3 py-2.5 rounded-md text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? `${danger ? 'bg-red-500/15 text-red-400' : 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'}`
          : danger
            ? 'text-[var(--color-text-muted)] hover:text-red-400 hover:bg-red-500/10'
            : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)]'
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}

function CreateRow({ placeholder, value, onChange, onSubmit, disabled, icon }: {
  placeholder: string
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  disabled: boolean
  icon: React.ReactNode
}) {
  const canSubmit = !disabled && value.trim().length > 0
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      {icon}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) onSubmit() }}
        placeholder={placeholder}
        disabled={disabled}
        className="flex-1 min-w-0 bg-[var(--color-surface-overlay)] border border-[var(--color-border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] disabled:opacity-50 transition-colors"
      />
      <button
        onClick={onSubmit}
        disabled={!canSubmit}
        aria-label="Create and apply"
        className="shrink-0 p-2 rounded-md bg-[var(--color-accent-strong)] text-white hover:bg-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <Plus size={14} />
      </button>
    </div>
  )
}

function Popover({ children, empty }: { children: React.ReactNode; empty: string }) {
  // children is an array; if it's empty, show the empty message
  const arr = Array.isArray(children) ? children : [children]
  if (arr.length === 0) {
    return (
      <div className="p-3 border-t border-[var(--color-border)]">
        <p className="text-xs text-[var(--color-text-muted)] text-center">{empty}</p>
      </div>
    )
  }
  return (
    <div className="p-2 border-t border-[var(--color-border)] max-h-72 overflow-y-auto">
      {children}
    </div>
  )
}
