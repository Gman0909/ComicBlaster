// useComic — shared comic-by-id fetch with offline fallback.
//
// Used by ReaderDispatch (to gate the format-router on the comic
// existing) and by Reader / ReaderEpub (to read the loaded
// metadata). All three call it with the same comicId so they share
// one react-query cache slot; the second + third calls return the
// cached value immediately.
//
// Offline behaviour:
//   - When the store's offlineMode flag is set, the query skips the
//     network entirely and reads from the cached library payload
//     (Phase E writes this on every successful online fetch).
//     `retry` is also forced to 0 — no point waiting 45 seconds for
//     three 15 s timeouts when we already know the server is gone.
//   - When NOT in offlineMode but the fetch errors anyway (flaky
//     network, server hiccup), the cached library is tried as a
//     fallback. This keeps a downloaded comic readable through
//     brief outages even before AuthGuard's bootstrap notices.

import { useQuery } from '@tanstack/react-query'
import { api, type Comic, type ComicsPage } from '../api'
import { useStore } from '../store'
import { bridge } from '../native'

export function useComic(comicId: number) {
  const offlineMode = useStore((s) => s.offlineMode)
  return useQuery<Comic>({
    queryKey: ['comic', comicId, offlineMode],
    queryFn: async () => {
      if (offlineMode) return loadComicFromCache(comicId)
      try {
        return await api.comic(comicId)
      } catch (err) {
        try { return await loadComicFromCache(comicId) } catch { throw err }
      }
    },
    retry: offlineMode ? 0 : 2,
    retryDelay: 800,
  })
}

async function loadComicFromCache(comicId: number): Promise<Comic> {
  const br = bridge()
  if (!br) throw new Error('cached library only available in the native client')
  const raw = await br.LoadCachedLibrary()
  if (!raw) throw new Error('no cached library — open the app online once first')
  const lib = JSON.parse(raw) as ComicsPage
  const found = lib.comics.find((c) => c.id === comicId)
  if (!found) throw new Error(`Comic ${comicId} is not in the cached library`)
  // Overlay the local progress queue so the reader's restore lands
  // on the user's latest position, not the stale value baked into
  // the JSON cache. Without this, every offline re-open snaps back
  // to the value from the last online session and the unmount-time
  // queued save just replays the same position forever.
  try {
    const queueRaw = localStorage.getItem('cb-progress-queue-v1')
    if (queueRaw) {
      const queue: Array<{ comic_id: number; last_page: number; last_cfi: string; seq: number }> = JSON.parse(queueRaw)
      const q = queue.find((e) => e.comic_id === comicId)
      if (q) {
        const cachedTs = found.progress?.updated_at ? Date.parse(found.progress.updated_at) : 0
        if (q.seq > cachedTs) {
          return {
            ...found,
            progress: {
              last_page: q.last_page,
              last_cfi: q.last_cfi,
              updated_at: new Date(q.seq).toISOString(),
            },
          }
        }
      }
    }
  } catch { /* malformed queue — ignore */ }
  return found
}
