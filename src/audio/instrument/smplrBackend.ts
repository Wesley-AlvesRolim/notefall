import type { SmplrGroup, SmplrPreset, SmplrRegion } from 'smplr'
import type {
  InstrumentPreset,
  PresetGroup,
  PresetRegion,
  SampleVoiceEngine,
  VoiceEngineOptions,
} from './types'

/**
 * The only module that talks to smplr. Everything else sees the app-owned
 * types in `./types`; the library is loaded on demand, so it stays out of
 * the startup bundle.
 */

// Side-effect import: patches AudioParam.prototype.linearRampToValueAtTime
// so smplr's linear release becomes an exponential decay. It has to be in
// place before the first voice is created, and this is the only place a
// voice engine is built.
import '../smoothRelease'

function toSmplrRegion(r: PresetRegion): SmplrRegion {
  const out: SmplrRegion = { sample: r.sample }
  if (r.pitch !== undefined) out.pitch = r.pitch
  if (r.keyRange) out.keyRange = r.keyRange
  if (r.velRange) out.velRange = r.velRange
  if (r.volume !== undefined) out.volume = r.volume
  if (r.detune !== undefined) out.detune = r.detune
  if (r.pan !== undefined) out.pan = r.pan
  if (r.offset !== undefined) out.offset = r.offset
  if (r.loop !== undefined) out.loop = r.loop
  if (r.loopStart !== undefined) out.loopStart = r.loopStart
  if (r.loopEnd !== undefined) out.loopEnd = r.loopEnd
  if (r.ampAttack !== undefined) out.ampAttack = r.ampAttack
  if (r.ampHold !== undefined) out.ampHold = r.ampHold
  if (r.ampDecay !== undefined) out.ampDecay = r.ampDecay
  if (r.ampSustain !== undefined) out.ampSustain = r.ampSustain
  return out
}

function toSmplrGroup(g: PresetGroup): SmplrGroup {
  const out: SmplrGroup = { regions: g.regions.map(toSmplrRegion) }
  if (g.velRange) out.velRange = g.velRange
  if (g.volume !== undefined) out.volume = g.volume
  return out
}

function toSmplrPreset(p: InstrumentPreset): SmplrPreset {
  return {
    meta: { name: p.name, license: p.license, source: p.source },
    // Pre-decoded buffers never touch the URL, but the schema wants one.
    samples: p.samples ?? { baseUrl: '', formats: [] },
    groups: p.groups.map(toSmplrGroup),
  }
}

export async function createVoiceEngine(
  ctx: BaseAudioContext,
  { preset, buffers, destination, storage, offline, onProgress }: VoiceEngineOptions,
): Promise<SampleVoiceEngine> {
  const { Instrument, Scheduler } = await import('smplr')

  // The plugin hands smplr our preset plus the pre-decoded buffers; the
  // stock `Sampler` takes no buffers next to a preset.
  const Piano = Instrument<{ preset: SmplrPreset; buffers?: Map<string, AudioBuffer> }>(
    (_ctx, options, smplr) =>
      smplr.loadInstrument(options.preset, { buffers: options.buffers }),
  )

  // Kept by reference: smplr reads each group's params on every note, so
  // changing `volume` here reaches the notes that follow.
  const smplrPreset = toSmplrPreset(preset)
  const instrument = Piano(ctx, {
    preset: smplrPreset,
    buffers,
    destination,
    storage,
    velocity: 100,
    // The default scheduler hands anything further ahead than its
    // lookahead to a `setInterval`, which never runs while an
    // `OfflineAudioContext` renders and would drop every note past the
    // first ~100 ms. An infinite lookahead dispatches each one at once.
    scheduler: offline ? Scheduler(ctx, { lookaheadMs: Number.POSITIVE_INFINITY }) : undefined,
    onLoadProgress: (p) => onProgress?.({ loaded: p.loaded, total: p.total }),
  })
  await instrument.ready

  return {
    start({ midi, velocity, time, stopId, release, detune }) {
      return instrument.start({
        note: midi,
        velocity,
        time,
        stopId,
        // The release time of the note's amplitude envelope, in seconds.
        ampRelease: release,
        detune,
      })
    },
    stopAll() {
      instrument.stop()
    },
    setGroupVolumes(db) {
      for (let i = 0; i < smplrPreset.groups.length && i < db.length; i++) {
        smplrPreset.groups[i].volume = db[i]
      }
    },
    dispose() {
      instrument.dispose()
    },
  }
}
