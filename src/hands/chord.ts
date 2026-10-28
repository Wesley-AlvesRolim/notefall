// Shared chord grouping (split / reach / fingering / pose use the same rule so they agree on what a chord is).
// Notes within CHORD_NARROW_SEC of the chord's first onset always join. Between NARROW and CHORD_WIDE_SEC they join
// only when they are a rolled / humanised chord: at least CHORD_WIDE_MIN_SEMIS from every note of the chord's narrow core
// (so no same-key repeat and no stepwise run, i.e. fast scales, trills and tremolos stay separate notes).
export const CHORD_NARROW_SEC = 0.04
export const CHORD_WIDE_SEC = 0.06
export const CHORD_WIDE_MIN_SEMIS = 3

/** Does a note starting `dt` after the chord's first onset, `minSemis` from its nearest chord note, join the chord? */
export function joinsChord(
  dt: number,
  minSemis: number,
  narrow = CHORD_NARROW_SEC,
  wide = CHORD_WIDE_SEC,
  wideMin = CHORD_WIDE_MIN_SEMIS,
): boolean {
  return dt <= narrow || (dt <= wide && minSemis >= wideMin)
}

/** Groups notes (sorted by time) into chords. */
export function groupChords<T extends { time: number; midi: number }>(
  sorted: T[],
  narrow = CHORD_NARROW_SEC,
  wide = CHORD_WIDE_SEC,
  wideMin = CHORD_WIDE_MIN_SEMIS,
): T[][] {
  const out: T[][] = []
  let cur: T[] = []
  for (const n of sorted) {
    if (cur.length) {
      const dt = n.time - cur[0].time
      let near = Infinity
      if (dt > narrow && dt <= wide) for (const c of cur) if (c.time - cur[0].time <= narrow) near = Math.min(near, Math.abs(c.midi - n.midi))
      if (!joinsChord(dt, near, narrow, wide, wideMin)) { out.push(cur); cur = [] }
    }
    cur.push(n)
  }
  if (cur.length) out.push(cur)
  return out
}
