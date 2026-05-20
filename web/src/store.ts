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
  scrollTop: number
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
  // Library UI state — persisted so opening a comic and coming back keeps
  // the user's place (search, sort, active filters, scroll).
  library: LibraryUiState
  setLibrarySearch: (q: string) => void
  setLibrarySort: (s: string) => void
  setLibraryOrder: (o: SortOrder) => void
  toggleLabelFilter: (id: number) => void
  toggleCollectionFilter: (id: number) => void
  clearLibraryFilters: () => void
  setLibraryScroll: (px: number) => void
}

const defaultLibrary: LibraryUiState = {
  search: '',
  sort: 'series',
  order: 'asc',
  labelFilters: [],
  collectionFilters: [],
  scrollTop: 0,
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

      library: defaultLibrary,
      setLibrarySearch: (q) =>
        set((s) => ({ library: { ...s.library, search: q, scrollTop: 0 } })),
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
          return { library: { ...s.library, labelFilters: next, scrollTop: 0 } }
        }),
      toggleCollectionFilter: (id) =>
        set((s) => {
          const has = s.library.collectionFilters.includes(id)
          const next = has
            ? s.library.collectionFilters.filter((x) => x !== id)
            : [...s.library.collectionFilters, id]
          return { library: { ...s.library, collectionFilters: next, scrollTop: 0 } }
        }),
      clearLibraryFilters: () =>
        set((s) => ({ library: { ...s.library, labelFilters: [], collectionFilters: [], scrollTop: 0 } })),
      setLibraryScroll: (scrollTop) =>
        set((s) => ({ library: { ...s.library, scrollTop } })),
    }),
    {
      name: 'cb-store',
      partialize: (s) => ({
        theme: s.theme,
        libraryView: s.libraryView,
        unreadOnly: s.unreadOnly,
        library: s.library,
      }),
    },
  ),
)
