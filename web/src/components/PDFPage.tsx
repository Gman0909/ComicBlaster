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

  // Keep external ref in sync with internal ref
  useEffect(() => {
    const el = internalRef.current
    if (!externalRef) return
    if (typeof externalRef === 'function') externalRef(el)
    else externalRef.current = el
  })

  useEffect(() => {
    let cancelled = false
    setError(false)
    onRendered?.(false)

    async function render() {
      const canvas = internalRef.current
      if (!canvas) return
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
        await pdfPage.render({ canvasContext: ctx, viewport: scaled, canvas }).promise
        if (!cancelled) onRendered?.(true)
      } catch {
        if (!cancelled) setError(true)
      }
    }

    render()
    return () => { cancelled = true }
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

  if (error) return (
    <div className="flex items-center justify-center text-white/30 text-sm w-full h-full">
      Could not render page
    </div>
  )

  return <canvas ref={internalRef} className={className} />
})

export default PDFPage
