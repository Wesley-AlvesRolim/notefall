import type { ParsedSong } from '../../midi/types'
import { midiToTimeline } from '../../midi/speedMap'
import type { Settings } from '../../store'
import { evaluateVelocityCurve } from '../../audio/velocityCurve'
import { LOOKAHEAD, STOP_BUFFER } from './consts'
import { pedalReleaseTime } from '../../audio/pedalDepth'
import type { ExportTimeline } from '../timeline'
import type { OfflinePiano, UserAudioTrack } from './types'

/**
 * Schedule the user-provided accompaniment alongside the piano. Goes
 * through its own GainNode so the mix volume is independent of the
 * sampler's. Negative offsets aren't supported in the MVP, so the
 * start time is always ≥ 0; if the offset overshoots the rendered
 * window the source simply never fires.
 */
export function scheduleUserAudio(
  ctx: OfflineAudioContext,
  userAudio: UserAudioTrack,
  settings: Settings,
  timeline: ExportTimeline,
): void {
  const { audioTrimStart, audioTrimEnd, totalDuration } = timeline
  if (userAudio.offsetSec >= totalDuration || audioTrimEnd <= audioTrimStart) return
  const src = ctx.createBufferSource()
  src.buffer = userAudio.buffer
  const gain = ctx.createGain()
  // Master × per-track stacking so the export tracks live playback.
  gain.gain.value = settings.volume * userAudio.volume
  src.connect(gain)
  gain.connect(ctx.destination)
  // Schedule with `(when, offset, duration)` so the trim window is
  // honoured by the audio graph itself rather than us needing to
  // pre-slice the buffer.
  const startTime = Math.max(0, userAudio.offsetSec + audioTrimStart)
  src.start(startTime, audioTrimStart, audioTrimEnd - audioTrimStart)
}

/**
 * Schedule every song note's on/off on the offline piano, with the
 * same trim, transpose, velocity-curve and pedal-sustain semantics as
 * the realtime engine's tick.
 */
export function scheduleSongNotes(
  piano: OfflinePiano,
  song: ParsedSong,
  settings: Settings,
  timeline: ExportTimeline,
): void {
  const { speedMap, midiOffset, midiTrimStart, midiTrimEnd, totalDuration } = timeline

  // Pedal handling. Mirror the engine: when settings.pedalEnabled is off,
  // ignore the song's pedal track entirely (notes release at their
  // natural offTime). Pedal events are stored in MIDI-time, so the
  // release is computed in MIDI-time and mapped at the per-note site below.
  const pedalEnd = totalDuration - midiOffset

  for (const n of song.notes) {
    // Trim filter — match the engine's tick semantics so a rendered
    // export sounds the same as live playback under the same trim.
    if (n.time < midiTrimStart) continue
    if (n.time >= midiTrimEnd) continue
    const playedMidi = n.midi + settings.transpose
    if (playedMidi < 0 || playedMidi > 127) continue

    const shaped = evaluateVelocityCurve(settings.velocityCurve, n.velocity)
    // n.time is MIDI-time; map through the speed curve and shift by
    // `midiOffset` to land on the export timeline. Without
    // automation `midiToTimeline` is the identity, so this collapses
    // to the linear `n.time + midiOffset` of before.
    const onTime = midiOffset + midiToTimeline(speedMap, n.time) + LOOKAHEAD
    // Clamp the natural note-off to the trim end (MIDI-time), then
    // optionally extend via the pedal (half-pedal aware, `audio/pedalDepth.ts`) (still MIDI-time), and
    // finally map to timeline-time.
    const naturalOff = Math.min(n.time + n.duration, midiTrimEnd)
    const sustained = settings.pedalEnabled
      ? pedalReleaseTime(song.pedals, naturalOff, pedalEnd)
      : naturalOff
    const offMidi = Math.min(sustained, midiTrimEnd)
    const actualOff = midiOffset + midiToTimeline(speedMap, offMidi)

    const stopFn = piano.start(playedMidi, shaped, onTime, `s${n.id}`)
    stopFn(actualOff + STOP_BUFFER)
  }
}
