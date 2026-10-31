import { useEffect } from 'react'

// A control pressed with the mouse doesn't keep keyboard focus (as in a DAW): the next key goes
// to the app's shortcuts and the PC-keyboard piano, and no focus ring appears around the last
// clicked button when a key is pressed. Text fields and sliders keep focus (typing, arrow
// nudges); dialogs keep theirs (their focus is managed). Keyboard users are unaffected: Tab
// still moves focus and shows the ring.
const RELEASE =
  'button, [role="button"], [role="radio"], input[type="radio"], input[type="checkbox"], [role="switch"], [role="tab"], [role="menuitem"]'

/** How long after a pointer press a control landing in focus counts as mouse-driven (a menu or
 *  popover closing restores focus to its trigger a moment after the click). */
const POINTER_WINDOW_MS = 800

export function useReleaseFocusAfterPointer(): void {
  useEffect(() => {
    let lastPointer = -Infinity
    const release = () => {
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body) return
      if (!el.matches(RELEASE)) return
      if (el.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return
      el.blur()
    }
    const onPointerUp = () => {
      lastPointer = performance.now()
      // after the press has been handled (react-aria acts on pointerup)
      window.setTimeout(release, 0)
    }
    const onFocusIn = () => {
      if (performance.now() - lastPointer < POINTER_WINDOW_MS) window.setTimeout(release, 0)
    }
    const onKeyDown = () => {
      lastPointer = -Infinity
    }
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('focusin', onFocusIn, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('focusin', onFocusIn, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])
}
