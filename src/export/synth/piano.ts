import { Scheduler } from 'smplr'
import type { Settings } from '../../store'
import { createPiano } from '../../audio/sampler'
import { raceWithAbort } from '../async'
import { AudioRenderAborted } from '../errors'
import type { AudioRenderProgress, OfflinePiano } from './types'

/**
 * Bring the piano up against the offline context. Reuses the
 * realtime-engine's effect-chain wiring (master → 6-band EQ → split →
 * dry / pre-delay → reverb → wet) verbatim — same setters, same IR
 * synthesis — so render parity with live playback is "free".
 *
 * The custom scheduler is critical: smplr's default Scheduler defers
 * any event scheduled more than ~100 ms ahead to a setInterval-driven
 * dispatcher. That dispatcher never gets a chance to run during
 * OfflineAudioContext.startRendering() (the render is one synchronous
 * microtask burst from the caller's perspective), so the default
 * would dispatch only the first ~100 ms of notes and silently drop
 * everything afterward. A Scheduler with an effectively-infinite
 * lookahead forces every `piano.start()` call to dispatch its voice
 * synchronously, scheduling each AudioBufferSourceNode at the
 * correct absolute time via `source.start(time)` — sample-accurate
 * because Web Audio honours the absolute time even on offline ctx.
 */
export async function loadOfflinePiano(
  ctx: OfflineAudioContext,
  settings: Settings,
  gain: number,
  onProgress?: (p: AudioRenderProgress) => void,
  signal?: AbortSignal,
): Promise<OfflinePiano> {
  onProgress?.({ phase: 'loading', loaded: 0, total: 1 })
  // Race against the abort signal so Cancel is responsive even during
  // the ~60 MB sample fetch — without this, `await createPiano` blocks
  // for the entire load before the next signal check fires.
  const piano = await raceWithAbort(
    createPiano(
      ctx,
      (p) => {
        onProgress?.({ phase: 'loading', loaded: p.loaded, total: p.total })
      },
      {
        scheduler: new Scheduler(ctx, { lookaheadMs: Number.POSITIVE_INFINITY }),
      },
    ),
    signal,
    () => new AudioRenderAborted(),
  )
  applyPianoSettings(piano, settings, gain)
  return piano
}

/**
 * Apply settings BEFORE scheduling any notes so the render pass sees
 * them at currentTime=0. setTargetAtTime ramps complete in well under
 * a millisecond at the given time constants, so notes scheduled at
 * t=LOOKAHEAD already inherit the final values.
 */
function applyPianoSettings(piano: OfflinePiano, settings: Settings, gain: number): void {
  piano.setVolume(gain)
  piano.setReverbDry(settings.reverbDry)
  piano.setReverbWet(settings.reverbEnabled ? settings.reverbWet : 0)
  piano.setReverbSize(settings.reverbSize)
  piano.setReverbDecayTime(settings.reverbDecayTime)
  piano.setReverbDecay(settings.reverbDecay)
  piano.setReverbPreDelay(settings.reverbPreDelay)
  piano.setReverbDamping(settings.reverbDamping)
  piano.setReverbHiCut(settings.reverbHiCut)
  piano.setReverbLowCut(settings.reverbLowCut)
  piano.setReleaseTime(settings.releaseTime)
  piano.setDetune(settings.samplerDetune)
  piano.setVelocityCompensation(settings.velocityCompensation)
  for (let i = 0; i < settings.eqBands.length; i++) {
    piano.setEqBand(i, settings.eqBands[i])
  }
}
