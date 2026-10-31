import type { PedalEvent } from '../midi/types'

/**
 * Half-pedal model shared by the realtime engine and the offline render.
 *
 * CC64 values are normalised 0..1. `pedalLift` maps a value to how far the
 * dampers are lifted: 0 = resting on the strings, 1 = fully clear. Below
 * `DAMPER_TOUCH` the pedal does nothing, above `DAMPER_CLEAR` it is a full
 * sustain, in between the dampers graze the strings.
 *
 * A released note under the pedal fades exponentially with the time constant
 * `dampTc(lift)` (applied through `smoothRelease.holdRelease`), re-targeted
 * whenever the pedal moves: full lift holds, a lighter pedal fades faster,
 * no lift is the normal key release. So an on/off pedal (0 / 127) behaves
 * exactly like a plain threshold.
 */
const DAMPER_TOUCH = 0.15
const DAMPER_CLEAR = 0.85
/** Fade time constant at half lift (seconds). */
const HALF_LIFT_TC = 0.4
/** Faded this many time constants (e^-7 ≈ -61 dB) = silent, stop the voice. */
export const SILENT_TCS = 7

export function pedalLift(value: number): number {
  return Math.min(1, Math.max(0, (value - DAMPER_TOUCH) / (DAMPER_CLEAR - DAMPER_TOUCH)))
}

/**
 * Fade time constant at `lift`. `releaseTc` is the plain key release's
 * (smoothRelease: release time / 5), used at no lift and as the floor.
 */
export function dampTc(lift: number, releaseTc: number): number {
  if (lift >= 1) return Infinity
  if (lift <= 0) return releaseTc
  return Math.max(releaseTc, (HALF_LIFT_TC * lift) / (1 - lift))
}

/** Lift in force at `time`: the last pedal event at or before it. */
export function liftAt(pedals: PedalEvent[], time: number): { lift: number; next: number } {
  let lo = 0
  let hi = pedals.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pedals[mid].time <= time) lo = mid + 1
    else hi = mid
  }
  return { lift: lo > 0 ? pedalLift(pedals[lo - 1].value) : 0, next: lo }
}
