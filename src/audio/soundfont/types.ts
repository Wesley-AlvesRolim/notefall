/**
 * App-owned model of a parsed SoundFont (`.sf2`). Nothing here imports the
 * parsing library: `parser.ts` is the only file that does, and it fills in
 * these shapes. Generators are keyed by name, already merged (coarse + fine
 * address offsets are summed into frames), and left as the file stored them
 * (timecents, centibels, cents) for `toPreset.ts` to convert.
 */

export type SoundfontGenerators = {
  /** Frames into the sample to start from. */
  startOffset?: number
  /** Frames added to the sample header's loop start / end. */
  loopStartOffset?: number
  loopEndOffset?: number
  /** -500 (left) .. 500 (right), in 0.1 %. */
  pan?: number
  /** Volume envelope, in timecents (attack / hold / decay) and centibels of attenuation (sustain). */
  attack?: number
  hold?: number
  decay?: number
  sustain?: number
  /** Centibels of attenuation. */
  attenuation?: number
  coarseTune?: number
  fineTune?: number
  /** 0 = no loop, 1 = loop, 3 = loop while held. */
  sampleModes?: number
  /** MIDI note the sample sounds at; overrides the header's pitch. */
  rootKey?: number
}

export type SoundfontZone = {
  keyRange?: [number, number]
  velRange?: [number, number]
  gens: SoundfontGenerators
}

export type SoundfontSample = {
  name: string
  rate: number
  /** MIDI note the sample was recorded at. */
  pitch: number
  /** Cents. */
  pitchCorrection: number
  /** Loop points in frames from the sample start. */
  loopStart: number
  loopEnd: number
  data: Int16Array
}

export type SoundfontInstrument = {
  name: string
  globalZone?: SoundfontZone
  zones: Array<SoundfontZone & { sample: number }>
}

export type SoundfontPreset = {
  /** `bank:program`, unique inside a file. */
  key: string
  bank: number
  program: number
  name: string
  globalZone?: SoundfontZone
  zones: Array<SoundfontZone & { instrument: number }>
}

export type SoundfontFile = {
  samples: SoundfontSample[]
  instruments: SoundfontInstrument[]
  presets: SoundfontPreset[]
}

/** The file could not be read as a SoundFont. */
export class SoundfontError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SoundfontError'
  }
}
