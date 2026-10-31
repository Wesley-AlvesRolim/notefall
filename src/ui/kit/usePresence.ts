import { useEffect, useState } from 'react'

/**
 * Keeps something mounted for `exitMs` after `open` turns false so it can fade out.
 * `leaving` is true during that window (apply `nf-leaving`).
 */
export function usePresence(open: boolean, exitMs = 140): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    const t = window.setTimeout(() => setMounted(false), exitMs)
    return () => clearTimeout(t)
  }, [open, exitMs])
  return { mounted: open || mounted, leaving: !open && mounted }
}
