// Shared contracts between the hand-lab modules. Everything except the renderer is pure TS (no three, no DOM)
// so it can later move to notefall's `src/hands/` unchanged.
//
// World frame = notefall's (see ../keyboard/layout):
//   x  lateral; key centre = keyForMidi(m).x (88 keys span x ∈ [-6.11, 6.11])
//   y  along the keys: front (player) edge at KEYBOARD_Y = -2.0, back edge at NOTE_HIT_Y = -0.525.
//      A key's local y (0 = front) → world y = KEYBOARD_Y + yLocal. Notes fall from +y onto the back edge.
//   z  up, toward the camera. White key top z = 0, black key top z = BLACK_KEY_THICKNESS (0.09).
//      Camera sits at (0, 0, 12) looking down -z (top-down view), FOV 32°.
//   Units: 1 mm = 0.01 world units (white key 23.5 mm wide).
// The player sits at -y: fingertips point toward +y, wrists/forearms extend to y < KEYBOARD_Y.

import type { NoteEvent, TrackInfo } from '../midi/types'

export type { NoteEvent, TrackInfo }

export type Hand = 'L' | 'R'
/** 1 = thumb … 5 = little finger (standard piano fingering numbers). */
export type Finger = 1 | 2 | 3 | 4 | 5

export type Fingering = { hand: Hand; finger: Finger }
/** note id → hand + finger. */
export type HandPlan = Map<number, Fingering>

/** Tunable options are flat records of numbers / booleans so the lab GUI can generate controls generically. */
export type Knobs = Record<string, number | boolean>

// ---- split.ts -------------------------------------------------------------------------------------------
// export const DEFAULT_SPLIT_OPTIONS: SplitOptions (extends Knobs)
// export function splitHands(notes: NoteEvent[], tracks: TrackInfo[], opts?: Partial<SplitOptions>): Map<number, Hand>

// ---- fingering.ts ---------------------------------------------------------------------------------------
// export const DEFAULT_FINGERING_OPTIONS: FingeringOptions (extends Knobs)
// export function assignFingers(notes: NoteEvent[], hands: Map<number, Hand>, opts?: Partial<FingeringOptions>): HandPlan

// ---- pose.ts --------------------------------------------------------------------------------------------
export type Vec3 = [number, number, number]

export type HandPose = {
  hand: Hand
  /** Forearm start (toward the player, y < wrist.y) — drawn as a thick capsule to `wrist`. */
  elbow: Vec3
  wrist: Vec3
  /** Metacarpal bases (CMC joints), thumb first: the palm is drawn wrist -> base -> knuckle (fingers[f][0]). */
  bases: Vec3[]
  /**
   * fingers[0] = thumb … fingers[4] = little. Each is a joint chain in world space, base → tip:
   * thumb: [CMC, MCP, IP, TIP]; others: [MCP (knuckle), PIP, DIP, TIP]. Renderer draws capsules between
   * consecutive joints and from `wrist` to each chain's first joint (palm).
   */
  fingers: Vec3[][]
  /** Per finger (same indexing): 0 = hovering … 1 = key fully down. For tinting / debugging. */
  press: number[]
  /** Round 32 (optional): the hand's dorsal axis carried to the thumb's metacarpal / proximal / distal bone (world unit vectors),
   *  the renderer's twist reference so the thumb's roll follows the CMC / MCP / IP axes. Absent = palm-normal reference. */
  thumbRef?: Vec3[]
}

export type HandPoses = { L: HandPose | null; R: HandPose | null }

// export const DEFAULT_MOTION_OPTIONS: MotionOptions (extends Knobs)
// export function buildHandMotion(notes: NoteEvent[], plan: HandPlan, opts?: Partial<MotionOptions>): HandMotion
// export function poseAt(motion: HandMotion, t: number): HandPoses
//   PURE in t (no hidden state between calls) — scrubbing / seeking / offline export must give identical poses.
//   t = song seconds (same clock as NoteEvent.time). A hand with no notes anywhere may return null.

// ---- handView.ts (three.js) -----------------------------------------------------------------------------
// export const DEFAULT_HAND_STYLE: HandStyle (extends Knobs; colours as numbers 0xRRGGBB are fine)
// export function createHandsView(parent: THREE.Object3D): { update(poses: HandPoses, style: HandStyle): void; dispose(): void }
