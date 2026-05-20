import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from './api'

type LibraryView = 'library' | 'collections'

interface AppState {
  user: User | null
  setUser: (u: User | null) => void
  theme: 'dark' | 'light'
  toggleTheme: () => void
  libraryView: LibraryView
  setLibraryView: (v: LibraryView) => void
  unreadOnly: boolean
  setUnreadOnly: (v: boolean) => void
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
    }),
    {
      name: 'cb-store',
      partialize: (s) => ({
        theme: s.theme,
        libraryView: s.libraryView,
        unreadOnly: s.unreadOnly,
      }),
    },
  ),
)
