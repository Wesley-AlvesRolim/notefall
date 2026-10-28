// Sustain-pedal (CC64) helpers. Pure TS. A pedal range is [down, up] in song seconds (value >= 64 = down).
import type { NoteEvent } from './types'

export type PedalRange = readonly [number, number]

/** CC64 events of ONE track (any order) -> sorted, disjoint down ranges (threshold 64; a pedal still down at the end ends at Infinity). */
export function pedalRanges(events: { time: number; value: number }[], threshold = 64): PedalRange[] {
  const ev = [...events].sort((a, b) => a.time - b.time)
  const out: [number, number][] = []
  let down = -1
  for (const e of ev) {
    const d = e.value >= threshold
    if (d && down < 0) down = e.time
    else if (!d && down >= 0) { out.push([down, e.time]); down = -1 }
  }
  if (down >= 0) out.push([down, Infinity])
  return out
}

/** Union of several tracks' ranges (the instrument sounds with the pedal of any track). */
export function unionRanges(lists: PedalRange[][]): PedalRange[] {
  const all = lists.flat().sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const r of all) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

/** True when ONE pedal range holds the pedal down from `a` (at the latest) through `b - tol`: the pedal really sustains a note released at `a` that was written to end at `b`. */
export function pedalCovers(ranges: readonly PedalRange[] | null | undefined, a: number, b: number, tol: number): boolean {
  if (!ranges || !ranges.length) return false
  let lo = 0
  let hi = ranges.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ranges[mid][0] <= a) lo = mid + 1
    else hi = mid
  }
  const r = ranges[lo - 1]
  return !!r && r[1] >= b - tol
}

/** Fraction of [a, b] with the pedal down (diagnostics). */
export function pedalShare(ranges: readonly PedalRange[], a: number, b: number): number {
  let s = 0
  for (const r of ranges) s += Math.max(0, Math.min(b, r[1]) - Math.max(a, r[0]))
  return b > a ? s / (b - a) : 0
}

// Lab scripts / patterns attach the pedal of a note list here so the audit scripts can pass it to buildHandMotion.
const registry = new WeakMap<NoteEvent[], PedalRange[]>()
export const setPedalOf = (notes: NoteEvent[], r: PedalRange[]) => { registry.set(notes, r) }
export const pedalOf = (notes: NoteEvent[]): PedalRange[] | undefined => registry.get(notes)
