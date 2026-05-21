import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { motion } from 'framer-motion'
import { Search, ScanLine, LogOut, Sun, Moon, Settings, Image, ArrowUp, ArrowDown, ArrowUpDown, Bookmark, Trash2, CheckSquare, LayoutGrid, Library as LibraryIcon, Check, Eye, EyeOff, User as UserIcon, Maximize, Minimize } from 'lucide-react'
import { api, type Comic, type Collection, type User } from '../api'
import { useStore } from '../store'
import { useScan } from '../hooks/useScan'
import { useFullscreen } from '../hooks/useFullscreen'
import SetThumbnailModal from '../components/SetThumbnailModal'
import RemoveComicModal from '../components/RemoveComicModal'
import BulkActionBar from '../components/BulkActionBar'

const CARD_ASPECT = 1.54 // typical comic cover ratio (taller than wide)

function useColumns() {
  const [cols, setCols] = useState(4)
  const [width, setWidth] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const obs = useRef<ResizeObserver | undefined>(undefined)

  const measure = useCallback((el: HTMLDivElement | null) => {
    obs.current?.disconnect()
    if (!el) return
    obs.current = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width
      setWidth(w)
      setCols(w < 480 ? 2 : w < 768 ? 3 : w < 1100 ? 4 : w < 1400 ? 5 : 6)
    })
    obs.current.observe(el)
    ref.current = el
  }, [])

  return { cols, width, ref: measure }
}

function ComicCard({ comic, onClick, onSetThumbnail, onRemove, canRemove, selected }: {
  comic: Comic
  onClick: (e: React.MouseEvent) => void
  onSetThumbnail: () => void
  onRemove: () => void
  canRemove: boolean
  selected: boolean
}) {
  const pct = comic.progress && comic.page_count > 0
    ? Math.round((comic.progress.last_page / comic.page_count) * 100)
    : 0

  // The card is structured as a <motion.div> container so its action
  // buttons (set thumbnail, remove) can live as siblings of the main click
  // target. Previously the outer was a <button> with nested action <button>s,
  // which axe flags as nested-interactive (and is invalid HTML — buttons
  // can't contain other buttons). Now the cover + meta live inside the
  // primary button; the action buttons sit above it via z-10.
  return (
    <motion.div
      data-comic-id={comic.id}
      className={`group relative rounded-lg overflow-hidden bg-[var(--color-surface-raised)] transition-shadow ${
        selected
          ? 'ring-2 ring-[var(--color-accent)] shadow-lg'
          : 'hover:ring-2 hover:ring-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent)]'
      }`}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.15 }}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={`Open ${comic.title}`}
        className="block w-full text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        {/* Cover */}
        <div className="relative w-full bg-[var(--color-surface-overlay)]" style={{ aspectRatio: `1 / ${CARD_ASPECT}` }}>
          <img
            src={comic.cover_url}
            alt=""
            loading="lazy"
            className={`absolute inset-0 w-full h-full object-cover transition-all ${pct === 100 ? 'brightness-[0.65] saturate-50' : ''}`}
            onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0' }}
          />
          {/* Format badge for types without cover art */}
          {comic.format === 'pdf' && (
            <div className="absolute inset-0 flex items-center justify-center" aria-hidden>
              <span className="text-[var(--color-text-muted)] text-xs font-bold tracking-widest uppercase opacity-40">PDF</span>
            </div>
          )}
          {pct > 0 && pct < 100 && (
            <div
              className="absolute bottom-0 left-0 right-0 h-1 bg-black/40"
              role="progressbar"
              aria-label={`Read ${pct}%`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <div className="h-full bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
            </div>
          )}
          {pct === 100 && !selected && (
            <>
              <div className="absolute top-2 right-2 flex items-center justify-center w-8 h-8 rounded-full bg-emerald-500 text-white shadow-lg ring-2 ring-emerald-500/30" aria-hidden>
                <Check size={18} strokeWidth={3} />
              </div>
              <div className="absolute bottom-0 left-0 right-0 bg-emerald-600 text-white text-[11px] font-bold uppercase tracking-wider text-center py-1 shadow-md">
                Read
              </div>
            </>
          )}
          {selected && (
            <div className="absolute inset-0 bg-[var(--color-accent)]/25 flex items-start justify-end p-2 pointer-events-none">
              <div className="w-6 h-6 rounded-full bg-[var(--color-accent-strong)] text-white flex items-center justify-center text-sm font-bold shadow-lg" aria-hidden>
                ✓
              </div>
            </div>
          )}
        </div>

        {/* Meta */}
        <div className="p-2 flex flex-col gap-0.5 min-w-0">
          <p className="text-xs font-medium text-[var(--color-text)] truncate leading-tight">{comic.title}</p>
          {comic.series && (
            <p className="text-[11px] text-[var(--color-text-muted)] truncate">{comic.series}</p>
          )}
          {comic.labels.length > 0 && (
            <div
              className="flex gap-1 mt-1 flex-wrap"
              title={comic.labels.map((l) => l.name).join(', ')}
            >
              {comic.labels.slice(0, 3).map((l) => (
                <span
                  key={l.id}
                  className="inline-block w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: l.color }}
                />
              ))}
              {comic.labels.length > 3 && (
                <span className="text-[10px] text-[var(--color-text-muted)] leading-none">+{comic.labels.length - 3}</span>
              )}
            </div>
          )}
        </div>
      </button>

      {/* Action buttons — siblings of the click target so they don't nest
          interactives. z-10 keeps them above the card button visually. */}
      <button
        type="button"
        onClick={onSetThumbnail}
        title="Set thumbnail"
        aria-label={`Set thumbnail for ${comic.title}`}
        className="absolute top-2 left-2 z-10 p-2.5 rounded-md bg-black/70 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-90 hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white transition-all"
      >
        <Image size={14} className={comic.custom_cover ? 'text-[var(--color-accent)]' : ''} aria-hidden />
      </button>
      {canRemove && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove from library"
          aria-label={`Remove ${comic.title} from library`}
          className="absolute top-2 right-2 z-10 p-2.5 rounded-md bg-black/70 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-90 hover:bg-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white transition-all"
        >
          <Trash2 size={14} aria-hidden />
        </button>
      )}
    </motion.div>
  )
}

function ProfileMenu({ user, theme, scanning, isFullscreen, onScan, onToggleTheme, onToggleFullscreen, onSettings, onSignOut }: {
  user: User | null
  theme: 'dark' | 'light'
  scanning: boolean
  isFullscreen: boolean
  onScan: () => void
  onToggleTheme: () => void
  onToggleFullscreen: () => void
  onSettings: () => void
  onSignOut: () => void
}) {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Profile menu"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-2 pl-1.5 pr-2 sm:pr-3 py-1.5 rounded-md transition-colors ${
          open
            ? 'bg-[var(--color-surface-overlay)] text-[var(--color-text)]'
            : 'hover:bg-[var(--color-surface-overlay)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
        }`}
      >
        <span className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--color-surface-overlay)] text-[var(--color-text)]">
          <UserIcon size={14} />
        </span>
        {user && (
          <span className="hidden sm:inline text-xs font-medium max-w-[8rem] truncate">{user.username}</span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={close} aria-hidden />
          <div
            role="menu"
            className="absolute right-0 top-full mt-2 z-40 w-56 rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-border)] shadow-2xl overflow-hidden"
          >
            {user && (
              <div className="px-3 py-2.5 border-b border-[var(--color-border)]">
                <p className="text-sm font-medium text-[var(--color-text)] truncate">{user.username}</p>
                {user.role === 'admin' && (
                  <p className="text-[10px] text-[var(--color-accent)] uppercase tracking-wider font-medium mt-0.5">admin</p>
                )}
              </div>
            )}
            <MenuItem
              icon={<ScanLine size={15} className={scanning ? 'animate-spin' : ''} />}
              label={scanning ? 'Scanning…' : 'Rescan library'}
              disabled={scanning}
              onClick={() => { onScan(); close() }}
            />
            <MenuItem
              icon={theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
              label={theme === 'dark' ? 'Light theme' : 'Dark theme'}
              onClick={() => { onToggleTheme(); close() }}
            />
            <MenuItem
              icon={isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
              label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              onClick={() => { onToggleFullscreen(); close() }}
            />
            <MenuItem
              icon={<Settings size={15} />}
              label="Settings"
              onClick={() => { onSettings(); close() }}
            />
            <div className="border-t border-[var(--color-border)]" />
            <MenuItem
              icon={<LogOut size={15} />}
              label="Sign out"
              danger
              onClick={() => { onSignOut(); close() }}
            />
          </div>
        </>
      )}
    </div>
  )
}

// Mobile-only collapsed sort control. On screens where the inline
// <select> + arrow button steal too much room from the search box, this
// icon button opens a popover with the same sort options + asc/desc
// toggle. Desktop keeps the inline controls — they're discoverable at a
// glance there, and there's no width pressure.
function MobileSortMenu({ sort, order, onSortChange, onOrderChange, inCollection }: {
  sort: string
  order: 'asc' | 'desc'
  onSortChange: (v: string) => void
  onOrderChange: (v: 'asc' | 'desc') => void
  inCollection: boolean
}) {
  const [open, setOpen] = useState(false)
  const options: Array<{ value: string; label: string }> = []
  if (inCollection) options.push({ value: 'position', label: 'Collection order' })
  options.push(
    { value: 'series', label: 'Series' },
    { value: 'title', label: 'Title' },
    { value: 'date_added', label: 'Date added' },
    { value: 'last_read', label: 'Last read' },
  )
  const close = () => setOpen(false)
  return (
    <div className="relative sm:hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Sort"
        aria-label="Sort"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`p-2.5 rounded-md transition-colors ${
          open
            ? 'bg-[var(--color-surface-overlay)] text-[var(--color-text)]'
            : 'hover:bg-[var(--color-surface-overlay)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
        }`}
      >
        <ArrowUpDown size={16} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={close} aria-hidden />
          <div
            role="menu"
            className="absolute right-0 top-full mt-2 z-40 w-56 rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-border)] shadow-2xl overflow-hidden"
          >
            <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
              Sort by
            </div>
            {options.map((opt) => (
              <button
                key={opt.value}
                role="menuitemradio"
                aria-checked={sort === opt.value}
                onClick={() => { onSortChange(opt.value); close() }}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)] transition-colors"
              >
                <span className="flex-1 text-left">{opt.label}</span>
                {sort === opt.value && <Check size={14} className="text-[var(--color-accent)]" />}
              </button>
            ))}
            <div className="border-t border-[var(--color-border)]" />
            <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
              Order
            </div>
            <button
              role="menuitem"
              onClick={() => onOrderChange(order === 'asc' ? 'desc' : 'asc')}
              disabled={sort === 'position'}
              title={sort === 'position' ? 'Collection order is fixed' : undefined}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {order === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
              <span className="flex-1 text-left">{order === 'asc' ? 'Ascending' : 'Descending'}</span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function MenuItem({ icon, label, onClick, danger, disabled }: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-3 px-3 py-2.5 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        danger
          ? 'text-[var(--color-text-muted)] hover:text-red-400 hover:bg-red-500/10'
          : 'text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)]'
      }`}
    >
      <span className="w-5 flex items-center justify-center text-[var(--color-text-muted)]">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
    </button>
  )
}

function CollectionCard({ collection, onClick, unreadOnly, selected }: {
  collection: Collection
  onClick: (e: React.MouseEvent) => void
  unreadOnly: boolean
  selected: boolean
}) {
  const previews = (collection.preview_ids ?? []).slice(0, 4)
  const total = collection.comic_count ?? 0
  const unread = collection.unread_count ?? 0
  return (
    <motion.button
      onClick={onClick}
      className={`group relative flex flex-col text-left rounded-lg overflow-hidden bg-[var(--color-surface-raised)] transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        selected
          ? 'ring-2 ring-[var(--color-accent)] shadow-lg'
          : 'hover:ring-2 hover:ring-[var(--color-accent)]'
      }`}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.15 }}
    >
      <div className="relative w-full bg-[var(--color-surface-overlay)]" style={{ aspectRatio: `1 / ${CARD_ASPECT}` }}>
        {previews.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-[var(--color-text-muted)] opacity-50">
            <Bookmark size={32} />
          </div>
        ) : previews.length === 1 ? (
          <img
            src={`/api/comics/${previews[0]}/cover`}
            alt=""
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0' }}
          />
        ) : (
          <div className={`absolute inset-0 grid gap-0.5 ${previews.length === 2 ? 'grid-cols-2' : 'grid-cols-2 grid-rows-2'}`}>
            {previews.map((id) => (
              <img
                key={id}
                src={`/api/comics/${id}/cover`}
                alt=""
                loading="lazy"
                className="w-full h-full object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0' }}
              />
            ))}
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/80 to-transparent">
          <div className="flex items-end justify-between gap-2">
            <p className="text-sm font-medium text-white truncate flex-1">{collection.name}</p>
            {unreadOnly ? (
              <span className="text-xs text-[var(--color-accent)] tabular-nums shrink-0 font-medium">{unread} new</span>
            ) : (
              <span className="text-xs text-white/70 tabular-nums shrink-0">{total}</span>
            )}
          </div>
        </div>
        {selected && (
          <div className="absolute inset-0 bg-[var(--color-accent)]/25 flex items-start justify-end p-2 pointer-events-none">
            <div className="w-6 h-6 rounded-full bg-[var(--color-accent)] text-white flex items-center justify-center text-sm font-bold shadow-lg">
              ✓
            </div>
          </div>
        )}
      </div>
    </motion.button>
  )
}

export default function Library() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const {
    setUser, theme, toggleTheme, user,
    libraryView, setLibraryView,
    unreadOnly, setUnreadOnly,
    library, setLibrarySearch, setLibrarySort, setLibraryOrder,
    toggleLabelFilter, toggleCollectionFilter, clearLibraryFilters, setLibraryScroll,
    lastOpenedComicId, setLastOpenedComicId,
  } = useStore()
  const isAdmin = user?.role === 'admin'
  const { status: scanStatus, trigger: triggerScan } = useScan(
    () => queryClient.invalidateQueries({ queryKey: ['comics'] })
  )
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen()
  const view = libraryView
  const setView = setLibraryView
  // Library UI state now lives in Zustand so opening a comic and coming
  // back keeps search / sort / filters / scroll exactly as they were.
  const search = library.search
  const setSearch = setLibrarySearch
  const sort = library.sort
  const setSort = setLibrarySort
  const order = library.order
  const setOrder = setLibraryOrder
  const labelFilters = library.labelFilters
  const collectionFilters = library.collectionFilters
  const [thumbnailComic, setThumbnailComic] = useState<Comic | null>(null)
  const [removeComic, setRemoveComic] = useState<Comic | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set())
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<Set<number>>(() => new Set())
  const [selectMode, setSelectMode] = useState(false)
  const anchorRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const { cols, width: gridWidth, ref: containerRef } = useColumns()
  // Estimate the height of a single grid row from the container width so the
  // virtualizer's scrollToIndex math is close to reality. Card width =
  // gridWidth / cols; height = width * CARD_ASPECT + ~60px for the meta
  // strip + gap. A bad estimate compounds as the user scrolls deeper.
  const rowHeight = gridWidth > 0
    ? Math.round((gridWidth / cols) * CARD_ASPECT + 60)
    : 320

  const { data, isLoading } = useQuery({
    queryKey: ['comics', search, sort, order, labelFilters, collectionFilters, unreadOnly],
    queryFn: () => api.comics({
      search,
      sort,
      order,
      per_page: 500,
      ...(labelFilters.length      ? { label_id:      labelFilters.join(',') } : {}),
      ...(collectionFilters.length ? { collection_id: collectionFilters.join(',') } : {}),
      ...(unreadOnly ? { unread: 1 } : {}),
    }),
    staleTime: 0,
  })

  const { data: labels = [] } = useQuery({
    queryKey: ['labels'],
    queryFn: () => api.labels(),
  })

  const { data: collections = [] } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api.collections(),
  })

  // "Inside a collection" UX (sort=position option, etc.) only makes sense
  // when exactly one collection is selected. With multiple, sort=position
  // is ambiguous and we fall back to normal sort options.
  const singleCollectionId = collectionFilters.length === 1 ? collectionFilters[0] : null
  const inCollection = singleCollectionId
    ? collections.find((c) => c.id === singleCollectionId)
    : null

  const [chipQuery, setChipQuery] = useState('')
  const totalChips = labels.length + collections.length
  const chipQueryLower = chipQuery.trim().toLowerCase()
  const visibleLabels = chipQueryLower
    ? labels.filter((l) => l.name.toLowerCase().includes(chipQueryLower))
    : labels
  const visibleCollections = chipQueryLower
    ? collections.filter((c) => c.name.toLowerCase().includes(chipQueryLower))
    : collections

  const comics = data?.comics ?? []
  const rowCount = Math.ceil(comics.length / cols)

  // Click on a card: modifier-aware multi-select. Without a modifier, opens the
  // comic unless a selection is already active (then it toggles, like Finder).
  const handleCardClick = useCallback((comic: Comic, e: React.MouseEvent) => {
    const meta = e.metaKey || e.ctrlKey
    const shift = e.shiftKey
    if (meta) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(comic.id)) next.delete(comic.id)
        else next.add(comic.id)
        return next
      })
      anchorRef.current = comic.id
      return
    }
    if (shift && anchorRef.current !== null) {
      const start = comics.findIndex((c) => c.id === anchorRef.current)
      const end = comics.findIndex((c) => c.id === comic.id)
      if (start === -1 || end === -1) return
      const [lo, hi] = start < end ? [start, end] : [end, start]
      setSelectedIds((prev) => {
        const next = new Set(prev)
        for (let i = lo; i <= hi; i++) next.add(comics[i].id)
        return next
      })
      return
    }
    if (selectedIds.size > 0 || selectMode) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(comic.id)) next.delete(comic.id)
        else next.add(comic.id)
        return next
      })
      anchorRef.current = comic.id
      return
    }
    anchorRef.current = comic.id
    // Mark so we can scroll back to this comic on return from the reader.
    setLastOpenedComicId(comic.id)
    navigate(`/read/${comic.id}`)
  }, [comics, selectedIds.size, selectMode, navigate, setLastOpenedComicId])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setSelectedCollectionIds(new Set())
    setSelectMode(false)
  }, [])

  // Switching views shouldn't carry selection from one mode into the other.
  useEffect(() => {
    setSelectedIds(new Set())
    setSelectedCollectionIds(new Set())
  }, [view])

  const handleCollectionCardClick = useCallback((c: Collection, e: React.MouseEvent) => {
    const meta = e.metaKey || e.ctrlKey
    const shift = e.shiftKey
    if (meta) {
      setSelectedCollectionIds((prev) => {
        const next = new Set(prev)
        if (next.has(c.id)) next.delete(c.id)
        else next.add(c.id)
        return next
      })
      anchorRef.current = c.id
      return
    }
    if (shift && anchorRef.current !== null) {
      const start = collections.findIndex((cc) => cc.id === anchorRef.current)
      const end = collections.findIndex((cc) => cc.id === c.id)
      if (start === -1 || end === -1) return
      const [lo, hi] = start < end ? [start, end] : [end, start]
      setSelectedCollectionIds((prev) => {
        const next = new Set(prev)
        for (let i = lo; i <= hi; i++) next.add(collections[i].id)
        return next
      })
      return
    }
    if (selectedCollectionIds.size > 0 || selectMode) {
      setSelectedCollectionIds((prev) => {
        const next = new Set(prev)
        if (next.has(c.id)) next.delete(c.id)
        else next.add(c.id)
        return next
      })
      anchorRef.current = c.id
      return
    }
    // Drill into the collection: replace any existing collection/label
    // filters with just this one and switch to the library grid view.
    anchorRef.current = c.id
    clearLibraryFilters()
    toggleCollectionFilter(c.id)
    setView('library')
  }, [collections, selectMode, selectedCollectionIds.size, setView, clearLibraryFilters, toggleCollectionFilter])

  // Escape clears selection and exits selection mode
  useEffect(() => {
    if (selectedIds.size === 0 && selectedCollectionIds.size === 0 && !selectMode) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') clearSelection()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds.size, selectedCollectionIds.size, selectMode, clearSelection])

  // 'position' sort only makes sense inside a collection — snap back when leaving
  useEffect(() => {
    if (!inCollection && sort === 'position') setSort('series')
  }, [inCollection, sort, setSort])

  const selectedComics = comics.filter((c) => selectedIds.has(c.id))
  const selectedCollections = collections.filter((c) => selectedCollectionIds.has(c.id))

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 3,
  })

  // Recompute virtualizer positions when the row-height estimate changes
  // (window resize, column count change). Otherwise scrollToIndex on
  // restore would use a stale estimate.
  useEffect(() => {
    virtualizer.measure()
  }, [rowHeight, virtualizer])

  // Save scroll position as the user scrolls. We persist the comic index of
  // the topmost visible card (not a pixel offset) so it survives both
  // virtualizer estimateSize errors and column-count changes between
  // sessions. RAF-throttled to avoid thrashing on momentum scrolling.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const items = virtualizer.getVirtualItems()
        if (items.length === 0) return
        // First virtual item whose bottom is past the viewport top is the
        // topmost visible row.
        const top = el.scrollTop
        const row = items.find((it) => it.end > top) ?? items[0]
        const comicIndex = row.index * cols
        setLibraryScroll(comicIndex)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [virtualizer, cols, setLibraryScroll])

  // Restore scroll position. Two strategies in priority order:
  //
  //   1. If the user just came back from a comic they opened from this
  //      library, scroll to *that* specific comic (centered) — guarantees
  //      it's visible regardless of where the viewport was at click time.
  //   2. Otherwise (cold mount, e.g. arriving from Settings) fall back to
  //      the topmost-visible comic recorded during prior scrolling.
  //
  // CRITICAL: do not run until ResizeObserver has measured the grid
  // container (gridWidth > 0). Before that, `cols` is the default (4) and
  // the rowHeight estimate is a guess (320), so scrollToIndex would land
  // in the wrong row. Both strategies are latched via scrollRestoredRef
  // so subsequent data refetches / re-renders don't re-trigger.
  const scrollRestoredRef = useRef(false)
  useEffect(() => {
    if (scrollRestoredRef.current) return
    if (!data || comics.length === 0) return
    if (gridWidth === 0 || cols <= 0) return

    const maxRow = Math.max(0, Math.ceil(comics.length / cols) - 1)

    function landAtRow(row: number, align: 'start' | 'center') {
      virtualizer.measure()
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          virtualizer.scrollToIndex(row, { align })
          scrollRestoredRef.current = true
        })
      })
    }

    // Targeted restore: the user just opened this specific comic. The
    // virtualizer's estimateSize is never perfectly accurate (covers vary,
    // labels add height, fonts differ across devices), so the most
    // reliable way to land the card inside the viewport is to (a) scroll
    // the virtualizer to the row so the card is rendered into the DOM,
    // then (b) ask the card itself to scrollIntoView({ block: 'center' }).
    // The browser uses the card's actual measured rect, not our estimate.
    if (lastOpenedComicId !== null) {
      const idx = comics.findIndex((c) => c.id === lastOpenedComicId)
      if (idx >= 0) {
        const row = Math.min(Math.floor(idx / cols), maxRow)
        const targetId = lastOpenedComicId
        virtualizer.measure()
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            virtualizer.scrollToIndex(row, { align: 'center' })
            // Give React + the virtualizer one frame to render the row,
            // then locate the card in the DOM and ask the browser to put
            // it dead-center using actual measurements.
            requestAnimationFrame(() => {
              const card = scrollRef.current?.querySelector(
                `[data-comic-id="${targetId}"]`,
              ) as HTMLElement | null
              card?.scrollIntoView({ block: 'center', behavior: 'auto' })
              scrollRestoredRef.current = true
            })
          })
        })
        setLastOpenedComicId(null)
        return
      }
      // Comic no longer in the current filtered set; drop the marker.
      setLastOpenedComicId(null)
    }

    const targetComic = library.scrollComic
    if (targetComic <= 0) {
      scrollRestoredRef.current = true
      return
    }
    landAtRow(Math.min(Math.floor(targetComic / cols), maxRow), 'start')
  }, [data, comics, cols, gridWidth, rowHeight, library.scrollComic, lastOpenedComicId, setLastOpenedComicId, virtualizer])

  async function handleLogout() {
    await api.logout().catch(() => {})
    setUser(null)
    navigate('/login')
  }

  return (
    <div className="flex flex-col h-dvh bg-[var(--color-surface)]">
      {/* Topbar */}
      <header className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface-raised)] shrink-0">
        <h1 className="hidden sm:block text-base font-bold tracking-tight mr-2">
          Comic<span className="text-[var(--color-accent)]">Blaster</span>
        </h1>

        {/* Search */}
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="w-full bg-[var(--color-surface-overlay)] border border-[var(--color-border)] rounded-md pl-8 pr-3 py-1.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] transition-colors"
          />
        </div>

        {/* Sort — hidden in collections view. Inline controls show only on sm+;
            on mobile the same options collapse into MobileSortMenu below to
            keep the search box wide enough to be usable. */}
        <div className={`hidden sm:flex items-center gap-0 shrink-0 ${view === 'collections' ? 'sm:hidden' : ''}`}>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            aria-label="Sort by"
            className="bg-[var(--color-surface-overlay)] border border-[var(--color-border)] rounded-l-md border-r-0 px-2 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] transition-colors"
          >
            {inCollection && <option value="position">Collection order</option>}
            <option value="series">Series</option>
            <option value="title">Title</option>
            <option value="date_added">Date added</option>
            <option value="last_read">Last read</option>
          </select>
          <button
            onClick={() => setOrder(order === 'asc' ? 'desc' : 'asc')}
            disabled={sort === 'position'}
            title={sort === 'position' ? 'Collection order is fixed' : (order === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending')}
            aria-label={`Sort ${order === 'asc' ? 'ascending' : 'descending'}`}
            className="bg-[var(--color-surface-overlay)] border border-[var(--color-border)] rounded-r-md px-2 py-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {order === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
          </button>
        </div>
        {view !== 'collections' && (
          <MobileSortMenu
            sort={sort}
            order={order}
            onSortChange={setSort}
            onOrderChange={setOrder}
            inCollection={!!inCollection}
          />
        )}

        <div className="flex items-center gap-1 ml-auto">
          <button
            onClick={() => setUnreadOnly(!unreadOnly)}
            title={unreadOnly ? 'Showing only unread — click to show all' : 'Show only unread'}
            aria-label="Toggle unread filter"
            aria-pressed={unreadOnly}
            className={`p-2.5 rounded-md transition-colors ${
              unreadOnly
                ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                : 'hover:bg-[var(--color-surface-overlay)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            {unreadOnly ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button
            onClick={() => setView(view === 'library' ? 'collections' : 'library')}
            title={view === 'library' ? 'View collections' : 'View all comics'}
            aria-label={view === 'library' ? 'View collections' : 'View all comics'}
            aria-pressed={view === 'collections'}
            className={`p-2.5 rounded-md transition-colors ${
              view === 'collections'
                ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                : 'hover:bg-[var(--color-surface-overlay)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            {view === 'library' ? <LayoutGrid size={16} /> : <LibraryIcon size={16} />}
          </button>
          <button
            onClick={() => {
              if (selectMode || selectedIds.size > 0 || selectedCollectionIds.size > 0) clearSelection()
              else setSelectMode(true)
            }}
            title={selectMode || selectedIds.size > 0 || selectedCollectionIds.size > 0 ? 'Exit selection' : 'Select multiple'}
            aria-label="Select multiple"
            aria-pressed={selectMode || selectedIds.size > 0 || selectedCollectionIds.size > 0}
            className={`p-2.5 rounded-md transition-colors ${
              selectMode || selectedIds.size > 0 || selectedCollectionIds.size > 0
                ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                : 'hover:bg-[var(--color-surface-overlay)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            <CheckSquare size={16} />
          </button>
          <ProfileMenu
            user={user}
            theme={theme}
            scanning={scanStatus?.running ?? false}
            isFullscreen={isFullscreen}
            onScan={triggerScan}
            onToggleTheme={toggleTheme}
            onToggleFullscreen={toggleFullscreen}
            onSettings={() => navigate('/settings')}
            onSignOut={handleLogout}
          />
        </div>
      </header>

      {/* Filter strip: labels + collections */}
      {view === 'library' && (labels.length > 0 || collections.length > 0) && (
        <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface-raised)]">
          <div className="relative">
            {/* edge fade so users see there's more to scroll */}
            <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-4 bg-gradient-to-r from-[var(--color-surface-raised)] to-transparent z-10" />
            <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-4 bg-gradient-to-l from-[var(--color-surface-raised)] to-transparent z-10" />
            <div className="px-4 py-2 flex gap-2 overflow-x-auto items-center">
              <button
                onClick={clearLibraryFilters}
                className={`shrink-0 px-2.5 py-1 rounded-full text-xs transition-colors ${
                  labelFilters.length === 0 && collectionFilters.length === 0
                    ? 'bg-[var(--color-accent-strong)] text-white'
                    : 'bg-[var(--color-surface-overlay)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                }`}
              >
                All
              </button>
              {totalChips >= 8 && (
                <input
                  type="search"
                  value={chipQuery}
                  onChange={(e) => setChipQuery(e.target.value)}
                  placeholder="Filter…"
                  aria-label="Filter labels and collections"
                  className="shrink-0 w-24 sm:w-32 bg-[var(--color-surface-overlay)] border border-[var(--color-border)] rounded-full px-2.5 py-1 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] transition-colors"
                />
              )}
              {visibleLabels.map((l) => {
                const active = labelFilters.includes(l.id)
                return (
                  <button
                    key={`l-${l.id}`}
                    onClick={() => toggleLabelFilter(l.id)}
                    className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition-colors ${
                      active
                        ? 'text-white'
                        : 'bg-[var(--color-surface-overlay)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                    }`}
                    style={active ? { backgroundColor: l.color } : undefined}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: l.color }}
                    />
                    {l.name}
                  </button>
                )
              })}
              {visibleLabels.length > 0 && visibleCollections.length > 0 && (
                <span className="shrink-0 h-5 w-px bg-[var(--color-border)]" aria-hidden />
              )}
              {visibleCollections.map((c) => {
                const active = collectionFilters.includes(c.id)
                return (
                <button
                  key={`c-${c.id}`}
                  onClick={() => toggleCollectionFilter(c.id)}
                  className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition-colors ${
                    active
                      ? 'bg-[var(--color-accent-strong)] text-white'
                      : 'bg-[var(--color-surface-overlay)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                  }`}
                >
                  <Bookmark size={10} className="shrink-0" aria-hidden />
                  {c.name}
                  <span className="tabular-nums">{c.comic_count ?? 0}</span>
                </button>
                )
              })}
              {chipQuery && visibleLabels.length === 0 && visibleCollections.length === 0 && (
                <span className="shrink-0 text-xs text-[var(--color-text-muted)] italic px-2">no matches</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Scan progress bar */}
      {scanStatus?.running && (
        <div className="shrink-0 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-raised)] space-y-1.5">
          <div className="flex justify-between text-xs text-[var(--color-text-muted)]">
            <span className="truncate">{scanStatus.current || '…'}</span>
            <span className="tabular-nums shrink-0 ml-4">{scanStatus.processed} files</span>
          </div>
          <div className="h-0.5 rounded-full bg-[var(--color-surface-overlay)] overflow-hidden">
            <div className="h-full bg-[var(--color-accent)] animate-[scan-progress_1.5s_ease-in-out_infinite]" style={{ width: '40%' }} />
          </div>
        </div>
      )}

      {/* Grid */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div ref={containerRef} className="px-4 py-4">
          {view === 'collections' && (
            <>
              {collections.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 gap-2 text-[var(--color-text-muted)]">
                  <p className="text-sm">No collections yet. Create some in Settings.</p>
                </div>
              ) : (
                (() => {
                  const visible = unreadOnly
                    ? collections.filter((c) => (c.unread_count ?? 0) > 0)
                    : collections
                  if (visible.length === 0) {
                    return (
                      <div className="flex flex-col items-center justify-center h-64 gap-2 text-[var(--color-text-muted)]">
                        <p className="text-sm">No unread collections.</p>
                      </div>
                    )
                  }
                  return (
                    <div
                      className="grid gap-3 pb-3"
                      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                    >
                      {visible.map((c) => (
                        <CollectionCard
                          key={c.id}
                          collection={c}
                          unreadOnly={unreadOnly}
                          selected={selectedCollectionIds.has(c.id)}
                          onClick={(e) => handleCollectionCardClick(c, e)}
                        />
                      ))}
                    </div>
                  )
                })()
              )}
            </>
          )}
          {view === 'library' && isLoading && (
            <div className="flex items-center justify-center h-64 text-[var(--color-text-muted)] text-sm">
              Loading library…
            </div>
          )}
          {view === 'library' && !isLoading && comics.length === 0 && (
            <div className="flex flex-col items-center justify-center h-64 gap-2 text-[var(--color-text-muted)]">
              <p className="text-sm">{search ? 'No results' : 'No comics found. Add paths in config.yaml and rescan.'}</p>
            </div>
          )}
          {view === 'library' && comics.length > 0 && (
            <div
              style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
            >
              {virtualizer.getVirtualItems().map((vRow) => {
                const rowComics = comics.slice(vRow.index * cols, vRow.index * cols + cols)
                return (
                  <div
                    key={vRow.key}
                    data-index={vRow.index}
                    ref={virtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vRow.start}px)` }}
                  >
                    <div
                      className="grid gap-3 pb-3"
                      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                    >
                      {rowComics.map((comic) => (
                        <ComicCard
                          key={comic.id}
                          comic={comic}
                          onClick={(e) => handleCardClick(comic, e)}
                          onSetThumbnail={() => setThumbnailComic(comic)}
                          onRemove={() => setRemoveComic(comic)}
                          canRemove={isAdmin}
                          selected={selectedIds.has(comic.id)}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Status bar */}
      {view === 'library' && comics.length > 0 && (
        <div className="px-4 py-1.5 border-t border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)] shrink-0">
          {comics.length} comic{comics.length !== 1 ? 's' : ''}
        </div>
      )}
      {view === 'collections' && collections.length > 0 && (
        <div className="px-4 py-1.5 border-t border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)] shrink-0">
          {collections.length} collection{collections.length !== 1 ? 's' : ''}
        </div>
      )}

      {thumbnailComic && (
        <SetThumbnailModal
          comic={thumbnailComic}
          onClose={() => setThumbnailComic(null)}
        />
      )}
      {removeComic && (
        <RemoveComicModal
          comic={removeComic}
          onClose={() => setRemoveComic(null)}
        />
      )}
      {(selectedIds.size > 0 || selectedCollectionIds.size > 0 || selectMode) && (
        <BulkActionBar
          selected={selectedComics}
          selectedCollections={selectedCollections}
          canHide={isAdmin}
          onClear={clearSelection}
        />
      )}
    </div>
  )
}
