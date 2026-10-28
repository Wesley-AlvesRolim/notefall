// Procedural sway: deterministic layered noise of song time, like camera shake / Perlin's idle character noise.
// Pure functions of t (no state, no Math.random), so poses stay export-parity safe.

/** Integer hash -> [-1, 1] gradient (xorshift-style; deterministic across platforms, 32-bit integer math only). */
function grad(i: number, seed: number): number {
  let h = (Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return (h >>> 0) / 2147483648 - 1
}

/** 1D gradient noise, ~[-0.7, 0.7], zero at integers, smooth (quintic fade -> C2). */
function noise1(x: number, seed: number): number {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * f * (f * (f * 6 - 15) + 10)
  const a = grad(i, seed) * f
  const b = grad(i + 1, seed) * (f - 1)
  return a + u * (b - a)
}

/** fBm of `oct` octaves (frequency ×2.03 / amplitude ×0.5 each, so no octave repeats another's period), ~[-1, 1]. */
export function fbm(t: number, hz: number, seed: number, oct = 2): number {
  let s = 0
  let a = 1
  let norm = 0
  let f = hz
  for (let k = 0; k < oct; k++) {
    // (a per-octave time offset keeps the octaves' zero crossings from lining up at t = 0)
    s += a * noise1(t * f + 17.31 * (k + 1), seed + 101 * k)
    norm += a
    a *= 0.5
    f *= 2.03
  }
  return (s / norm) * 3 // (gradient noise RMS is only ~0.2 of its range: scaled to RMS ~0.5, peaks ~±1.3)
}

/** Seed -> [0, 1) (a fixed property of a channel, e.g. its own rate). */
export function seed01(seed: number): number {
  return (grad(seed * 7 + 3, 0x51ed) + 1) / 2
}

/** "Settle" noise: plateaus at random levels with soft hops between them (the hand moves to a new resting spot and
 *  stays a while, instead of oscillating around one point). ~[-1, 1], rare (period ~1/hz s, jittered per cell). */
export function settle(t: number, hz: number, seed: number): number {
  const x = t * hz
  const i = Math.floor(x)
  const f = x - i
  const e = Math.min(1, Math.max(0, (f - 0.55) / 0.45)) // hop in the last 45 % of each cell
  const u = e * e * (3 - 2 * e)
  const a = grad(i, seed + 5)
  return a + u * (grad(i + 1, seed + 5) - a)
}

/** One sway channel: its own slow rate (spread 0.27–1.5 × `hz`, fixed per seed, so no two channels or hands share a
 *  beat), 3 octaves, a faster small layer, and rare settle shifts. */
export function swayChannel(t: number, seed: number, hz: number, amp: number, fastAmp: number, settleAmp: number): number {
  const rate = hz * (0.27 + 1.23 * seed01(seed))
  return amp * fbm(t, rate, seed, 3) + fastAmp * fbm(t, rate * (3.2 + 1.6 * seed01(seed + 1)), seed + 7919, 1) + settleAmp * settle(t, rate * 0.35, seed + 3)
}
