// Hand split: assign every note to L or R.
// Strategy: (1) if the file has exactly two tracks with notes, trust them (lower mean pitch = L);
// (2) otherwise a Viterbi over onset clusters where the state is the split index inside the cluster
// (notes sorted by pitch; the lowest `s` go to L, the rest to R — monotone by construction).
import { CHORD_NARROW_SEC, CHORD_WIDE_SEC, groupChords } from './chord'
import type { Hand, Knobs, NoteEvent, TrackInfo } from './types'

export interface SplitOptions extends Knobs {
  /** Allow the two-track shortcut (the file's two note tracks = the hands). */
  useTracks: boolean
  /** Round 45: only take the tracks when they plausibly are hands (see trackMinShare / trackMinSep / trackMinAgree); false = always trust exactly-two-track files (old behaviour). */
  trackAuto: boolean
  /** Each of the two tracks must hold at least this share of the notes. */
  trackMinShare: number
  /** Mean pitch of the higher track must exceed the lower track's by at least this many semitones. */
  trackMinSep: number
  /** Share of notes on which the tracks must agree with the pitch-based split. */
  trackMinAgree: number
  /** Pitch the prior is centred on (middle C). */
  splitMidi: number
  /** Notes whose onsets are this close (seconds) form one cluster. */
  clusterSec: number
  /** Rolled chords (wide intervals only) join up to this onset spread (see chord.ts). */
  wideSec: number
  /** Widest span (semitones) one hand may cover inside a cluster. */
  maxSpan: number
  /** Prior weight: cost per octave of a note lying on the "wrong" side of splitMidi. */
  wPrior: number
  /** Cost per semitone a hand's span exceeds maxSpan. */
  wSpan: number
  /** Cost per note beyond 5 in one hand within a cluster. */
  wCount: number
  /** Cost per octave a hand's centre jumps beyond what the elapsed time allows. */
  wMove: number
  /** Semitones a hand may move for free. */
  moveFree: number
  /** Extra free semitones per second of gap. */
  moveSpeed: number
  /** Always-on pull toward the running centre (per octave); mostly a tie-breaker. */
  wDrift: number
  /** Blend of the running centre toward the new cluster centre (0..1). */
  centreBlend: number
}

export const DEFAULT_SPLIT_OPTIONS: SplitOptions = {
  useTracks: true,
  trackAuto: true,
  trackMinShare: 0.1,
  trackMinSep: 2,
  trackMinAgree: 0.55,
  splitMidi: 60,
  clusterSec: CHORD_NARROW_SEC,
  wideSec: CHORD_WIDE_SEC,
  maxSpan: 14,
  wPrior: 1,
  wSpan: 1,
  wCount: 1.5,
  wMove: 1,
  wDrift: 0.05,
  moveFree: 10,
  moveSpeed: 40,
  centreBlend: 0.6,
}

export function splitHands(
  notes: NoteEvent[],
  tracks: TrackInfo[],
  opts?: Partial<SplitOptions>,
): Map<number, Hand> {
  const o = { ...DEFAULT_SPLIT_OPTIONS, ...opts } as SplitOptions
  const out = new Map<number, Hand>()
  if (notes.length === 0) return out

  if (o.useTracks) {
    const used = new Map<number, { sum: number; n: number; t0: number; t1: number }>()
    for (const n of notes) {
      const u = used.get(n.track) ?? { sum: 0, n: 0, t0: Infinity, t1: -Infinity }
      u.sum += n.midi
      u.n++
      if (n.time < u.t0) u.t0 = n.time
      if (n.time > u.t1) u.t1 = n.time
      used.set(n.track, u)
    }
    if (used.size === 2) {
      const [a, b] = [...used.entries()].sort((x, y) => x[0] - y[0])
      const lowIsA = a[1].sum / a[1].n <= b[1].sum / b[1].n
      const lowTrack = lowIsA ? a[0] : b[0]
      const lo = lowIsA ? a[1] : b[1]
      const hi = lowIsA ? b[1] : a[1]
      let ok = true
      if (o.trackAuto) {
        ok =
          Math.min(lo.n, hi.n) >= o.trackMinShare * notes.length &&
          hi.sum / hi.n - lo.sum / lo.n >= o.trackMinSep &&
          // Two hands play together: the tracks' time spans must overlap (not "first half" vs "second half").
          Math.min(lo.t1, hi.t1) - Math.max(lo.t0, hi.t0) >= 0.5 * Math.min(lo.t1 - lo.t0, hi.t1 - hi.t0)
        if (ok) {
          // Agreement with the pitch-based split (cheap: one extra Viterbi pass).
          const ref = splitHands(notes, tracks, { ...opts, useTracks: false })
          let agree = 0
          for (const n of notes) if (ref.get(n.id) === (n.track === lowTrack ? 'L' : 'R')) agree++
          ok = agree >= o.trackMinAgree * notes.length
        }
      }
      if (ok) {
        for (const n of notes) out.set(n.id, n.track === lowTrack ? 'L' : 'R')
        return out
      }
    }
  }

  const sorted = notes.slice().sort((a, b) => a.time - b.time || a.midi - b.midi)
  const clusters = groupChords(sorted, o.clusterSec, o.wideSec)

  type St = { score: number; cL: number; cR: number; back: number }
  let prev: St[] | null = null
  const backs: Int32Array[] = []
  let prevTime = 0
  const initL = o.splitMidi - 12
  const initR = o.splitMidi + 12

  for (const cl of clusters) {
    const n = cl.length
    const p = cl.map((x) => x.midi).sort((a, b) => a - b)
    const gap = prev ? cl[0].time - prevTime : 1
    const free = o.moveFree + o.moveSpeed * gap
    const cur: St[] = []
    const back = new Int32Array(n + 1)
    for (let s = 0; s <= n; s++) {
      // static cost of state s: p[0..s-1] -> L, p[s..n-1] -> R
      let c = 0
      for (let i = 0; i < s; i++) c += (o.wPrior * Math.max(0, p[i] - o.splitMidi)) / 12
      for (let i = s; i < n; i++) c += (o.wPrior * Math.max(0, o.splitMidi - p[i])) / 12
      const nL = s
      const nR = n - s
      let centL = NaN
      let centR = NaN
      if (nL) {
        c += o.wSpan * Math.max(0, p[s - 1] - p[0] - o.maxSpan)
        c += o.wCount * Math.max(0, nL - 5)
        centL = (p[0] + p[s - 1]) / 2
      }
      if (nR) {
        c += o.wSpan * Math.max(0, p[n - 1] - p[s] - o.maxSpan)
        c += o.wCount * Math.max(0, nR - 5)
        centR = (p[s] + p[n - 1]) / 2
      }
      let best = Infinity
      let bi = 0
      let bL = initL
      let bR = initR
      const m = prev ? prev.length : 1
      for (let j = 0; j < m; j++) {
        const pr = prev ? prev[j] : { score: 0, cL: initL, cR: initR }
        let t = pr.score + c
        let nl = pr.cL
        let nr = pr.cR
        if (nL) {
          t += (o.wMove * Math.max(0, Math.abs(centL - pr.cL) - free) + o.wDrift * Math.abs(centL - pr.cL)) / 12
          nl = pr.cL + o.centreBlend * (centL - pr.cL)
        }
        if (nR) {
          t += (o.wMove * Math.max(0, Math.abs(centR - pr.cR) - free) + o.wDrift * Math.abs(centR - pr.cR)) / 12
          nr = pr.cR + o.centreBlend * (centR - pr.cR)
        }
        if (t < best) {
          best = t
          bi = j
          bL = nl
          bR = nr
        }
      }
      cur.push({ score: best, cL: bL, cR: bR, back: bi })
      back[s] = bi
    }
    backs.push(back)
    prev = cur
    prevTime = cl[0].time
  }

  // Backtrack.
  let bs = 0
  for (let s = 1; s < prev!.length; s++) if (prev![s].score < prev![bs].score) bs = s
  for (let ci = clusters.length - 1; ci >= 0; ci--) {
    const cl = clusters[ci].slice().sort((a, b) => a.midi - b.midi)
    for (let i = 0; i < cl.length; i++) out.set(cl[i].id, i < bs ? 'L' : 'R')
    bs = backs[ci][bs]
  }
  return out
}
