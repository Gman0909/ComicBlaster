import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft, ChevronLeft, ChevronRight, Tag, Bookmark, Type, Sun, Moon, Maximize, Minimize, ZoomIn, ZoomOut } from 'lucide-react'
import ePub, { type Book, type Rendition, type Location } from 'epubjs'
import { api } from '../api'
import { FullPageSpinner } from '../components/Spinner'
import { useFullscreen } from '../hooks/useFullscreen'
import { useOffline } from '../hooks/useOffline'
import { useComic } from '../hooks/useComic'

type Theme = 'light' | 'dark' | 'sepia'

const THEMES: Record<Theme, { body: Record<string, string> }> = {
  light: { body: { background: '#fafafa', color: '#222' } },
  dark:  { body: { background: '#000',    color: '#e6e6e6' } },
  sepia: { body: { background: '#f4ecd8', color: '#3c2f1c' } },
}

const FONT_STEPS = [80, 90, 100, 110, 125, 140, 160, 180] // percent

// Zoom levels are a discrete ladder; 1× is fit-to-viewport (the
// default), values above that overflow the iframe and let the user
// scroll within the page. Comic-style ePubs (one image per spine
// item) benefit from zooming in to read small panels; text ePubs
// stay readable at 1× and use the font-size slider instead.
const ZOOM_STEPS = [1, 1.25, 1.5, 2, 3]

export default function ReaderEpub() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const comicId = Number(id)
  // Read-once snapshot of which comics are downloaded for offline
  // reading. Used to decide whether to point epub.js at the local
  // file (`/_offline/<id>`) or the network (`/api/comics/<id>/file`).
  // We don't re-subscribe to updates because the rendition is
  // created in a single useEffect; if the user toggles offline state
  // mid-read, the new state takes effect on next open.
  const { entries: offlineEntries } = useOffline()

  // Shared offline-aware fetch (see hooks/useComic.ts).
  // ReaderDispatch above us calls the same hook with the same id
  // and offlineMode, so this resolves from cache.
  const { data: comic } = useComic(comicId)
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
  // Spine position drives the bottom-bar slider + "Page X / Y" label.
  // Total is set once the sanitised spine is known; current is mirrored
  // into scrubIdx on every relocated event unless the user is mid-drag
  // (userMovedRef latched). Same scrub/commit split as the CBZ reader:
  // dragging the thumb across 100 pages must not trigger 100 displays.
  const [spineTotal, setSpineTotal] = useState(0)
  const [scrubIdx, setScrubIdx]   = useState(0)
  const userMovedRef = useRef(false)
  // Zoom is an index into ZOOM_STEPS. Stored in localStorage so the
  // user's preferred zoom survives across opens of the same comic
  // (and across comics — for now there's no per-comic memory; the
  // user's last zoom level applies everywhere).
  const [zoomIdx, setZoomIdx] = useState(() => {
    const s = localStorage.getItem('cb-epub-zoom-idx')
    return s ? parseInt(s, 10) : 0
  })
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
    // Prefer the locally-stored copy when the comic has been
    // downloaded for offline reading. Same origin so epub.js's
    // XHR happily fetches it, and it works without a server
    // connection — the whole point of the feature.
    const isOffline = offlineEntries.has(comicId)
    const sourceUrl = isOffline ? api.offlineFileUrl(comicId) : api.fileUrl(comicId)
    const book = ePub(sourceUrl, { openAs: 'epub' })
    bookRef.current = book
    const rendition = book.renderTo(containerRef.current, {
      width:  '100%',
      height: '100%',
      // flow:'paginated' with spread:'none' is the most reliable
      // layout we have for image-per-section ePubs. scrolled-doc
      // was tried but ended up collapsing the iframe to 20px tall
      // (height auto-sizes to content, which fights our 100vh
      // image-fit CSS).
      flow:   'paginated',
      spread: 'none',
      allowScriptedContent: false,
    })
    renditionRef.current = rendition

    // Default rules — apply to every iframe regardless of named theme.
    // These fix three of the symptoms reported on the Jeff Hawke
    // comic-style ePub:
    //   - page off-centre → body flex centring
    //   - image doesn't scale → max-width 100vw, max-height 100vh,
    //     object-fit contain
    //   - whole page collapses to a corner → html/body fill the
    //     viewport
    // Text-only ePubs are unaffected: there's no <img> to constrain
    // and flex centring of long-form text doesn't visibly change
    // anything because the column fills the viewport anyway.
    // Default rules — these fix the layout symptoms reported on
    // comic-style ePubs (Jeff Hawke etc., where each spine item is a
    // thin XHTML wrapper around a single <img>):
    //
    //   img: width=100vw + max-height=100vh + object-fit:contain
    //   actively SCALES the image up to fill the viewport (vs.
    //   max-width:100vw which is non-binding when the natural image
    //   is smaller than the viewport, leaving it tiny in a corner).
    //   object-fit:contain preserves aspect ratio — for portrait
    //   pages the height-cap wins; for landscape the width-cap wins.
    //
    //   body: flex centring keeps the letterboxed image in the
    //   middle. height:100vh + overflow:hidden ensures the iframe
    //   doesn't grow scrollbars at 1× zoom even if a stray <p> or
    //   stylesheet rule pushes it just past viewport.
    rendition.themes.default({
      'html': { 'height': '100%', 'margin': '0', 'padding': '0' },
      'body': {
        'margin': '0',
        'padding': '0',
        'height': '100vh',
        'display': 'flex',
        'align-items': 'center',
        'justify-content': 'center',
        'overflow': 'hidden',
      },
      'img': {
        'width': '100vw',
        'max-height': '100vh',
        'height': 'auto',
        'object-fit': 'contain',
        'display': 'block',
        'margin': '0 auto',
      },
    })

    // Register themes and apply current selection + font size
    rendition.themes.register('light', THEMES.light)
    rendition.themes.register('dark',  THEMES.dark)
    rendition.themes.register('sepia', THEMES.sepia)
    rendition.themes.select(theme)
    rendition.themes.fontSize(`${FONT_STEPS[fontIdx]}%`)

    const startCfi = comic.progress?.last_cfi || undefined
    // Sequence: wait for the book's manifest to parse → mark which
    // spine items are reachable → try to display.
    //
    // We DON'T mutate spine.spineItems (filtering it shifts indices
    // and invalidates the cfiBase values already baked into each
    // section — epub.js then can't resolve any CFI back to the
    // right section). Instead:
    //
    //   - Items with no href (idref pointed at a missing manifest
    //     entry) get linear='no' so epub.js's section.next/prev
    //     skip them — they're still in the array, indices intact.
    //   - Items WITH href get linear='yes' explicitly. The EPUB
    //     spec defaults linear to 'yes' when omitted, but
    //     epub.js's strict `linear === "yes"` check treats
    //     undefined as non-linear, breaking ALL chevron / keyboard
    //     navigation on OPFs that simply omit the attribute (which
    //     is most of them in the wild). Forcing it makes nav work.
    ;(async () => {
      try {
        await book.ready
        const spine = book.spine as unknown as {
          spineItems: Array<{ href?: string; idref?: string; index: number; linear?: string }>
        }
        const items = (spine.spineItems ?? []) as Array<{
          href?: string; linear?: string; index: number;
          prev?: () => unknown; next?: () => unknown;
        }>
        let brokenCount = 0
        items.forEach((s) => {
          if (!s.href) {
            s.linear = 'no'  // section.next/prev will skip these
            brokenCount++
          } else if (s.linear !== 'yes') {
            s.linear = 'yes' // EPUB spec default; epub.js requires the exact string
          }
        })
        // Re-bind every section's prev/next closure to traverse the
        // current items array skipping non-linear entries. The
        // original closures were set during spine.unpack(), but ONLY
        // for items whose linear was already 'yes' at that point —
        // for OPFs that omit the linear attribute (most of them), no
        // closures got created at all, so rendition.prev()/next()
        // silently return undefined and the chevrons no-op. This
        // rebuild is the actual fix.
        items.forEach((s, i) => {
          s.prev = () => {
            let p = i
            while (p > 0) {
              const prev = items[p - 1]
              if (prev && prev.linear === 'yes') return prev
              p -= 1
            }
            return undefined
          }
          s.next = () => {
            let p = i
            while (p < items.length - 1) {
              const nxt = items[p + 1]
              if (nxt && nxt.linear === 'yes') return nxt
              p += 1
            }
            return undefined
          }
        })
        if (brokenCount > 0) {
          console.warn(`epub ${comicId}: ${brokenCount} broken spine item(s) marked non-linear`)
        }
        setSpineTotal(items.length)

        // Initial display: prefer the stored CFI, fall back to the
        // first item with a valid href so we don't trigger the
        // archive.request(undefined) crash on a bad spine[0].
        const firstValid = items.find((s) => !!s.href)
        const startTarget = startCfi || firstValid?.href
        try {
          await rendition.display(startTarget)
        } catch (cfiErr) {
          console.warn(`epub ${comicId}: display(${startTarget}) failed`, cfiErr)
          if (firstValid?.href && startTarget !== firstValid.href) {
            await rendition.display(firstValid.href)
          }
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
      // Spine index — drives the slider + "Page X / Y" label.
      // Resolve via book.spine.get(cfi) since loc.start.index isn't
      // exposed on every epub.js build; falls back to (loc.start as
      // any).index if present.
      const cfiIdx = ((): number | null => {
        try {
          const sec = book.spine.get(loc.start.cfi) as { index?: number } | null
          if (sec && typeof sec.index === 'number') return sec.index
        } catch { /* falls through */ }
        const li = (loc as any).start?.index
        return typeof li === 'number' ? li : null
      })()
      if (cfiIdx !== null) {
        // Keep the slider thumb glued to programmatic moves unless the
        // user is actively scrubbing — userMovedRef latches during a
        // drag and clears once the commit completes.
        if (!userMovedRef.current) setScrubIdx(cfiIdx)
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

  // Zoom application. epub.js's `themes.override(selector, decl)` adds
  // a CSS declaration block to the iframe's injected stylesheet; it
  // merges with our default theme rules (the override is appended
  // later, so for shared properties the override wins). Img grows to
  // a multiple of viewport units (so the image actually has a larger
  // bounding box, not a pure visual transform); body is switched out
  // of flex centring when zoomed so overflow scrolling works — flex
  // on a larger-than-viewport child traps you above-left and you
  // can't scroll up past the centre.
  useEffect(() => {
    const r = renditionRef.current
    if (!r) return
    const zoom = ZOOM_STEPS[zoomIdx] ?? 1
    localStorage.setItem('cb-epub-zoom-idx', String(zoomIdx))
    if (zoom === 1) {
      r.themes.override('body', 'display: flex; overflow: hidden; align-items: center; justify-content: center')
      r.themes.override('img',  'width: 100vw; max-height: 100vh; height: auto; object-fit: contain')
    } else {
      // When zoomed past 1×, the image overflows the iframe. Drop
      // flex centring (which traps the user above-left when the
      // child is larger than the parent) and let body scroll
      // naturally. The image's bounding box grows with zoom so
      // panning by scroll works as expected.
      r.themes.override('body', 'display: block; overflow: auto')
      r.themes.override('img',  `width: ${100 * zoom}vw; height: auto; max-height: none; object-fit: contain`)
    }
  }, [zoomIdx])

  // Navigate to a specific spine index — used by chevron prev/next,
  // slider commit, and future direct-jump UI (table of contents).
  //
  // epub.js's rendition.prev()/next() rely on the bound
  // section.prev/section.next closures created during spine.unpack.
  // Those closures only get the linear-navigation chain if the
  // itemref had linear="yes" — many ePubs (including this one) omit
  // the attribute entirely. epub.js then treats those as
  // non-linear, prev/next return undefined, and the chevrons
  // silently no-op. We sidestep the whole mess by jumping directly
  // by spine index using rendition.display(href).
  const goToSpineIdx = useCallback((idx: number) => {
    const r = renditionRef.current
    const b = bookRef.current
    if (!r || !b) return
    const spine = b.spine as unknown as { spineItems: Array<{ href?: string; linear?: string }> }
    const items = spine.spineItems
    // Find the nearest item with a valid href, searching toward the
    // request direction. We snap to the next valid item if the
    // target itself is non-linear (e.g. the broken cover entry the
    // OPF declared but never gave a manifest match).
    let i = Math.max(0, Math.min(items.length - 1, idx))
    const goingForward = idx >= 0
    while (i >= 0 && i < items.length && (!items[i].href || items[i].linear !== 'yes')) {
      i = goingForward ? i + 1 : i - 1
    }
    if (i < 0 || i >= items.length) return
    r.display(items[i].href!).catch(() => {})
  }, [])

  // Mirror the slider commit position into a ref so prev/next can
  // read it without re-binding the callback every render.
  const scrubIdxRef = useRef(0)
  useEffect(() => { scrubIdxRef.current = scrubIdx }, [scrubIdx])

  const next = useCallback(() => goToSpineIdx(scrubIdxRef.current + 1), [goToSpineIdx])
  const prev = useCallback(() => goToSpineIdx(scrubIdxRef.current - 1), [goToSpineIdx])

  // Slider commit. The slider's onChange updates scrubIdx continuously
  // (so the thumb tracks the finger smoothly); we commit to the actual
  // spine position only on release / debounce, so dragging across 100
  // pages doesn't trigger 100 rendition.display() calls.
  const scrubTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const commitScrub = useCallback((idx: number) => {
    if (scrubTimer.current) clearTimeout(scrubTimer.current)
    scrubTimer.current = setTimeout(() => {
      scrubTimer.current = undefined
      userMovedRef.current = false
      goToSpineIdx(idx)
    }, 120)
  }, [goToSpineIdx])
  // Drain the save queue first so the latest position lands on the server
  // before the library refetches. Catches the case where a backward move
  // would otherwise be clobbered by a slower forward save still in flight.
  const goBack = useCallback(async () => {
    if (cfiRef.current) {
      try { await enqueueSave(cfiRef.current) } catch {}
    }
    navigate(-1)
  }, [enqueueSave, navigate])

  // Keyboard — bound at the window level for arrow keys when the
  // user hasn't clicked into the iframe yet, AND on the rendition
  // for the case where they have. epub.js fires 'keydown' on the
  // rendition for any key pressed inside one of its iframes; we
  // forward those through the same handler so the reading shortcuts
  // keep working after the iframe steals focus on click.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); next() }
      if (e.key === 'ArrowLeft'  || e.key === 'PageUp')                    { e.preventDefault(); prev() }
      if (e.key === 'Escape') goBack()
    }
    window.addEventListener('keydown', onKey)
    const r = renditionRef.current
    r?.on('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      r?.off('keydown', onKey)
    }
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
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-white/40 mb-1.5">Zoom</p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setZoomIdx(i => Math.max(0, i - 1))}
                          disabled={zoomIdx === 0}
                          aria-label="Zoom out"
                          className="w-8 h-8 rounded text-white/60 hover:text-white flex items-center justify-center disabled:opacity-30 transition-colors"
                        ><ZoomOut size={14} aria-hidden /></button>
                        <span className="flex-1 text-center text-xs text-white/70 tabular-nums">{(ZOOM_STEPS[zoomIdx] ?? 1).toFixed(2)}×</span>
                        <button
                          onClick={() => setZoomIdx(i => Math.min(ZOOM_STEPS.length - 1, i + 1))}
                          disabled={zoomIdx === ZOOM_STEPS.length - 1}
                          aria-label="Zoom in"
                          className="w-8 h-8 rounded text-white/60 hover:text-white flex items-center justify-center disabled:opacity-30 transition-colors"
                        ><ZoomIn size={14} aria-hidden /></button>
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
            <div className="flex items-center gap-3 max-w-2xl mx-auto pointer-events-auto">
              <button
                onClick={prev}
                aria-label="Previous page"
                title="Previous page"
                className={`p-3 rounded-full ${overlayText} opacity-85 hover:opacity-100 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 transition-opacity`}
              >
                <ChevronLeft size={22} aria-hidden />
              </button>
              {spineTotal > 1 ? (
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, spineTotal - 1)}
                  value={scrubIdx}
                  onChange={(e) => {
                    userMovedRef.current = true
                    const v = parseInt(e.target.value, 10)
                    setScrubIdx(v)
                    commitScrub(v)
                  }}
                  aria-label="Page"
                  aria-valuemin={1}
                  aria-valuemax={spineTotal}
                  aria-valuenow={scrubIdx + 1}
                  className={`flex-1 h-1 rounded-full appearance-none ${isDark ? 'bg-white/15' : 'bg-black/15'} accent-[var(--color-accent)]`}
                />
              ) : (
                <div className={`flex-1 h-0.5 rounded-full ${isDark ? 'bg-white/15' : 'bg-black/15'}`}>
                  <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
                </div>
              )}
              <button
                onClick={next}
                aria-label="Next page"
                title="Next page"
                className={`p-3 rounded-full ${overlayText} opacity-85 hover:opacity-100 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 transition-opacity`}
              >
                <ChevronRight size={22} aria-hidden />
              </button>
              <span className={`${overlayText} opacity-85 text-sm tabular-nums shrink-0 min-w-[5rem] text-right`} aria-live="polite">
                {spineTotal > 0 ? `${scrubIdx + 1} / ${spineTotal}` : `${pct}%`}
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
