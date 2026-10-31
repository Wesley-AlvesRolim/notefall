import { create } from 'zustand'

// View state of the floating shell that is not part of a project: which panels are open.
// (The Timeline's open state stays in `settings.timelineEditorOpen`.)

const LOOK_KEY = 'nf:ui:lookOpen'

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

function writeBool(key: string, v: boolean): void {
  try {
    window.localStorage.setItem(key, v ? '1' : '0')
  } catch {
    /* storage unavailable: keep the in-memory value */
  }
}

type ShellState = {
  lookOpen: boolean
  setLookOpen: (v: boolean) => void
  shortcutsOpen: boolean
  setShortcutsOpen: (v: boolean) => void
}

export const useShell = create<ShellState>((set) => ({
  lookOpen: readBool(LOOK_KEY, false),
  setLookOpen: (v) => {
    writeBool(LOOK_KEY, v)
    set({ lookOpen: v })
  },
  shortcutsOpen: false,
  setShortcutsOpen: (v) => set({ shortcutsOpen: v }),
}))
