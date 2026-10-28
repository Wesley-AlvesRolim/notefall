// Hand skeleton: bone lengths, rest joint positions, range of motion and the thumb solver. Pure, no three.
// Sources (see ../research/hand_skeleton.md; VERIFIED = read in the source, ESTIMATE = no source reached):
// - Bone lengths: Buryanov & Kotiuk 2010, Int J Morphol 28(3) Table I (radiographs, 66 adults) — VERIFIED.
// - Hand length 178.1 mm / breadth 84.5 mm / wrist breadth 59.1 mm: Rogers et al. 2008, Ergonomics 51(4) — VERIFIED.
// - Flexion ROM (finger MCP / PIP / DIP, thumb CMC / MCP / IP): Lee & Jung 2015, Table 3 — VERIFIED.
// - Thumb CMC arcs 53° flex/ext, 42° abd/add, 17° axial rotation: Cooney 1981 — search snippet only.
// - Ring / little CMC flexion ~15 / ~25°: hand-surgery references — search snippets only.
// Units: wu, unscaled (1 mm = 0.01). Local frame of the RIGHT hand (the left mirrors x): origin = wrist joint
// centre, +x lateral toward the little finger, +y toward the fingertips, +z dorsal (up when the palm faces down).

export type V3 = [number, number, number]
const MM = 0.01
const DEG = Math.PI / 180

// ---- bones (thumb first) -------------------------------------------------------------------------------------
const METACARPAL_MM = [46.22, 68.12, 64.6, 58.0, 53.69]
const PROXIMAL_MM = [31.57, 39.78, 44.63, 41.37, 32.74]
const MIDDLE_MM = [0, 22.38, 26.33, 25.65, 18.11]
const DISTAL_MM = [21.67, 15.82, 17.4, 17.3, 15.96]
/** The chain's tip point is the pad centre, a little past the end of the distal bone (ESTIMATE). */
const PULP_MM = 3

export const METACARPAL = METACARPAL_MM.map((v) => v * MM)
/** Phalanx chain lengths from the MCP (thumb: proximal, distal; fingers: proximal, middle, distal). */
export const BONES: number[][] = PROXIMAL_MM.map((p, f) =>
  f === 0 ? [p * MM, (DISTAL_MM[0] + PULP_MM) * MM] : [p * MM, MIDDLE_MM[f] * MM, (DISTAL_MM[f] + PULP_MM) * MM],
)
export const CHAIN_LEN = BONES.map((b) => b.reduce((a, c) => a + c, 0))

// ---- metacarpals 2–5 ------------------------------------------------------------------------------------------
// Carpus depth (wrist centre -> 3rd CMC) chosen so wrist -> middle fingertip equals the mean hand length (Rogers:
// 178.1 mm, measured from the wrist crease, ~6 mm soft tissue past the distal bone — ESTIMATE).
const CARPUS = (178.1 - METACARPAL_MM[2] - PROXIMAL_MM[2] - MIDDLE_MM[2] - DISTAL_MM[2] - 6) * MM
// Knuckle row: lateral spacing inside the hand breadth (84.5 mm minus the index / little sides' bone + soft tissue,
// ESTIMATE — the MyoHand model's 42 mm index–little breadth is implausibly narrow for it); fore-aft stagger and
// dorsal-palmar arch of the heads relative to the middle one from MyoHand (Lee / Holzbaur OpenSim geometry, see
// ../research/finger_anatomy.md §1): index +0.4 / ring −1.3 / little −9.4 mm distal, index −0.5 / ring −5.9 /
// little −14.9 mm dorsal. Bases fan within the wrist breadth (59 mm, ESTIMATE); base y follows from the bone length.
const HEAD_X = [0, -0.31, -0.1, 0.11, 0.3]
const BASE_X = [0, -0.15, -0.05, 0.05, 0.14]
const HEAD_DY = [0, 0.4, 0, -1.3, -9.4].map((v) => v * MM)
const HEAD_DZ = [0, -0.5, 0, -5.9, -14.9].map((v) => v * MM)
const MID_HEAD_Y = CARPUS + METACARPAL[2] * Math.cos(Math.asin((HEAD_X[2] - BASE_X[2]) / METACARPAL[2]))
const BASE: V3[] = [0, 1, 2, 3, 4].map((f) => {
  if (f === 0) return [0, 0, 0]
  const dx = HEAD_X[f] - BASE_X[f]
  const dz = HEAD_DZ[f]
  return [BASE_X[f], MID_HEAD_Y + HEAD_DY[f] - Math.sqrt(METACARPAL[f] ** 2 - dx * dx - dz * dz), 0]
})
/** Unit direction of each metacarpal at rest (base -> head). */
const MC_DIR: V3[] = BASE.map((b, f) => {
  if (f === 0) return [0, 1, 0]
  const L = METACARPAL[f]
  return [(HEAD_X[f] - b[0]) / L, (MID_HEAD_Y + HEAD_DY[f] - b[1]) / L, HEAD_DZ[f] / L]
})
/** CMC flexion of the ring / little metacarpals ("cupping"): rest (from the arch above) and max (rad). 2nd / 3rd
 *  are rigid. Max: little ~25° (J Hand Microsurg 2022, 24.9 ± 6.2 — snippet), ring ~15° (snippets). */
export const CUP_REST = HEAD_DZ.map((dz, f) => (f >= 3 ? Math.asin(-dz / METACARPAL[f]) : 0))
export const CUP_MAX = [0, 0, 0, 15 * DEG, 25 * DEG]

export function metacarpalBase(f: number): V3 {
  return BASE[f]
}
/** Metacarpal head (MCP joint centre) for a CMC flexion `cup`: beyond rest the head moves palmar and a little
 *  toward the thumb (the 4th / 5th CMC axes are oblique, which is what makes the palm cup). */
export function metacarpalHead(f: number, cup = CUP_REST[f]): V3 {
  const b = BASE[f]
  const dc = cup - CUP_REST[f]
  const d = dc === 0 ? MC_DIR[f] : rot(MC_DIR[f], norm(crossV(MC_DIR[f], CUP_TOWARD)), dc)
  const L = METACARPAL[f]
  return [b[0] + L * d[0], b[1] + L * d[1], b[2] + L * d[2]]
}
/** Direction a cupping metacarpal head turns toward: palmar, a quarter as much toward the thumb (oblique axis). */
const CUP_TOWARD: V3 = [-0.24, 0, -0.97]
/** MCP flexion-axis roll per finger: the axis tilts from lateral toward dorsal by 0 / 11.5 / 25.8 / 34.4° (MyoHand),
 *  so the ring and little fingers flex toward the thumb side (they converge in a fist). */
export const FLEX_ROLL = [0, 0, 11.5, 25.8, 34.4].map((v) => v * DEG)

// ---- finger ROM (rad) ----------------------------------------------------------------------------------------
/** MCP flexion: Lee & Jung 2015 Table 3 (mean of seven studies). */
export const MCP_FLEX = [0, 80, 85, 87, 86].map((v) => v * DEG)
/** MCP active hyperextension: Ibrahim et al. 2024 (PMC11436331, 390 hands) — 25.7 / 24.7 / 22.3 / 26.3. */
export const MCP_HYPER = [0, 25.7, 24.7, 22.3, 26.3].map((v) => v * DEG)
export const PIP_MAX = [0, 104, 107, 107, 104].map((v) => v * DEG)
export const DIP_MAX = [0, 68, 70, 66, 69].map((v) => v * DEG)
/** DIP flexion follows the PIP linearly in free motion — slopes 0.77 / 0.75 / 0.75 / 0.57 (Mentzel 2011, n = 10, via
 *  Roda-Sales et al. 2022, PMC9541616 Table 1; Hahn 1995 index 0.76) — until the DIP reaches its own range. */
const DIP_SLOPE = [0, 0.77, 0.75, 0.75, 0.57]
/** Bend of joint k (1 = PIP, 2 = DIP) of finger f for the PIP bend b. */
export function jointBend(f: number, k: number, b: number): number {
  return k === 1 ? b : Math.min(DIP_SLOPE[f] * b, DIP_MAX[f])
}
/** MCP sideways limits [toward thumb, toward little]: ±15° (MyoHand coordinate ranges; total 25–30° in anatomy
 *  texts, e.g. Kenhub). The range shrinks with MCP flexion in reality (collateral ligaments) — not modelled. */
export const MCP_ABD: [number, number][] = [[0, 0], [15 * DEG, 15 * DEG], [15 * DEG, 15 * DEG], [15 * DEG, 15 * DEG], [15 * DEG, 15 * DEG]]

// ---- wrist / forearm (rad) -----------------------------------------------------------------------------------
/** Active wrist ROM, Chung, Park & Chi 1986 (n = 120): flexion 73.9, extension 65.9, ulnar 28.3, radial 18.6. */
export const WRIST_FLEX = 73.9 * DEG
export const WRIST_EXT = 65.9 * DEG
export const WRIST_ULNAR = 28.3 * DEG
export const WRIST_RADIAL = 18.6 * DEG
/** Forearm pronation / supination from mid-position: 80 / 87° active (PMC6555111, n = 352); the smaller bounds the
 *  hand's roll either way. */
export const FOREARM_ROT = 80 * DEG

// ---- thumb ---------------------------------------------------------------------------------------------------
// Kinematic structure from the Stanford VA Upper Limb Model (OpenSim, Holzbaur lineage; raw .osim read, see
// ../research/thumb_anatomy.md §1): CMC = two non-intersecting, non-orthogonal axes (flexion through the
// trapezium, abduction 9 mm distal of it in the metacarpal, 99° apart), MCP and IP hinges whose axes point nearly
// dorsal — the thumb flexes ACROSS the palm, sweeping its tip toward the index, not down like a finger — 17° apart.
// The rest (all-zero) pose puts the 1st metacarpal ~30° radial / ~21° palmar of the fingers' axis, 36° from the 2nd.
// Model frame (capitate, metres): +x radial, +y proximal, +z dorsal (deduced: thumb radial + palmar of the index);
// ours: x ulnar, y distal, z dorsal -> (-x, -y, z), scaled so the proximal phalanx matches Buryanov (31.57 mm).
// Placed relative to the index MCP head, as in the model. Ranges: CMC from the model's coordinate limits, MCP / IP
// from Barakat et al. 2013 (PMC3653006, 100 adults): MCP 60 flex / 8 ext, IP 88 flex / 12 ext.
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
const crossV = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dotV = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
/** Rodrigues rotation of v about unit axis k by angle a. */
function rot(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  const kv = crossV(k, v)
  const d = dotV(k, v) * (1 - c)
  return [v[0] * c + kv[0] * s + k[0] * d, v[1] * c + kv[1] * s + k[1] * d, v[2] * c + kv[2] * s + k[2] * d]
}
/** Rotate point p about the axis k through o. */
const rotAt = (p: V3, o: V3, k: V3, a: number): V3 => {
  const r = rot([p[0] - o[0], p[1] - o[1], p[2] - o[2]], k, a)
  return [o[0] + r[0], o[1] + r[1], o[2] + r[2]]
}

const OS = {
  cmcFlex: [0.015293, -0.004569, -0.010308],
  cmcAbd: [0.022493, -0.009969, -0.012808],
  mcp: [0.038993, -0.039169, -0.025508],
  ip: [0.052993, -0.065069, -0.035608],
  indexMcp: [0.018186, -0.065863, 0.008652],
  axFlex: [-0.042399, -0.665286, 0.745384],
  axAbd: [0.495557, 0.731736, 0.467959],
  axMcp: [-0.084295, -0.203488, 0.975442],
  axIp: [-0.050102, -0.479623, 0.876043],
}
const OS_SCALE = PROXIMAL_MM[0] / (Math.hypot(OS.ip[0] - OS.mcp[0], OS.ip[1] - OS.mcp[1], OS.ip[2] - OS.mcp[2]) * 1000)
const osAxis = (v: number[]): V3 => norm([-v[0], -v[1], v[2]])
const osPoint = (v: number[]): V3 => {
  const h = metacarpalHead(1, 0)
  const k = 1000 * MM * OS_SCALE
  return [h[0] - (v[0] - OS.indexMcp[0]) * k, h[1] - (v[1] - OS.indexMcp[1]) * k, h[2] + (v[2] - OS.indexMcp[2]) * k]
}
/** Thumb CMC (flexion axis point, in the trapezium) and the abduction axis point 9 mm distal of it. */
export const THUMB_CMC = osPoint(OS.cmcFlex)
const TH_P2 = osPoint(OS.cmcAbd)
const TH_MCP0 = osPoint(OS.mcp)
const TH_IP0 = osPoint(OS.ip)
const TH_TIP0: V3 = (() => {
  const d = norm([TH_IP0[0] - TH_MCP0[0], TH_IP0[1] - TH_MCP0[1], TH_IP0[2] - TH_MCP0[2]])
  return [TH_IP0[0] + BONES[0][1] * d[0], TH_IP0[1] + BONES[0][1] * d[1], TH_IP0[2] + BONES[0][1] * d[2]]
})()
const AX = { flex: osAxis(OS.axFlex), abd: osAxis(OS.axAbd), mcp: osAxis(OS.axMcp), ip: osAxis(OS.axIp) }
export const THUMB_MCP_REST: V3 = TH_MCP0
/** Joint-centre metacarpal length (abduction point -> MCP); shorter than the radiographic bone, whose base runs on
 *  into the saddle. */
export const THUMB_MC_LEN = Math.hypot(TH_MCP0[0] - TH_P2[0], TH_MCP0[1] - TH_P2[1], TH_MCP0[2] - TH_P2[2])
/** CMC -> tip with the thumb straight (what the reach logic measures against). */
export const THUMB_REACH = Math.hypot(TH_TIP0[0] - THUMB_CMC[0], TH_TIP0[1] - THUMB_CMC[1], TH_TIP0[2] - THUMB_CMC[2])
/** Rest 1st-metacarpal direction (for the audits). */
export const THUMB_DIR0 = norm([TH_MCP0[0] - TH_P2[0], TH_MCP0[1] - TH_P2[1], TH_MCP0[2] - TH_P2[2]])
/** CMC coordinate ranges (rad) about the model axes: + flexion turns the thumb radially / dorsally, + abduction palmar.
 *  Flexion keeps the model's limits; abduction's upper limit is raised from the model's 25° to 35° so the 1st–2nd
 *  metacarpal angle reaches Barakat's palmar abduction (61°; radial abduction 63° is reached at the flexion limit). */
export const THUMB_FLEX: [number, number] = [-15 * DEG, 45 * DEG]
export const THUMB_ABD: [number, number] = [-25 * DEG, 35 * DEG]
export const THUMB_MCP_FLEX = 60 * DEG
export const THUMB_IP_FLEX = 88 * DEG
/** One bend b drives MCP and IP in proportion to their flexion ranges; b < 0 hyperextends both, down to the
 *  tighter of the two measured extensions (MCP 8.1 / 60, IP 12 / 88). */
const THUMB_B_MIN = -Math.min(8.1 / 60, 12 / 88)

/** Clinical limits on the 1st–2nd metacarpal angle (Barakat 2013): radial abduction 62.9 (adduction 10.2 past
 *  parallel), palmar abduction 61.2. The CMC coordinate box above is cut back to these (its corners exceed them). */
export const THUMB_RADIAL_ABD: [number, number] = [-10.2 * DEG, 62.9 * DEG]
export const THUMB_PALMAR_ABD_MAX = 61.2 * DEG
/** 1st-metacarpal angles vs the 2nd: [radial abduction, palmar abduction] (rad), measured as goniometry does. */
export function thumbClinical(flex: number, abd: number): [number, number] {
  let d = rot(THUMB_DIR0, AX.abd, abd)
  d = rot(d, AX.flex, flex)
  const m2 = MC_DIR[1]
  return [Math.atan2(-d[0], d[1]) - Math.atan2(-m2[0], m2[1]), Math.atan2(-d[2], d[1]) - Math.atan2(-m2[2], m2[1])]
}
const thumbOk = (flex: number, abd: number, romScale: number) => {
  if (romScale > 1) return true
  const [ra, pa] = thumbClinical(flex, abd)
  return ra >= THUMB_RADIAL_ABD[0] && ra <= THUMB_RADIAL_ABD[1] && pa <= THUMB_PALMAR_ABD_MAX
}

/** `w` (0..1, default 0) relaxes the IP: the MCP / IP bends are no longer locked in the ratio of their ranges (see `thumbBend`). */
export type ThumbState = { flex: number; abd: number; b: number; w?: number; ipRest?: number }
/** IP flexion that stays at a straight thumb (b = 0) when relaxed (rad). Pianists keep the thumb's IP slightly flexed. */
export const THUMB_IP_REST = 0 * DEG
/** MCP / IP flexion (rad) for the bend b. w = 0: both in proportion to their ranges (the Round 12 coupling, bit for bit).
 *  w > 0: the MCP keeps its share, the IP moves toward `ipRest + (range - ipRest) b^2` — mild (near ipRest) for a lightly bent
 *  thumb, reaching its full range only when b = 1, so a short reach (thumb under) still has the whole IP range. */
export function thumbBend(b: number, w = 0, ipRest = THUMB_IP_REST): [number, number] {
  if (w === 0) return [b * THUMB_MCP_FLEX, b * THUMB_IP_FLEX]
  const ip = b >= 0 ? (1 - w) * b * THUMB_IP_FLEX + w * (ipRest + (THUMB_IP_FLEX - ipRest) * b * b) : b * THUMB_IP_FLEX + w * ipRest
  return [b * THUMB_MCP_FLEX, ip]
}
/** Thumb joints (local, unscaled): [CMC abduction point, MCP, IP, TIP] (the flexion point is `THUMB_CMC`, 9 mm
 *  proximal; the renderer's palm covers the gap). */
export function thumbChain(s: ThumbState): V3[] {
  const [m, i] = thumbBend(s.b, s.w ?? 0, s.ipRest)
  return thumbChainFree(s.flex, s.abd, m, i)
}
/** The same chain with the MCP and IP flexion (rad) given separately (the lab's pose sandbox; playback couples them
 *  through one bend b). thumbChain(s) === thumbChainFree(s.flex, s.abd, s.b * THUMB_MCP_FLEX, s.b * THUMB_IP_FLEX). */
export function thumbChainFree(flex: number, abd: number, mcpFlex: number, ipFlex: number): V3[] {
  // distal first, each about its rest axis, then carried by the joints above it (nested frames, as in the model)
  let tip = rotAt(TH_TIP0, TH_IP0, AX.ip, -ipFlex)
  let ip = TH_IP0
  tip = rotAt(tip, TH_MCP0, AX.mcp, -mcpFlex)
  ip = rotAt(ip, TH_MCP0, AX.mcp, -mcpFlex)
  let mcp = TH_MCP0
  ;[mcp, ip, tip] = [mcp, ip, tip].map((p) => rotAt(p, TH_P2, AX.abd, abd))
  let p2 = TH_P2
  ;[p2, mcp, ip, tip] = [p2, mcp, ip, tip].map((p) => rotAt(p, THUMB_CMC, AX.flex, flex))
  return [p2, mcp, ip, tip]
}

/** Orientation of the thumb's distal phalanx (local frame, unit vectors): `d` along the bone (IP -> tip), `h` the IP hinge
 *  axis (the lateral axis of the tip: pad-side corners lie along +-h), `n` the nail normal (nail faces +n, pad -n). They are
 *  the rest vectors carried through the same nested rotations as `thumbChainFree`, so the roll follows the CMC axes. */
export function thumbFrameFree(flex: number, abd: number, mcpFlex: number, ipFlex: number): { d: V3; h: V3; n: V3 } {
  const d0 = norm([TH_TIP0[0] - TH_IP0[0], TH_TIP0[1] - TH_IP0[1], TH_TIP0[2] - TH_IP0[2]])
  const h0 = AX.ip
  let n0 = norm(crossV(h0, d0))
  if (n0[0] > 0) n0 = [-n0[0], -n0[1], -n0[2]] // the nail faces radially at rest (x is ulnar)
  const carry = (v: V3): V3 => {
    let r = rot(v, AX.ip, -ipFlex)
    r = rot(r, AX.mcp, -mcpFlex)
    r = rot(r, AX.abd, abd)
    return rot(r, AX.flex, flex)
  }
  return { d: carry(d0), h: carry(h0), n: carry(n0) }
}
export function thumbFrame(s: ThumbState) {
  const [m, i] = thumbBend(s.b, s.w ?? 0, s.ipRest)
  return thumbFrameFree(s.flex, s.abd, m, i)
}
/** The hand's dorsal axis (local z) carried to the metacarpal / proximal / distal bone: the renderer's twist reference for
 *  the thumb (the roll of each bone follows the CMC / MCP / IP axes, not the palm normal). */
export function thumbRefsFree(flex: number, abd: number, mcpFlex: number, ipFlex: number): V3[] {
  const z: V3 = [0, 0, 1]
  const c2 = (v: V3): V3 => rot(rot(v, AX.abd, abd), AX.flex, flex)
  const c1 = (v: V3): V3 => c2(rot(v, AX.mcp, -mcpFlex))
  const c0 = (v: V3): V3 => c1(rot(v, AX.ip, -ipFlex))
  return [c2(z), c1(z), c0(z)]
}
export function thumbRefs(s: ThumbState): V3[] {
  const [m, i] = thumbBend(s.b, s.w ?? 0, s.ipRest)
  return thumbRefsFree(s.flex, s.abd, m, i)
}

const clampR = (v: number, r: [number, number]) => Math.max(r[0], Math.min(r[1], v))
/**
 * Thumb IK (local, unscaled). The bend sets the CMC -> tip distance and the two CMC rotations aim it, so they are
 * solved apart: b by bisection on the distance, then (flex, abd) by clamped Gauss–Newton on the tip position, twice
 * round. If a limit cuts in, b is re-picked so the tip gets as close as it can, height counted double (a thumb short
 * of its key stays at the key's height rather than dipping into it). Fixed iteration counts: pure and bounded.
 * `romScale` scales the limits (the audits use 9 = unlimited).
 */
export function solveThumb(target: V3, romScale = 1, w = 0, ipRest?: number): ThumbState {
  const sc = (r: [number, number]): [number, number] => [r[0] * romScale, r[1] * romScale]
  const fL = sc(THUMB_FLEX)
  const aL = sc(THUMB_ABD)
  const bL: [number, number] = [THUMB_B_MIN * romScale, Math.min(1, romScale)]
  const C = THUMB_CMC
  const W = [1, 1, 2]
  const s: ThumbState = w === 0 ? { flex: 0, abd: 0, b: 0.3 } : { flex: 0, abd: 0, b: 0.3, w, ipRest }
  const tipOf = (st: ThumbState) => thumbChain(st)[3]
  const err = (st: ThumbState) => {
    const t = tipOf(st)
    return [W[0] * (t[0] - target[0]), W[1] * (t[1] - target[1]), W[2] * (t[2] - target[2])]
  }
  const r = Math.hypot(target[0] - C[0], target[1] - C[1], target[2] - C[2])
  const reachOf = (b: number) => {
    const t = tipOf({ ...s, b })
    return Math.hypot(t[0] - C[0], t[1] - C[1], t[2] - C[2])
  }
  const pickB = () => {
    // reach shrinks as the thumb bends (b > 0); hyperextension only if the straight thumb is still short
    if (r >= reachOf(0)) { s.b = reachOf(bL[0]) > reachOf(0) && r > reachOf(0) ? bL[0] : 0; return }
    if (r <= reachOf(bL[1])) { s.b = bL[1]; return }
    let lo = 0
    let hi = bL[1]
    for (let it = 0; it < 20; it++) {
      const mid = 0.5 * (lo + hi)
      if (reachOf(mid) > r) lo = mid
      else hi = mid
    }
    s.b = 0.5 * (lo + hi)
  }
  const aim = () => {
    const h = 1e-4
    for (let it = 0; it < 6; it++) {
      const e = err(s)
      const ef = err({ ...s, flex: s.flex + h })
      const ea = err({ ...s, abd: s.abd + h })
      const jf = ef.map((v, i) => (v - e[i]) / h)
      const ja = ea.map((v, i) => (v - e[i]) / h)
      // 2x2 normal equations, lightly damped
      const a11 = dotV(jf as V3, jf as V3) + 1e-4
      const a12 = dotV(jf as V3, ja as V3)
      const a22 = dotV(ja as V3, ja as V3) + 1e-4
      const g1 = -dotV(jf as V3, e as V3)
      const g2 = -dotV(ja as V3, e as V3)
      const det = a11 * a22 - a12 * a12
      if (Math.abs(det) < 1e-12) break
      const nf = clampR(s.flex + (g1 * a22 - g2 * a12) / det, fL)
      const na = clampR(s.abd + (a11 * g2 - a12 * g1) / det, aL)
      if (thumbOk(nf, na, romScale)) { s.flex = nf; s.abd = na; continue }
      // (step leaves the clinical range: go as far along it as stays inside)
      let lo = 0
      let hi = 1
      for (let k = 0; k < 12; k++) {
        const mid = 0.5 * (lo + hi)
        if (thumbOk(s.flex + mid * (nf - s.flex), s.abd + mid * (na - s.abd), romScale)) lo = mid
        else hi = mid
      }
      s.flex += lo * (nf - s.flex)
      s.abd += lo * (na - s.abd)
    }
  }
  for (let round = 0; round < 2; round++) {
    pickB()
    aim()
  }
  const total = (b: number) => {
    const e = err({ ...s, b })
    return Math.hypot(e[0], e[1], e[2])
  }
  if (total(s.b) > 1e-3) {
    let lo = bL[0]
    let hi = bL[1]
    for (let it = 0; it < 20; it++) {
      const m1 = lo + (hi - lo) / 3
      const m2 = hi - (hi - lo) / 3
      if (total(m1) < total(m2)) hi = m2
      else lo = m1
    }
    s.b = 0.5 * (lo + hi)
    aim()
  }
  return s
}
