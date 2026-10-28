// Reachability: notes one hand cannot physically take in a chord are dropped before fingering (they still sound —
// a real pianist rolls / redistributes / leaves them to the pedal; the hands just don't fake an impossible shape).
//
// Span limit from Boyle & Boyle's pianist hand-span calibration (paskpiano.org, "Hand span and maximum interval
// reach"): a 21.6 cm (8.5 in) 1-5 span plays an octave without tension, a 9th with minimal comfort and a 10th at the
// limit. The lab's hand (skeleton.ts: mean adult bones, 178 mm long; thumb from the OpenSim model with Barakat's
// abduction ranges) spans ~22.5 cm thumb–little at most, and takes every octave and a 9th with thumb and little finger
// on their keys (scripts/span-check.ts), so its limit is a 9th = 8 white-key steps; it scales with handScale.
import { WHITE_KEY_WIDTH, keyForMidi } from '../keyboard/layout'
import { CHORD_NARROW_SEC, CHORD_WIDE_SEC, groupChords } from './chord'
import type { Hand, Knobs, NoteEvent } from './types'

export interface ReachOptions extends Knobs {
  /** Widest chord one hand can take, in white-key steps between the outer key centres (7 = an octave, 8 = a 9th). */
  maxSpanWhite: number
  /** Notes starting within this many seconds form one chord. */
  clusterSec: number
  /** Rolled chords (wide intervals only) join up to this onset spread (see chord.ts). */
  wideSec: number
  /** Hand size multiplier (keep in sync with the motion's handScale). */
  handScale: number
}

export const DEFAULT_REACH_OPTIONS: ReachOptions = {
  maxSpanWhite: 8,
  clusterSec: CHORD_NARROW_SEC,
  wideSec: CHORD_WIDE_SEC,
  handScale: 1,
}

/**
 * Returns the hand map without unreachable notes, plus the dropped ids. Per hand and chord, keeps the largest
 * subset (at most 5 notes) that fits within the span; ties keep the outer voice (R: the top, L: the bass).
 */
export function pruneUnreachable(
  notes: NoteEvent[],
  hands: Map<number, Hand>,
  opts?: Partial<ReachOptions>,
): { hands: Map<number, Hand>; dropped: Set<number> } {
  const o = { ...DEFAULT_REACH_OPTIONS, ...opts }
  const maxSpan = o.maxSpanWhite * WHITE_KEY_WIDTH * o.handScale + 1e-6
  const kept = new Map(hands)
  const dropped = new Set<number>()
  for (const hand of ['L', 'R'] as const) {
    const mine = notes.filter((n) => hands.get(n.id) === hand).sort((a, b) => a.time - b.time)
    for (const grp of groupChords(mine, o.clusterSec, o.wideSec)) {
      if (grp.length > 1) {
        const chord = grp.map((n) => ({ id: n.id, x: keyForMidi(n.midi)?.x ?? 0 })).sort((a, b) => a.x - b.x)
        // Best window [a, b) by note count; ties prefer the outer voice.
        let best = [0, 1]
        for (let a = 0; a < chord.length; a++) {
          let b = a + 1
          while (b < chord.length && b - a < 5 && chord[b].x - chord[a].x <= maxSpan) b++
          const better = b - a > best[1] - best[0] || (b - a === best[1] - best[0] && hand === 'R')
          if (better) best = [a, b]
        }
        chord.forEach((c, k) => {
          if (k >= best[0] && k < best[1]) return
          kept.delete(c.id)
          dropped.add(c.id)
        })
      }
    }
  }
  return { hands: kept, dropped }
}
