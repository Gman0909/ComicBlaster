// useOffline — React state for the offline-reading feature.
//
// Single source of truth for the React tree about which comics are
// downloaded and which are mid-download. Components subscribe via
// the hook and re-render when the manifest changes or a progress
// event arrives from Go.
//
// In a non-native context (browser) the hook returns empty state and
// no-op actions — callers don't have to gate on isNative() at every
// site, just check the returned values.

import { useEffect, useState, useCallback, useRef } from 'react'
import { bridge, isNative, type OfflineEntry, type OfflineStatus } from '../native'

export interface OfflineState {
  /** Map of comic_id → manifest entry for everything currently downloaded. */
  entries: Map<number, OfflineEntry>
  /** Map of comic_id → live status for in-flight downloads. */
  inFlight: Map<number, OfflineStatus>
  /** True when the host can actually do offline work (native shell + bridge present). */
  available: boolean
}

export interface OfflineActions {
  /** Kick off a download. Returns immediately; progress arrives via events. */
  download: (params: { comic_id: number; format: string; title: string; cover_url: string }) => Promise<void>
  /** Remove a downloaded comic from the local store. */
  remove: (comic_id: number) => Promise<void>
  /** Force a refresh of the entries list (after operations that change the manifest). */
  refresh: () => Promise<void>
}

// Module-level cache so the manifest list is shared across every
// hook consumer without re-fetching per component. Updated by the
// progress-event handler + explicit refresh calls; consumers
// subscribe via the React state setter.
let cachedEntries: OfflineEntry[] = []
const subscribers = new Set<(e: OfflineEntry[]) => void>()
let initialLoadPromise: Promise<void> | null = null

function setEntries(next: OfflineEntry[]): void {
  cachedEntries = next
  subscribers.forEach((s) => s(next))
}

async function loadOnce(): Promise<void> {
  if (initialLoadPromise) return initialLoadPromise
  const br = bridge()
  if (!br) return
  initialLoadPromise = br.ListDownloads()
    .then((es) => setEntries(es ?? []))
    .catch((err: unknown) => {
      console.warn('offline: initial ListDownloads failed', err)
    })
  return initialLoadPromise
}

export function useOffline(): OfflineState & OfflineActions {
  const native = isNative()
  const br = bridge()
  const [entriesArr, setEntriesArr] = useState<OfflineEntry[]>(cachedEntries)
  const [inFlight, setInFlight] = useState<Map<number, OfflineStatus>>(new Map())
  const mountedRef = useRef(true)

  // Subscribe to manifest updates from other components / progress
  // events. Single source of truth at the module level — every
  // mounted instance of the hook gets the same list.
  useEffect(() => {
    mountedRef.current = true
    const onChange = (e: OfflineEntry[]) => {
      if (mountedRef.current) setEntriesArr(e)
    }
    subscribers.add(onChange)
    loadOnce()
    return () => {
      mountedRef.current = false
      subscribers.delete(onChange)
    }
  }, [])

  // Listen for the "offline:progress" Wails event so progress bars
  // update without polling. Each event is a single OfflineStatus
  // payload; when state === "complete" we also refresh the
  // manifest so the cached entries list picks up the new comic.
  useEffect(() => {
    const rt = typeof window !== 'undefined' ? window.runtime : undefined
    if (!rt || !native) return
    const off = rt.EventsOn('offline:progress', (...args: unknown[]) => {
      const st = args[0] as OfflineStatus
      if (!st || typeof st.comic_id !== 'number') return
      setInFlight((prev) => {
        const next = new Map(prev)
        if (st.state === 'complete' || st.state === 'error') {
          next.delete(st.comic_id)
        } else {
          next.set(st.comic_id, st)
        }
        return next
      })
      if (st.state === 'complete' && br) {
        // Refetch the manifest so consumers see the new entry.
        br.ListDownloads().then(setEntries).catch(() => {})
      }
    })
    return () => { off() }
  }, [native, br])

  const refresh = useCallback(async () => {
    if (!br) return
    const es = await br.ListDownloads()
    setEntries(es ?? [])
  }, [br])

  const download = useCallback(async (p: { comic_id: number; format: string; title: string; cover_url: string }) => {
    if (!br) throw new Error('offline reading is only available in the native client')
    // Optimistically reflect a "queued" status so the UI updates
    // before the first progress event arrives.
    setInFlight((prev) => {
      const next = new Map(prev)
      next.set(p.comic_id, { comic_id: p.comic_id, state: 'queued', bytes_done: 0, bytes_total: 0 })
      return next
    })
    try {
      await br.DownloadComic(p)
    } catch (err) {
      // Roll back the optimistic status; the Go side never actually
      // started so the user can retry immediately.
      setInFlight((prev) => {
        const next = new Map(prev)
        next.delete(p.comic_id)
        return next
      })
      throw err
    }
  }, [br])

  const remove = useCallback(async (comic_id: number) => {
    if (!br) return
    await br.RemoveDownload(comic_id)
    await refresh()
  }, [br, refresh])

  const entries = new Map<number, OfflineEntry>()
  for (const e of entriesArr) entries.set(e.comic_id, e)

  return { entries, inFlight, available: native, download, remove, refresh }
}
