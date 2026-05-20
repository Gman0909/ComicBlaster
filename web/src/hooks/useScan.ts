import { useState, useEffect, useRef } from 'react'
import { api } from '../api'

export type ScanStatus = {
  running: boolean
  processed: number
  current: string
  last_scan: string
  last_count: number
}

export function useScan(onComplete?: () => void) {
  const [status, setStatus] = useState<ScanStatus | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const wasRunning = useRef(false)

  function stopPolling() {
    clearInterval(pollRef.current)
    pollRef.current = undefined
  }

  async function fetchStatus() {
    try {
      const s = await api.scanStatus()
      setStatus(s)
      if (!s.running) {
        if (wasRunning.current) onComplete?.()
        wasRunning.current = false
        stopPolling()
      } else {
        wasRunning.current = true
      }
    } catch {}
  }

  async function trigger() {
    await api.triggerScan().catch(() => {})
    await fetchStatus()
    stopPolling()
    pollRef.current = setInterval(fetchStatus, 800)
  }

  useEffect(() => {
    fetchStatus()
    return stopPolling
  }, [])

  return { status, trigger }
}
