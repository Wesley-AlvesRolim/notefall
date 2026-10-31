import { useEffect } from 'react'

// A control pressed with the mouse doesn't keep keyboard focus (as in a DAW): the next key goes
// to the app's shortcuts and the PC-keyboard piano, and no focus ring appears around the last
// clicked button when a key is pressed. Text fields and sliders keep focus (typing, arrow
// nudges); dialogs keep theirs (their focus is managed). Keyboard users are unaffected: Tab
// still moves focus and shows the ring.
const RELEASE =
  'button, [role="button"], [role="radio"], input[type="radio"], input[type="checkbox"], [role="switch"], [role="tab"], [role="menuitem"]'

export function useReleaseFocusAfterPointer(): void {
  useEffect(() => {
    const onPointerUp = () => {
      // after the press has been handled (react-aria acts on pointerup)
      window.setTimeout(() => {
        const el = document.activeElement as HTMLElement | null
        if (!el || el === document.body) return
        if (!el.matches(RELEASE)) return
        if (el.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return
        el.blur()
      }, 0)
    }
    window.addEventListener('pointerup', onPointerUp, true)
    return () => window.removeEventListener('pointerup', onPointerUp, true)
  }, [])
}
