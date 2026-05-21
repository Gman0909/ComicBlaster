import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { TransformWrapper, TransformComponent, useControls, useTransformEffect } from 'react-zoom-pan-pinch'
import { ArrowLeft, ChevronLeft, ChevronRight, Image, Tag, Bookmark, Maximize, Minimize } from 'lucide-react'
import { api } from '../api'
import SetThumbnailModal from '../components/SetThumbnailModal'
import { FullPageSpinner } from '../components/Spinner'
import { useFullscreen } from '../hooks/useFullscreen'

// Resets the zoom/pan transform whenever the page changes — instead of
// remounting the entire TransformWrapper (which throws away the canvas /
// img element and flashes a blank frame), we keep the wrapper alive and
// snap its transform back to identity on each new page.
//
// IMPORTANT: useControls() returns a fresh object on every render, so its
// resetTransform reference changes every time. Listing it as an effect
// dependency would fire resetTransform(0) on every parent re-render —
// including the re-render triggered by pinch-zoom updating `zoomed` state,
// which would wipe out the user's pinch the moment the touch ended. Instead
// we keep resetTransform in a ref (updated each render) and only fire when
// the page number actually changes.
function PageResetOnChange({ page }: { page: number }) {
  const { resetTransform } = useControls()
  const resetRef = useRef(resetTransform)
  resetRef.current = resetTransform
  useEffect(() => {
    resetRef.current(0)
  }, [page])
  return null
}

// Intercepts wheel events on the container.
//   - Vertical wheel  → zoom centered on the viewport (when at fit-to-screen
//     a downward scroll zooms out is a no-op since minScale=1, so this only
//     meaningfully zooms in/out when already past 1×).
//   - Horizontal wheel (trackpad swipe / mouse with tilt) → page nav, with an
//     accumulator + short cooldown so a single fling doesn't blow through
//     a dozen pages.
// Also exposes the current scale to the parent (ref for swipe handlers, state
// callback for prop-driven config like locking the Y axis at scale=1).
function WheelZoomCapture({ containerRef, scaleRef, onZoomChange, onPageDelta }: {
  containerRef: React.RefObject<HTMLDivElement | null>
  scaleRef: React.RefObject<number>
  onZoomChange: (zoomed: boolean) => void
  onPageDelta: (dir: 1 | -1) => void
}) {
  const { zoomIn, zoomOut } = useControls()
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let accumX = 0
    let lastPaged = 0
    const PAGE_THRESHOLD = 80
    const COOLDOWN_MS = 250

    const handler = (e: WheelEvent) => {
      const dx = e.deltaX
      const dy = e.deltaY
      // Horizontal wheel input outweighs vertical → treat as pagination,
      // but only when not zoomed (zoomed view uses pan for navigation).
      if (Math.abs(dx) > Math.abs(dy) && scaleRef.current <= 1.01) {
        e.preventDefault()
        const now = performance.now()
        if (now - lastPaged < COOLDOWN_MS) return
        accumX += dx
        if (Math.abs(accumX) >= PAGE_THRESHOLD) {
          lastPaged = now
          onPageDelta(accumX > 0 ? 1 : -1)
          accumX = 0
        }
        return
      }
      // Otherwise: vertical → zoom toward viewport center.
      e.preventDefault()
      accumX = 0
      dy < 0 ? zoomIn(0.15, 80) : zoomOut(0.15, 80)
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [zoomIn, zoomOut, onPageDelta])
  useTransformEffect(({ state }) => {
    scaleRef.current = state.scale
    onZoomChange(state.scale > 1.01)
  })
  return null
}

const PDFPage = lazy(() => import('../components/PDFPage'))

export default function Reader() {
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

  const [labelsOpen, setLabelsOpen] = useState(false)
  const [collectionsOpen, setCollectionsOpen] = useState(false)
  const labelIDs = new Set((comic?.labels ?? []).map((l) => l.id))
  const collectionIDs = new Set((comic?.collections ?? []).map((c) => c.id))

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

  const [page, setPage] = useState(1)
  const [pdfPageCount, setPdfPageCount] = useState(0)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [zoomed, setZoomed] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const scaleRef = useRef(1)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pointerStart = useRef<{ x: number; y: number } | null>(null)
  const pageRef = useRef(page)
  // True once the saved progress has been applied, so we don't overwrite it on initial render
  const readyRef = useRef(false)
  const serverCount = comic?.page_count ?? 0
  const totalPages = (comic?.format === 'pdf' && pdfPageCount > serverCount)
    ? pdfPageCount
    : serverCount

  // Restore saved progress.
  //
  // It used to depend on [comic] and run again on EVERY React Query
  // refetch, which clobbered the user's slider/keyboard navigation back
  // to the server-side last_page whenever a refetch landed mid-read. The
  // user's backward change then got overwritten by a save with a higher
  // seq triggered by the bounce — backward changes appeared to "not
  // register" until manually retried.
  //
  // We can't simply latch after the first restore either: React Query
  // serves cached data (potentially stale from before the previous save)
  // immediately, then refetches in the background. We want the fresh
  // refetch to win on a cold mount — but only if the user hasn't taken
  // over yet. So the latch is gated on user input via userMovedRef, set
  // by goTo() on every slider / chevron / keyboard / gesture action.
  const userMovedRef = useRef(false)
  useEffect(() => {
    if (userMovedRef.current) return
    if (!comic) return
    if (comic.progress?.last_page && comic.progress.last_page > 1) {
      // PDFs report page_count=0 because pdf.js owns the count — only clamp
      // when we actually know the upper bound.
      const target = comic.page_count > 0
        ? Math.min(comic.progress.last_page, comic.page_count)
        : comic.progress.last_page
      pageRef.current = target // keep ref in lockstep for goBack/beacon
      setPage(target)
    }
    readyRef.current = true
  }, [comic])

  // Keep ref in sync so goBack / beforeunload always see the latest page
  useEffect(() => { pageRef.current = page }, [page])

  // Single-flight save queue.
  //
  // Previously each page change fired an independent fetch; with rapid paging
  // (or just preload-warmed pages flipping fast) several saves could be in
  // flight at once, and Go's handler goroutines could resolve them in any
  // order. That made backward moves "lose" — a stale forward save would
  // land last and overwrite the user's true position on the server.
  //
  // The fix is to keep at most one save in flight at a time. While one is
  // running, newer page values overwrite a single `pending` slot. When the
  // running save completes, the pending value (if any) is sent next. Net
  // effect: server is always updated in user-time order, with the latest
  // value as the final write.
  const saveQueueRef = useRef<{
    runner: Promise<void> | null
    pending: number | null
    lastSaved: number | null
  }>({ runner: null, pending: null, lastSaved: null })

  const enqueueSave = useCallback((target: number) => {
    const q = saveQueueRef.current
    q.pending = target
    if (q.runner) return q.runner
    q.runner = (async () => {
      while (q.pending !== null && q.pending !== q.lastSaved) {
        const next = q.pending
        q.pending = null
        try {
          await api.saveProgress(comicId, next)
          q.lastSaved = next
        } catch {
          // Network glitch — leave lastSaved alone so the next change retries.
        }
      }
      q.runner = null
    })()
    return q.runner
  }, [comicId])

  // Page changes feed the queue — every change, including landing back on
  // page 1, so the saved position always matches the user's current view.
  useEffect(() => {
    if (!readyRef.current || page < 1) return
    enqueueSave(page)
  }, [page, enqueueSave])

  // Preload neighbouring pages so the next flip is served from the browser
  // cache instead of waiting on the network. Two pages ahead, one behind —
  // weighted forward since most readers move that direction.
  useEffect(() => {
    if (!comic || comic.format === 'pdf' || comic.format === 'epub') return
    if (totalPages <= 1) return
    const width = window.innerWidth
    const targets = [page + 1, page + 2, page - 1].filter(
      (n) => n >= 1 && n <= totalPages && n !== page,
    )
    const imgs: HTMLImageElement[] = []
    for (const n of targets) {
      // window.Image — disambiguated from the lucide `Image` icon imported above.
      const img = new window.Image()
      img.decoding = 'async'
      img.src = api.pageUrl(comicId, n, width)
      imgs.push(img)
    }
    return () => {
      // Cancel in-flight preloads by clearing the src; the browser keeps
      // anything already downloaded in cache.
      for (const img of imgs) img.src = ''
    }
  }, [comicId, page, totalPages, comic?.format])

  // Final-save safety net.
  //
  // beforeunload covers the tab-close / hard-reload case. The cleanup return
  // covers the SPA case — browser back, route change, anything that unmounts
  // the Reader without going through goBack. Both paths fire sendBeacon with
  // a current seq so this write reliably beats any queue save still in
  // flight (server only accepts writes with a higher seq).
  useEffect(() => {
    const send = () => {
      // Skip only if we never learned a page (PDF that never loaded a count
      // would have pageRef.current=1 by default — still worth recording).
      if (pageRef.current < 1) return
      const body = JSON.stringify({
        last_page: pageRef.current,
        last_cfi: '',
        seq: Date.now(),
      })
      navigator.sendBeacon(
        `/api/comics/${comicId}/progress`,
        new Blob([body], { type: 'application/json' }),
      )
    }
    window.addEventListener('beforeunload', send)
    return () => {
      window.removeEventListener('beforeunload', send)
      // Unmount = SPA navigation (browser back, in-app nav, etc.). Fire a
      // final beacon so the library always refetches against the user's
      // latest position even if it crossed a backward move.
      send()
    }
  }, [comicId])

  // Await the save before navigating so the library always loads after the
  // write — and crucially, await the *queue draining*, not just one fetch,
  // so any in-flight save can't land after we leave the page.
  const goBack = useCallback(async () => {
    try {
      await enqueueSave(pageRef.current)
    } catch {}
    navigate(-1)
  }, [enqueueSave, navigate])

  const [thumbnailOpen, setThumbnailOpen] = useState(false)
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen()

  const goTo = useCallback((n: number) => {
    const next = Math.max(1, Math.min(n, totalPages))
    // Update the ref synchronously so goBack / beforeunload see the new
    // page even if invoked in the same task tick (before React flushes
    // the setState and the [page] useEffect updates the ref).
    pageRef.current = next
    // Mark that the user has navigated — restore effect now stops
    // overwriting their position on subsequent React Query refetches.
    userMovedRef.current = true
    setPage((prev) => (next !== prev ? next : prev))
  }, [totalPages])

  // Keyboard
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); goTo(page + 1) }
      if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')                     { e.preventDefault(); goTo(page - 1) }
      if (e.key === 'Escape') goBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [page, goTo, goBack])

  // Auto-hide controls
  const showControls = useCallback(() => {
    setControlsVisible(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setControlsVisible(false), 6000)
  }, [])

  useEffect(() => {
    showControls()
    return () => clearTimeout(hideTimer.current)
  }, [])

  // Swipe handling via pointer events
  function onPointerDown(e: React.PointerEvent) {
    pointerStart.current = { x: e.clientX, y: e.clientY }
  }
  function onPointerUp(e: React.PointerEvent) {
    if (!pointerStart.current) return
    const dx = e.clientX - pointerStart.current.x
    const dy = e.clientY - pointerStart.current.y
    pointerStart.current = null
    const absDx = Math.abs(dx)
    const absDy = Math.abs(dy)
    // Tap (small movement) — independent of zoom, just toggles the chrome.
    if (absDx < 10 && absDy < 10) {
      showControls()
      return
    }
    // While zoomed in, the gesture belongs to the pan transform — don't paginate.
    if (scaleRef.current > 1.01) return
    // Strict horizontal swipe: enough lateral travel AND a steep angle so that
    // mostly-vertical drags (accidental scroll, thumb wobble) don't flip pages.
    if (absDx > 40 && absDx > absDy * 2.5 && absDy < 60) {
      dx < 0 ? goTo(page + 1) : goTo(page - 1)
    }
  }

  if (!comic) return <FullPageSpinner />

  return (
    <div className="min-h-dvh bg-black flex flex-col select-none overflow-hidden">
      {/* Top bar */}
      <AnimatePresence>
        {controlsVisible && (
          <motion.div
            initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="fixed top-0 left-0 right-0 z-20 flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-black/80 to-transparent pointer-events-none"
          >
            <button
              onClick={goBack}
              className="flex items-center gap-1.5 text-white/80 hover:text-white transition-colors text-sm pointer-events-auto"
            >
              <ArrowLeft size={16} /> Back
            </button>
            <span className="text-white/50 text-sm truncate flex-1">{comic.title}</span>
            <div className="relative pointer-events-auto">
              <button
                onClick={() => { setLabelsOpen(o => !o); setCollectionsOpen(false) }}
                title="Assign labels"
                aria-label="Assign labels"
                className={`p-2.5 -m-1.5 rounded-full transition-colors ${labelIDs.size > 0 ? 'text-[var(--color-accent)]' : 'text-white/60 hover:text-white'} hover:bg-white/10`}
              >
                <Tag size={16} />
              </button>
              {labelsOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setLabelsOpen(false)} />
                  <div className="absolute right-0 top-full mt-2 z-30 w-56 rounded-lg bg-zinc-900/95 backdrop-blur-sm border border-white/10 shadow-2xl p-2 max-h-80 overflow-y-auto">
                    {allLabels.length === 0 ? (
                      <p className="text-xs text-white/40 px-2 py-3 text-center">
                        No labels yet. Create some in Settings.
                      </p>
                    ) : allLabels.map((l) => {
                      const on = labelIDs.has(l.id)
                      return (
                        <button
                          key={l.id}
                          onClick={() => toggleLabel(l.id)}
                          className="flex w-full items-center gap-2 px-2 py-1.5 rounded text-xs text-white/80 hover:bg-white/10 transition-colors"
                        >
                          <span
                            className="w-3 h-3 rounded-full shrink-0"
                            style={{ backgroundColor: l.color }}
                          />
                          <span className="flex-1 text-left truncate">{l.name}</span>
                          {on && <span className="text-[var(--color-accent)] text-base leading-none">✓</span>}
                        </button>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
            <div className="relative pointer-events-auto">
              <button
                onClick={() => { setCollectionsOpen(o => !o); setLabelsOpen(false) }}
                title="Add to collection"
                aria-label="Add to collection"
                className={`p-2.5 -m-1.5 rounded-full transition-colors ${collectionIDs.size > 0 ? 'text-[var(--color-accent)]' : 'text-white/60 hover:text-white'} hover:bg-white/10`}
              >
                <Bookmark size={16} />
              </button>
              {collectionsOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setCollectionsOpen(false)} />
                  <div className="absolute right-0 top-full mt-2 z-30 w-56 rounded-lg bg-zinc-900/95 backdrop-blur-sm border border-white/10 shadow-2xl p-2 max-h-80 overflow-y-auto">
                    {allCollections.length === 0 ? (
                      <p className="text-xs text-white/40 px-2 py-3 text-center">
                        No collections yet. Create some in Settings.
                      </p>
                    ) : allCollections.map((c) => {
                      const on = collectionIDs.has(c.id)
                      return (
                        <button
                          key={c.id}
                          onClick={() => toggleCollection(c.id)}
                          className="flex w-full items-center gap-2 px-2 py-1.5 rounded text-xs text-white/80 hover:bg-white/10 transition-colors"
                        >
                          <Bookmark size={12} className="shrink-0 text-white/50" />
                          <span className="flex-1 text-left truncate">{c.name}</span>
                          {on && <span className="text-[var(--color-accent)] text-base leading-none">✓</span>}
                        </button>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
            <button
              onClick={() => setThumbnailOpen(true)}
              title="Set thumbnail"
              aria-label="Set thumbnail"
              className={`p-2.5 -m-1.5 rounded-full transition-colors pointer-events-auto ${comic.custom_cover ? 'text-[var(--color-accent)]' : 'text-white/60 hover:text-white'} hover:bg-white/10`}
            >
              <Image size={16} />
            </button>
            <button
              onClick={toggleFullscreen}
              title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              className="p-2.5 -m-1.5 rounded-full text-white/60 hover:text-white hover:bg-white/10 transition-colors pointer-events-auto"
            >
              {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Page — zoom wrapper */}
      <div
        ref={containerRef}
        className="flex-1 flex items-center justify-center"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
        <TransformWrapper
          initialScale={1}
          minScale={1}
          maxScale={5}
          wheel={{ disabled: true }}
          doubleClick={{ mode: 'toggle', step: 2 }}
          panning={{
            excluded: ['input', 'button'],
            // Lock vertical movement when the page is fit-to-screen. Once
            // zoomed in, pan freely so the user can navigate the image.
            lockAxisY: !zoomed,
            lockAxisX: !zoomed,
          }}
        >
          <WheelZoomCapture
            containerRef={containerRef}
            scaleRef={scaleRef}
            onZoomChange={setZoomed}
            onPageDelta={(d) => goTo(pageRef.current + d)}
          />
          <PageResetOnChange page={page} />
          <TransformComponent
            wrapperStyle={{ width: '100%', height: '100dvh' }}
            contentStyle={{ display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%', height: '100dvh' }}
          >
            {/* No fade transition — neighbours are preloaded, so the new
                image / canvas appears as soon as the bits are ready. */}
            {comic.format === 'pdf' ? (
              <Suspense fallback={null}>
                <PDFPage url={api.fileUrl(comicId)} page={page} onPageCount={setPdfPageCount} />
              </Suspense>
            ) : (
              <img
                src={api.pageUrl(comicId, page, window.innerWidth)}
                alt={`Page ${page}`}
                className="max-h-dvh max-w-full object-contain"
                decoding="async"
                draggable={false}
              />
            )}
          </TransformComponent>
        </TransformWrapper>
      </div>

      {thumbnailOpen && comic && (
        <SetThumbnailModal
          comic={comic}
          initialPage={page}
          onClose={() => setThumbnailOpen(false)}
        />
      )}

      {/* Bottom bar */}
      <AnimatePresence>
        {controlsVisible && (
          <motion.div
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
            className="fixed bottom-0 left-0 right-0 z-20 px-4 pt-4 pb-safe-4 bg-gradient-to-t from-black/80 to-transparent"
          >
            <div className="flex items-center gap-3 max-w-lg mx-auto">
              <button
                onClick={() => goTo(page - 1)}
                disabled={page <= 1}
                className="p-3 rounded-full text-white/70 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-colors"
              >
                <ChevronLeft size={20} />
              </button>

              <input
                type="range" min={1} max={totalPages} value={page}
                onChange={(e) => goTo(Number(e.target.value))}
                className="flex-1 accent-[var(--color-accent)]"
              />

              <button
                onClick={() => goTo(page + 1)}
                disabled={page >= totalPages}
                className="p-3 rounded-full text-white/70 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-colors"
              >
                <ChevronRight size={20} />
              </button>

              <span className="text-white/50 text-xs tabular-nums w-16 text-right shrink-0">
                {page} / {totalPages}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
