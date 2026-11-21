import type {
  SoundfontFile,
  SoundfontGenerators,
  SoundfontInstrument,
  SoundfontPreset,
  SoundfontZone,
} from './types'
import { SoundfontError } from './types'

/**
 * The only module that imports the SoundFont parser. It is loaded on demand
 * (a dynamic `import()`), so it stays out of the startup bundle, and its
 * types never leave this file: the result is the app-owned `SoundfontFile`.
 */

// Generator ids from the SF2 spec (section 8.1.2).
const GEN = {
  startAddrsOffset: 0,
  endAddrsOffset: 1,
  startLoopAddrsOffset: 2,
  endLoopAddrsOffset: 3,
  startAddrsCoarseOffset: 4,
  pan: 17,
  attackVolEnv: 34,
  holdVolEnv: 35,
  decayVolEnv: 36,
  sustainVolEnv: 37,
  keyRange: 43,
  velRange: 44,
  startLoopAddrsCoarseOffset: 45,
  initialAttenuation: 48,
  endLoopAddrsCoarseOffset: 50,
  coarseTune: 51,
  fineTune: 52,
  sampleModes: 54,
  overridingRootKey: 58,
} as const

// Address offsets come as a fine part plus a coarse part in units of 32768 frames.
const COARSE_FRAMES = 32768

type RawGen = { value?: number; range?: { lo: number; hi: number } }
type RawZone = {
  keyRange?: { lo: number; hi: number }
  generators: Record<number, RawGen | undefined>
}

function num(z: RawZone, id: number): number | undefined {
  return z.generators[id]?.value
}

function sumAddress(z: RawZone, fine: number, coarse: number): number | undefined {
  const f = num(z, fine)
  const c = num(z, coarse)
  if (f === undefined && c === undefined) return undefined
  return (f ?? 0) + (c ?? 0) * COARSE_FRAMES
}

function range(r: { lo: number; hi: number } | undefined): [number, number] | undefined {
  return r ? [r.lo, r.hi] : undefined
}

function convertZone(z: RawZone): SoundfontZone {
  const gens: SoundfontGenerators = {}
  const set = <K extends keyof SoundfontGenerators>(k: K, v: number | undefined) => {
    if (v !== undefined) gens[k] = v
  }
  set('startOffset', sumAddress(z, GEN.startAddrsOffset, GEN.startAddrsCoarseOffset))
  set('loopStartOffset', sumAddress(z, GEN.startLoopAddrsOffset, GEN.startLoopAddrsCoarseOffset))
  set('loopEndOffset', sumAddress(z, GEN.endLoopAddrsOffset, GEN.endLoopAddrsCoarseOffset))
  set('pan', num(z, GEN.pan))
  set('attack', num(z, GEN.attackVolEnv))
  set('hold', num(z, GEN.holdVolEnv))
  set('decay', num(z, GEN.decayVolEnv))
  set('sustain', num(z, GEN.sustainVolEnv))
  set('attenuation', num(z, GEN.initialAttenuation))
  set('coarseTune', num(z, GEN.coarseTune))
  set('fineTune', num(z, GEN.fineTune))
  set('sampleModes', num(z, GEN.sampleModes))
  set('rootKey', num(z, GEN.overridingRootKey))
  return {
    keyRange: range(z.keyRange ?? z.generators[GEN.keyRange]?.range),
    velRange: range(z.generators[GEN.velRange]?.range),
    gens,
  }
}

export async function parseSoundfont(bytes: Uint8Array): Promise<SoundfontFile> {
  const { SoundFont2 } = await import('soundfont2')
  let sf: InstanceType<typeof SoundFont2>
  try {
    sf = new SoundFont2(bytes)
  } catch (e) {
    throw new SoundfontError(e instanceof Error ? e.message : 'Not a valid SoundFont file')
  }

  const samples = sf.samples.map((s) => ({
    name: s.header.name,
    rate: s.header.sampleRate,
    pitch: s.header.originalPitch,
    pitchCorrection: s.header.pitchCorrection,
    // The parser already makes these relative to the sample's own data.
    loopStart: s.header.startLoop,
    loopEnd: s.header.endLoop,
    data: s.data,
  }))
  const sampleIndex = new Map(sf.samples.map((s, i) => [s, i]))

  // `globalZone` is on the parsed objects but missing from the typings.
  type WithGlobal = { globalZone?: RawZone }
  const instruments: SoundfontInstrument[] = sf.instruments.map((inst) => {
    const g = (inst as unknown as WithGlobal).globalZone
    return {
      name: inst.header.name,
      globalZone: g ? convertZone(g) : undefined,
      zones: inst.zones.map((z) => ({
        ...convertZone(z as unknown as RawZone),
        sample: sampleIndex.get(z.sample) ?? -1,
      })),
    }
  })
  const instrumentIndex = new Map(sf.instruments.map((inst, i) => [inst, i]))

  const presets: SoundfontPreset[] = sf.presets.map((p) => {
    const g = (p as unknown as WithGlobal).globalZone
    return {
      key: `${p.header.bank}:${p.header.preset}`,
      bank: p.header.bank,
      program: p.header.preset,
      name: p.header.name,
      globalZone: g ? convertZone(g) : undefined,
      zones: p.zones.map((z) => ({
        ...convertZone(z as unknown as RawZone),
        instrument: instrumentIndex.get(z.instrument) ?? -1,
      })),
    }
  })

  if (presets.length === 0) throw new SoundfontError('The SoundFont has no presets')
  return { samples, instruments, presets }
}
