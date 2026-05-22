import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, X } from 'lucide-react'
import { api, type Comic } from '../api'

interface Props {
  comic: Comic
  onClose: () => void
}

export default function RemoveComicModal({ comic, onClose }: Props) {
  const queryClient = useQueryClient()
  const [deleteFile, setDeleteFile] = useState(false)
  const [working, setWorking] = useState(false)
  const [err, setErr] = useState('')

  async function confirm() {
    setWorking(true)
    setErr('')
    try {
      // When deleting the file from disk, skip the ignore list — the file
      // is gone, so there's nothing for future scans to skip. The server
      // enforces this too (handleRemoveComic forces ignore=false when
      // delete_file=1) but being explicit keeps the contract obvious.
      const res = await api.removeComic(comic.id, { ignore: !deleteFile, deleteFile })
      queryClient.invalidateQueries({ queryKey: ['comics'] })
      queryClient.invalidateQueries({ queryKey: ['ignoredPaths'] })
      // Partial-success: the DB row is gone but the file delete
      // step failed (typical cause: a systemd-hardened unit where
      // the library mount isn't in ReadWritePaths). The server has
      // auto-added the path to the ignore list so the comic won't
      // reappear on the next scan, but the file is still on disk
      // and the user needs to either fix the permission or remove
      // it manually — surface that.
      if (res && res.file_warn) {
        setErr(`Library entry removed and ignored, but the file is still on disk: ${res.file_warn}`)
        setWorking(false)
        return
      }
      onClose()
    } catch (e: any) {
      setErr(e.message ?? 'Failed to remove')
    } finally {
      setWorking(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-[var(--color-surface-raised)] rounded-xl shadow-2xl w-full max-w-sm flex flex-col gap-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Remove from library?</h2>
          <button onClick={onClose} aria-label="Close" className="shrink-0 p-2 -m-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-overlay)] transition-colors">
            <X size={16} />
          </button>
        </div>

        <p className="text-sm text-[var(--color-text-muted)] leading-snug">
          <span className="text-[var(--color-text)] font-medium">{comic.title}</span>{' '}
          {deleteFile
            ? 'will be removed from the library and the file deleted from disk. This cannot be undone.'
            : 'will be removed from the library and added to the ignore list so future scans skip it. You can restore it from Settings → Ignored items.'}
        </p>

        <label className="flex items-start gap-3 cursor-pointer select-none p-3 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-surface-overlay)] transition-colors">
          <input
            type="checkbox"
            checked={deleteFile}
            onChange={(e) => setDeleteFile(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-red-500 shrink-0"
          />
          <div className="min-w-0">
            <p className="text-sm text-[var(--color-text)] flex items-center gap-1.5">
              {deleteFile && <AlertTriangle size={14} className="text-red-400 shrink-0" />}
              Also delete the file from disk
            </p>
            <p className="text-[11px] text-[var(--color-text-muted)] font-mono truncate mt-0.5" title={comic.id ? `comic #${comic.id}` : ''}>
              Cannot be undone.
            </p>
          </div>
        </label>

        {err && <p className="text-sm text-red-400">{err}</p>}

        <div className="flex gap-2">
          <button
            onClick={onClose}
            disabled={working}
            className="flex-1 rounded-lg border border-[var(--color-border)] py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={working}
            className={`flex-1 rounded-lg py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${deleteFile ? 'bg-red-600 hover:bg-red-500' : 'bg-[var(--color-accent-strong)] hover:bg-[var(--color-accent-hover)]'}`}
          >
            {working ? 'Removing…' : deleteFile ? 'Delete forever' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  )
}
