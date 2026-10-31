import type { PedalEvent } from '../midi/types'

/**
 * Half-pedal model shared by the realtime engine and the offline render.
 *
 * CC64 values are normalised 0..1. `pedalLift` maps a value to how far the
 * dampers are lifted: 0 = resting on the strings, 1 = fully clear. Below
 * `DAMPER_TOUCH` the pedal does nothing, above `DAMPER_CLEAR` it is a full
 * sustain, in between the dampers graze the strings.
 *
 * smplr can't change a sounding voice's envelope, so a partial lift is
 * modelled as how long a released note keeps ringing: each held note
 * accumulates damping at `dampRate(lift)` per second and is released once
 * the total reaches 1. Full lift never damps (held until the pedal drops),
 * no lift releases at once, so an on/off pedal (0 / 127) behaves exactly
 * like a plain threshold.
 */
const DAMPER_TOUCH = 0.15
const DAMPER_CLEAR = 0.85
/** Seconds a released note keeps ringing at half lift. */
const HALF_LIFT_RING = 1.5

export function pedalLift(value: number): number {
  return Math.min(1, Math.max(0, (value - DAMPER_TOUCH) / (DAMPER_CLEAR - DAMPER_TOUCH)))
}

/** Damping accumulated per second at `lift`; Infinity = release now. */
export function dampRate(lift: number): number {
  if (lift <= 0) return Infinity
  if (lift >= 1) return 0
  return (1 - lift) / (lift * HALF_LIFT_RING)
}

/**
 * Release time of a note whose key goes up at `keyOff`, under the pedal
 * curve `pedals` (sorted, same time base). A pedal still up at the end
 * holds the note until `endTime`.
 */
export function pedalReleaseTime(pedals: PedalEvent[], keyOff: number, endTime: number): number {
  // Last pedal event at or before the key-off sets the starting lift.
  let lo = 0
  let hi = pedals.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pedals[mid].time <= keyOff) lo = mid + 1
    else hi = mid
  }
  let lift = lo > 0 ? pedalLift(pedals[lo - 1].value) : 0
  let t = keyOff
  let damp = 0
  for (let i = lo; ; i++) {
    const rate = dampRate(lift)
    if (rate === Infinity) return t
    const next = i < pedals.length ? pedals[i].time : Infinity
    if (rate > 0 && damp + rate * (next - t) >= 1) return t + (1 - damp) / rate
    if (next === Infinity) return Math.max(t, endTime)
    damp += rate * (next - t)
    t = next
    lift = pedalLift(pedals[i].value)
  }
}
