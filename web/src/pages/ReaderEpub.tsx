import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft, ChevronLeft, ChevronRight, Tag, Bookmark, Type, Sun, Moon, Maximize, Minimize } from 'lucide-react'
import ePub, { type Book, type Rendition, type Location } from 'epubjs'
import { api } from '../api'
import { FullPageSpinner } from '../components/Spinner'
import { useFullscreen } from '../hooks/useFullscreen'

type Theme = 'light' | 'dark' | 'sepia'

const THEMES: Record<Theme, { body: Record<string, string> }> = {
  light: { body: { background: '#fafafa', color: '#222' } },
  dark:  { body: { background: '#000',    color: '#e6e6e6' } },
  sepia: { body: { background: '#f4ecd8', color: '#3c2f1c' } },
}

const FONT_STEPS = [80, 90, 100, 110, 125, 140, 160, 180] // percent

export default function ReaderEpub() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const comicId = Number(id)

  const { data: comic } = useQuery({
    queryKey: ['comic', comicId],
    queryFn: () => api.comic(comicId),
  })
  const { data: allLabels = [] } = useQuery({
    queryKey: ['labels'],
    queryFn: () => api.labels(),
  })
  const { data: allCollections = [] } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api.collections(),
  })

  const containerRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<Book | null>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const cfiRef = useRef<string>('')
  const readyRef = useRef(false)
  // ePub has no native concept of "page count" — store rounded percentage
  // (0-100) in last_page so the existing library bar formula
  // (last_page / page_count * 100) yields a percentage display. pctRef is
  // updated by the relocated handler and read by every save/beacon.
  const pctRef = useRef(0)

  const [controlsVisible, setControlsVisible] = useState(true)
  const [pct, setPct] = useState(0)
  // Surfaced when epub.js fails to render the file (malformed spine,
  // unreadable archive, etc.). Without this the user just sees a
  // black screen because epub.js's crash happens inside a
  // requestAnimationFrame callback that bypasses the display()
  // promise rejection path.
  const [renderError, setRenderError] = useState<string | null>(null)
  const [fontIdx, setFontIdx] = useState(() => {
    const stored = localStorage.getItem('cb-epub-font-idx')
    return stored ? parseInt(stored, 10) : 2 // 100%
  })
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('cb-epub-theme')
    return (stored as Theme) ?? 'dark'
  })
  const [labelsOpen, setLabelsOpen] = useState(false)
  const [collectionsOpen, setCollectionsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen()
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const labelIDs = new Set((comic?.labels ?? []).map((l) => l.id))
  const collectionIDs = new Set((comic?.collections ?? []).map((c) => c.id))

  // Single-flight CFI save queue. Same reason as the page-based reader:
  // overlapping in-flight saves could otherwise land out of order on the
  // server and overwrite a more recent position with an older one.
  const saveQueueRef = useRef<{
    runner: Promise<void> | null
    pending: string | null
    lastSaved: string | null
  }>({ runner: null, pending: null, lastSaved: null })

  const enqueueSave = useCallback((cfi: string) => {
    const q = saveQueueRef.current
    q.pending = cfi
    if (q.runner) return q.runner
    q.runner = (async () => {
      while (q.pending !== null && q.pending !== q.lastSaved) {
        const next = q.pending
        q.pending = null
        try {
          // last_page doubles as percentage for ePub (see pctRef comment).
          await api.saveProgress(comicId, pctRef.current, next)
          q.lastSaved = next
        } catch {}
      }
      q.runner = null
    })()
    return q.runner
  }, [comicId])

  // Mount the epub.js rendition once
  useEffect(() => {
    if (!comic || !containerRef.current) return
    const book = ePub(api.fileUrl(comicId), { openAs: 'epub' })
    bookRef.current = book
    const rendition = book.renderTo(containerRef.current, {
      width:  '100%',
      height: '100%',
      flow:   'paginated',
      allowScriptedContent: false,
    })
    renditionRef.current = rendition

    // Register themes and apply current selection + font size
    rendition.themes.register('light', THEMES.light)
    rendition.themes.register('dark',  THEMES.dark)
    rendition.themes.register('sepia', THEMES.sepia)
    rendition.themes.select(theme)
    rendition.themes.fontSize(`${FONT_STEPS[fontIdx]}%`)

    const startCfi = comic.progress?.last_cfi || undefined
    // Sequence: wait for the book's manifest to parse → sanitise the
    // spine → try to display.
    //
    // The sanitisation step is defensive. Some ePubs declare spine
    // itemrefs whose idref has no matching manifest item — the
    // classic example is `<itemref idref="cover"/>` with no
    // `<item id="cover"/>`. When epub.js tries to render those it
    // crashes in archive.request via `new Path(undefined).indexOf("://"`)
    // and because the throw fires inside a requestAnimationFrame
    // callback the display() promise never rejects — the iframe
    // never gets injected and the user sees a black void. Stripping
    // the broken items before display() bypasses the crash; remaining
    // valid spine entries render normally.
    ;(async () => {
      try {
        await book.ready
        // epub.js's Book['spine'] type doesn't expose spineItems
        // publicly; cast through unknown so TS doesn't complain about
        // the field we're rewriting.
        const spine = book.spine as unknown as {
          spineItems: Array<{ href?: string; idref?: string; index: number }>
          spineByHref: Record<string, number>
          spineById: Record<string, number>
          length: number
        }
        const items = spine.spineItems
        const brokenCount = items?.filter((s) => !s.href).length ?? 0
        if (brokenCount > 0) {
          const cleaned = items.filter((s) => !!s.href)
          cleaned.forEach((s, i) => { s.index = i })
          spine.spineItems = cleaned
          spine.length = cleaned.length
          // Rebuild the href/id → index lookup maps so spine.get()
          // still resolves by all the keys epub.js supports.
          const byHref: Record<string, number> = {}
          const byId: Record<string, number> = {}
          cleaned.forEach((s, i) => {
            if (s.href) {
              byHref[s.href] = i
              byHref[encodeURI(s.href)] = i
              try { byHref[decodeURI(s.href)] = i } catch { /* malformed URI */ }
            }
            if (s.idref) byId[s.idref] = i
          })
          spine.spineByHref = byHref
          spine.spineById = byId
          console.warn(`epub ${comicId}: skipped ${brokenCount} broken spine item(s) with no manifest href`)
        }

        // Display with a CFI fallback — if the stored CFI pointed at a
        // now-removed spine slot (or was never valid), retry from the
        // start so the reader at least opens.
        try {
          await rendition.display(startCfi)
        } catch (cfiErr) {
          console.warn(`epub ${comicId}: display(${startCfi}) failed, retrying from start`, cfiErr)
          await rendition.display()
        }
        readyRef.current = true
      } catch (err) {
        console.error(`epub ${comicId}: render failed`, err)
        setRenderError((err as Error)?.message ?? String(err))
      }
    })()

    rendition.on('relocated', (loc: Location) => {
      cfiRef.current = loc.start.cfi
      // location.start.percentage is 0..1; round to 0-100 and stash in pctRef
      // so saves can carry it through to the server.
      const p = (loc as any).start?.percentage
      if (typeof p === 'number') {
        const rounded = Math.max(0, Math.min(100, Math.round(p * 100)))
        pctRef.current = rounded
        setPct(rounded)
      }
      // Persist after the first restore completes
      if (readyRef.current) {
        enqueueSave(loc.start.cfi)
      }
    })

    // Tell the server this ePub has 100 "pages" — the synthetic denominator
    // that lets last_page (= percentage) render as a library bar via the
    // existing pct = last_page/page_count formula. Fires once per mount;
    // server no-ops when page_count is already 100.
    if (comic.format === 'epub' && comic.page_count !== 100) {
      api.setPageCount(comicId, 100)
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ['comic', comicId] })
          queryClient.invalidateQueries({ queryKey: ['comics'] })
        })
        .catch(() => {})
    }

    return () => {
      // Final save on unmount (SPA back, modal exit, route change). The seq
      // here is fresher than anything the queue's in-flight save can carry,
      // so the server's seq-gated upsert guarantees this write wins.
      if (readyRef.current && cfiRef.current) {
        const body = JSON.stringify({
          last_page: pctRef.current,
          last_cfi: cfiRef.current,
          seq: Date.now(),
        })
        navigator.sendBeacon(
          `/api/comics/${comicId}/progress`,
          new Blob([body], { type: 'application/json' }),
        )
      }
      rendition.destroy()
      book.destroy()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comic?.id])

  // Apply theme + font size changes without recreating the rendition
  useEffect(() => {
    renditionRef.current?.themes.select(theme)
    localStorage.setItem('cb-epub-theme', theme)
  }, [theme])
  useEffect(() => {
    renditionRef.current?.themes.fontSize(`${FONT_STEPS[fontIdx]}%`)
    localStorage.setItem('cb-epub-font-idx', String(fontIdx))
  }, [fontIdx])

  const next   = useCallback(() => renditionRef.current?.next(), [])
  const prev   = useCallback(() => renditionRef.current?.prev(), [])
  // Drain the save queue first so the latest position lands on the server
  // before the library refetches. Catches the case where a backward move
  // would otherwise be clobbered by a slower forward save still in flight.
  const goBack = useCallback(async () => {
    if (cfiRef.current) {
      try { await enqueueSave(cfiRef.current) } catch {}
    }
    navigate(-1)
  }, [enqueueSave, navigate])

  // Keyboard
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); next() }
      if (e.key === 'ArrowLeft'  || e.key === 'PageUp')                    { e.preventDefault(); prev() }
      if (e.key === 'Escape') goBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, prev, goBack])

  // Auto-hide controls
  const showControls = useCallback(() => {
    setControlsVisible(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setControlsVisible(false), 6000)
  }, [])
  useEffect(() => {
    showControls()
    return () => clearTimeout(hideTimer.current)
  }, [showControls])

  async function toggleLabel(labelId: number) {
    if (!comic) return
    const has = labelIDs.has(labelId)
    try {
      if (has) await api.unassignLabel(comic.id, labelId)
      else await api.assignLabel(comic.id, labelId)
    } catch {}
    queryClient.invalidateQueries({ queryKey: ['comic', comic.id] })
    queryClient.invalidateQueries({ queryKey: ['comics'] })
  }
  async function toggleCollection(collectionId: number) {
    if (!comic) return
    const has = collectionIDs.has(collectionId)
    try {
      if (has) await api.removeFromCollection(collectionId, comic.id)
      else await api.addToCollection(collectionId, comic.id)
    } catch {}
    queryClient.invalidateQueries({ queryKey: ['comic', comic.id] })
    queryClient.invalidateQueries({ queryKey: ['comics'] })
    queryClient.invalidateQueries({ queryKey: ['collections'] })
  }

  if (!comic) return <FullPageSpinner />

  const isDark = theme === 'dark'
  const overlayBg = isDark ? 'from-black/80' : 'from-white/90'
  const overlayText = isDark ? 'text-white' : 'text-zinc-900'

  return (
    <div
      className="min-h-dvh flex flex-col select-none overflow-hidden"
      style={{ backgroundColor: THEMES[theme].body.background }}
      onPointerMove={showControls}
    >
      {/* Top bar */}
      <AnimatePresence>
        {controlsVisible && (
          <motion.div
            initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className={`fixed top-0 left-0 right-0 z-20 flex items-center gap-3 sm:gap-4 px-4 sm:px-5 py-4 bg-gradient-to-b ${overlayBg} to-transparent pointer-events-none`}
          >
            <button
              onClick={goBack}
              className={`flex items-center gap-2 ${overlayText} hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 rounded-md px-1 py-1 transition-opacity text-base font-medium pointer-events-auto`}
            >
              <ArrowLeft size={22} aria-hidden /> Back
            </button>
            <span className={`${overlayText} opacity-85 text-base font-medium truncate flex-1`}>{comic.title}</span>

            {/* Labels */}
            <div className="relative pointer-events-auto">
              <button
                onClick={() => { setLabelsOpen(o => !o); setCollectionsOpen(false); setSettingsOpen(false) }}
                title="Assign labels"
                aria-label="Assign labels"
                className={`p-3 rounded-full transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${labelIDs.size > 0 ? 'text-[var(--color-accent)]' : `${overlayText} opacity-85 hover:opacity-100`} hover:bg-white/15`}
              >
                <Tag size={22} aria-hidden />
              </button>
              {labelsOpen && <PopoverList
                items={allLabels.map(l => ({ id: l.id, name: l.name, color: l.color, on: labelIDs.has(l.id) }))}
                empty="No labels yet. Create some in Settings."
                onToggle={toggleLabel}
                onClose={() => setLabelsOpen(false)}
              />}
            </div>

            {/* Collections */}
            <div className="relative pointer-events-auto">
              <button
                onClick={() => { setCollectionsOpen(o => !o); setLabelsOpen(false); setSettingsOpen(false) }}
                title="Add to collection"
                aria-label="Add to collection"
                className={`p-3 rounded-full transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${collectionIDs.size > 0 ? 'text-[var(--color-accent)]' : `${overlayText} opacity-85 hover:opacity-100`} hover:bg-white/15`}
              >
                <Bookmark size={22} aria-hidden />
              </button>
              {collectionsOpen && <PopoverList
                items={allCollections.map(c => ({ id: c.id, name: c.name, on: collectionIDs.has(c.id) }))}
                empty="No collections yet. Create some in Settings."
                onToggle={toggleCollection}
                onClose={() => setCollectionsOpen(false)}
              />}
            </div>

            {/* Theme + font */}
            <div className="relative pointer-events-auto">
              <button
                onClick={() => { setSettingsOpen(o => !o); setLabelsOpen(false); setCollectionsOpen(false) }}
                title="Reading settings"
                aria-label="Reading settings"
                className={`p-3 rounded-full transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${overlayText} opacity-85 hover:opacity-100 hover:bg-white/15`}
              >
                <Type size={22} aria-hidden />
              </button>
              {settingsOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setSettingsOpen(false)} />
                  <div className="absolute right-0 top-full mt-2 z-30 w-56 rounded-lg bg-zinc-900/95 backdrop-blur-sm border border-white/10 shadow-2xl p-3 space-y-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-white/40 mb-1.5">Theme</p>
                      <div className="grid grid-cols-3 gap-1">
                        {(['light','sepia','dark'] as Theme[]).map(t => (
                          <button
                            key={t}
                            onClick={() => setTheme(t)}
                            className={`py-1.5 rounded text-xs font-medium transition-colors ${theme === t ? 'bg-white/15 text-white' : 'text-white/60 hover:bg-white/5'}`}
                            style={{ backgroundColor: theme === t ? THEMES[t].body.background : undefined, color: theme === t ? THEMES[t].body.color : undefined }}
                          >
                            {t === 'light' ? <Sun size={14} className="mx-auto" /> : t === 'dark' ? <Moon size={14} className="mx-auto" /> : 'Aa'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-white/40 mb-1.5">Font size</p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setFontIdx(i => Math.max(0, i - 1))}
                          disabled={fontIdx === 0}
                          className="w-8 h-8 rounded text-white/60 hover:text-white text-base font-medium disabled:opacity-30 transition-colors"
                        >A−</button>
                        <span className="flex-1 text-center text-xs text-white/70 tabular-nums">{FONT_STEPS[fontIdx]}%</span>
                        <button
                          onClick={() => setFontIdx(i => Math.min(FONT_STEPS.length - 1, i + 1))}
                          disabled={fontIdx === FONT_STEPS.length - 1}
                          className="w-8 h-8 rounded text-white/60 hover:text-white text-lg font-medium disabled:opacity-30 transition-colors"
                        >A+</button>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Fullscreen */}
            <button
              onClick={toggleFullscreen}
              title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              className={`p-3 rounded-full transition-opacity pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${overlayText} opacity-85 hover:opacity-100 hover:bg-white/15`}
            >
              {isFullscreen ? <Minimize size={22} aria-hidden /> : <Maximize size={22} aria-hidden />}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Book container with side tap zones */}
      <div className="flex-1 relative">
        <div ref={containerRef} className="absolute inset-0" />
        {renderError && (
          <div
            role="alert"
            className="absolute inset-0 z-30 flex items-center justify-center p-6 pointer-events-auto"
            style={{ backgroundColor: THEMES[theme].body.background }}
          >
            <div className="max-w-md text-center space-y-3">
              <p className={`text-base font-semibold ${overlayText}`}>This ePub can&apos;t be opened.</p>
              <p className={`text-sm ${overlayText} opacity-70 break-words`}>
                {renderError}
              </p>
              <p className={`text-xs ${overlayText} opacity-50`}>
                The file is likely malformed (spine references missing manifest items, broken archive, etc.). Try rebuilding it with Calibre or Sigil.
              </p>
              <button
                onClick={goBack}
                className={`mt-2 px-4 py-2 rounded-lg text-sm font-medium border border-white/15 ${overlayText} opacity-85 hover:opacity-100 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 transition-opacity`}
              >
                Back to library
              </button>
            </div>
          </div>
        )}
        {/* Tap zones — left = prev, right = next, middle = toggle controls */}
        <div
          className="absolute inset-y-0 left-0 w-1/5 z-10 cursor-w-resize"
          onClick={prev}
          aria-label="Previous page"
        />
        <div
          className="absolute inset-y-0 right-0 w-1/5 z-10 cursor-e-resize"
          onClick={next}
          aria-label="Next page"
        />
        <div
          className="absolute inset-y-0 left-1/5 right-1/5 z-10"
          onClick={showControls}
        />
      </div>

      {/* Bottom bar */}
      <AnimatePresence>
        {controlsVisible && (
          <motion.div
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
            className={`fixed bottom-0 left-0 right-0 z-20 px-4 pt-3 pb-safe-3 bg-gradient-to-t ${overlayBg} to-transparent pointer-events-none`}
          >
            <div className="flex items-center gap-3 max-w-lg mx-auto pointer-events-auto">
              <button
                onClick={prev}
                aria-label="Previous page"
                title="Previous page"
                className={`p-3 rounded-full ${overlayText} opacity-85 hover:opacity-100 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 transition-opacity`}
              >
                <ChevronLeft size={22} aria-hidden />
              </button>
              <div
                className={`flex-1 h-0.5 rounded-full ${isDark ? 'bg-white/15' : 'bg-black/15'}`}
                role="progressbar"
                aria-label="Reading progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
              >
                <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
              </div>
              <button
                onClick={next}
                aria-label="Next page"
                title="Next page"
                className={`p-3 rounded-full ${overlayText} opacity-85 hover:opacity-100 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 transition-opacity`}
              >
                <ChevronRight size={22} aria-hidden />
              </button>
              <span className={`${overlayText} opacity-85 text-sm tabular-nums w-10 text-right shrink-0`} aria-live="polite">
                {pct}%
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// Reusable popover list for labels and collections in the reader top bar.
function PopoverList<T extends { id: number; name: string; color?: string; on: boolean }>({
  items, empty, onToggle, onClose,
}: {
  items: T[]
  empty: string
  onToggle: (id: number) => void
  onClose: () => void
}) {
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} />
      <div className="absolute right-0 top-full mt-2 z-30 w-56 rounded-lg bg-zinc-900/95 backdrop-blur-sm border border-white/10 shadow-2xl p-2 max-h-80 overflow-y-auto">
        {items.length === 0 ? (
          <p className="text-xs text-white/40 px-2 py-3 text-center">{empty}</p>
        ) : items.map((it) => (
          <button
            key={it.id}
            onClick={() => onToggle(it.id)}
            className="flex w-full items-center gap-2 px-2 py-1.5 rounded text-xs text-white/80 hover:bg-white/10 transition-colors"
          >
            {it.color
              ? <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: it.color }} />
              : <Bookmark size={12} className="shrink-0 text-white/50" />
            }
            <span className="flex-1 text-left truncate">{it.name}</span>
            {it.on && <span className="text-[var(--color-accent)] text-base leading-none">✓</span>}
          </button>
        ))}
      </div>
    </>
  )
}
