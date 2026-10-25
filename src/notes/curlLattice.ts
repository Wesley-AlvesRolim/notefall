// Piecewise-constant flow field for the hit particles: the curl noise from
// `curlNoise.ts` baked lazily into a periodic 3D lattice and read back
// nearest-cell. The particles' velocity lags toward this field (see
// `particleSim.ts`), and that lag is what smooths the cell steps into
// gentle swirls — sampling the continuous noise directly reads as a
// fine jitter instead. Baking also makes a sample a table lookup, so
// thousands of particles × several octaves stay cheap per frame.

import { sampleCurl } from './curlNoise'

const PERIOD = 24 // noise cells covered by the lattice before it wraps
const RES = 128 // lattice cells per axis (≈ 5.3 per noise cell); power of two for `& MASK` wrapping
const MASK = RES - 1
const CELL = PERIOD / RES
// Values are normalised to a per-component RMS of TARGET_RMS so the
// motion constants in particleSim keep their meaning, then stored as
// int16 (range ±QUANT_RANGE) — half the memory of float32 with no visible
// difference for a field the velocity lag low-passes anyway.
const TARGET_RMS = 0.8
const QUANT_RANGE = 4
const QUANT = 32767 / QUANT_RANGE
// Per-octave offsets decorrelate the octaves, which all read this one lattice.
const OCTAVE_OFFSETS = [
  [5.13, 11.71, 3.37],
  [17.29, 2.83, 9.61],
  [8.47, 19.05, 14.23],
] as const

let values: Int16Array | null = null
let ready: Uint8Array | null = null
let gain = 1
const tmp: [number, number, number] = [0, 0, 0]

function rawCell(ix: number, iy: number, iz: number, out: number[]) {
  sampleCurl((ix + 0.5) * CELL, (iy + 0.5) * CELL, (iz + 0.5) * CELL, 1, 1, 1, tmp)
  out[0] = tmp[0]
  out[1] = tmp[1]
  out[2] = tmp[2]
}

// Allocated on first use (~14 MB) so a session that never shows a
// particle never pays for it. The RMS gain is measured on a fixed
// pseudo-random set of cells so it is identical in every session.
function init() {
  const s = [0, 0, 0]
  let seed = 12345
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
  let acc = 0
  const N = 4000
  for (let i = 0; i < N; i++) {
    rawCell((rnd() * RES) | 0, (rnd() * RES) | 0, (rnd() * RES) | 0, s)
    acc += s[0] * s[0] + s[1] * s[1] + s[2] * s[2]
  }
  gain = TARGET_RMS / Math.sqrt(acc / (3 * N))
  values = new Int16Array(RES * RES * RES * 3)
  ready = new Uint8Array(RES * RES * RES)
}

const cellOut = [0, 0, 0]
function quantise(v: number) {
  const q = Math.round(v * gain * QUANT)
  return q > 32767 ? 32767 : q < -32767 ? -32767 : q
}

/** Nearest lattice sample at a point given in noise cells; adds `amp ×` the sample into `out`. */
function addCell(x: number, y: number, z: number, amp: number, out: number[]) {
  if (!values || !ready) init()
  const ix = Math.floor(x / CELL) & MASK
  const iy = Math.floor(y / CELL) & MASK
  const iz = Math.floor(z / CELL) & MASK
  const vi = ix + (iy + iz * RES) * RES
  const o = vi * 3
  const v = values!
  if (!ready![vi]) {
    rawCell(ix, iy, iz, cellOut)
    v[o] = quantise(cellOut[0])
    v[o + 1] = quantise(cellOut[1])
    v[o + 2] = quantise(cellOut[2])
    ready![vi] = 1
  }
  const k = amp / QUANT
  out[0] += v[o] * k
  out[1] += v[o + 1] * k
  out[2] += v[o + 2] * k
}

/**
 * Multi-octave flow sample at (x, y, z + evolution) scaled by `frequency`
 * (in noise cells per unit). Octave n reads the lattice at
 * `p × octaveScale^n` plus its own offset, weighted `octaveMul^n`.
 */
export function sampleFlow(
  x: number, y: number, z: number, evolution: number,
  octaves: number, octaveScale: number, octaveMul: number,
  frequency: number, out: number[],
) {
  out[0] = 0
  out[1] = 0
  out[2] = 0
  let px = x * frequency
  let py = y * frequency
  let pz = (z + evolution) * frequency
  addCell(px, py, pz, 1, out)
  let amp = 1
  for (let o = 1; o < octaves && o <= OCTAVE_OFFSETS.length; o++) {
    px *= octaveScale
    py *= octaveScale
    pz *= octaveScale
    amp *= octaveMul
    const off = OCTAVE_OFFSETS[o - 1]
    addCell(px + off[0], py + off[1], pz + off[2], amp, out)
  }
}
