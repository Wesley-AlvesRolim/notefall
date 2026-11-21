/**
 * App-owned types for the sampled instrument. Nothing here imports a
 * third-party audio library: `smplrBackend.ts` is the only file that does,
 * and it maps these shapes onto the library's own (the same arrangement as
 * `export/codec/muxer.ts` for mediabunny).
 */

export type LoadProgress = { loaded: number; total: number }

/** One sample placed on the keyboard. Times are in seconds, volume in dB. */
export type PresetRegion = {
  /** Sample name: the file name under `samples.baseUrl`, or a key into the pre-decoded buffers. */
  sample: string
  /** MIDI note the sample was recorded at; keys in `keyRange` are pitch-shifted from it. */
  pitch?: number
  keyRange?: [number, number]
  velRange?: [number, number]
  volume?: number
  /** Extra tuning in cents. */
  detune?: number
  pan?: number
  /** Start this far into the sample. */
  offset?: number
  loop?: boolean
  loopStart?: number
  loopEnd?: number
  /** Volume envelope (seconds; sustain is a 0..1 level). Omitted = the instrument's default. */
  ampAttack?: number
  ampHold?: number
  ampDecay?: number
  ampSustain?: number
}

/** Regions that share a velocity layer and a gain. */
export type PresetGroup = {
  velRange?: [number, number]
  volume?: number
  regions: PresetRegion[]
}

export type InstrumentPreset = {
  name?: string
  license?: string
  source?: string
  /** Where the sample files live. Leave out when every sample comes pre-decoded. */
  samples?: { baseUrl: string; formats: string[] }
  groups: PresetGroup[]
}

/** The subset of a fetch `Response` the sample loader reads. A `Response` satisfies it. */
export type SampleResponse = {
  readonly status: number
  arrayBuffer(): Promise<ArrayBuffer>
  json(): Promise<unknown>
  text(): Promise<string>
}

export type SampleStorage = {
  fetch(url: string): Promise<SampleResponse>
}

/** Stops one started note. `time` is on the audio-context clock; default = now. */
export type VoiceStop = (time?: number) => void

export type VoiceStart = {
  midi: number
  /** MIDI velocity, 1..127. */
  velocity: number
  /** Audio-context time to start at; default = now. */
  time?: number
  /** Unique per voice, so a returned stop only ends this one. */
  stopId?: string
  /** Release time in seconds. */
  release?: number
  /** Tuning in cents. */
  detune?: number
}

export type SampleVoiceEngine = {
  start(note: VoiceStart): VoiceStop
  stopAll(): void
  /** Replace each group's gain (dB), index-aligned with the preset's groups. Applies to later notes. */
  setGroupVolumes(db: readonly number[]): void
  dispose(): void
}

export type VoiceEngineOptions = {
  preset: InstrumentPreset
  /** Pre-decoded samples keyed by `PresetRegion.sample`; these skip the fetch. */
  buffers?: Map<string, AudioBuffer>
  destination: AudioNode
  storage?: SampleStorage
  /**
   * Render into an `OfflineAudioContext`: every note is dispatched
   * synchronously instead of by a timer that never fires there.
   */
  offline?: boolean
  onProgress?: (p: LoadProgress) => void
}
