import type { SoundfontFile } from './soundfont/types'

/** Where the piano's samples come from. */
export type PianoSource =
  | { kind: 'salamander' }
  | { kind: 'sf2'; file: SoundfontFile; presetKey: string }

export const SALAMANDER_SOURCE: PianoSource = { kind: 'salamander' }
