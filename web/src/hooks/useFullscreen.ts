import { useCallback, useEffect, useState } from 'react'

// Browser-level fullscreen. Persists across SPA navigation by definition —
// it's the page itself that's in fullscreen, not any individual route.
export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(
    typeof document !== 'undefined' && !!document.fullscreenElement,
  )

  useEffect(() => {
    function handle() {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handle)
    return () => document.removeEventListener('fullscreenchange', handle)
  }, [])

  const toggle = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        await document.documentElement.requestFullscreen()
      }
    } catch {
      // User gesture missing or browser disallowed — just leave the state
      // synchronized with reality via the fullscreenchange listener.
    }
  }, [])

  return { isFullscreen, toggle }
}
