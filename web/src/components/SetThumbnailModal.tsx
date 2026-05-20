import { lazy, Suspense, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { api, type Comic, type ComicsPage } from '../api'

const PDFPage = lazy(() => import('./PDFPage'))

interface Props {
  comic: Comic
  initialPage?: number
  onClose: () => void
}

export default function SetThumbnailModal({ comic, initialPage = 1, onClose }: Props) {
  const queryClient = useQueryClient()
  const isPdf = comic.format === 'pdf'
  const maxPage = comic.page_count || 1
  const [page, setPage] = useState(Math.max(1, Math.min(initialPage, maxPage)))
  const [saving, setSaving] = useState(false)
  const [pdfReady, setPdfReady] = useState(false)
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null)

  // Optimistically patch the comic in every comics-list and single-comic query
  // so the UI reflects the change instantly, then trigger a background refetch
  // to reconcile with the server's actual mtime-versioned URL.
  function patchCache(custom: boolean) {
    const newCoverUrl = `/api/comics/${comic.id}/cover?v=${Date.now()}`
    queryClient.setQueriesData<ComicsPage>({ queryKey: ['comics'] }, (old) => {
      if (!old?.comics) return old
      return {
        ...old,
        comics: old.comics.map((c) =>
          c.id === comic.id
            ? { ...c, custom_cover: custom, cover_url: newCoverUrl }
            : c,
        ),
      }
    })
    queryClient.setQueryData<Comic>(['comic', comic.id], (old) =>
      old ? { ...old, custom_cover: custom, cover_url: newCoverUrl } : old,
    )
    queryClient.invalidateQueries({ queryKey: ['comics'] })
    queryClient.invalidateQueries({ queryKey: ['comic', comic.id] })
  }

  async function handleSet() {
    setSaving(true)
    try {
      if (isPdf) {
        const canvas = pdfCanvasRef.current
        if (!canvas) return
        const blob = await new Promise<Blob | null>(resolve =>
          canvas.toBlob(resolve, 'image/jpeg', 0.92)
        )
        if (blob) await api.uploadCover(comic.id, blob)
      } else {
        await api.setCover(comic.id, page)
      }
      patchCache(true)
      onClose()
    } catch {
      // silent — user can retry
    } finally {
      setSaving(false)
    }
  }

  async function handleClear() {
    setSaving(true)
    try {
      await api.clearCover(comic.id)
      patchCache(false)
      onClose()
    } catch {
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[var(--color-surface-raised)] rounded-xl shadow-2xl w-full max-w-xs mx-4 flex flex-col gap-4 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--color-text)] truncate pr-2">
            Set thumbnail
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 p-2 -m-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)] transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Page preview */}
        <div
          className="rounded-lg overflow-hidden bg-black flex items-center justify-center"
          style={{ aspectRatio: '2/3' }}
        >
          {isPdf ? (
            <Suspense fallback={<span className="text-white/30 text-xs">Loading…</span>}>
              <PDFPage
                ref={pdfCanvasRef}
                url={api.fileUrl(comic.id)}
                page={page}
                maxWidth={300}
                onRendered={setPdfReady}
                className="max-w-full max-h-full"
              />
            </Suspense>
          ) : (
            <img
              key={page}
              src={api.pageUrl(comic.id, page, 400)}
              alt={`Page ${page}`}
              className="max-w-full max-h-full object-contain"
            />
          )}
        </div>

        {/* Slider */}
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={1}
            max={maxPage}
            value={page}
            onChange={(e) => setPage(Number(e.target.value))}
            className="flex-1 accent-[var(--color-accent)]"
          />
          <span className="text-xs text-[var(--color-text-muted)] tabular-nums w-16 text-right shrink-0">
            {page} / {maxPage}
          </span>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          {comic.custom_cover && (
            <button
              onClick={handleClear}
              disabled={saving}
              className="flex-1 rounded-lg border border-[var(--color-border)] py-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50 transition-colors"
            >
              Clear
            </button>
          )}
          <button
            onClick={handleSet}
            disabled={saving || (isPdf && !pdfReady)}
            className="flex-1 rounded-lg bg-[var(--color-accent)] text-white py-2 text-xs font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {saving
              ? 'Saving…'
              : isPdf && !pdfReady
              ? 'Rendering…'
              : 'Set thumbnail'}
          </button>
        </div>
      </div>
    </div>
  )
}
