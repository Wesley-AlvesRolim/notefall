import { create } from 'zustand'
import { useStore } from '../../store'
import { parseSoundfont } from './parser'
import type { SoundfontFile } from './types'

/**
 * The SoundFont the user loaded as the piano sound. Mirrors `userAudio`:
 * the original bytes are kept so the project can write them back out, and
 * the parsed model is what the audio engine builds its instrument from.
 */
type SoundfontStore = {
  fileName: string | null
  /** Original file bytes, re-serialised into the project. */
  fileBytes: ArrayBuffer | null
  file: SoundfontFile | null
  loading: boolean
  /** A human-readable message when the most recent file couldn't be read. */
  error: string | null

  /** User-gesture entry point (pick / drop). Marks the project dirty. */
  setFromFile: (file: File) => Promise<void>
  /** Project-load entry point: same parsing, no dirty mark. */
  setFromBytes: (bytes: ArrayBuffer, fileName: string) => Promise<void>
  /** Project-load clear (the opened project carries no SoundFont). No dirty mark. */
  clearFromLoad: () => void
  /** User-gesture clear ("Remove"). Marks dirty and drops the chosen preset. */
  clear: () => void
}

export const SOUNDFONT_EXTENSIONS = ['.sf2']

export function isSoundfontName(name: string): boolean {
  return /\.sf2$/i.test(name)
}

export const useSoundfont = create<SoundfontStore>((set, get) => {
  const reset = () =>
    set({ fileName: null, fileBytes: null, file: null, loading: false, error: null })

  const load = async (bytes: ArrayBuffer, fileName: string) => {
    set({ loading: true, error: null })
    try {
      const file = await parseSoundfont(new Uint8Array(bytes))
      set({ fileName, fileBytes: bytes, file, loading: false, error: null })
    } catch (e) {
      // A bad file must not leave the previous SoundFont half-applied.
      set({
        fileName: null,
        fileBytes: null,
        file: null,
        loading: false,
        error: e instanceof Error ? e.message : 'Could not read the SoundFont',
      })
      throw e
    }
  }

  return {
    fileName: null,
    fileBytes: null,
    file: null,
    loading: false,
    error: null,
    setFromFile: async (file) => {
      await load(await file.arrayBuffer(), file.name)
      // A different file has different presets: start from its default.
      useStore.getState().updateSettings({ soundfontPreset: null })
      useStore.getState().markDirty()
    },
    setFromBytes: async (bytes, fileName) => {
      await load(bytes, fileName)
    },
    clearFromLoad: () => reset(),
    clear: () => {
      if (get().file === null && get().fileBytes === null) return
      reset()
      useStore.getState().updateSettings({ soundfontPreset: null })
      useStore.getState().markDirty()
    },
  }
})
