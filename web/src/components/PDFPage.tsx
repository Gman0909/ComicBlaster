import { forwardRef, useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const docCache = new Map<string, pdfjsLib.PDFDocumentProxy>()

async function loadDoc(url: string): Promise<pdfjsLib.PDFDocumentProxy> {
  if (docCache.has(url)) return docCache.get(url)!
  const doc = await pdfjsLib.getDocument({ url, withCredentials: true }).promise
  docCache.set(url, doc)
  return doc
}

// pdf.js exposes RenderingCancelledException — but the public types don't
// always export it cleanly, so detect by name. Cancellation is the normal
// outcome when a fresh render starts before the previous one finished and
// must not show up as a user-facing error.
function isCancellation(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  return name === 'RenderingCancelledException' || name === 'AbortException'
}

interface Props {
  url: string
  page: number // 1-indexed
  onPageCount?: (n: number) => void
  onRendered?: (ready: boolean) => void // fires false when render starts, true when done
  className?: string
  maxWidth?: number  // CSS px — caps the rendered width
  maxHeight?: number // CSS px — caps the rendered height
}

const PDFPage = forwardRef<HTMLCanvasElement, Props>(function PDFPage(
  { url, page, onPageCount, onRendered, className, maxWidth, maxHeight },
  externalRef,
) {
  const internalRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState(false)
  // Hold the in-flight render task so a rapid re-render (page change, prop
  // change, mount/unmount race) can cancel it before kicking off a new one.
  // pdf.js otherwise complains about overlapping renders on the same canvas.
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null)

  // Keep external ref in sync with internal ref
  useEffect(() => {
    const el = internalRef.current
    if (!externalRef) return
    if (typeof externalRef === 'function') externalRef(el)
    else externalRef.current = el
  })

  useEffect(() => {
    let cancelled = false
    onRendered?.(false)

    async function render() {
      const canvas = internalRef.current
      if (!canvas) return
      // Cancel any in-flight render on the same canvas first. The await on
      // the previous task's promise will reject with RenderingCancelled —
      // that error path is handled in the previous effect run's catch and
      // ignored thanks to isCancellation().
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel() } catch {}
        renderTaskRef.current = null
      }
      try {
        const doc = await loadDoc(url)
        if (cancelled) return
        onPageCount?.(doc.numPages)
        const pdfPage = await doc.getPage(page)
        if (cancelled) return

        const dpr = window.devicePixelRatio || 1
        const viewport = pdfPage.getViewport({ scale: 1 })
        const refW = maxWidth  !== undefined ? maxWidth  * dpr : window.innerWidth  * dpr
        const refH = maxHeight !== undefined ? maxHeight * dpr : window.innerHeight * dpr
        const scale = Math.min(refW / viewport.width, refH / viewport.height)
        const scaled = pdfPage.getViewport({ scale })

        canvas.width = scaled.width
        canvas.height = scaled.height
        canvas.style.width  = `${scaled.width  / dpr}px`
        canvas.style.height = `${scaled.height / dpr}px`

        const ctx = canvas.getContext('2d')!
        const task = pdfPage.render({ canvasContext: ctx, viewport: scaled, canvas })
        renderTaskRef.current = task
        await task.promise
        if (!cancelled) {
          setError(false)
          onRendered?.(true)
        }
      } catch (err) {
        if (cancelled) return
        if (isCancellation(err)) return // expected — a newer render took over
        // Real failure (network, parse, etc.). Log so the user has something
        // actionable in devtools, but don't leave them staring at an opaque
        // overlay forever — the canvas content from the previous page (if
        // any) stays visible underneath.
        // eslint-disable-next-line no-console
        console.warn('[PDFPage] render failed', err)
        setError(true)
      }
    }

    render()
    return () => {
      cancelled = true
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel() } catch {}
        renderTaskRef.current = null
      }
    }
  }, [url, page, maxWidth, maxHeight])

  // After the current page is on screen, prime pdf.js's internal page cache
  // for the neighbours so the next flip renders without a fetch. Cheap: we
  // only retain the PDFPageProxy, no rasterization.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(async () => {
      try {
        const doc = await loadDoc(url)
        if (cancelled) return
        const ahead = page + 1
        const behind = page - 1
        if (ahead <= doc.numPages) doc.getPage(ahead).catch(() => {})
        if (behind >= 1)            doc.getPage(behind).catch(() => {})
      } catch {}
    }, 100)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [url, page])

  // Error is shown as a small overlay rather than replacing the canvas so
  // a transient failure on one page doesn't blank out the whole reader.
  return (
    <>
      <canvas ref={internalRef} className={className} />
      {error && (
        <div className="absolute inset-x-0 bottom-4 flex justify-center pointer-events-none">
          <div className="px-3 py-1.5 rounded-md bg-red-600/90 text-white text-xs shadow-lg pointer-events-auto">
            Couldn't render this page
          </div>
        </div>
      )}
    </>
  )
})

export default PDFPage
