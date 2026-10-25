// CPU simulation behind HitParticles: two pools (dots + rays, and fog
// puffs) sharing one motion model. React-free so the component only owns
// wiring (key / death events, settings, GPU upload).
//
// Space. The sim works in its own units where the 88-key keyboard spans
// SIM_KEYBOARD_WIDTH, x is relative to the keyboard centre and y = 0 is
// the hit line. Every tuning constant below is expressed in these units;
// `SIM_TO_WORLD` maps them onto the scene (positions and sizes alike).
//
// Motion, per particle per step:
//   y += rise × dt                                   (a position add, not a velocity)
//   target = flowAmp × flow(p) × ageBoost(age)       (multi-octave lattice curl)
//   v += (1 − e^(−FLOW_RESPONSE × dt)) × (target − v) (first-order lag toward the flow)
//   [twirl around the key's vertical axis, air friction / gravity curl]
//   p += v × dt
// The lag (rather than integrating the flow as a force) keeps sideways
// speed bounded by the field itself, so the plume meanders at a steady
// width instead of fanning out with age, and low-passes the lattice's
// cell steps. `ageBoost` stirs young particles harder so the column
// opens up just above the keys and then settles.

import { KEYBOARD_LAYOUT } from '../keyboard/layout'
import { sampleFlow } from './curlLattice'

export const SIM_KEYBOARD_WIDTH = 17.7778
export const SIM_TO_WORLD = KEYBOARD_LAYOUT.totalWidth / SIM_KEYBOARD_WIDTH
const KEY_SLOT = SIM_KEYBOARD_WIDTH / 88

const MAX_DOTS = 65536 // ≈ 18 keys held at count 10
const MAX_FOG = 4096

// Emission — particles per key per second at count 1 (before the
// per-frame rounding below), the extra factor on the first frame of a
// press, and the spawn band just above the hit line.
const DOT_RATE = 130.45
const FOG_RATE = 4.6
const PRESS_BURST = 8
export const KEY_EMITTER_HALF_WIDTH = KEY_SLOT * 0.93
export const KEY_SPAWN_Y = 0.13
// Below this frame rate a frame's emission is split into two half-steps
// so the per-step rounding doesn't starve low-fps output.
const EMIT_SPLIT_FPS = 45

// Motion.
const LIFETIME_SCALE = 2.8
export const RISE_SCALE = 1.19
const LAUNCH_SCALE = 1.248
const FLOW_AMP = 0.865
const FLOW_FREQ = 1.4072 // noise cells per sim unit at frequency 1
const FLOW_EVOLUTION = 0.255 // field slide along z per second at evolution 1
const FLOW_RESPONSE = 7 // 1/s, rate of the velocity lag toward the flow
const AGE_BOOST = 1.54
// Twirl: angular rate (rad/s at twirl 1) around the key's vertical axis,
// and the radius band over which the orbit fades out and is pulled back in.
const TWIRL_RATE = 1.995
const TWIRL_INNER = 0.75
const TWIRL_OUTER = 2
// Air friction / gravity curl act per 1/30 s step, scaled by this rate.
const FRICTION_STEPS_PER_SEC = 52.5
const FRICTION_SCALE = 0.05
const GRAVITY_CURL_SCALE = 0.04
// Sideways floor speed kept while friction is active so particles never stall.
const MIN_SPEED = 0.05

// Sprites.
export const DOT_SIZE_SCALE = 0.0852
export const RAY_SIZE_SCALE = 1.114
// Motion trails stretch the dot along its velocity, so its quad is larger.
export const MOTION_TRAIL_QUAD = 3
// Rays are a share of the dots: about RAY_SHARE_AT_1 of them at count 1,
// scaled so the absolute number of rays stays put as the count grows.
const RAY_SHARE_AT_1 = 0.3
export const FOG_SIZE = 1.15

const HALF_PI = Math.PI / 2
const RAD_TO_DEG = 180 / Math.PI

export type ParticleParams = {
  dotCount: number
  dotSize: number
  life: number
  rise: number
  /** 0..2: launch-direction fan proportional to the spawn offset from the key centre. */
  spread: number
  emitterWidth: number
  flowStrength: number
  flowX: number
  flowY: number
  flowZ: number
  flowOctaves: number
  flowOctaveScale: number
  flowOctaveGain: number
  flowFrequency: number
  flowEvolution: number
  /** How much the flow's sample point scrolls with the rise (0 = static field, 1 = rises with the particles). */
  flowFollow: number
  launchSpeed: number
  randomDirection: number
  randomSpeed: number
  airFriction: number
  gravityCurl: number
  twirl: number
  twirlVariance: number
  motionTrail: boolean
  raysEnabled: boolean
  rayLength: number
  /** Degrees: ray tilt at the keyboard centre, and the extra tilt fanned across the full width. */
  rayAngle: number
  raySpread: number
  fogEnabled: boolean
  fogCount: number
}

/** Structure-of-arrays pool; live particles occupy [0, count) oldest-first. */
class Pool {
  count = 0
  readonly x: Float32Array
  readonly y: Float32Array
  readonly z: Float32Array
  readonly vx: Float32Array
  readonly vy: Float32Array
  readonly vz: Float32Array
  readonly age: Float32Array
  readonly life: Float32Array
  readonly size: Float32Array
  readonly rot: Float32Array // degrees
  readonly phase: Float32Array // 0..2, per-particle animation offset
  readonly originX: Float32Array // emitter centre, the twirl axis
  readonly ray: Uint8Array
  readonly r: Float32Array
  readonly g: Float32Array
  readonly b: Float32Array

  constructor(readonly capacity: number) {
    const f = () => new Float32Array(capacity)
    this.x = f(); this.y = f(); this.z = f()
    this.vx = f(); this.vy = f(); this.vz = f()
    this.age = f(); this.life = f(); this.size = f(); this.rot = f(); this.phase = f()
    this.originX = f()
    this.r = f(); this.g = f(); this.b = f()
    this.ray = new Uint8Array(capacity)
  }

  /** Index for a new particle, or -1 when full (emission is dropped, never recycles a live one). */
  alloc(): number {
    return this.count < this.capacity ? this.count++ : -1
  }

  /** Order-preserving removal of every particle past its lifetime. */
  compact() {
    let w = 0
    for (let i = 0; i < this.count; i++) {
      if (this.age[i] >= this.life[i]) continue
      if (w !== i) {
        this.x[w] = this.x[i]; this.y[w] = this.y[i]; this.z[w] = this.z[i]
        this.vx[w] = this.vx[i]; this.vy[w] = this.vy[i]; this.vz[w] = this.vz[i]
        this.age[w] = this.age[i]; this.life[w] = this.life[i]; this.size[w] = this.size[i]
        this.rot[w] = this.rot[i]; this.phase[w] = this.phase[i]; this.originX[w] = this.originX[i]
        this.ray[w] = this.ray[i]
        this.r[w] = this.r[i]; this.g[w] = this.g[i]; this.b[w] = this.b[i]
      }
      w++
    }
    this.count = w
  }
}

/** Spawn area: either a key's emitter band or an arbitrary sim-space rectangle. */
export type EmitSource = {
  /** Centre x (sim units). */
  x: number
  /** Half width of the spawn band (sim units), before the emitter-width setting. */
  halfWidth: number
  /** Centre y and half height of the spawn band (sim units). */
  y: number
  halfHeight: number
  r: number
  g: number
  b: number
}

export class ParticleSim {
  readonly dots = new Pool(MAX_DOTS)
  readonly fog = new Pool(MAX_FOG)
  /** Accumulated sim time; drives the flow field's evolution and scroll. */
  time = 0
  private readonly flow = [0, 0, 0]

  clear() {
    this.dots.count = 0
    this.fog.count = 0
    this.time = 0
  }

  get alive() {
    return this.dots.count + this.fog.count
  }

  /** Emission for one source over `dt` seconds. `burst` = first frame of a press. */
  emit(src: EmitSource, dt: number, burst: boolean, p: ParticleParams) {
    if (dt <= 0) return
    if (1 / dt < EMIT_SPLIT_FPS) {
      this.emitStep(src, dt * 0.5, burst, p)
      this.emitStep(src, dt * 0.5, false, p)
    } else {
      this.emitStep(src, dt, burst, p)
    }
  }

  private emitStep(src: EmitSource, dt: number, burst: boolean, p: ParticleParams) {
    const scale = burst ? PRESS_BURST : 1
    if (p.fogEnabled) {
      const n = roundEmission(FOG_RATE * p.fogCount * dt * scale)
      for (let k = 0; k < n; k++) this.spawn(this.fog, src, p, false)
    }
    const n = roundEmission(DOT_RATE * p.dotCount * dt * scale)
    const rayShare = p.raysEnabled && p.rayLength > 0
      ? (p.dotCount > RAY_SHARE_AT_1 ? RAY_SHARE_AT_1 / p.dotCount : 1)
      : 0
    for (let k = 0; k < n; k++) this.spawn(this.dots, src, p, Math.random() <= rayShare)
  }

  private spawn(pool: Pool, src: EmitSource, p: ParticleParams, isRay: boolean) {
    const i = pool.alloc()
    if (i < 0) return
    const offset = Math.random() * 2 - 1 // -1..1 across the emitter
    const x = src.x + p.emitterWidth * src.halfWidth * offset
    pool.x[i] = x
    pool.y[i] = src.y + src.halfHeight * (Math.random() * 2 - 1)
    pool.z[i] = 0
    pool.originX[i] = src.x

    // Launch: straight up, optionally randomised, and fanned outward by
    // `spread` in proportion to how far from the centre it spawned.
    let angle = HALF_PI
    if (p.randomDirection > 0) angle += p.randomDirection * (Math.random() - 0.5) * Math.PI
    if (p.spread > 0) {
      angle -= p.spread * offset * Math.PI * 0.25
      angle = Math.min(Math.PI, Math.max(0, angle))
    }
    let speed = p.launchSpeed * LAUNCH_SCALE
    if (p.randomSpeed > 0) {
      const skew = Math.pow(Math.random(), 0.7)
      const jitter = 0.6 + Math.random() * 0.5
      speed *= (1 + p.randomSpeed * (skew - 0.5)) * (1 + (jitter - 1) * p.randomSpeed)
    }
    pool.vx[i] = speed * Math.cos(angle)
    pool.vy[i] = speed * Math.sin(angle)
    pool.vz[i] = 0

    pool.age[i] = 0
    pool.life[i] = p.life * LIFETIME_SCALE
    pool.r[i] = src.r; pool.g[i] = src.g; pool.b[i] = src.b
    const rand = Math.random()
    pool.phase[i] = 2 * rand
    if (pool === this.fog) {
      pool.size[i] = FOG_SIZE
      pool.rot[i] = rand * 360
      pool.ray[i] = 0
    } else {
      const dot = p.dotSize * DOT_SIZE_SCALE * (p.motionTrail ? MOTION_TRAIL_QUAD : 1)
      const rayOn = isRay && p.raysEnabled && p.rayLength > 0
      pool.size[i] = rayOn ? Math.max(dot, p.rayLength * RAY_SIZE_SCALE) : dot
      pool.rot[i] = p.rayAngle + p.raySpread * (x / SIM_KEYBOARD_WIDTH)
      pool.ray[i] = isRay ? 1 : 0
    }
  }

  /** Advance every live particle by `dt` seconds and drop the expired ones. */
  step(dt: number, p: ParticleParams) {
    if (dt <= 0) return
    this.move(this.dots, dt, p)
    this.move(this.fog, dt, p)
    if (p.motionTrail) {
      // Trails point along the particle's travel, rise included.
      const { vx, vy, rot } = this.dots
      const rise = p.rise * RISE_SCALE
      for (let i = 0; i < this.dots.count; i++) rot[i] = Math.atan2(vx[i], vy[i] + rise) * RAD_TO_DEG
    }
    for (const pool of [this.dots, this.fog]) {
      const { x, y, z, vx, vy, vz, age } = pool
      for (let i = 0; i < pool.count; i++) {
        x[i] += vx[i] * dt
        y[i] += vy[i] * dt
        z[i] += vz[i] * dt
        age[i] += dt
      }
      pool.compact()
    }
    this.time += dt
  }

  private move(pool: Pool, dt: number, p: ParticleParams) {
    const n = pool.count
    if (n === 0) return
    const frictionOn = p.airFriction > 0 || p.gravityCurl > 0
    const applyFriction = frictionOn || p.motionTrail
    if (!frictionOn && p.flowStrength <= 0 && p.twirl <= 0 && !p.motionTrail && p.rise <= 0) return

    const rise = p.rise * RISE_SCALE
    const riseStep = rise * dt
    const octaves = Math.max(1, Math.min(4, Math.trunc(p.flowOctaves)))
    const m = p.flowOctaveGain
    const octaveNorm = 1 / ((octaves < 2 ? 1 : 1 + m) + (octaves < 3 ? 0 : m * m) + (octaves < 4 ? 0 : m * m * m))
    const amp = FLOW_AMP * p.flowStrength * octaveNorm
    const ax = amp * p.flowX, ay = amp * p.flowY, az = amp * p.flowZ
    const freq = FLOW_FREQ * p.flowFrequency
    const evolution = this.time * FLOW_EVOLUTION * p.flowEvolution
    const scroll = this.time * (rise + p.launchSpeed * LAUNCH_SCALE)
    const k = 1 - Math.exp(-FLOW_RESPONSE * dt)
    const kf = dt * FRICTION_STEPS_PER_SEC
    const friction = kf * p.airFriction * FRICTION_SCALE
    const curl = kf * p.gravityCurl
    const c = this.flow
    const { x, y, z, vx, vy, vz, age, originX } = pool
    for (let i = 0; i < n; i++) {
      if (rise > 0) y[i] += riseStep
      if (amp > 0) {
        sampleFlow(x[i], y[i] - scroll * p.flowFollow, z[i], evolution,
          octaves, p.flowOctaveScale, m, freq, c)
        const a = age[i]
        const boost = (a < 0.2 ? 1.5 : a < 0.5 ? 1 + ((0.5 - a) / 0.3) * 0.5 : 1) * AGE_BOOST
        vx[i] += k * (ax * boost * c[0] - vx[i])
        vy[i] += k * (ay * boost * c[1] - vy[i])
        vz[i] += k * (az * boost * c[2] - vz[i])
      }
      if (p.twirl > 0) {
        // Orbit around the emitter's vertical axis at a rate jittered by
        // the flow; past TWIRL_INNER the orbit fades and is reeled back in.
        sampleFlow(x[i], y[i] - scroll, z[i], 0, 1, 1, 1, 0.5, c)
        const dx = x[i] - originX[i]
        const dz = z[i]
        let ang = Math.atan2(dz, dx)
        let r = Math.sqrt(dx * dx + dz * dz)
        let fade = 1
        if (r > TWIRL_INNER) {
          fade = clamp01((TWIRL_OUTER - r) / (TWIRL_OUTER - TWIRL_INNER))
          r -= 2 * dt * clamp01(2 * (r - TWIRL_INNER))
        }
        const rate = 2 * (c[0] * 0.25 * p.twirlVariance + 0.5)
        ang += fade * p.twirl * rate * TWIRL_RATE * dt
        x[i] = originX[i] + r * Math.cos(ang)
        z[i] = r * Math.sin(ang)
      }
      if (applyFriction) {
        // Friction slows the in-plane speed (floored at MIN_SPEED) and |vz|;
        // gravity curl bends the heading away from straight up, more the
        // further it already leans.
        let a = Math.atan2(vy[i], vx[i])
        const sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i])
        if (a < -HALF_PI) a += 2 * Math.PI
        const dev = Math.min(1, Math.abs(HALF_PI - a) / HALF_PI)
        const sgn = HALF_PI - a < 0 ? -GRAVITY_CURL_SCALE : GRAVITY_CURL_SCALE
        const fr = Math.min(sp, 1) * friction
        const na = a - curl * sgn * dev
        const nsp = Math.max(sp - fr, MIN_SPEED)
        vx[i] = nsp * Math.cos(na)
        vy[i] = nsp * Math.sin(na)
        vz[i] = (vz[i] < 0 ? -1 : 1) * Math.max(Math.abs(vz[i]) - fr, 0)
      }
    }
  }
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Fractional counts below 1 become a coin flip; larger ones round up. */
function roundEmission(n: number): number {
  if (n <= 0) return 0
  if (n < 1) return Math.random() <= n ? 1 : 0
  return Math.ceil(n)
}
