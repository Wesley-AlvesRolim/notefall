// Fingering: per hand, Viterbi over onset clusters (chords). A state = which fingers play the cluster's notes.
// Hand-written Parncutt (1997) / Jacobs (2001)-style rules; the numbers are NOT fitted to any dataset.
//
// The left hand is mirrored (pitch -> -pitch) so both hands share one model where "higher in mirrored
// pitch = higher finger number". Colour (black/white) keeps using the real pitch.
import { isBlackKey } from '../keyboard/layout'
import { CHORD_NARROW_SEC, CHORD_WIDE_SEC, groupChords } from './chord'
import type { Finger, Hand, HandPlan, Knobs, NoteEvent } from './types'

export interface FingeringOptions extends Knobs {
  /** Notes within this many seconds of the cluster's first onset form a chord. */
  clusterSec: number
  /** Rolled chords (wide intervals only) join up to this onset spread (see chord.ts). */
  wideSec: number
  /** Onset gap (s) below which transition costs count fully. */
  gapFullSec: number
  /** Onset gap (s) from which the hand repositions freely (costs fall to `gapFloor`). */
  gapFreeSec: number
  /** Fraction of transition cost that remains after a long gap. */
  gapFloor: number
  /** Per semitone beyond the comfortable span of a finger pair. */
  wStretchComf: number
  /** Extra per semitone beyond the practical (max) span. */
  wStretchPrac: number
  /** Per semitone a finger pair is squeezed below its comfortable minimum. */
  wSqueeze: number
  /** Thumb passing under / finger crossing over: base cost scale (x per-finger factor). */
  wCross: number
  /** Extra crossing cost per semitone of the interval beyond a semitone (crossing is easiest over E-F / B-C). */
  wCrossStep: number
  /** Crossing that is not thumb<->2/3/4 (practically forbidden). */
  wForbidden: number
  /** A leap of at least `hopSemis` with at least `hopSec` between onsets lets the hand re-place itself: finger order stops mattering, a flat cost applies instead. */
  wHop: number
  hopSemis: number
  hopSec: number
  /** Tempo: onset gap (s) below which a note counts as 'fast'; the weak-finger costs grow linearly up to
   *  (1 + wFastWeak) x at gap 0, and in fast passages finger 5 is priced like 4 (strong fingers 1-2-3 preferred). */
  fastSec: number
  wFastWeak: number
  /** Parncutt 3<->4 transition (the ring finger is tied to the middle finger). */
  wThree4: number
  /** Finger 4 on a black key. */
  wFourBlack: number
  wWeak4: number
  wWeak5: number
  wThumbBlack: number
  wFiveBlack: number
  /** Index finger on a black key (the long fingers 3 / 4 are preferred there). */
  wTwoBlack: number
  /** Same finger, same key again. Full weight at ioi=0, fading to 0 at `repeatSec`. */
  wRepeat: number
  repeatSec: number
  /** Same finger on a different key. */
  wSameFinger: number
  /** Hand-position (diatonic) shift: flat cost per shift larger than `shiftTol` keys + per white key. */
  wShiftCount: number
  wShiftSize: number
  shiftTol: number
  /** Hand-shift speed budget (m/s, white key 23.5 mm): cost per unit of speed beyond the sustained / peak limit,
   *  relative to that limit. Replaces the flat 'free hop at any speed' of fast passages. */
  vSoft: number
  vPeak: number
  wSpeed: number
  wSpeedPeak: number
  /** Chord: stretch/squeeze weight, and deviation from the "natural" finger spacing. */
  wChordSpan: number
  wChordIdeal: number
  /** Hand-position memory: per white key a cluster's position (thumb's key) strays from the path's running
   *  position beyond `anchorTol`. Sees past the previous note, so 5-1-3-1 beats 5-1-2-1 in an Alberti bass. */
  wAnchor: number
  anchorTol: number
  /** Running-position smoothing per cluster (1 = previous cluster only). */
  anchorRate: number
  /** Fingers 2–4 on a black key sit this many white keys closer to the thumb than in a five-finger position (the
   *  black keys lie further in, so 1-3-1-3 chromatics keep one hand position). */
  blackCompact: number
}

export const DEFAULT_FINGERING_OPTIONS: FingeringOptions = {
  clusterSec: CHORD_NARROW_SEC,
  wideSec: CHORD_WIDE_SEC,
  gapFullSec: 0.2,
  gapFreeSec: 0.55,
  gapFloor: 0.15,
  wStretchComf: 1,
  wStretchPrac: 3,
  wSqueeze: 0.5,
  wCross: 1,
  wCrossStep: 1,
  wForbidden: 12,
  wHop: 3,
  hopSemis: 3,
  hopSec: 0.08,
  fastSec: 0.2,
  wFastWeak: 3,
  wThree4: 0.3,
  wFourBlack: 0.5,
  wWeak4: 0.7,
  wWeak5: 0.2,
  wThumbBlack: 1,
  wFiveBlack: 0.5,
  wTwoBlack: 0.3,
  wRepeat: 4,
  repeatSec: 0.4,
  wSameFinger: 6,
  wShiftCount: 3,
  wShiftSize: 0.15,
  shiftTol: 1.5,
  vSoft: 1,
  vPeak: 2,
  wSpeed: 3,
  wSpeedPeak: 6,
  wChordSpan: 1,
  wChordIdeal: 0.1,
  wAnchor: 0.5,
  anchorTol: 0.5,
  anchorRate: 0.5,
  blackCompact: 1,
}

// Span between fingers lo<hi in semitones (pitch(hi) - pitch(lo)): [minPrac, minComf, maxComf, maxPrac].
// Negative minimums = the thumb sits above the other finger (crossing).
const SPAN: Record<number, [number, number, number, number]> = {
  12: [-5, -3, 5, 8],
  13: [-4, -2, 7, 10],
  14: [-3, -1, 9, 12],
  15: [-1, 1, 10, 13],
  23: [1, 1, 2, 3],
  24: [1, 2, 4, 5],
  25: [2, 3, 6, 9],
  34: [1, 1, 2, 3],
  35: [1, 2, 4, 6],
  45: [1, 1, 2, 3],
}
const CROSS_FACTOR = [0, 0, 1.5, 1, 1.5] // indexed by the non-thumb finger (2..4)

// White-key position of a note (black = half a step above the white key below it).
const WHITE_PC_INDEX = [0, 0.5, 1, 1.5, 2, 3, 3.5, 4, 4.5, 5, 5.5, 6]
function keyPos(midi: number): number {
  return Math.floor(midi / 12) * 7 + WHITE_PC_INDEX[midi % 12]
}

// Finger sets per note count: ascending finger tuples.
const COMBOS: Finger[][][] = [[[]]]
for (let k = 1; k <= 5; k++) {
  const res: Finger[][] = []
  const rec = (start: number, acc: Finger[]) => {
    if (acc.length === k) return void res.push(acc.slice())
    for (let f = start; f <= 5; f++) {
      acc.push(f as Finger)
      rec(f + 1, acc)
      acc.pop()
    }
  }
  rec(1, [])
  COMBOS.push(res)
}

type Item = { id: number; mp: number; kp: number; black: boolean; user?: Finger }
type Cluster = { time: number; items: Item[]; sel: number[]; near: Int8Array | null; fast: number }

/** A finger set on the note (selection card) is all but fixed: the search plans the rest around it. */
const USER_FINGER_COST = 1e4

export function assignFingers(
  notes: NoteEvent[],
  hands: Map<number, Hand>,
  opts?: Partial<FingeringOptions>,
): HandPlan {
  const o = { ...DEFAULT_FINGERING_OPTIONS, ...opts } as FingeringOptions
  const plan: HandPlan = new Map()
  for (const hand of ['L', 'R'] as const) {
    const mine = notes.filter((n) => hands.get(n.id) === hand)
    if (mine.length) fingerHand(mine, hand, o, plan)
  }
  return plan
}

/** White keys from the thumb's key to finger f's key in the hand's current position. */
function fingerOffset(f: number, black: boolean, o: FingeringOptions): number {
  return black && f >= 2 && f <= 4 ? f - 1 - o.blackCompact : f - 1
}

function stretchCost(D: number, lo: number, hi: number, o: FingeringOptions): number {
  const t = SPAN[lo * 10 + hi]
  let c = 0
  if (D > t[2]) c += o.wStretchComf * (D - t[2])
  if (D > t[3]) c += o.wStretchPrac * (D - t[3])
  if (D < t[1]) c += o.wSqueeze * (t[1] - D)
  return c
}

/** Cost of playing note (f2, b) after note (f1, a). `mult` = gap scaling, `ioi` = onset gap. */
function pairCost(a: Item, f1: number, b: Item, f2: number, mult: number, ioi: number, o: FingeringOptions, chords = false): number {
  const d = b.mp - a.mp
  let c = 0
  if (f1 === f2) {
    // (chord to chord, the same finger on the same key is the normal repeated-chord fingering)
    if (d === 0) return chords ? 0 : o.wRepeat * Math.max(0, 1 - ioi / o.repeatSec)
    c += o.wSameFinger
  } else if (d !== 0) {
    if ((f1 === 3 && f2 === 4) || (f1 === 4 && f2 === 3)) c += o.wThree4
    const lo = Math.min(f1, f2)
    const hi = Math.max(f1, f2)
    const D = f1 < f2 ? d : -d // pitch(hi) - pitch(lo)
    const hop = Math.abs(d) >= o.hopSemis && ioi >= o.hopSec
    if (D < 0) {
      let x: number
      if (lo === 1 && hi <= 4) {
        x = o.wCross * CROSS_FACTOR[hi] + o.wCrossStep * Math.max(0, Math.abs(d) - 1)
        const t = SPAN[10 + hi]
        if (D < t[1]) x += o.wStretchComf * (t[1] - D)
        if (D < t[0]) x += o.wStretchPrac * (t[0] - D)
      } else x = o.wForbidden * (1 - D / 4)
      c += hop ? Math.min(x, o.wHop) : x
    } else c += stretchCost(D, lo, hi, o)
  }
  // Hand-position shift: fingers on consecutive white keys keep the hand where it is.
  const shift = Math.abs(b.kp - fingerOffset(f2, b.black, o) - (a.kp - fingerOffset(f1, a.black, o)))
  if (shift > o.shiftTol) {
    c += o.wShiftCount + o.wShiftSize * shift
    const v = (shift * 0.0235) / Math.max(ioi, 0.03)
    c += o.wSpeed * Math.max(0, v - o.vSoft) / o.vSoft + o.wSpeedPeak * Math.max(0, v - o.vPeak) / o.vPeak
  }
  return c * mult
}

function fingerHand(mine: NoteEvent[], hand: Hand, o: FingeringOptions, plan: HandPlan): void {
  const sign = hand === 'R' ? 1 : -1
  const sorted = mine.slice().sort((a, b) => a.time - b.time || sign * (a.midi - b.midi))
  const clusters: Cluster[] = []
  for (const cur of groupChords(sorted, o.clusterSec, o.wideSec)) {
    const items: Item[] = cur.map((n) => ({ id: n.id, mp: sign * n.midi, kp: sign * keyPos(n.midi), black: isBlackKey(n.midi), user: n.finger }))
    items.sort((a, b) => a.mp - b.mp)
    const n = items.length
    // More than 5 notes: finger an evenly spread subset (always incl. both extremes); the rest copy
    // the finger of the nearest fingered note.
    const sel = n <= 5 ? items.map((_, i) => i) : [0, 1, 2, 3, 4].map((i) => Math.round((i * (n - 1)) / 4))
    clusters.push({ time: cur[0].time, items, sel, near: null, fast: 0 })
  }

  // Tempo: how fast the passage is around each cluster (0 = slow, 1 = simultaneous), from the nearer neighbour.
  for (let c = 0; c < clusters.length; c++) {
    const gp = c > 0 ? clusters[c].time - clusters[c - 1].time : Infinity
    const gn = c + 1 < clusters.length ? clusters[c + 1].time - clusters[c].time : Infinity
    clusters[c].fast = Math.min(1, Math.max(0, 1 - Math.min(gp, gn) / o.fastSec))
  }

  // Per cluster: nearest selected note of the previous cluster for each selected note (transition pairing).
  for (let c = 1; c < clusters.length; c++) {
    const pc = clusters[c - 1]
    const cl = clusters[c]
    cl.near = Int8Array.from(cl.sel, (si) => {
      let best = 0
      let bd = Infinity
      pc.sel.forEach((pj, k) => {
        const dd = Math.abs(pc.items[pj].mp - cl.items[si].mp)
        if (dd < bd) { bd = dd; best = k }
      })
      return best
    })
  }

  const staticCost = (cl: Cluster, fs: Finger[]): number => {
    let c = 0
    for (let k = 0; k < fs.length; k++) {
      const it = cl.items[cl.sel[k]]
      const f = fs[k]
      if (it.user !== undefined && it.user !== f) c += USER_FINGER_COST
      const tf = 1 + o.wFastWeak * cl.fast
      if (f === 4) c += o.wWeak4 * tf
      else if (f === 5) c += (o.wWeak5 + cl.fast * Math.max(0, o.wWeak4 - o.wWeak5)) * tf
      if (f === 4 && it.black) c += o.wFourBlack
      if (it.black) {
        if (f === 1) c += o.wThumbBlack
        else if (f === 5) c += o.wFiveBlack
        else if (f === 2) c += o.wTwoBlack
      }
    }
    for (let i = 0; i < fs.length; i++)
      for (let j = i + 1; j < fs.length; j++) {
        const D = cl.items[cl.sel[j]].mp - cl.items[cl.sel[i]].mp
        const df = fs[j] - fs[i]
        c += o.wChordSpan * stretchCost(D, fs[i], fs[j], o)
        c += o.wChordIdeal * Math.abs(D - 2 * df)
      }
    return c
  }

  // Thumb position implied by a state (mean over its notes, white-key units).
  const anchorOf = (cl: Cluster, fs: Finger[]): number => {
    let a = 0
    for (let k = 0; k < fs.length; k++) a += cl.items[cl.sel[k]].kp - fingerOffset(fs[k], cl.items[cl.sel[k]].black, o)
    return a / fs.length
  }

  const scores: Float64Array[] = []
  let anchors = new Float64Array(0)
  const backs: Int16Array[] = []
  for (let ci = 0; ci < clusters.length; ci++) {
    const cl = clusters[ci]
    const states = COMBOS[cl.sel.length]
    const sc = new Float64Array(states.length)
    const bk = new Int16Array(states.length)
    const an = new Float64Array(states.length)
    if (ci === 0) {
      for (let s = 0; s < states.length; s++) {
        sc[s] = staticCost(cl, states[s])
        an[s] = anchorOf(cl, states[s])
      }
    } else {
      const pc = clusters[ci - 1]
      const pStates = COMBOS[pc.sel.length]
      const ioi = cl.time - pc.time
      const mult = ioi <= o.gapFullSec ? 1 : ioi >= o.gapFreeSec ? o.gapFloor
        : 1 - ((1 - o.gapFloor) * (ioi - o.gapFullSec)) / (o.gapFreeSec - o.gapFullSec)
      const ps = scores[ci - 1]
      const chords = cl.sel.length > 1 && pc.sel.length > 1
      for (let s = 0; s < states.length; s++) {
        const fs = states[s]
        const st = staticCost(cl, fs)
        const a = anchorOf(cl, fs)
        let best = Infinity
        let bi = 0
        for (let q = 0; q < pStates.length; q++) {
          const pf = pStates[q]
          let t = 0
          for (let k = 0; k < fs.length; k++) {
            const j = cl.near![k]
            t += pairCost(pc.items[pc.sel[j]], pf[j], cl.items[cl.sel[k]], fs[k], mult, ioi, o, chords)
          }
          const drift = Math.max(0, Math.abs(a - anchors[q]) - o.anchorTol)
          const tot = ps[q] + t / fs.length + o.wAnchor * drift * mult
          if (tot < best) { best = tot; bi = q }
        }
        sc[s] = best + st
        bk[s] = bi
        an[s] = anchors[bi] + o.anchorRate * (a - anchors[bi])
      }
    }
    scores.push(sc)
    backs.push(bk)
    anchors = an
  }

  let s = 0
  const last = scores[scores.length - 1]
  for (let i = 1; i < last.length; i++) if (last[i] < last[s]) s = i
  for (let ci = clusters.length - 1; ci >= 0; ci--) {
    const cl = clusters[ci]
    const fs = COMBOS[cl.sel.length][s]
    cl.items.forEach((it, idx) => {
      let k = cl.sel.indexOf(idx)
      if (k < 0) { // excess note: finger of the nearest fingered note (by index)
        let bd = Infinity
        cl.sel.forEach((sj, kk) => { if (Math.abs(sj - idx) < bd) { bd = Math.abs(sj - idx); k = kk } })
      }
      // mirrored order is ascending in finger for both hands, so the finger number is fs[k] directly
      plan.set(it.id, { hand, finger: it.user ?? fs[k] })
    })
    s = backs[ci][s]
  }
}
