/**
 * Runtime patch that converts smplr's hard-coded linear release ramp
 * into an exponential decay (Web Audio `setTargetAtTime`).
 *
 * Why this exists:
 *
 *   smplr's `Voice.stop` runs this exact sequence to fade a voice:
 *
 *     envelope.gain.cancelScheduledValues(t)
 *     envelope.gain.setValueAtTime(1, t)
 *     envelope.gain.linearRampToValueAtTime(0, stopAt)
 *
 *   The linear ramp from 1 → 0 in dB-domain looks abrupt: a linear
 *   amplitude curve drops 6 dB only after half the duration, then
 *   crashes through −∞ near the end. Real piano releases decay
 *   exponentially, so users perceive smplr's release as "snipped".
 *   smplr exposes no hook to change the ramp shape (one hardcoded
 *   call site), and the Voice class is private, so we can't subclass
 *   or wrap it cleanly.
 *
 *   This module patches `AudioParam.prototype.linearRampToValueAtTime`
 *   so that **only when the target is exactly 0 and a non-zero
 *   `setValueAtTime` happened earlier on the same param**, the call
 *   is rerouted to `setTargetAtTime(0, startTime, duration/5)` — an
 *   exponential approach that hits ~0.7 % gain (effectively silent)
 *   by `endTime` and trails off naturally past that.
 *
 *   The guard "target === 0 AND last setValueAtTime > 0" is specific
 *   enough to match smplr's release pattern without breaking other
 *   `linearRampToValueAtTime(0, …)` users (we don't have any
 *   ourselves — `exportChime` ramps to a non-zero peak then uses
 *   `exponentialRampToValueAtTime` for its decay).
 *
 *   The patch is global and idempotent — calling the module multiple
 *   times reuses the same wrapped methods.
 */

type SetValueAtTime = AudioParam['setValueAtTime']
type LinearRamp = AudioParam['linearRampToValueAtTime']

// Marker so a second import of this module doesn't double-wrap.
const PATCHED_FLAG = Symbol.for('notefall.smoothRelease.patched')

type PatchedProto = AudioParam & { [PATCHED_FLAG]?: boolean }

function install(): void {
  const proto = AudioParam.prototype as PatchedProto
  if (proto[PATCHED_FLAG]) return

  const lastSetValue = new WeakMap<AudioParam, { value: number; time: number }>()
  const origSetValueAtTime: SetValueAtTime = proto.setValueAtTime
  const origLinearRamp: LinearRamp = proto.linearRampToValueAtTime

  proto.setValueAtTime = function (this: AudioParam, value: number, time: number) {
    lastSetValue.set(this, { value, time })
    return origSetValueAtTime.call(this, value, time)
  }

  proto.linearRampToValueAtTime = function (
    this: AudioParam,
    value: number,
    endTime: number,
  ) {
    if (value === 0) {
      const last = lastSetValue.get(this)
      if (last && last.value > 0 && endTime > last.time) {
        // Inside `holdRelease`: hand the envelope to the caller instead.
        if (capture) {
          capture.params.push(this)
          return this
        }
        const duration = endTime - last.time
        // tc = duration / 5 → after `duration` seconds, gain ≈ e^-5 ≈
        // 0.0067 (≈ −43 dB), which the listener perceives as silent
        // while preserving the original "release length" envelope.
        const tc = duration / 5
        return this.setTargetAtTime(0, last.time, tc)
      }
    }
    return origLinearRamp.call(this, value, endTime)
  }

  const srcProto = AudioScheduledSourceNode.prototype
  const origStop = srcProto.stop
  srcProto.stop = function (this: AudioScheduledSourceNode, when?: number) {
    // Inside `holdRelease`: keep the source alive (a later `end` call
    // replaces this stop time; only the last stop() call applies).
    if (capture) {
      capture.sources.push(this)
      return origStop.call(this, (when ?? 0) + HOLD_SAFETY_SEC)
    }
    return origStop.call(this, when)
  }

  proto[PATCHED_FLAG] = true
}

install()

/**
 * Half-pedal support. smplr's `Voice.stop` ramps the envelope and stops the
 * source in one go; a damper that only grazes the strings needs the decay
 * rate to follow the pedal instead. `holdRelease` calls a smplr stop fn
 * while capturing that voice's envelope param and source: no release ramp
 * is scheduled, and the caller drives the fade with `decay` (re-targetable
 * at any time; each `setTargetAtTime` starts from the value reached so far)
 * and ends it with `end`. A voice that hadn't started yet is stopped as
 * smplr asked. Works on realtime and offline contexts alike.
 */
export type HeldVoice = {
  /** From `time`, decay exponentially with time constant `tc` seconds. */
  decay(time: number, tc: number): void
  /** Stop the source at `time`. */
  end(time: number): void
}

// Upper bound on how long a captured voice can be left running if its
// owner never ends it.
const HOLD_SAFETY_SEC = 600
// A time constant this long is a hold (no audible decay).
const MAX_TC = 1e4

let capture: { params: AudioParam[]; sources: AudioScheduledSourceNode[] } | null = null

export function holdRelease(stop: (time?: number) => void, time: number): HeldVoice {
  const c = { params: [] as AudioParam[], sources: [] as AudioScheduledSourceNode[] }
  capture = c
  try {
    stop(time)
  } finally {
    capture = null
  }
  if (c.params.length === 0) {
    for (const s of c.sources) s.stop(time)
    c.sources = []
  }
  return {
    decay(t, tc) {
      for (const p of c.params) p.setTargetAtTime(0, t, Math.min(tc, MAX_TC))
    },
    end(t) {
      for (const s of c.sources) s.stop(t)
    },
  }
}
