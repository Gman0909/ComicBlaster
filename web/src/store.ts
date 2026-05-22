import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from './api'

type LibraryView = 'library' | 'collections'
type SortOrder = 'asc' | 'desc'

interface LibraryUiState {
  search: string
  sort: string
  order: SortOrder
  labelFilters: number[]      // serialised as array for persistence; toggled via setters
  collectionFilters: number[]
  // Index of the topmost visible comic in the grid. Stored as a comic
  // index (not a row index or pixel offset) so it survives column-count
  // changes and is independent of the virtualizer's estimateSize.
  scrollComic: number
}

interface AppState {
  user: User | null
  setUser: (u: User | null) => void
  theme: 'dark' | 'light'
  toggleTheme: () => void
  libraryView: LibraryView
  setLibraryView: (v: LibraryView) => void
  unreadOnly: boolean
  setUnreadOnly: (v: boolean) => void
  // Whether the library view also shows comics flagged with
  // missing_since by the scanner. Default false (hidden). Flipped
  // from Settings → Missing files.
  showMissing: boolean
  setShowMissing: (v: boolean) => void
  // True when the native client has decided the server is
  // unreachable but a non-empty offline manifest exists, so the
  // app falls back to the cached library + locally-downloaded
  // comics. Reset to false when /api/auth/me starts succeeding
  // again. Never true in the browser deployment.
  offlineMode: boolean
  setOfflineMode: (v: boolean) => void
  // User-controlled filter: when true the library view shows ONLY
  // comics downloaded for offline reading. Distinct from
  // offlineMode (which is an automatic state set when the server
  // is unreachable). Persisted so the user's preference survives
  // reloads. Native-only; the toolbar button hides in browsers.
  offlineOnly: boolean
  setOfflineOnly: (v: boolean) => void
  // Library UI state — persisted so opening a comic and coming back keeps
  // the user's place (search, sort, active filters, scroll).
  library: LibraryUiState
  setLibrarySearch: (q: string) => void
  setLibrarySort: (s: string) => void
  setLibraryOrder: (o: SortOrder) => void
  toggleLabelFilter: (id: number) => void
  toggleCollectionFilter: (id: number) => void
  clearLibraryFilters: () => void
  setLibraryScroll: (comicIndex: number) => void
  // ID of the comic the user most recently opened from the library. Set on
  // navigate-into-reader and consumed by the library on mount to guarantee
  // that comic is scrolled into view on return — independent of where the
  // viewport happened to be when the card was clicked.
  lastOpenedComicId: number | null
  setLastOpenedComicId: (id: number | null) => void
}

const defaultLibrary: LibraryUiState = {
  search: '',
  sort: 'series',
  order: 'asc',
  labelFilters: [],
  collectionFilters: [],
  scrollComic: 0,
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      user: null,
      setUser: (user) => set({ user }),
      theme: 'dark',
      toggleTheme: () =>
        set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
      libraryView: 'library',
      setLibraryView: (libraryView) => set({ libraryView }),
      unreadOnly: false,
      setUnreadOnly: (unreadOnly) => set({ unreadOnly }),
      showMissing: false,
      setShowMissing: (showMissing) => set({ showMissing }),
      offlineMode: false,
      setOfflineMode: (offlineMode) => set({ offlineMode }),
      offlineOnly: false,
      setOfflineOnly: (offlineOnly) => set({ offlineOnly }),

      library: defaultLibrary,
      setLibrarySearch: (q) =>
        set((s) => ({ library: { ...s.library, search: q, scrollComic: 0 } })),
      setLibrarySort: (sort) =>
        set((s) => ({ library: { ...s.library, sort } })),
      setLibraryOrder: (order) =>
        set((s) => ({ library: { ...s.library, order } })),
      toggleLabelFilter: (id) =>
        set((s) => {
          const has = s.library.labelFilters.includes(id)
          const next = has
            ? s.library.labelFilters.filter((x) => x !== id)
            : [...s.library.labelFilters, id]
          return { library: { ...s.library, labelFilters: next, scrollComic: 0 } }
        }),
      toggleCollectionFilter: (id) =>
        set((s) => {
          const has = s.library.collectionFilters.includes(id)
          const next = has
            ? s.library.collectionFilters.filter((x) => x !== id)
            : [...s.library.collectionFilters, id]
          return { library: { ...s.library, collectionFilters: next, scrollComic: 0 } }
        }),
      clearLibraryFilters: () =>
        set((s) => ({ library: { ...s.library, labelFilters: [], collectionFilters: [], scrollComic: 0 } })),
      setLibraryScroll: (scrollComic) =>
        set((s) => ({ library: { ...s.library, scrollComic } })),
      lastOpenedComicId: null,
      setLastOpenedComicId: (lastOpenedComicId) => set({ lastOpenedComicId }),
    }),
    {
      name: 'cb-store',
      partialize: (s) => ({
        theme: s.theme,
        libraryView: s.libraryView,
        unreadOnly: s.unreadOnly,
        showMissing: s.showMissing,
        offlineOnly: s.offlineOnly,
        // user is persisted so offline-mode bootstrap has a name
        // to show in the profile menu. Server-side role is the
        // authority; admin sections gate on it but their endpoints
        // also require a valid token, so the worst a stale user
        // can do is show the UI for actions that immediately error.
        user: s.user,
        library: s.library,
        lastOpenedComicId: s.lastOpenedComicId,
      }),
    },
  ),
)
