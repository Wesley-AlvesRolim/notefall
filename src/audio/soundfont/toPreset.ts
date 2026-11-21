import type { InstrumentPreset, PresetRegion } from '../instrument/types'
import type {
  SoundfontFile,
  SoundfontGenerators,
  SoundfontPreset,
  SoundfontZone,
} from './types'
import { SoundfontError } from './types'

/**
 * Turns one SoundFont preset into an `InstrumentPreset` plus the decoded
 * sample buffers it refers to. This is the part smplr's own SF2 converter
 * skips: velocity layers, per-zone tuning and attenuation, loop mode,
 * sample start offsets, panning and the volume envelope.
 */

/** Presets, in the order a picker should show them. */
export function defaultPresetKey(presets: readonly SoundfontPreset[]): string {
  const piano = presets.find((p) => p.bank === 0 && p.program <= 7)
  return (piano ?? presets[0]).key
}

// Fade the first frames of every sample in, so a sample that doesn't
// start at zero doesn't click on attack.
const FADE_IN_SEC = 0.0015
// Timecents at or below this are "instant" (the spec's default is -12000).
const INSTANT_TC = -11000
const FULL_RANGE: [number, number] = [0, 127]

function timecentsToSec(tc: number): number {
  return Math.pow(2, tc / 1200)
}

/** The overlap of the given ranges (an absent one is unbounded), or null when they don't meet. */
function intersect(...ranges: Array<[number, number] | undefined>): [number, number] | null {
  let lo = 0
  let hi = 127
  for (const r of ranges) {
    if (!r) continue
    lo = Math.max(lo, r[0])
    hi = Math.min(hi, r[1])
  }
  return lo <= hi ? [lo, hi] : null
}

function isFull(r: [number, number]): boolean {
  return r[0] <= FULL_RANGE[0] && r[1] >= FULL_RANGE[1]
}

/** Instrument-level value: the zone's own, else the instrument's global zone, else the spec default. */
function instValue(
  zone: SoundfontZone,
  global: SoundfontZone | undefined,
  key: keyof SoundfontGenerators,
): number | undefined {
  return zone.gens[key] ?? global?.gens[key]
}

/** Preset-level offset, which adds to the instrument's value. */
function presetOffset(
  zone: SoundfontZone,
  global: SoundfontZone | undefined,
  key: keyof SoundfontGenerators,
): number {
  return zone.gens[key] ?? global?.gens[key] ?? 0
}

function addValue(
  iz: SoundfontZone,
  ig: SoundfontZone | undefined,
  pz: SoundfontZone,
  pg: SoundfontZone | undefined,
  key: keyof SoundfontGenerators,
  fallback: number,
): number {
  return (instValue(iz, ig, key) ?? fallback) + presetOffset(pz, pg, key)
}

export function soundfontToPreset(
  file: SoundfontFile,
  presetKey: string,
  ctx: BaseAudioContext,
): { preset: InstrumentPreset; buffers: Map<string, AudioBuffer> } {
  const sfPreset = file.presets.find((p) => p.key === presetKey)
  if (!sfPreset) throw new SoundfontError(`No such preset: ${presetKey}`)

  const regions: PresetRegion[] = []
  const buffers = new Map<string, AudioBuffer>()

  const bufferFor = (index: number): string | null => {
    const name = `s${index}`
    if (buffers.has(name)) return name
    const sample = file.samples[index]
    if (!sample || sample.data.length < 2) return null
    let buffer: AudioBuffer
    try {
      buffer = ctx.createBuffer(1, sample.data.length, sample.rate)
    } catch {
      return null // a sample rate the browser can't play
    }
    const out = buffer.getChannelData(0)
    for (let i = 0; i < out.length; i++) out[i] = sample.data[i] / 32768
    const fade = Math.min(out.length, Math.ceil(FADE_IN_SEC * sample.rate))
    for (let i = 0; i < fade; i++) out[i] *= i / fade
    buffers.set(name, buffer)
    return name
  }

  for (const pz of sfPreset.zones) {
    const inst = file.instruments[pz.instrument]
    if (!inst) continue
    for (const iz of inst.zones) {
      const sample = file.samples[iz.sample]
      if (!sample) continue
      const keyRange = intersect(
        iz.keyRange ?? inst.globalZone?.keyRange,
        pz.keyRange ?? sfPreset.globalZone?.keyRange,
      )
      const velRange = intersect(
        iz.velRange ?? inst.globalZone?.velRange,
        pz.velRange ?? sfPreset.globalZone?.velRange,
      )
      if (!keyRange || !velRange) continue
      const name = bufferFor(iz.sample)
      if (!name) continue

      const ig = inst.globalZone
      const pg = sfPreset.globalZone
      const rate = sample.rate

      const rootGen = instValue(iz, ig, 'rootKey')
      const root = rootGen !== undefined && rootGen >= 0 && rootGen <= 127 ? rootGen : sample.pitch
      const region: PresetRegion = { sample: name, pitch: root }
      if (!isFull(keyRange)) region.keyRange = keyRange
      if (!isFull(velRange)) region.velRange = velRange

      const attenuationCb = addValue(iz, ig, pz, pg, 'attenuation', 0)
      if (attenuationCb > 0) region.volume = -attenuationCb / 10

      const cents =
        addValue(iz, ig, pz, pg, 'coarseTune', 0) * 100 +
        addValue(iz, ig, pz, pg, 'fineTune', 0) +
        sample.pitchCorrection
      if (cents !== 0) region.detune = cents

      const pan = Math.max(-500, Math.min(500, addValue(iz, ig, pz, pg, 'pan', 0))) / 500
      if (pan !== 0) region.pan = pan

      const startOffset = instValue(iz, ig, 'startOffset') ?? 0
      if (startOffset > 0) region.offset = startOffset / rate

      const mode = instValue(iz, ig, 'sampleModes') ?? 0
      if (mode === 1 || mode === 3) {
        const start = sample.loopStart + (instValue(iz, ig, 'loopStartOffset') ?? 0)
        const end = sample.loopEnd + (instValue(iz, ig, 'loopEndOffset') ?? 0)
        if (start >= 0 && end > start && end <= sample.data.length) {
          region.loop = true
          region.loopStart = start / rate
          region.loopEnd = end / rate
        }
      }

      // Volume envelope. The release stays the app's Release setting.
      const attackTc = addValue(iz, ig, pz, pg, 'attack', -12000)
      const holdTc = addValue(iz, ig, pz, pg, 'hold', -12000)
      const sustainCb = Math.max(0, Math.min(1440, addValue(iz, ig, pz, pg, 'sustain', 0)))
      if (attackTc > INSTANT_TC) region.ampAttack = timecentsToSec(attackTc)
      if (holdTc > INSTANT_TC) region.ampHold = timecentsToSec(holdTc)
      if (sustainCb > 0) {
        region.ampDecay = timecentsToSec(addValue(iz, ig, pz, pg, 'decay', -12000))
        region.ampSustain = Math.pow(10, -sustainCb / 200)
      }

      regions.push(region)
    }
  }

  if (regions.length === 0) throw new SoundfontError('The preset has no playable samples')
  return {
    preset: { name: sfPreset.name, groups: [{ regions }] },
    buffers,
  }
}
