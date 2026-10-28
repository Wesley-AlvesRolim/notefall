// Joint-angle measurement on a HandPose (pure, no three). Shared by scripts/skeleton-check.ts (audit over whole songs)
// and the lab's joint inspector / pose sandbox (src/inspector.ts). Independent of how pose.ts / skeleton.ts get to the
// pose: everything is recovered from the output points, in the hand frame (wrist, index / middle metacarpal heads are
// rigid), then compared with the limits skeleton.ts defines.
import * as SK from './skeleton'
import type { HandPose, Vec3 } from './types'

type V = number[]
export const sub = (a: V, b: V) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const len = (a: V) => Math.hypot(a[0], a[1], a[2])
export const norm = (a: V) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
export const cross = (a: V, b: V) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const angle = (a: V, b: V) => Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b)))))
export const DEG = 180 / Math.PI
const az = (v: V) => Math.atan2(-v[0], v[1])
const el = (v: V) => Math.atan2(-v[2], Math.hypot(v[0], v[1]))
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

/** Orthonormal frame (rows) from two vectors. */
const frame = (u: V, v: V) => { const a = norm(u); const c = norm(cross(a, v)); return [a, cross(c, a), c] }
/** Azimuth of each metacarpal (base -> head) in the rest hand's palm plane, + toward the little finger (rad). */
const MC_AZ = [0, 1, 2, 3, 4].map((f) => (f === 0 ? 0 : Math.atan2(SK.metacarpalHead(f)[0] - SK.metacarpalBase(f)[0], SK.metacarpalHead(f)[1] - SK.metacarpalBase(f)[1])))
const REST = { wrist: [0, 0, 0], b2: SK.metacarpalBase(1), h2: SK.metacarpalHead(1), h3: SK.metacarpalHead(2) }

/** world -> hand-local (unscaled, R-hand frame) for this pose, and back. */
export function localizer(p: HandPose) {
  const m = p.hand === 'R' ? 1 : -1
  const mir = (v: V) => [m * v[0], v[1], v[2]]
  const Fl = frame(mir(sub(REST.h3, REST.wrist)), mir(sub(REST.h2, REST.h3)))
  const Fw = frame(sub(p.fingers[2][0], p.wrist), sub(p.fingers[1][0], p.fingers[2][0]))
  const S = len(sub(p.fingers[2][0], p.wrist)) / len(sub(REST.h3, REST.wrist))
  return {
    S,
    vec: (w: V) => { const c = Fw.map((r) => dot(r, w)); const l = [0, 1, 2].map((i) => Fl[0][i] * c[0] + Fl[1][i] * c[1] + Fl[2][i] * c[2]); return mir(l).map((x) => x / S) },
    /** hand-local (R-frame, unscaled) vector -> world vector (the inverse of `vec`). */
    world: (l: V) => { const ml = mir(l.map((x) => x * S)); const c = Fl.map((r) => dot(r, ml)); return [0, 1, 2].map((i) => Fw[0][i] * c[0] + Fw[1][i] * c[1] + Fw[2][i] * c[2]) },
  }
}

// ---- readings --------------------------------------------------------------------------------------------------
export const FINGER_NAMES = ['Thumb', 'Index', 'Middle', 'Ring', 'Little']
export type Reading = {
  /** 'wrist.flex' | 'wrist.dev' | 'wrist.roll' | 'f<1-4>.mcp|abd|pip|dip|cup' | 'th.radial|palmar|mcp|ip' */
  id: string
  /** 0 = thumb … 4 = little; -1 = wrist */
  finger: number
  joint: string
  label: string
  /** degrees */
  value: number
  lo: number
  hi: number
  /** world position of the joint (for markers / picking) */
  at: Vec3
  /** one-line meaning of the sign */
  hint: string
}
export type Status = 'ok' | 'near' | 'out'
/** Tolerance beyond a limit that still counts as "at the limit" (the skeleton audit's own 0.5° slack). */
export const LIMIT_SLACK = 0.5
/** green inside; amber within 10 % (not at a 0° lower limit) of the range's width of a limit (or past it by <= the slack); red beyond. */
export function statusOf(value: number, lo: number, hi: number): Status {
  if (value < lo - LIMIT_SLACK || value > hi + LIMIT_SLACK) return 'out'
  const band = 0.1 * (hi - lo)
  // (a straight finger sits at 0 = the extension limit all the time: not flagged amber)
  return (lo !== 0 && value < lo + band) || value > hi - band ? 'near' : 'ok'
}
/** The worst of a list of statuses. */
export const worst = (s: Status[]): Status => (s.includes('out') ? 'out' : s.includes('near') ? 'near' : 'ok')

const v3 = (a: V): Vec3 => [a[0], a[1], a[2]]

/** Hinge-plane basis of finger f in the hand frame: `up` (the plane's normal; the palm normal tilted by the MCP axis roll),
 *  e1 (lateral, toward the little finger) and e2 (forward). pose.ts bends the finger as a planar chain in the plane spanned
 *  by `up` and the in-plane direction d = sin(abd) e1 + cos(abd) e2. */
export function hingeBasis(f: number) {
  const r = SK.FLEX_ROLL[f]
  return { up: [Math.sin(r), 0, Math.cos(r)], e1: [Math.cos(r), 0, -Math.sin(r)], e2: [0, 1, 0] }
}

/** Hinge-plane decomposition of a finger's first bone (hand-local vector `prox`): `abd` = yaw of the plane about the palm normal
 *  (+ toward the little finger), `d` = the in-plane forward direction, `a1` = the bone's angle above the palm plane
 *  (pose.ts's MCP angle: flexion = -(a1 + cup)). d is taken forward-pointing (|abd| < 90 deg), so a fist (first bone pointing
 *  straight down or even back) still gets a well-defined plane; a curled chain's tip is NOT used - it lies behind the knuckle. */
export function fingerPlane(f: number, prox: V, reach: V[] = []) {
  const hb = hingeBasis(f)
  const inPlane = (v: V) => sub(v, hb.up.map((u) => u * dot(v, hb.up)))
  // (the in-plane direction comes from the chain vector with the largest in-plane part: a ring / little first bone points
  // almost straight down in a press, where its own in-plane part is too small to define a direction)
  let dp = inPlane(prox)
  for (const v of reach) { const q = inPlane(v); if (len(q) > len(dp)) dp = q }
  if (dot(dp, hb.e2) < 0) dp = dp.map((x) => -x)
  const d = norm(dp)
  return { abd: Math.atan2(dot(d, hb.e1), dot(d, hb.e2)), a1: Math.atan2(dot(prox, hb.up), dot(prox, d)), d }
}

/** Every joint angle of a pose with its limit. Angles in degrees, in the hand frame (not the world). */
export function measureHand(p: HandPose): Reading[] {
  const L = localizer(p)
  const out: Reading[] = []
  const D = DEG
  // wrist: absolute pitch of the hand axis vs horizontal (what pose.ts limits), ulnar deviation vs the forearm, forearm roll
  {
    const ex = norm(L.world([1, 0, 0])), ey = norm(L.world([0, 1, 0]))
    const m = p.hand === 'R' ? 1 : -1
    const pitch = Math.asin(Math.max(-1, Math.min(1, ey[2])))
    const dev = m * wrapPi(Math.atan2(ey[0], ey[1]) - Math.atan2(p.wrist[0] - p.elbow[0], p.wrist[1] - p.elbow[1]))
    const roll = Math.asin(Math.max(-1, Math.min(1, (-m * ex[2]) / Math.max(1e-6, Math.cos(pitch)))))
    out.push(
      { id: 'wrist.flex', finger: -1, joint: 'flex', label: 'Wrist extension (+) / flexion (-)', value: pitch * D, lo: -SK.WRIST_FLEX * D, hi: SK.WRIST_EXT * D, at: p.wrist, hint: '+ = back of the hand raised (extension)' },
      { id: 'wrist.dev', finger: -1, joint: 'dev', label: 'Wrist deviation: ulnar (+) / radial (-)', value: dev * D, lo: -SK.WRIST_RADIAL * D, hi: SK.WRIST_ULNAR * D, at: p.wrist, hint: '+ = hand turned toward the little finger' },
      { id: 'wrist.roll', finger: -1, joint: 'roll', label: 'Forearm roll (pronation / supination)', value: roll * D, lo: -SK.FOREARM_ROT * D, hi: SK.FOREARM_ROT * D, at: p.wrist, hint: '0 = palm flat down' },
    )
  }
  // thumb
  {
    const th = p.fingers[0].map((q) => L.vec(sub(q, p.wrist)))
    const d = sub(th[1], th[0])
    const m2 = sub(L.vec(sub(p.fingers[1][0], p.wrist)), L.vec(sub(p.bases[1], p.wrist)))
    // clinical angles between the 1st and 2nd metacarpals (as goniometry measures them): radial abduction in the
    // palm plane (+ toward the thumb side), palmar abduction in the plane normal to it along the 2nd metacarpal
    out.push(
      { id: 'th.radial', finger: 0, joint: 'radial', label: 'Thumb CMC radial abduction', value: (az(d) - az(m2)) * D, lo: SK.THUMB_RADIAL_ABD[0] * D, hi: SK.THUMB_RADIAL_ABD[1] * D, at: p.bases[0], hint: '1st vs 2nd metacarpal, in the palm plane' },
      { id: 'th.palmar', finger: 0, joint: 'palmar', label: 'Thumb CMC palmar abduction', value: (Math.atan2(-d[2], d[1]) - Math.atan2(-m2[2], m2[1])) * D, lo: -90, hi: SK.THUMB_PALMAR_ABD_MAX * D, at: p.bases[0], hint: '1st vs 2nd metacarpal, out of the palm plane' },
      { id: 'th.mcp', finger: 0, joint: 'mcp', label: 'Thumb MCP flexion', value: angle(d, sub(th[2], th[1])) * D, lo: 0, hi: SK.THUMB_MCP_FLEX * D, at: p.fingers[0][1], hint: 'unsigned bend (hyperextension up to 8° reads as flexion)' },
      { id: 'th.ip', finger: 0, joint: 'ip', label: 'Thumb IP flexion', value: angle(sub(th[2], th[1]), sub(th[3], th[2])) * D, lo: 0, hi: SK.THUMB_IP_FLEX * D, at: p.fingers[0][2], hint: 'unsigned bend (hyperextension up to 12° reads as flexion)' },
    )
  }
  // fingers 2-5
  const handFwd = norm(L.world([0, 1, 0]))
  for (let f = 1; f < 5; f++) {
    const c = p.fingers[f].map((q) => L.vec(sub(q, p.wrist)))
    const mc = sub(c[0], L.vec(sub(p.bases[f], p.wrist)))
    const prox = sub(c[1], c[0]), mid = sub(c[2], c[1]), dis = sub(c[3], c[2])
    const nm = FINGER_NAMES[f]
        // abduction as pose.ts enforces it: azimuth of the finger's reach (MCP -> tip) in the world's horizontal plane relative to the
    // hand's forward axis, + toward the little finger. For a finger pointing nearly straight down (horizontal reach < 30 mm) it is undefined:
    // reported as 0 then.
    const tw = sub(p.fingers[f][3], p.fingers[f][0])
    const horiz = Math.hypot(tw[0], tw[1])
    const mm = p.hand === 'R' ? 1 : -1
    // Round 23: measured from the finger's own metacarpal axis (the model's neutral: index / middle fan 14 / 4 deg toward the thumb,
    // ring / little 6 / 18 deg toward the little finger), which is where pose.ts centres the +-15 deg window (`abdAboutMc`)
    // Round 39: a finger whose tip hangs below / behind its knuckle (loose fist, withdrawn hand) has no usable horizontal azimuth: use the hinge-plane yaw
    const behind = tw[0] * handFwd[0] + tw[1] * handFwd[1] < 0
    const abd = horiz < 0.3 || behind ? fingerPlane(f, prox, [sub(c[2], c[1]), sub(c[3], c[2])]).abd - Math.atan2(mc[0], mc[1]) : mm * wrapPi(Math.atan2(tw[0], tw[1]) - Math.atan2(handFwd[0], handFwd[1])) - MC_AZ[f]
    // MCP flexion as the model defines it (and the sandbox slider shows it): the first bone's angle below the plane normal to its hinge-plane `up`
    // (= pose.ts's a1 for a bone in the hinge plane), minus the metacarpal's own tilt. Round 23: was el(prox) - el(mc), which reads a finger pointing nearly straight down in a
    // yawed hinge plane of a tilted-axis finger (middle 11.5 deg, ring 25.8, little 34.4) up to ~10 deg too deep (88 deg vs the pose's 79).
    const mcpFlex = -Math.asin(Math.max(-1, Math.min(1, dot(prox, hingeBasis(f).up) / (len(prox) || 1)))) - el(mc)
    const pip = angle(prox, mid) * D, dip = angle(mid, dis) * D
    out.push(
      { id: `f${f}.mcp`, finger: f, joint: 'mcp', label: `${nm} MCP flexion (vs its metacarpal)`, value: mcpFlex * D, lo: -SK.MCP_HYPER[f] * D, hi: SK.MCP_FLEX[f] * D, at: p.fingers[f][0], hint: '+ = flexion, - = hyperextension' },
      { id: `f${f}.abd`, finger: f, joint: 'abd', label: `${nm} MCP abduction`, value: abd * D, lo: -SK.MCP_ABD[f][0] * D, hi: SK.MCP_ABD[f][1] * D, at: p.fingers[f][0], hint: '+ = toward the little finger, - = toward the thumb' },
      { id: `f${f}.pip`, finger: f, joint: 'pip', label: `${nm} PIP flexion`, value: pip, lo: 0, hi: SK.PIP_MAX[f] * D, at: p.fingers[f][1], hint: '' },
      { id: `f${f}.dip`, finger: f, joint: 'dip', label: `${nm} DIP flexion`, value: dip, lo: 0, hi: SK.DIP_MAX[f] * D, at: p.fingers[f][2], hint: 'follows the PIP in the model' },
    )
    if (f >= 3) out.push({ id: `f${f}.cup`, finger: f, joint: 'cup', label: `${nm} CMC cupping`, value: el(mc) * D, lo: 0, hi: SK.CUP_MAX[f] * D, at: p.bases[f], hint: 'the metacarpal tilting palmar' })
  }
  return out
}

/** DIP / PIP flexion ratio for a finger (null when the PIP is nearly straight), for the audit. */
export function dipPipRatio(r: Reading[], f: number): number | null {
  const pip = r.find((x) => x.id === `f${f}.pip`)!.value
  const dip = r.find((x) => x.id === `f${f}.dip`)!.value
  return pip > 5 ? dip / pip : null
}

export const fmtDeg = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(1)
export { v3 }
