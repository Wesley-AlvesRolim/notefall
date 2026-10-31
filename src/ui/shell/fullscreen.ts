import { useSyncExternalStore } from 'react'

// Fullscreen targets the whole app root (Layout registers it) so the islands, panels and
// the pill come along with the canvas.

let rootEl: HTMLElement | null = null

export function setFullscreenRoot(el: HTMLElement | null): void {
  rootEl = el
}

export function getFullscreenRoot(): HTMLElement | null {
  return rootEl
}

export async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await rootEl?.requestFullscreen?.()
  } catch {
    /* user-gesture or permission failure: ignore */
  }
}

const subscribe = (cb: () => void) => {
  document.addEventListener('fullscreenchange', cb)
  return () => document.removeEventListener('fullscreenchange', cb)
}
const snapshot = () => rootEl !== null && document.fullscreenElement === rootEl

export const useIsFullscreen = (): boolean => useSyncExternalStore(subscribe, snapshot)
