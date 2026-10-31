// Song -> hand motion. Pure: the same (song, mapping, humanize) always gives the same HandMotion, and
// `poseAt(motion, t)` is a pure function of song time, so the live preview and the offline exporter (which steps a
// virtual clock) draw identical hands. No Math.random anywhere in this folder (sway.ts seeds from note data).
//
// Tuning lives in `pose.ts` (`DEFAULT_MOTION_OPTIONS`) / `split.ts` / `reach.ts` / `fingering.ts` defaults. They are the
// user-approved values from `_local/hand-lab`, which stays the source of truth: retune there, then re-copy.

import type { ParsedSong } from '../midi/types'
import { MIDI_MAX, MIDI_MIN } from '../keyboard/layout'
import { midiToTimeline, type SpeedMap } from '../midi/speedMap'
import { assignFingers } from './fingering'
import { pedalRanges } from './pedal'
import { buildHandMotion, type HandMotion } from './pose'
import { pruneUnreachable } from './reach'
import { splitHands } from './split'
import { getTuning } from './tuning'
import type { MotionOptions } from './pose'
import type { ReachOptions } from './reach'
import type { SplitOptions } from './split'
import type { FingeringOptions } from './fingering'
import type { NoteEvent } from './types'

/** How the app places the song on the timeline (the same inputs FallingNotes uses). */
export type HandsTimeMap = {
  speedMap: SpeedMap
  midiOffsetSec: number
  trimStartSec: number
  trimEndSec: number
  transpose: number
}

/** Last build's numbers, for the dev panel (cheap; written on every build). */
export const lastBuild: { ms: number; notes: number; unreachable: number; motion: HandMotion | null; count: number } = {
  ms: 0,
  notes: 0,
  unreachable: 0,
  motion: null,
  count: 0,
}

export type HandsMotionSettings = { humanize: number }

/**
 * Builds the motion on the TIMELINE clock (`audioEngine.currentSongTime()`): note times go through the speed map and the
 * clip offset, notes outside the trim window are dropped, pitches get the global transpose.
 */
export function buildSongHandMotion(song: ParsedSong, map: HandsTimeMap, opts: HandsMotionSettings): HandMotion {
  const tl = (t: number) => map.midiOffsetSec + midiToTimeline(map.speedMap, t)
  const notes: NoteEvent[] = []
  for (const n of song.notes) {
    if (n.time < map.trimStartSec || n.time >= map.trimEndSec) continue
    const midi = n.midi + map.transpose
    if (midi < MIDI_MIN || midi > MIDI_MAX) continue
    const start = tl(n.time)
    const end = tl(Math.min(n.time + n.duration, map.trimEndSec))
    notes.push({ ...n, midi, time: start, duration: Math.max(0, end - start) })
  }
  notes.sort((a, b) => a.time - b.time || a.midi - b.midi)
  const t0 = performance.now()
  // Dev-only overrides (tuning.ts); all undefined in production, so the lab defaults apply.
  const tm = getTuning<MotionOptions>('motion')
  const split = splitHands(notes, song.tracks, getTuning<SplitOptions>('split'))
  const reach = pruneUnreachable(notes, split, {
    ...(tm?.handScale !== undefined ? { handScale: tm.handScale } : null),
    ...getTuning<ReachOptions>('reach'),
  })
  const plan = assignFingers(notes, reach.hands, getTuning<FingeringOptions>('fingering'))
  // song pedal values are 0..1, the lab's pedalRanges thresholds raw CC (>= 64)
  const pedal = pedalRanges(song.pedals.map((p) => ({ time: tl(p.time), value: p.value * 127 })))
  const motion = buildHandMotion(notes, plan, { ...tm, humanize: opts.humanize }, pedal)
  lastBuild.ms = performance.now() - t0
  lastBuild.notes = notes.length
  lastBuild.unreachable = reach.dropped.size
  lastBuild.motion = motion
  lastBuild.count++
  return motion
}
