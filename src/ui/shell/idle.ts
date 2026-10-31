import { useEffect } from 'react'
import { create } from 'zustand'
import { useStore } from '../../store'

// Idle auto-hide of the floating chrome while a song plays. `hidden` flips true after
// IDLE_HIDE_MS without pointer movement (the cursor over the canvas is hidden with it) and
// back to false on any pointer movement, Tab, pause or when something holds it open.
// Surfaces read it with `useChromeHidden()`; the transport pill is the first consumer.

const IDLE_HIDE_MS = 2000

type IdleState = {
  hidden: boolean
  /** Reasons to stay visible (an open popover, a menu). Set/clear by key. */
  holds: ReadonlySet<string>
  /** The pointer is over the Customize panel: the chrome steps aside so the picture can be judged. */
  overPanel: boolean
  setOverPanel: (v: boolean) => void
  setHidden: (v: boolean) => void
  hold: (key: string, on: boolean) => void
}

export const useIdle = create<IdleState>((set, get) => ({
  hidden: false,
  holds: new Set(),
  overPanel: false,
  setOverPanel: (overPanel) => {
    if (get().overPanel !== overPanel) set({ overPanel })
  },
  setHidden: (hidden) => {
    if (get().hidden !== hidden) set({ hidden })
  },
  hold: (key, on) => {
    const holds = new Set(get().holds)
    if (on) holds.add(key)
    else holds.delete(key)
    if (holds.size !== get().holds.size) set({ holds })
  },
}))

/**
 * True while the chrome (islands, pill) should be faded out: playing + idle with nothing holding it
 * open, or the pointer is over the Customize panel (playing or paused; it comes back on leaving).
 * Only the idle case hides the cursor (Viewport).
 */
export const useChromeHidden = (): boolean => useIdle((s) => (s.hidden && s.holds.size === 0) || s.overPanel)

/** Mounted once (Layout): runs the idle timer. */
export function IdleDriver() {
  const playing = useStore((s) => s.transport === 'playing')
  useEffect(() => {
    const { setHidden } = useIdle.getState()
    if (!playing) {
      setHidden(false)
      return
    }
    let timer = 0
    const arm = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        // Never fade under an open menu, popover or dialog (it may be driven by the keyboard,
        // which produces no pointer moves); look again later.
        if (document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]')) arm()
        else setHidden(true)
      }, IDLE_HIDE_MS)
    }
    const onMove = (e: PointerEvent) => {
      setHidden(false)
      // A cursor parked on a control or a glass surface produces no further moves: keep
      // the chrome up instead of arming the timer under the user's hand.
      const target = e.target as HTMLElement | null
      if (target?.closest('button, [role="slider"], .nf-glass, .nf-glass-strong')) {
        window.clearTimeout(timer)
        return
      }
      arm()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        setHidden(false)
        arm()
      }
    }
    arm()
    window.addEventListener('pointermove', onMove)
    // a tap on a touch screen produces no move
    window.addEventListener('pointerdown', onMove)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onMove)
      window.removeEventListener('keydown', onKey)
      window.clearTimeout(timer)
      setHidden(false)
    }
  }, [playing])
  return null
}
