// Procedural piano-hand motion. Pure TS (no three / DOM); Vec3 tuples in notefall world space (see types.ts).
//
// Hierarchy (after the Tipiano paper):
//   (a) fingertip targets come from key geometry + fingering (strike point on the key top, pressed by a dip);
//   (b) the wrist trajectory is planned from those targets: one knot per chord (anchor = where the hand must sit so the
//       pressing fingers are at rest above their keys), eased between knots with ANTICIPATION (the move starts before
//       the next onset, never later than the previous knot);
//   (c) each finger blends hover -> key (attack) -> hover (release) with sympathetic lowering of neighbours;
//   (d) joints by analytic IK in the finger's vertical plane (curl distributed PIP/DIP with DIP = 2/3 PIP).
// poseAt is a pure function of t: everything time-varying is binary-searched in arrays precomputed by buildHandMotion.

import { CHORD_NARROW_SEC, CHORD_WIDE_SEC, joinsChord } from './chord'
import { BLACK_KEY_LENGTH, BLACK_KEY_THICKNESS, BLACK_KEY_WIDTH, KEYBOARD_LAYOUT, KEYBOARD_Y, WHITE_KEY_LENGTH, WHITE_KEY_WIDTH, keyForMidi } from '../keyboard/layout'
import type { Finger, Hand, HandPlan, HandPose, HandPoses, NoteEvent, Vec3 } from './types'
import { fingerRadius } from './handDims'
import { seed01, swayChannel } from './sway'
import { pedalCovers, type PedalRange } from './pedal'
import {
  BONES, CHAIN_LEN, FLEX_ROLL, WRIST_EXT, WRIST_FLEX, WRIST_RADIAL, WRIST_ULNAR, FOREARM_ROT, jointBend, CUP_MAX, CUP_REST, MCP_ABD, MCP_FLEX, MCP_HYPER, METACARPAL, PIP_MAX, THUMB_CMC, THUMB_MCP_REST, THUMB_REACH,
  metacarpalBase, metacarpalHead, solveThumb, thumbChain, thumbRefs,
} from './skeleton'

export type MotionOptions = {
  /** Seconds before an onset at which the hand starts travelling toward it (at least; fast leaps start earlier). */
  anticipation: number
  /** Hand travel speed cap (wu/s, average) used to lengthen the travel window on big leaps. */
  maxHandSpeed: number
  /** Seconds a finger takes to descend from hover onto its key (ends exactly at onset). */
  attack: number
  /** Seconds before its next note a free finger starts moving over that key (pre-shaping the hand), at hover height. */
  prepare: number
  /** Height above the key top a prepared finger waits at (share of hoverHeight). */
  prepareHeight: number
  /** A finger whose next note is on another key lets go at least this long before it (s), so it can move over
   *  the next key in the air — but holds at least 60 % of the time to its next onset. */
  prepareLead: number
  /** How much a finger gliding over its next key already counts as active (wrist yaw, fanning around it); only in
   *  unhurried passages (fades out when the hand's previous chord is within 0.25–0.6 s). */
  prepareWeight: number
  /** Seconds a finger takes to lift back to hover after the note ends. */
  release: number
  /** Fingertip hover height above the white key top at rest (wu). */
  hoverHeight: number
  /** 0..1: how far a finger that is not pressing (weighted by 1 - activity) takes the relaxed joint distribution
   *  (more MCP, less PIP / DIP — a curved resting finger, not a claw) instead of the one the hover reach dictates. */
  relaxFlex: number
  /** Relaxed MCP : PIP flexion ratio the idle finger is steered toward (resting / functional hand position:
   *  MCP ~35-45, PIP ~15-30 deg, see README Round 19). */
  relaxRatio: number
  /** Tolerance (rad) of that ratio, and (wu) how far the relaxed finger may land from the planned hover reach. */
  relaxSigma: number
  relaxReach: number
  /** Round 20: per-note finger lift scales with the time/articulation available (see `liftScale`). `liftHover` = lowest
   *  tip height above the key (wu) for a finger that plays again at once (instead of the full hoverHeight);
   *  `liftPrepare` = the same for the prepared height over the next key (instead of prepareHeight·hoverHeight);
   *  the full amounts return with inter-onset interval `liftT0`..`liftT1` s and with detached articulation
   *  (`liftGap` = free gap as a share of the interval at which a note counts as fully detached). */
  liftHover: number
  liftPrepare: number
  liftT0: number
  liftT1: number
  liftGap: number
  liftLegato: number
  /** Share of `travelLift` left when the hand has no time between chords (it grows to the full lift over liftT0..liftT1). */
  liftTravelMin: number
  /** Height (wu) a repetition-walk finger rests at over its key between strikes when strikes are fast / when slow. */
  liftWalkMin: number
  /** Round 35: minimum lift scale (0..1) of a finger in a thumb-and-finger alternation on one key (1-2-1-2 repeats, IOI <= `repeatGap`): the striking finger lifts (and the idle one stays up) by this share of the full lift even when the time scale would flatten it. 0 = off (Round 34). */
  altLift: number
  /** Round 35: in such an alternation the descent takes at most this share of the finger's own cycle (default 0.6 elsewhere) and the rise after the release at most `altRelease` of it. */
  altAttack: number
  altRelease: number
  /** Key-dip depth: how far the tip pushes below the key top (wu, scaled by 0.5 + 0.5*velocity). */
  keyDip: number
  /** Seconds for the key to go fully down after onset. */
  dipTime: number
  /** Scale on how far each fingertip may sit sideways from its rest spot. Consecutive chords whose notes all fit
   *  within that slack from one hand position share it, so the wrist stays put (Alberti 5-1-3-1 = no arm motion). */
  lateralSlack: number
  /** 0..1: where a new hand position lands inside its feasible range (0 = least travel, 1 = range centre). */
  centering: number
  /** A held finger may stretch this many times its sideways slack while the hand moves away; past that it lets
   *  go (the pedal sustains the note) instead of being dragged along. */
  holdStretch: number
  /** 0..1: how much idle fingers next to an active finger drop with it. */
  sympathetic: number
  /** 0..1: share of the pressing fingers' mean sideways offset the hand absorbs by yawing at the wrist (the idle
   *  fingers turn with it instead of the pressing finger sliding under them). */
  yawAmount: number
  /** 0..1: idle fingers carry along this share of a nearby pressing finger's remaining sideways offset (fan). */
  fanFollow: number
  /** Scale on all joint range-of-motion limits (1 = clinical normal ROM). */
  romScale: number
  /** Same-key repetitions with changing fingers (2-3-2-3…): at most this gap (s) between onsets. */
  repeatGap: number
  /** Extra ulnar wrist tilt (rad) held through a repetition run, so the fingers take turns on the key instead of
   *  shuffling sideways. */
  repeatTilt: number
  /** In a repetition run, the thumb-side finger strikes this much deeper into the key per finger number (wu). */
  repeatStagger: number
  /** In a repetition run, how far a pressing fingertip pulls back toward the player ("scratch", wu). */
  repeatScratch: number
  /** In a repetition run, between strikes the finger curls this far back toward the palm (wu) before swinging out
   *  again — the "walking fingers" loop. */
  repeatCurl: number
  /** A note whose hand position is this far (wu) from the previous one is an arm move: its finger only prepares
   *  just before it (rides along with the hand); closer ones are crossings the hand makes by itself. */
  crossReach: number
  /** Seconds of glide for an arm-move note's finger. */
  latePrepare: number
  /** Wrist deviation (rad) toward the thumb while a finger crosses over the thumb (1 → 2/3/4 toward the thumb side). */
  crossOverYaw: number
  /** Wrist deviation (rad) toward the pinky while the thumb passes under (2/3/4 → 1 toward the pinky side). */
  thumbUnderYaw: number
  /** Seconds the crossing deviation takes to unwind after the crossing note. */
  crossRelease: number
  /** A finger preparing to cross over the thumb waits curled: pulled back toward the palm by this much (wu)… */
  crossCurl: number
  /** …and arched this high above the key top (wu), over the thumb. */
  crossArc: number
  /** Wrist snap / arm drop for repeated chords, arm leaps and strong notes: wrist lift (wu) at full intensity… */
  snapLift: number
  /** …and wrist extension (rad, knuckles up) at full intensity. */
  snapPitch: number
  /** Seconds of wind-up before the strike (capped at 60 % of the gap to the previous chord). */
  snapTime: number
  /** In a repetition run the fingers share the key side by side: each strikes this far (wu) left / right of centre. */
  repeatSpread: number
  /** Angular margin (rad) by which a pinky-side finger must point at least as far toward the pinky as its
   *  thumb-side neighbour, seen from above — neighbouring fingers never cross. */
  fanMargin: number
  /** Hands closer than this (wrist to wrist, wu) — or crossed — share the keys: the hand that has crossed into the
   *  other's side plays over it… */
  handGap: number
  /** …this far further in on the keys (wu)… */
  overBack: number
  /** …with the wrist this much higher (wu), so its palm clears the other hand's fingers. */
  overLift: number
  /** …and pitched knuckles-down by this much (rad, wrist flexion) so the fingers can still come down curved (Round 21). */
  overPitch: number
  /** The hand underneath a crossing lowers its wrist by this (wu) and draws back toward the player by `yieldBack`. */
  yieldDrop: number
  yieldBack: number
  /** Share of the knuckle drop from that pitch the idle fingers' hover height follows (0 = they stay as high as before). */
  overIdleDrop: number
  /** Share of that pitch's knuckle drop given back as extra wrist height (keeps the knuckles clear of the other hand). */
  overPitchLift: number
  /** `over` level (0..1) from which the pitch is applied (it reaches full at over = 1). */
  overPitchFrom: number
  /** Uniform hand size multiplier (1 = adult hand). */
  handScale: number
  /** Strike point on white keys, yLocal from the front edge (wu). Near the front of the black keys. */
  whiteStrikeY: number
  /** Strike point on black keys, yLocal (mid length). */
  blackStrikeY: number
  /** Thumb / little finger strike on black keys (shorter fingers stay nearer the black key's front end). */
  shortBlackStrikeY: number
  /** Thumb strike point on white keys (thumb plays nearer the front edge). */
  thumbStrikeY: number
  /** Round 37: extra hover reach (share of the chain-length difference to the index finger, middle / ring) of a finger that is not pressing: at one hover height
   *  the longest finger needs the most PIP / DIP bend, so the idle middle finger looked curled in next to the index. 0 = Round 36. */
  reachLong: number
  /** Round 37: extra planned reach (middle / ring: this x the chain-length excess over the index) in the wrist-y plan (hand-position knots). The wrist is shared but placed from each
   *  pressing finger's reach = `reachRatio` x its length at the SAME tip height, so the longer middle finger was planned at a more bent knuckle-to-tip distance than the index and its
   *  PIP / DIP bent visibly more. The plan is smoothed with the rest of the hand path (a per-frame correction on the pose made the wrist accelerate 5x harder). 0 = Round 36. */
  reachPlan: number
  /** Round 32: the thumb plays on its side (0 off = Round 31 bit for bit .. 1). The IP stays mildly flexed (the MCP / IP bends are no
   *  longer locked in ratio: the IP follows `thumbIpRest` + a squared share of its range) and the mesh thumb's roll follows the
   *  CMC / MCP / IP axes (HandPose.thumbRef), so the nail visibly turns sideways with the thumb's own rotation. */
  thumbSide: number
  /** IP flexion kept at a straight thumb (deg) while `thumbSide` is on. */
  thumbIpRest: number
  /** Wrist height above the white key top at rest (wu). */
  wristHeight: number
  /** Extra wrist height when the pressed keys are black. */
  blackLift: number
  /** Wrist rise during a travel between chords (wu, scaled by distance up to 1 wu). */
  travelLift: number
  /** Palm pitch (rad; negative = knuckles lower than the wrist). */
  palmPitch: number
  /** Max wrist roll toward the pressing side (rad). */
  rollAmount: number
  /** Round 23: forearm roll into the direction of travel (rad at full travel): the hand tilts so the side it is travelling
   *  toward lowers (RH going up = supinate: thumb side up, little finger side down; LH going up = thumb side down).
   *  0 = off. The travel signal is the net, monotone share of the planned hand path over +-`travelWindow` s. */
  rollTravel: number
  /** Round 24: forearm rotation as a playing motion. The hand rocks toward the side of the finger(s) about to play (thumb side =
   *  -1 ... little-finger side = +1, press-weighted per chord): peak roll `rotAmp` (rad) at side 1, reached `rotLead` s BEFORE
   *  the strike, the transition between two chords taking at most `rotWindow` s (a fast alternation rocks continuously).
   *  `rotDyn` (x humanize, stylistic) = louder chords rotate more; `rotWeak` = extra little-finger-side tilt when 4 / 5
   *  play; `rotMelody` = tilt toward the little-finger side when the chord's outer note (RH top / LH bottom) is the melody
   *  (louder / longer than the inner notes). 0 `rotAmp` = off. Mechanical, so NOT scaled by humanize. */
  rotAmp: number
  rotLead: number
  rotWindow: number
  rotDyn: number
  rotWeak: number
  rotMelody: number
  /** Round 24: the wrist slides sideways by this x S x (rotation, rad) so a finger hanging in the rolled hand's plane still lands on its key (wu per rad). */
  rotShift: number
  rotLeapAt: number
  /** Round 24: share of the side term removed for chords whose neighbouring hand position is further than ~`rotLeapAt` (wu) away (arm moves; fully gone at twice that). */
  rotLeap: number
  /** Round 24: wrist rise for the rotation (x half knuckle width x |sin|), like `rollLift`. */
  rotLift: number
  /** Round 24: side change (thumb -1 ... little +1) between neighbouring chords at which the side term counts in full (0 = always). */
  rotAlt: number
  /** Round 24: the rotation fades with the travel signal (1 = none left at full travel): a scale / arpeggio already rolls into its direction. */
  rotTravelDamp: number
  /** Round 23: the wrist also leans into the travel (ulnar for the RH going up, radial for the LH; rad at full travel). */
  devTravel: number
  /** Round 23: wrist rise (x the half knuckle-row width x |sin roll|) that keeps the lower side of a travel-rolled hand off the keys. */
  rollLift: number
  /** Round 23: window (s) either side of a knot over which the travel is measured, and the net hand-path distance (wu)
   *  that counts as full travel (tanh). */
  travelWindow: number
  travelSpan: number
  /** Round 23: 1 = the wrist deviation is chosen by minimising the pressing fingers' MCP abduction beyond their range
   *  (weighted by activity, within the wrist range); 0 = the old two gain-1 correction steps only. `devSolveHold` =
   *  weight (rad^-2) of the pull back to the yaw the planner proposed (small: the abduction cost wins). */
  devSolve: number
  devSolveHold: number
  /** Round 23: the forearm roll may also move (rad, either way) from the planned one to take the abduction load off the
   *  pressing fingers (0 = roll stays as planned), pulled back to the planned roll with weight `rollSolveHold` (rad^-2).
   *  `abdSoft` = share of the MCP abduction range the fingers may use for free: beyond it the wrist / roll take over. */
  rollSolve: number
  rollSolveHold: number
  abdSoft: number
  /** Round 23: the wrist may lead / lag sideways by up to this much (wu) to bring the pressing fingers (and the thumb) inside their
   *  sideways range, pulled back to the planned x with weight `wristLeadHold` (wu^-2). 0 = the planned x only. */
  wristLead: number
  wristLeadHold: number
  /** Round 23: weight of the thumb's own sideways stretch in that choice (0 = fingers only). */
  thumbLeadWeight: number
  /** Round 23: 1 = the MCP abduction window (+-15 deg) is centred on each finger's own metacarpal axis instead of the hand's forward axis. */
  abdAboutMc: number
  /** Nominal horizontal MCP -> fingertip distance as a fraction of the finger length. */
  reachRatio: number
  /** Wrist -> elbow (wu): ~27 cm, FAA 2008 elbow–fingertip minus hand length (men 28.4 / women 25.6). */
  forearmLength: number
  /** Lateral outward tilt of the forearm (unit slope). */
  elbowOutward: number
  /** Forearm swing toward the body centre per wu of wrist x. */
  elbowSwing: number
  /** Round 34: 1 = the forearm follows the register (seated 2-link arm from a shoulder point per hand to the wrist; the elbow and the forearm
   *  direction come out of it, the hand yaw is planned relative to that forearm); 0 = the fixed `elbowOutward` / `elbowSwing` forearm (Round 33 bit for bit). */
  armModel: number
  /** Bench centre x (wu; middle C is about -0.6), the torso's rest position. */
  armBodyX: number
  /** Shoulder joints at bodyX +- this (wu, 1 wu = 10 cm). */
  armShoulderHalf: number
  /** Shoulder joint height above the key tops / distance behind the keyboard's front edge (wu). */
  armShoulderHeight: number
  armShoulderDepth: number
  /** Upper-arm length (wu); the forearm is `forearmLength`. */
  armUpperLength: number
  /** Sideways share of the elbow's preferred direction (down + out): 0 = straight down, 0.4 = ~22 deg out. */
  armElbowOut: number
  /** Share of the torso's lean toward the register the two hands' mean x is away from the bench centre (0 = no lean), its time constant (s) and cap (wu). */
  armLean: number
  armLeanTau: number
  armLeanMax: number
  /** Share of the sideways offset between the shoulder joint and the wrist the shoulder closes (trunk rotation, scapula slide toward the playing side). */
  armFollow: number
  /** The elbow swings toward the hand's own direction (the finger-driven yaw + the neutral deviation) by up to `armSwing` rad off where the shoulder geometry puts the forearm, scaled by `armAlign` (0 = pure geometry). */
  armAlign: number
  armSwing: number
  /** Dead band (rad) of the elbow's swing: it only follows the part of (hand direction - forearm direction) beyond this. */
  armBand: number
  /** Share of `armSwing` that widens the yaw range the deviation solve may use (the elbow then takes what the wrist cannot). */
  armWiden: number
  /** The shoulder is dragged toward a wrist beyond this share of the arm's length (trunk rotation / protraction). */
  armReach: number
  /** How far the hand's plan yaw follows the forearm direction (1 = hand in line with the forearm at `armNeutralDev`, 0 = hand yaw as planned from the fingers alone). */
  armYaw: number
  /** Neutral wrist deviation (rad, + = ulnar) the hand takes against the forearm before the finger needs add to it. */
  armNeutralDev: number
  /** Notes starting within this window (s) form one chord / gesture. */
  groupWindow: number
  /** Rolled chords join up to this spread when the notes are >= 3 semitones apart (chord.ts). */
  groupWindowWide: number
  /** Weight of still-held earlier notes when placing the hand for a new chord. */
  heldWeight: number
  /** Notes shorter than this (s) are treated as this long. */
  minNoteDuration: number
  /** Master scale of ALL humanising terms (sway, rest relaxation, release follow-through): 1 = on, 0 = off. */
  humanize: number
  /** Dynamics-driven motion (step 3, scaled by `humanize`): each note's velocity is normalised against the whole song
   *  (median ± half the 10–90 % spread, at least `dynMinSpread` so a near-constant-velocity song stays unchanged) and
   *  against the same hand's notes within ±`dynWindow` s (accent = notably louder than those neighbours). The
   *  normalised loudness `dyn` ∈ [−1, 1] and accent ∈ [0, 1] drive:
   *  prepared-finger lift height × (1 + dynLift·dyn + dynAccent·accent) — soft starts near the key, loud lifts high…*/
  dynLift: number
  dynAccent: number
  /** …descent time × (1 − dynAttack·dyn − 0.5·dynAttack·accent) (loud strikes faster, soft ones slower)… */
  dynAttack: number
  /** …the wrist's arm-weight preparation: it rises this much (wu at full loudness; × (1 + dynChord·min(1, (notes−1)/3))
   *  for chords, accent counts half extra) over `dynDropTime` s and drops back into the key exactly at the strike (never
   *  below its resting height, so the palm doesn't sink into the keys); folded into the snap where one is planned… */
  dynDrop: number
  dynChord: number
  dynDropTime: number
  /** …the hand's travel between chords lifts × (1 + dynTravel·dyn) (soft passages stay quiet and low)… */
  dynTravel: number
  /** …and the wrist snap (`snap*`) intensity scales × (1 + dynSnap·dyn), accented chords snap at least dynSnapAccent. */
  dynSnap: number
  dynSnapAccent: number
  dynWindow: number
  dynMinSpread: number
  /** Step-2 humanising (rest relaxation + release follow-through) on top of `humanize`: 0 = off. On hold — the user
   *  found it unnatural (the same canned motion every rest), Round 16. */
  restMotion: number
  /** Rests (a hand with nothing to hold for >= 0.8 s, incl. before the first / after the last note): wrist rise (wu)
   *  and drift back toward the player, idle fingers' extra curl (wu of reach lost), tips pulled together, thumb
   *  relaxed inward. Ramps in 0.2 s after the last release, gone 0.45 s before the next note (pre-shape untouched). */
  restRise: number
  restBack: number
  restCurl: number
  restSpread: number
  /** Long rests (> 3 s, start / end of the piece): extra lift (wu) and drift back on top of the above, slowly. */
  restFarRise: number
  restFarBack: number
  /** Round 29 idle hand withdrawal (0 = off): a hand with nothing to play for >= `withdrawMin` s (incl. before its first / after its last
   *  note) leaves the keys: down and toward the player, in front of the keyboard's edge, below key level, to its own side. */
  withdraw: number
  withdrawMin: number
  /** s after the last release before it leaves; peak arm speed (wu/s) setting the travel time; min travel time; arrival margin before the onset; min hold. */
  withdrawDelay: number
  withdrawSpeed: number
  withdrawMinTravel: number
  withdrawSettle: number
  withdrawHold: number
  /** Resting spot of the wrist: sideways from the middle (own side), in front of the keyboard edge, below the key tops (wu). */
  withdrawX: number
  withdrawFront: number
  withdrawDepth: number
  /** Relaxed lift at the start (wu), lateral arc (wu), seeded variation share of all of them (x humanize), hand shape: palm flexion (rad), idle reach lost (wu), fingers droop (wu), extra idle sway (x). */
  withdrawLift: number
  withdrawArc: number
  withdrawVar: number
  /** Round 44: the idle-hand SHAPE knobs `withdrawPitch` / `withdrawCurl` / `withdrawDroop` / `withdrawLead` / `withdrawFist` / `withdrawFistThumb` are x `humanize` (the withdrawal itself stays on at 0). */
  withdrawPitch: number
  withdrawCurl: number
  withdrawDroop: number
  withdrawSway: number
  /** Round 36: share of the way the rest x goes from the out spot to the x under the return's first note (1 = straight under it), */
  withdrawReturnX: number
  /** relaxed hand shape while withdrawn: shape reaches full at this share of the move (0.5), finger curl stagger across the fingers, extra curl (wu) and droop per finger index, thumb curl, palm flexion extra (rad), fingers' MCP extra drop */
  withdrawShapeBy: number
  withdrawStagger: number
  withdrawCurlTilt: number
  /** Round 38: the loose shape on the way back is complete at this share of the return (0.2), the wrist leads the departure with this much extension (rad) before it hangs, and the hand may start sinking while its tips are still this far (wu) in front of the front edge */
  withdrawShapeByRet: number
  withdrawLead: number
  withdrawGateLead: number
  /** Round 39 (x `humanize`): share of the loose-fist joint pose (set as joint angles, adducted, not through the tip IK) blended in while withdrawn (0 = Round 38 shape) */
  withdrawFist: number
  /** Round 39 ablation: 1 = idle fingertips clear black keys (Round 13 `tipFloor`), 0 = only the white-key top (probe: does clearance bend fingers sideways?) */
  blackFloor: number
  withdrawFistThumb: number
  /** Release follow-through: a released finger rebounds above its lift path by up to this (wu, scaled by velocity and
   *  staccato), a damped swing at `reboundHz` with decay constant `reboundDecay` (s). Zero if it re-presses soon. */
  rebound: number
  reboundHz: number
  reboundDecay: number
  /** Procedural sway master scale (1 = default, 0 = off): slow noise on the wrist position and orientation, so the
   *  hands never freeze. Applied before the finger IK, so pressing fingertips stay on their keys. */
  sway: number
  /** Slow wrist drift amplitude, sideways (wu; 0.01 wu = 1 mm); forward is 0.6× this. */
  swayDrift: number
  /** Faster small wrist-position layer (wu), ~3–5× the slow rate. */
  swayFast: number
  /** Wrist yaw sway amplitude (rad); roll is 0.8× this. */
  swayAngle: number
  /** Vertical (z) and palm-pitch sway as a share of the drift / angle amplitudes (kept small: a regular up-down
   *  rise and fall reads as breathing). */
  swayVertical: number
  /** Share of the slow amplitude carried by rare "settle" hops (the hand moves to a new resting spot). */
  swaySettle: number
  /** Idle-finger hover noise (wu): each finger's own curl / lift / spread variation, weighted by 1 - activity. */
  swayFinger: number
  /** Centre of the slow-rate spread (Hz): each channel gets its own rate, 0.27–1.5× this. */
  swayHz: number
  /** Share of the sway left while fingers press (0..1; scaled by finger activity). Zero inside repetition runs. */
  swayPlaying: number
  /** Round 22: PIP flexion floor (rad) of a finger that is not pressing: its approach / leave target is pulled in so the
   *  finger stays at least this curved (weight (1 - activity)^2). 0 = off. Not scaled by humanize (it is a fix). */
  curlFloor: number
  /** Round 22 (all scaled by humanize): */
  /** Temporal smoothing of the free fingers' targets: share of the kernel average that replaces the raw target (0 = off). */
  loose: number
  /** Half-step (s) of the 5-tap kernel (taps at -2..+2 steps, triangular weights, centre shifted `looseLag` steps back). */
  looseStep: number
  looseLag: number
  /** Drag: free fingers trail the wrist by this share of its travel over the last `dragLag` s (overlapping action), capped at `dragMax` wu. */
  drag: number
  dragLag: number
  dragMax: number
  /** Finger enslaving: reach shortening (wu) of a free finger per unit of neighbour activity (weighted by the pair table). */
  enslave: number
  /** Per-note variation (seeded hash of the note id): stroke start +-share of the attack, lift +-share, relaxed PIP +-rad. */
  varTime: number
  varLift: number
  varCurl: number
  /** Round 22: 1 = Newton steps in the wrist-yaw ROM correction (no limit-to-limit flips on fast leaps), 0 = the old 2 fixed-point steps. */
  yawNewton: number
  /** Per-knot wrist offsets (wu) of the hand position, seeded by the knot index (gated off in repetition runs). */
  varWrist: number
  /** Round 25 pedal-aware release (mechanical technique, NOT scaled by humanize; needs pedal ranges passed to buildHandMotion, 0 = off):
   *  where the sustain pedal is down across a chord's written end and the hand has a position shift of at least `pedalShift` wu
   *  to make in a gap of at least `pedalGap` s, the notes are released when the hand sets off (instead of being held to the
   *  written end / the reach limit) and the travel may start earlier (up to `pedalCap` of the gap instead of half of it) and
   *  takes `pedalSlow` x as long (slower, smoother, same arrival). `pedalTol` = how far (s) before the written end the pedal may
   *  already be lifted and still count as sustaining it. */
  pedalRelease: number
  pedalShift: number
  pedalGap: number
  pedalCap: number
  /** Round 26: share of the gap a non-arm hand move may use (0.5 = Round 25: the hand waits half the gap; ~0.9 = it flows from the strike). */
  departFrac: number
  /** …only in a glide: the move's gap is at most `departGap` s and the neighbouring hand move (previous or next non-zero) goes the same way (a run). 0 = glide off (departFrac unused). */
  departGap: number
  /** Any move: a chord whose notes are struck a few ms apart (arpeggiated / rolled) is not left before its LAST onset + this (s); 0 = off (Round 25 left at the planned time, dragging the late finger off its key). */
  departSettle: number
  /** Round 45 long-gap hold-then-move: a move whose gap is at least `holdGap` s (0 = off, Round 44 bit for bit) waits at the chord it played and then travels
   *  in its natural time (below), arriving with the usual anticipation margin; the pedal does not make it set off early / drift over the gap
   *  (`holdPedal` 1; the notes are still released early under the pedal), and a finger-crossing move no longer starts right after the strike
   *  when its gap exceeds `xoverGap` s (0 = always, Round 44). Shorter gaps (runs, fast legato) keep the early-departure rules. */
  holdGap: number
  holdPedal: number
  xoverGap: number
  /** Natural travel time of a long-gap move (Fitts-like): `fittsA + fittsB * log2(1 + dist / fittsW)` s (dist in wu), blended in by `fitts` (0 = the old distance / maxHandSpeed window). */
  fitts: number
  fittsA: number
  fittsB: number
  fittsW: number
  /** Round 45 idle-hand withdrawal: a middle rest in which the OTHER hand is idle too (a pause in the music, not one hand resting) only leaves the keys from `withdrawBothMin` s (0 = as `withdrawMin`);
   *  `withdrawPedal` 1 = a hand that released its last chord under the sustain pedal stays until the pedal comes up before it leaves. */
  withdrawBothMin: number
  withdrawPedal: number
  /** …only when that spread (last onset - first onset of the chord) is at most this (s); wider rolls keep the planned departure (shortening a big-arm-move window made the etude wrists jerkier). */
  departSpread: number
  /** Round 40 smoothness of the travel moves (x `humanize`; 0 = Round 39 exactly; 1 = default; up to ~2): the wrist plan (x / y / z / forearm roll) is averaged with a zero-phase
   *  Hann kernel of half-width `smoothness * smoothFrac * (the local gap between chords)` (<= `smoothMax` s), so the hand no longer comes to a full stop at every chord
   *  between moves (strike times unchanged; the finger IK absorbs the few mm of wrist offset), and the finger approach / release moves ease with a minimum-jerk blend
   *  (`smoothness` share) over windows widened by `smoothFinger` x smoothness (the key contact itself is untouched). */
  smoothness: number
  smoothFrac: number
  smoothMax: number
  smoothFinger: number
  /** …a move joins the next one's slope when that starts at most this many s after it ends (and goes the same way). */
  smoothJoin: number
  /** …the smoothing offset is removed around each chord onset (share `smoothStrike`, flat for 0.025 s then fading in over `smoothStrikeT` s) so the strike lands where the unsmoothed plan puts it. */
  smoothStrike: number
  smoothStrikeT: number
  /** Round 41 (x `humanize`; 0 = Round 40 exactly): big hand moves (travel `leapD0`..`leapD1` wu = weight 0..1, smooth) follow a bell-shaped, slightly asymmetric velocity profile (a minimum-jerk
   *  profile in warped time) instead of the smoothstep + wide Hann kernel (that flattened the bell into a plateau). `leapBell` = share of the bell profile (0..1). */
  leapBell: number
  /** Where the speed peaks within the move (0.5 = symmetric; ~0.42 = quick start, longer deceleration). */
  leapPeak: number
  /** The bell finishes this share of the move before the strike (the hand arrives a hair early and settles into the chord). */
  leapEarly: number
  /** (x `humanize`) Overshoot past the target as a share of the move distance, settled again by the strike (x sin^2 over the last `leapEarly` of the move). */
  leapSettle: number
  /** (x `humanize`) Extra vertical arc of the wrist (wu per wu travelled, travel capped at 1.5 wu), peaking early in the move and landing at the strike. */
  leapArc: number
  /** How much the smoothing kernel is narrowed during a bell move (1 = to nothing), so the bell is not flattened again. */
  leapKernel: number
  /** Big moves take this much longer than `maxHandSpeed` alone gives (the bell profile peaks higher than the smoothstep it replaces: 2.07 x the mean speed against 1.5 x). */
  leapWin: number
  leapD0: number
  leapD1: number
  /** (x `humanize`) Free fingers trail the wrist more during a big move (x (1 + leapDrag) in `dragMax` and `dragLag`): the wrist leads, the fingers follow. */
  leapDrag: number
  /** Round 41 chord grasp, weighted by the big move into the chord (graspStagger / Shape / Settle / Reach all x `humanize`; all 0 = Round 40): per-finger seeded +- this many seconds on the descent length (contact time unchanged), */
  graspStagger: number
  /** …the fingers' pre-shape over their keys follows the hand later (exponent 1 + this x weight on the prepare blend, reaches the chord shape by the descent), */
  graspShape: number
  /** …and the wrist sinks this far (wu) while the chord is held after landing (rise over `graspSettleT` s, back before the next departure). */
  graspSettle: number
  graspSettleT: number
  /** …and the reach pull toward the keys starts with the pre-shape (share of it used as activation) instead of in one lunge during the descent. */
  graspReach: number
  /** Round 42 gravity / arm weight (master; 0 = Round 41 bit for bit; x `humanize`). Loud strikes (note velocity above `gravityVel`, mean of the chord,
   *  x (1 + `gravityChord`) for chords) get: a higher preparation (`gravityLift` wu at full loudness and `gravityFall` s of fall time; scaled by (time
   *  available / `gravityFall`)^2, i.e. a free-fall height, so fast repeats lift little), an ACCELERATING fall into the strike (z = H (1 - (1 - s/tf)^2),
   *  the speed is largest at contact), a give (the wrist sinks `gravityGive` wu x loudness x time scale below its planned height right after contact,
   *  critically damped, velocity-continuous with the fall; the fingertips stay on their keys) and ONE rebound (`gravityRebound` x the lift, a half-sine
   *  bump of up to `gravityReboundT` s, shorter when the next chord is near, larger before a leap: it is the lift-off). The wrist pitch follows the height
   *  (`gravityPitch`: share of the wrist height change the palm pitch takes out at the knuckles), the rebound also moves the wrist `gravityForward` x
   *  its height toward the keys. `gravityMix`: share of the snap wind-up and the Round 17 arm-weight rise that gravity replaces at the same strike.
   *  `gravityVar`: seeded per-strike variation of amplitude and fall time. */
  gravity: number
  gravityVel: number
  gravityLift: number
  gravityFall: number
  gravityGive: number
  gravityRebound: number
  gravityReboundT: number
  gravityLeap: number
  gravityChord: number
  gravityPitch: number
  gravityForward: number
  gravityMix: number
  gravityVar: number
  /** Round 43 early release of held keys (visual only) before the wrist lifts for the next strike (master 1 = on, 0 = Round 42 bit for bit; see `repeatRelease`):
   *  `repRise` wrist rise (wu) above its strike height that triggers it, `repLiftMin` s kept before the next onset for the finger to lift and come back (halved gap at most),
   *  `repHold` s the key stays down at least, `repOverlap` s a note may reach past the next onset and still be released, `repMaxGap` s longest gap considered. */
  repRelease: number
  repRise: number
  repLiftMin: number
  repHold: number
  repOverlap: number
  repMaxGap: number
  /** Round 43: the key must come up at least this many seconds earlier than the MIDI says to be worth moving. */
  repMinGain: number
  /** Round 44: a sustained note is held for its written length unless the hand really leaves: the early release is only considered in the last `repWindow` s
   *  before the next strike (the whole gap if it is shorter: quick repeats), judged against the lowest wrist height of the held part. `repAbsorb`: share of the
   *  gravity rebound a chord held at least ~0.3 s does NOT make (the fingers are down: it settles; the bigger lift comes when the hand leaves). Needs `repRelease` > 0. */
  repWindow: number
  repAbsorb: number
  /** Round 26: wrist-yaw plan weight of a next-chord finger from the previous strike on (1 = full weight at the next strike; 0 = off, Round 25) over gaps up to `yawLeadGap` s. */
  yawLead: number
  yawLeadGap: number
  /** Round 28 (hand-shape flow in fast runs): 0 = off (Round 27), 1 = on (scales the wrist path blend). A run = >= `flowMinChords` chords of <= 2
   *  notes, gaps <= `flowGap` s, one pitch direction, steps <= `flowMaxStep` semitones. Within it the wrist x / y / z follow a velocity-continuous
   *  Hermite curve through nodes at the chord onsets (node values = the position path smoothed over `flowSigma` mean inter-onset intervals and kept inside `flowSlack` of each
   *  chord's feasible range), and wrist deviation / roll are held at ONE value per hand-position group (fingering reset = thumb-under / cross-over
   *  starts a new group), changing only around the shift over `flowShift` of its gap; `flowShape` scales that, `flowRamp` s eases it in / out at the
   *  run ends, `flowLift` cuts the per-move travel lift inside a run. */
  flow: number
  flowGap: number
  flowMinChords: number
  flowMaxStep: number
  flowSigma: number
  flowSlack: number
  flowShape: number
  flowRamp: number
  flowShift: number
  flowLift: number
  /** Weight of the pull of a group's wrist deviation toward the mean of its per-strike optima (the group value minimises the SUMMED devSolve cost over its strikes + this). */
  flowPull: number
  /** 1 = the group shape is also tested between two strikes (at 30 / 60 / 85 % of the gap, where the next chord's fingers are being prepared), 0 = strikes only. */
  flowMid: number
  /** Groups holding one shape only inside runs of chords of at most this many notes (the path glide covers dyads too). */
  flowShapeNotes: number
  /** A group holds one shape only if that costs at most this much summed devSolve cost over its strikes beyond their individual optima (units: squared miss in key half-widths); else its notes keep their own solve. */
  flowTol: number
  /** Share of the group roll that replaces the per-strike roll (0 = roll untouched). */
  flowRollShare: number
  pedalSlow: number
  pedalTol: number
  /** …and the fingers let go this long (s) before the hand sets off, so the wrist is not dragged by a key it has not left yet. */
  pedalLead: number
  /** Round 25 articulation: staccato from the wrist, legato from the fingers. A chord whose written duration is a small share of
   *  the interval to the hand's next chord (duration / IOI below `stacR0` = fully staccato, above `stacR1` = legato; smooth between)
   *  at a tempo with room for it (IOI `stacT0`..`stacT1` s) bounces the wrist: it rises `stacLift` wu in the gap after the
   *  release and comes back down with the strike (free fingers ride along with the hand), and the fingers' own lift after those
   *  notes shrinks by `stacFinger` x the weight (the hand does the lifting). Mechanical technique, stays on at humanize 0; the loudness
   *  scaling `stacDyn` and the per-chord seeded variation `stacVar` are x humanize. Not inside repetition runs; faded for leaps
   *  (`stacLeap` wu = distance at which it is gone: travelLift does that) and snaps. */
  stacLift: number
  stacR0: number
  stacR1: number
  stacT0: number
  stacT1: number
  stacFinger: number
  stacDyn: number
  stacVar: number
  stacLeap: number
  /** Round 27 finger staccato (per note, from the same weight; mechanical, stays on at humanize 0; the loudness scaling `stacDyn` and
   *  the seeded per-note variation `stacVar` are x humanize): the final descent takes (1 - `stacPress` x w) of its time and its profile
   *  accelerates into the key (`stacAccel` = share of a quadratic ease-in: the strike is the fastest point), and after the written end the
   *  finger is flicked up in (1 - `stacRel` x w) of its lift time with a one-peak overshoot `stacRebound` wu above the hover height
   *  (peak at `stacReboundT` s after the release, critically damped, back to the hover / prepare path by ~4x that). The hand stays
   *  quiet: only the finger joints move. */
  stacPress: number
  stacAccel: number
  stacRel: number
  stacRebound: number
  stacReboundT: number
}

export const DEFAULT_MOTION_OPTIONS: MotionOptions = {
  anticipation: 0.32,
  maxHandSpeed: 10,
  attack: 0.12,
  prepare: 0.45,
  prepareHeight: 0.55,
  prepareLead: 0.3,
  prepareWeight: 0.8,
  release: 0.15,
  hoverHeight: 0.22,
  relaxFlex: 1,
  relaxRatio: 1,
  relaxSigma: 0.35,
  relaxReach: 0.09,
  keyDip: 0.05,
  liftHover: 0.04,
  liftPrepare: 0.04,
  liftT0: 0.1,
  liftT1: 1.2,
  liftGap: 0.5,
  liftLegato: 0.4,
  liftTravelMin: 1,
  liftWalkMin: 0.06,
  altLift: 0.6,
  altAttack: 0.4,
  altRelease: 0.3,
  dipTime: 0.05,
  lateralSlack: 1,
  centering: 0.5,
  holdStretch: 1.2,
  sympathetic: 0.4,
  yawAmount: 0.8,
  fanFollow: 0.85,
  fanMargin: 0.04,
  romScale: 1,
  repeatGap: 0.25,
  repeatTilt: 0.35,
  repeatStagger: 0.1,
  repeatScratch: 0.08,
  repeatCurl: 0.2,
  crossReach: 1.0,
  latePrepare: 0.06,
  crossOverYaw: 0.2,
  thumbUnderYaw: 0.1,
  crossRelease: 0.2,
  crossCurl: 0.15,
  crossArc: 0.16,
  snapLift: 0.14,
  snapPitch: 0.3,
  snapTime: 0.16,
  repeatSpread: 0.1,
  handGap: 1.1,
  overBack: 0.6,
  overLift: 0.32,
  overPitch: 0.5,
  yieldDrop: 0.2,
  yieldBack: 0.1,
  overIdleDrop: 0.35,
  overPitchLift: 0.15,
  overPitchFrom: 0.7,
  handScale: 1,
  whiteStrikeY: 0.42,
  blackStrikeY: 0.8,
  shortBlackStrikeY: 0.68,
  thumbStrikeY: 0.3,
  reachLong: 0.5,
  reachPlan: 3,
  thumbSide: 1,
  thumbIpRest: 0,
  wristHeight: 0.7,
  blackLift: 0.05,
  travelLift: 0.1,
  palmPitch: 0,
  rollAmount: 0.2,
  rollTravel: 0.15,
  rotAmp: 0.12,
  rotLead: 0.02,
  rotWindow: 0.3,
  rotDyn: 0.3,
  rotWeak: 0.1,
  rotMelody: 0.1,
  rotShift: 0,
  rotLeapAt: 0.15,
  rotLeap: 1,
  rotLift: 1.5,
  rotAlt: 0.5,
  rotTravelDamp: 0.7,
  devTravel: 0,
  rollLift: 1.5,
  travelWindow: 0.6,
  travelSpan: 1.0,
  devSolve: 1,
  devSolveHold: 0.02,
  rollSolve: 0,
  rollSolveHold: 0.05,
  abdSoft: 0.6,
  wristLead: 0,
  wristLeadHold: 0.3,
  thumbLeadWeight: 0,
  abdAboutMc: 1,
  reachRatio: 0.55,
  forearmLength: 2.7,
  elbowOutward: 0.12,
  elbowSwing: 0.05,
  armModel: 0,
  armBodyX: -0.5,
  armShoulderHalf: 1.7,
  armShoulderHeight: 3.0,
  armShoulderDepth: 5.0,
  armUpperLength: 3.0,
  armElbowOut: 0.2,
  armLean: 0.5,
  armLeanTau: 0.8,
  armLeanMax: 2.5,
  armFollow: 0.7,
  armAlign: 0.6,
  armSwing: 0.3,
  armBand: 0,
  armWiden: 0,
  armReach: 0.9,
  armYaw: 0,
  armNeutralDev: 0.08,
  groupWindow: CHORD_NARROW_SEC,
  groupWindowWide: CHORD_WIDE_SEC,
  heldWeight: 0.6,
  minNoteDuration: 0.05,
  humanize: 1,
  dynLift: 0.4,
  dynAccent: 0.35,
  dynAttack: 0.4,
  dynDrop: 0.05,
  dynChord: 0.6,
  dynDropTime: 0.14,
  dynTravel: 0.5,
  dynSnap: 0.6,
  dynSnapAccent: 0.7,
  dynWindow: 1,
  dynMinSpread: 0.1,
  restMotion: 0,
  restRise: 0.15,
  restBack: 0.1,
  restCurl: 0.12,
  restSpread: 0.35,
  restFarRise: 0.3,
  restFarBack: 0.25,
  withdraw: 1,
  withdrawMin: 3,
  withdrawDelay: 0.05,
  withdrawSpeed: 5.2,
  withdrawMinTravel: 0.8,
  withdrawSettle: 0.55,
  withdrawHold: 0.25,
  withdrawX: 1.5,
  withdrawFront: 4.1,
  withdrawDepth: 2,
  withdrawLift: 0.2,
  withdrawArc: 0.25,
  withdrawVar: 1,
  withdrawPitch: 0.22,
  withdrawCurl: 0.35,
  withdrawDroop: 0.35,
  withdrawSway: 1.6,
  withdrawReturnX: 1,
  withdrawShapeBy: 0.3,
  withdrawStagger: 0.08,
  withdrawCurlTilt: 0,
  withdrawShapeByRet: 0.35,
  withdrawLead: 0.1,
  withdrawGateLead: 0.4,
  withdrawFist: 1,
  blackFloor: 1,
  withdrawFistThumb: 1,
  rebound: 0.12,
  reboundHz: 3.5,
  reboundDecay: 0.18,
  sway: 1,
  swayDrift: 0.085,
  swayFast: 0.01,
  swayAngle: 0.055,
  swayVertical: 0.25,
  swaySettle: 0.5,
  swayFinger: 0.03,
  swayHz: 0.3,
  swayPlaying: 0.05,
  curlFloor: 0.45,
  loose: 1,
  looseStep: 0.03,
  looseLag: 0.5,
  drag: 0.5,
  dragLag: 0.04,
  dragMax: 0.02,
  enslave: 0.03,
  varTime: 0.12,
  varLift: 0.3,
  varCurl: 0.12,
  yawNewton: 0,
  varWrist: 0.012,
  pedalRelease: 1,
  pedalShift: 0.4,
  pedalGap: 0.3,
  pedalCap: 0.85,
  departFrac: 1,
  departGap: 0.35,
  holdGap: 1.2,
  holdPedal: 1,
  xoverGap: 0.8,
  fitts: 1,
  fittsA: 0.28,
  fittsB: 0.13,
  fittsW: 0.5,
  withdrawBothMin: 8,
  withdrawPedal: 1,
  smoothness: 1.5,
  smoothFrac: 0.8,
  smoothMax: 0.12,
  smoothFinger: 0.2,
  smoothJoin: 0.02,
  smoothStrike: 0.75,
  smoothStrikeT: 0.07,
  leapBell: 0.5,
  leapPeak: 0.42,
  leapEarly: 0.1,
  leapSettle: 0.012,
  leapArc: 0.05,
  leapKernel: 0.8,
  leapWin: 0.35,
  leapD0: 0.3,
  leapD1: 1.0,
  leapDrag: 2,
  graspStagger: 0.02,
  graspShape: 0.8,
  graspSettle: 0.02,
  graspSettleT: 0.15,
  graspReach: 0.6,
  gravity: 1,
  gravityVel: 0.7,
  gravityLift: 0.14,
  gravityFall: 0.11,
  gravityGive: 0.035,
  gravityRebound: 0.5,
  gravityReboundT: 0.34,
  gravityLeap: 0.6,
  gravityChord: 0.3,
  gravityPitch: 0.5,
  gravityForward: 0.3,
  gravityMix: 0.6,
  gravityVar: 0.25,
  repRelease: 1,
  repRise: 0.02,
  repLiftMin: 0.12,
  repHold: 0.06,
  repOverlap: 0.05,
  repMaxGap: 1.5,
  repMinGain: 0.05,
  repWindow: 0.3,
  repAbsorb: 0.85,
  departSettle: 0.01,
  departSpread: 0.04,
  yawLead: 1,
  yawLeadGap: 0.22,
  flow: 1,
  flowGap: 0.27,
  flowMinChords: 4,
  flowMaxStep: 5,
  flowSigma: 1,
  flowSlack: 0.6,
  flowShape: 1,
  flowRamp: 0.15,
  flowShift: 1.5,
  flowLift: 1,
  flowPull: 0.5,
  flowMid: 1,
  flowShapeNotes: 1,
  flowTol: 0.05,
  flowRollShare: 1,
  pedalSlow: 1.35,
  pedalTol: 0.1,
  pedalLead: 0,
  stacLift: 0,
  stacR0: 0.3,
  stacR1: 0.7,
  stacT0: 0.12,
  stacT1: 0.3,
  stacFinger: 0,
  stacDyn: 0.4,
  stacVar: 0.25,
  stacLeap: 1,
  stacPress: 0,
  stacAccel: 0.7,
  stacRel: 0,
  stacRebound: 0,
  stacReboundT: 0.035,
}

// ---- hand geometry (unscaled, hand-local, R hand; L mirrors x) -----------------------------------------------
// Local frame: origin = wrist, +x lateral (pinky side for R), +y toward the fingertips, +z up. Bones, joint
// positions and ROM live in skeleton.ts (sourced); here only the rest knuckles the planner works from.
const REST_HEAD = [0, 1, 2, 3, 4].map((f) => (f === 0 ? THUMB_MCP_REST : metacarpalHead(f)))
const FINGER_LAT = REST_HEAD.map((v) => v[0]) // MCP lateral (thumb: its rest MCP)
const FINGER_LY = REST_HEAD.map((v) => v[1]) // MCP forward distance from the wrist
const FINGER_LZ = REST_HEAD.map((v) => v[2]) // ring / little knuckles sit lower (rest cupping)
const THUMB_MCP = THUMB_MCP_REST
/** Lateral offset of each finger's resting tip (what the hand anchor is computed from). */
const TIP_LAT = [-0.45, -0.37, -0.12, 0.12, 0.35]
const THUMB_HOVER_INWARD = -0.12 // negative: the resting thumb tip sits a little outside its knuckle
/** The resting thumb hovers lower than the fingers (share of hoverHeight). */
const THUMB_HOVER_Z = 0.45

/** How far each fingertip may sit sideways from its rest spot without moving the hand (unscaled wu): for the fingers
 *  what MCP abduction (±15°) swings the tip at the nominal reach (0.55 of the finger — `reachRatio`'s default), so
 *  the planner never counts on a reach the pose then has to clamp; the thumb's CMC swings far more (tuned). */
const TIP_SLACK = [0.2, ...[1, 2, 3, 4].map((f) => 0.55 * CHAIN_LEN[f] * Math.sin(Math.min(MCP_ABD[f][0], MCP_ABD[f][1])))]

/** Thumbs reach (and sit) further out relative to their length than the fingers. */
const REACH_MULT = [1.5, 1, 1, 1, 1]
const TOTAL_LEN = BONES.map((b, i) => b.reduce((a, c) => a + c, 0) * REACH_MULT[i])

/** Margin (rad) kept inside the MCP hyperextension limit: the solver bends in the finger's tilted hinge plane, so with
 *  the finger abducted the hyperextension measured against its metacarpal (skeleton-check) runs ~1.5° past it. */
const HYPER_MARGIN = 0.03

/** Black keys' x centres and half widths (sorted), for the fingertip clearance floor. */
const BLACK_X = KEYBOARD_LAYOUT.keys.filter((k) => k.isBlack).map((k) => [k.x, k.width / 2] as const)
/** Lowest a fingertip centre (radius r) may be at (x, y) without cutting into a key it isn't pressing: above a black
 *  key's top where its sphere overlaps one, else above the white keys' top. */
let BLACK_FLOOR = 1
function tipFloor(x: number, y: number, r: number): number {
  if (BLACK_FLOOR === 0) return r
  if (y - KEYBOARD_Y < WHITE_KEY_LENGTH - BLACK_KEY_LENGTH - r) return r
  for (const [bx, hw] of BLACK_X) if (Math.abs(x - bx) < hw + r) return BLACK_KEY_THICKNESS + r
  return r
}

/** `tipFloor` for a hand leaving the keyboard: in front of the front edge (y < KEYBOARD_Y - r) nothing is there to clear, eased in over 2 r. */
function tipFloorFree(x: number, y: number, r: number): number {
  const u = (y - (KEYBOARD_Y - 3 * r)) / (2 * r)
  const s = u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u)
  return s * tipFloor(x, y, r) - (1 - s) * 9
}

/** Azimuth (rad, + toward the little finger) of each metacarpal in the palm plane, from the hand's forward axis: the centre of the
 *  MCP abduction window when `abdAboutMc` is on (index / middle fan toward the thumb, ring / little toward the little finger). */
const abdC = [0, 1, 2, 3, 4].map((f) => {
  if (f === 0) return 0
  const b = metacarpalBase(f)
  const hd = metacarpalHead(f)
  return Math.atan2(hd[0] - b[0], hd[1] - b[1])
})

/** Whether (x, y) lies on a black key's top (not the white key between / in front of them). */
function isBlackAt(x: number, y: number): boolean {
  if (y - KEYBOARD_Y < WHITE_KEY_LENGTH - BLACK_KEY_LENGTH) return false
  for (const [bx, hw] of BLACK_X) if (Math.abs(x - bx) < hw) return true
  return false
}

// ---- data structures -----------------------------------------------------------------------------------------
type FingerTrack = {
  on: Float64Array
  off: Float64Array
  x: Float64Array
  y: Float64Array
  top: Float64Array
  dip: Float64Array
  /** 1 = this note is part of a same-key repetition run (scratch motion). */
  rep: Uint8Array
  /** Round 35: 1 = note of a thumb-and-finger alternation on one key (`altLift`). */
  alt: Uint8Array
  /** 0..1: how unhurried the hand is before this note (gap since the hand's previous chord: 0 ≤ 0.25 s, 1 ≥ 0.6 s). */
  calm: Float64Array
  /** 1 = reached by an arm move (hand position jumps > crossReach): prepare only just before. */
  late: Uint8Array
  /** Round 41: grasp weight (the bell weight of the big move into this note's chord, less for a lone note) and a seeded -1..1 stagger value. */
  gw: Float64Array
  gs: Float64Array
  /** 1 = this note's finger crosses over the thumb to reach it (prepares curled, arched over the thumb). */
  xover: Uint8Array
  /** Seconds the finger takes to lift after this note (shorter when the arm is already leaping away). */
  rel: Float64Array
  /** Release rebound amplitude (wu) after this note (0 = none). */
  rb: Float64Array
  /** 0..1 lift scale of the stretch between this note and the finger's next one (Round 20): 0 = stays at the key,
   *  1 = full hover / prepare height. */
  lift: Float64Array
  /** Normalised loudness −1..1 and accent 0..1 of this note (see `dynLift`). */
  dyn: Float64Array
  acc: Float64Array
  /** Round 27: finger staccato weight of this note's press (descent) and release (rebound), 0..1, and the rebound's amplitude scale (loudness x variation). */
  swP: Float64Array
  swR: Float64Array
  swA: Float64Array
  /** Round 22: per-note variation, 3 channels (stroke timing, lift, curl) in -1..1 from a seeded hash of the note id. */
  vr: Float64Array
}

type HandTrack = {
  hand: Hand
  m: number // +1 R, -1 L
  fingers: FingerTrack[]
  knotT: Float64Array
  knotS: Float64Array // transition start per segment i -> i+1
  /** Round 40: normalised start / end slope of the wrist move i -> i+1 (0 = smoothstep: stops at both ends; > 0 where the neighbouring move follows at once in the same direction). */
  knotM0: Float64Array
  knotM1: Float64Array
  /** Round 41: weight (0..1) of the bell profile on the wrist move i -> i+1. */
  knotBell: Float64Array
  knotX: Float64Array
  knotY: Float64Array
  knotZ: Float64Array
  knotR: Float64Array
  /** Round 23: travel direction -1..1 per knot (+ = toward +x). */
  knotTrav: Float64Array
  /** Round 24: per chord onset, the forearm rotation target (rad, + = toward world +x side down). */
  rotT: Float64Array
  rotV: Float64Array
  knotDist: Float64Array // travel distance per segment (for the lift)
  /** Round 28 flow: per segment k -> k+1 inside a run (0/1), the run's first / last chord, per chord the hand-position group id, the group's wrist
   *  deviation / roll, and the Hermite nodes (value + tangent) of the wrist path. */
  flowSeg: Uint8Array
  flowA: Int32Array
  flowB: Int32Array
  flowG: Int32Array
  flowU: Float64Array
  flowRoll: Float64Array
  flowN: Float64Array[] // [x, xm, y, ym, z, zm]
  /** Round 25: staccato bounce weight per segment k -> k+1 (0..1), the written chord-end offset in it (s since onset), the mean loudness of the next chord. */
  stacW: Float64Array
  stacH: Float64Array
  knotO: Float64Array // 0..1 playing over the other hand
  repS: Float64Array // repetition runs [start, end] (sorted, disjoint)
  repE: Float64Array
  repX: Float64Array // the run's key x
  repLat: Float64Array // mean rest lateral offset (world, mirrored) of the run's fingertips from the wrist
  repLen: Float64Array // mean wrist -> rest fingertip forward distance of the run's fingers
  // crossing events: deviation `crossU` (ulnar +) rising over [crossS, crossP], unwinding by crossE
  crossS: Float64Array
  crossP: Float64Array
  crossE: Float64Array
  crossU: Float64Array
  // wrist snap per knot: intensity 0..1 and wind-up time
  snapI: Float64Array
  snapPre: Float64Array
  /** Round 42 gravity per knot (strike): weight 0..1.3, lift height H (wu), fall time, rise time, give depth, give time constant, rebound height, rebound duration (0 = none). */
  gravW: Float64Array
  gravH: Float64Array
  gravTf: Float64Array
  gravTr: Float64Array
  gravD: Float64Array
  gravTs: Float64Array
  gravR: Float64Array
  gravTR: Float64Array
  /** Per knot: mean normalised loudness, max accent, chord size (dynamics: wrist drop, soft-hand lowering, snap scale). */
  dynK: Float64Array
  accK: Float64Array
  cntK: Float64Array
  /** Rests: [gapA, gapB] intervals with nothing held (>= 0.8 s; the first starts at -1e9, the last ends at 1e9). */
  gapA: Float64Array
  gapB: Float64Array
  /** Round 29 withdrawals: WD_STRIDE numbers per idle span (see `buildWithdrawals`), sorted by start time. */
  wd: Float64Array
}

export type HandMotion = {
  opts: MotionOptions
  L: HandTrack | null
  R: HandTrack | null
  /** Round 34: torso lean (wu, + = toward +x) sampled every LEAN_DT s from LEAN_T0 (null with `armModel` 0). */
  lean: Float64Array | null
}
const LEAN_DT = 0.05
const LEAN_T0 = -1

/** Round 34: the torso leans toward the register the hands are in. Target = armLean x (the two hands' mean planned wrist x - bench centre),
 *  smoothed forward and backward in time (so it starts leaning a little before the hands arrive and never steps), capped at armLeanMax. */
function buildLean(L: HandTrack | null, R: HandTrack | null, o: MotionOptions): Float64Array {
  const tEnd = Math.max(L ? L.knotT[L.knotT.length - 1] : 0, R ? R.knotT[R.knotT.length - 1] : 0) + 2
  const N = Math.max(2, Math.ceil((tEnd - LEAN_T0) / LEAN_DT) + 1)
  const x = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    const t = LEAN_T0 + i * LEAN_DT
    let sum = 0, c = 0
    if (L) { sum += knotXAt(L, t); c++ }
    if (R) { sum += knotXAt(R, t); c++ }
    x[i] = c ? sum / c - o.armBodyX : 0
  }
  const a = Math.exp(-LEAN_DT / Math.max(1e-3, o.armLeanTau))
  const f = new Float64Array(N), b = new Float64Array(N)
  f[0] = x[0]
  for (let i = 1; i < N; i++) f[i] = a * f[i - 1] + (1 - a) * x[i]
  b[N - 1] = x[N - 1]
  for (let i = N - 2; i >= 0; i--) b[i] = a * b[i + 1] + (1 - a) * x[i]
  const out = new Float64Array(N)
  for (let i = 0; i < N; i++) out[i] = clamp(o.armLean * 0.5 * (f[i] + b[i]), -o.armLeanMax, o.armLeanMax)
  return out
}
function leanAt(motion: HandMotion, t: number): number {
  const a = motion.lean
  if (!a) return 0
  const u = (t - LEAN_T0) / LEAN_DT
  if (u <= 0) return a[0]
  if (u >= a.length - 1) return a[a.length - 1]
  const i = Math.floor(u)
  return a[i] + (u - i) * (a[i + 1] - a[i])
}

/** Round 34: the seated arm. Shoulder joint (bench centre + lean, +- half the shoulder width, behind the keyboard and above the keys) -> elbow
 *  (two-link, upper arm / forearm; the elbow on the circle of solutions as near as it gets to "down and out") -> wrist. A wrist beyond `armReach` of
 *  the arm's length drags the shoulder toward it (trunk rotation / protraction; softly, so the elbow stays C1 in the wrist position).
 *  Returns the elbow's offset from the wrist. */
export function armElbowOffset(o: MotionOptions, m: number, S: number, wx: number, wy: number, wz: number, lean: number): Vec3 {
  const U = o.armUpperLength * S, F = o.forearmLength * S
  let sx = o.armBodyX + lean + m * o.armShoulderHalf * S
  let sy = KEYBOARD_Y - o.armShoulderDepth * S
  let sz = o.armShoulderHeight * S
  sx += o.armFollow * (wx - sx)
  let dx = wx - sx, dy = wy - sy, dz = wz - sz
  let D = Math.hypot(dx, dy, dz)
  const e = D - o.armReach * (U + F), w = 0.3
  const pull = 0.5 * (e + Math.sqrt(e * e + w * w)) - 0.5 * w
  if (pull > 0) { sx += (dx / D) * pull; sy += (dy / D) * pull; sz += (dz / D) * pull; dx = wx - sx; dy = wy - sy; dz = wz - sz; D = Math.hypot(dx, dy, dz) }
  const ax = dx / D, ay = dy / D, az = dz / D
  const a = (U * U - F * F + D * D) / (2 * D)
  const r = Math.sqrt(Math.max(0, U * U - a * a))
  // preferred elbow direction (down and out), made perpendicular to the shoulder -> wrist axis
  let px = m * o.armElbowOut, py = 0, pz = -1
  const d = px * ax + py * ay + pz * az
  px -= d * ax; py -= d * ay; pz -= d * az
  const pl = Math.hypot(px, py, pz) || 1
  return [sx + a * ax + (r * px) / pl - wx, sy + a * ay + (r * py) / pl - wy, sz + a * az + (r * pz) / pl - wz]
}

type Entry = {
  on: number; off: number; f: number; kx: number; ky: number; top: number; vel: number; black: boolean
  rep: boolean; alt: boolean; calm: number; k: number; late: boolean; xover: boolean
  midi: number
  id: number
  /** Round 25: release time the pedal allows (Infinity = none), applied after the lift scale is measured. */
  pedOff: number
  /** 0..1: this note is played over the other hand (further in, wrist higher). */
  over: number
  dyn: number
  acc: number
  rel: number
}

const smooth = (u: number) => {
  const c = u < 0 ? 0 : u > 1 ? 1 : u
  return c * c * (3 - 2 * c)
}
/** Inverse of `smooth` on [0, 1]. */
function invSmooth(v: number): number {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 20; i++) {
    const mid = 0.5 * (lo + hi)
    if (smooth(mid) < v) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

function upperBound(a: Float64Array, v: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (a[mid] <= v) lo = mid + 1
    else hi = mid
  }
  return lo
}

// ---- build ---------------------------------------------------------------------------------------------------
/** Chord membership by onset gap and key distance (same rule as chord.ts, on world x). */
const chordJoin = (o: MotionOptions, dt: number, dkx: number): boolean =>
  joinsChord(dt, (Math.abs(dkx) / WHITE_KEY_WIDTH) * (12 / 7), o.groupWindow, o.groupWindowWide)

/** Round 44: the stylistic features scale with the `humanize` master (x 1 = unchanged bit for bit, 0 = the plain mechanical motion): `smoothness` (Round 40, incl.
 *  its finger easing), `leapBell` and the Round 41 leap / grasp shaping (`leapArc`, `leapSettle`, `leapDrag`, `graspStagger` / `Shape` / `Settle` / `Reach`), and the
 *  SHAPE of the idle hand (`withdrawFist` / `FistThumb` / `Curl` / `Droop` / `Pitch` / `Lead`; the withdrawal itself, leaving the keys and going off-screen, stays on).
 *  Mechanical fixes (`repRelease`, reach, collisions, withdraw timing) are not scaled. Applied once to the merged options, so `motion.opts` carries the scaled values. */
function scaleByHumanize(o: MotionOptions): MotionOptions {
  const h = o.humanize
  if (h === 1) return o
  const r = { ...o }
  for (const k of ['smoothness', 'leapBell', 'leapArc', 'leapSettle', 'leapDrag', 'graspStagger', 'graspShape', 'graspSettle', 'graspReach',
    'withdrawFist', 'withdrawFistThumb', 'withdrawCurl', 'withdrawDroop', 'withdrawPitch', 'withdrawLead'] as const) r[k] = o[k] * h
  return r
}

export function buildHandMotion(notes: NoteEvent[], plan: HandPlan, optsIn?: Partial<MotionOptions>, pedal?: readonly PedalRange[]): HandMotion {
  const opts: MotionOptions = scaleByHumanize({ ...DEFAULT_MOTION_OPTIONS, ...optsIn })
  const per: Record<Hand, Entry[]> = { L: [], R: [] }
  for (const n of notes) {
    const fg = plan.get(n.id)
    if (!fg) continue
    const key = keyForMidi(n.midi)
    if (!key) continue
    const f = fg.finger - 1
    const short = f === 0 || f === 4
    const strike = key.isBlack ? (short ? opts.shortBlackStrikeY : opts.blackStrikeY) : f === 0 ? opts.thumbStrikeY : opts.whiteStrikeY
    per[fg.hand].push({
      on: n.time,
      off: n.time + Math.max(n.duration, opts.minNoteDuration),
      f,
      kx: key.x,
      ky: KEYBOARD_Y + strike,
      // the fingertip touches with its pad: its centre sits one tip radius above the key surface
      top: (key.isBlack ? BLACK_KEY_THICKNESS : 0) + fingerRadius(f, 1, opts.handScale),
      vel: n.velocity,
      black: key.isBlack,
      rep: false,
      alt: false,
      calm: 1,
      k: 0,
      late: false,
      xover: false,
      midi: n.midi,
      id: n.id,
      pedOff: Infinity,
      over: 0,
      dyn: 0,
      acc: 0,
      rel: opts.release,
    })
  }
  dynamics(per, notes, plan, opts)
  if (per.L.length && per.R.length) handOver(per, opts, pedal)
  const L = per.L.length ? buildTrack('L', per.L, opts, false, pedal, per.R) : null
  const R = per.R.length ? buildTrack('R', per.R, opts, false, pedal, per.L) : null
  if (opts.flow > 0) {
    // a run in which either hand plays over the other (hands crossing) keeps the planned path
    const clearCrossed = (h: HandTrack | null, other: HandTrack | null) => {
      if (!h || !other) return
      for (let k = 0; k < h.knotT.length; k++) {
        if (!h.flowSeg[k] || h.flowA[k] < 0) continue
        const a = h.flowA[k], b = h.flowB[k]
        const t0 = h.knotT[a] - 0.5, t1 = h.knotT[b] + 0.5
        let hit = false
        for (let q = 0; q < other.knotT.length && !hit; q++) if (other.knotT[q] >= t0 && other.knotT[q] <= t1 && other.knotO[q] > 1e-3) hit = true
        for (let q = 0; q < h.knotT.length && !hit; q++) if (h.knotT[q] >= t0 && h.knotT[q] <= t1 && h.knotO[q] > 1e-3) hit = true
        if (hit) for (let q = a; q <= b; q++) { h.flowSeg[q] = 0; h.flowG[q] = -1; h.flowA[q] = -1; h.flowB[q] = -1 }
      }
    }
    clearCrossed(L, R)
    clearCrossed(R, L)
    if (opts.flowShape > 0) { if (L) computeFlowShapes(opts, L); if (R) computeFlowShapes(opts, R) }
  }

  return { opts, L, R, lean: opts.armModel > 0 ? buildLean(L, R, opts) : null }
}

/** Normalised loudness (`dyn`) and accent (`acc`) per entry: velocity against the whole song's distribution and against
 *  the same hand's notes around it. Pure and deterministic; constant-velocity songs give dyn = acc = 0 everywhere. */
function dynamics(per: Record<Hand, Entry[]>, notes: NoteEvent[], plan: HandPlan, o: MotionOptions) {
  const v = notes.filter((n) => plan.has(n.id)).map((n) => n.velocity).sort((a, b) => a - b)
  if (v.length < 2) return
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))]
  const med = q(0.5)
  const spread = Math.max(0.5 * (q(0.9) - q(0.1)), o.dynMinSpread)
  for (const h of ['L', 'R'] as Hand[]) {
    const es = [...per[h]].sort((a, b) => a.on - b.on)
    const pre = new Float64Array(es.length + 1)
    for (let i = 0; i < es.length; i++) pre[i + 1] = pre[i] + es[i].vel
    let lo = 0
    let hi = 0
    for (let i = 0; i < es.length; i++) {
      while (es[lo].on < es[i].on - o.dynWindow) lo++
      while (hi < es.length && es[hi].on <= es[i].on + o.dynWindow) hi++
      const cnt = hi - lo - 1
      const local = cnt > 0 ? (pre[hi] - pre[lo] - es[i].vel) / cnt : med
      const g = clamp((es[i].vel - med) / spread, -1, 1)
      const l = (es[i].vel - local) / spread
      es[i].dyn = clamp(0.7 * g + 0.3 * clamp(l, -1, 1), -1, 1)
      es[i].acc = smooth((l - 0.4) / 0.6)
    }
  }
}

/** Wrist x of a built track at t (the knot plan only). */
function knotXAt(h: KnotPlan, t: number): number {
  const n = h.knotT.length
  const k = upperBound(h.knotT, t) - 1
  if (k < 0) return h.knotX[0]
  if (k >= n - 1) return h.knotX[n - 1]
  const s = h.knotS[k]
  const span = h.knotT[k + 1] - s
  const u = span > 1e-9 ? smooth((t - s) / span) : 1
  return h.knotX[k] + u * (h.knotX[k + 1] - h.knotX[k])
}

/** Hands sharing the keys: where the wrists come closer than handGap (or cross), the hand that has gone further into
 *  the other's side (measured from middle C) plays over the other — its strikes move further in on the keys (white
 *  keys between the black ones) and its wrist rises, so its palm passes above the other hand's fingers and its
 *  fingers come down beyond their tips. Decided on a preliminary plan of both hands, then the tracks are rebuilt. */
function handOver(per: Record<Hand, Entry[]>, o: MotionOptions, pedal?: readonly PedalRange[]) {
  const pre = {
    L: buildTrack('L', per.L.map((e) => ({ ...e })), o, true, pedal),
    R: buildTrack('R', per.R.map((e) => ({ ...e })), o, true, pedal),
  }
  const mid = keyForMidi(60)!.x
  const black = (midi: number) => { const k = keyForMidi(midi); return k && k.isBlack ? k : null }
  for (const hand of ['L', 'R'] as const) {
    for (const e of per[hand]) {
      // sample the wrists over the note's hold, take the worst (NOT the approach: the wrist is still in flight from
      // the previous position there, which flagged the note that ENDS a crossing as played over the other hand)
      let A = 0
      for (let q = 0; q <= 1; q++) {
        const t = e.on + q * 0.5 * Math.min(0.05, e.off - e.on)
        const xL = knotXAt(pre.L, t)
        const xR = knotXAt(pre.R, t)
        const crosser = xL - mid > mid - xR ? 'L' : 'R'
        if (crosser === hand) A = Math.max(A, smooth((o.handGap - (xR - xL)) / 0.4))
      }
      if (A <= 0) continue
      e.over = A
      const yl = e.ky - KEYBOARD_Y
      const back = Math.min(yl + o.overBack * A, WHITE_KEY_LENGTH - 0.12)
      e.ky = KEYBOARD_Y + back
      if (!e.black && back > WHITE_KEY_LENGTH - BLACK_KEY_LENGTH) {
        // further in, a white key is only the gap between its black neighbours
        const lo = black(e.midi - 1)
        const hi = black(e.midi + 1)
        const k = keyForMidi(e.midi)!
        const l = lo ? lo.x + lo.width / 2 : k.x - k.width / 2
        const r = hi ? hi.x - hi.width / 2 : k.x + k.width / 2
        e.kx += smooth((back - (WHITE_KEY_LENGTH - BLACK_KEY_LENGTH)) / 0.1) * (0.5 * (l + r) - e.kx)
      }
    }
  }
}

type KnotPlan = Pick<HandTrack, 'knotT' | 'knotS' | 'knotX'>

function buildTrack(hand: Hand, entries: Entry[], o: MotionOptions, knotsOnly: false, pedal?: readonly PedalRange[], other?: readonly Entry[]): HandTrack
function buildTrack(hand: Hand, entries: Entry[], o: MotionOptions, knotsOnly: true, pedal?: readonly PedalRange[]): KnotPlan
function buildTrack(hand: Hand, entries: Entry[], o: MotionOptions, knotsOnly = false, pedal?: readonly PedalRange[], other?: readonly Entry[]): HandTrack | KnotPlan {
  entries.sort((a, b) => a.on - b.on || a.kx - b.kx)
  const m = hand === 'R' ? 1 : -1
  const S = o.handScale

  // Calm: gap since the hand's previous chord (pre-shaping only gets the wrist / other fingers involved when slow).
  {
    let prevChord = -Infinity
    let chordOn = -Infinity
    let chordNear: number | null = null
    for (const e of entries) {
      if (e.on - chordOn > o.groupWindow && !(chordNear !== null && chordJoin(o, e.on - chordOn, e.kx - chordNear))) { prevChord = chordOn; chordOn = e.on; chordNear = e.kx } else if (chordNear === null) chordNear = e.kx
      e.calm = smooth((e.on - prevChord - 0.25) / 0.35)
    }
  }

  // Same-key repetition runs (≥ 3 single notes on one key, ≥ 2 fingers, quick): the thumb-side finger strikes
  // deeper into the key so the fingers take turns along it.
  const repS: number[] = []
  const repE: number[] = []
  const repX: number[] = []
  const repLat: number[] = []
  const repLen: number[] = []
  for (let a = 0; a < entries.length; ) {
    let b = a + 1
    while (b < entries.length && entries[b].kx === entries[a].kx && entries[b].on - entries[b - 1].on <= o.repeatGap &&
      !chordJoin(o, entries[b].on - entries[b - 1].on, entries[b].kx - entries[b - 1].kx)) b++
    const fingersUsed = new Set(entries.slice(a, b).map((e) => e.f))
    // (not with the thumb: 1-2 repetitions are played from the thumb's side, no tilt / scratch)
    if (b - a >= 3 && fingersUsed.size >= 2 && !fingersUsed.has(0)) {
      const keyX = entries[a].kx // before the side-by-side spread below
      const fMax = Math.max(...fingersUsed)
      for (let k = a; k < b; k++) {
        entries[k].rep = true
        entries[k].ky += o.repeatStagger * (fMax - entries[k].f)
        // side by side on the key: thumb-side finger toward the thumb side
        const fMin = Math.min(...fingersUsed)
        // (scaled to the key: on a black key the tips stay on its narrower top)
        entries[k].kx += m * o.repeatSpread * (entries[k].black ? BLACK_KEY_WIDTH / WHITE_KEY_WIDTH : 1) * ((entries[k].f - fMin) / Math.max(1, fMax - fMin) - 0.5) * 2
      }
      const s0 = entries[a].on
      const e0 = entries[b - 1].off
      const fl = [...fingersUsed]
      const lat = fl.reduce((acc, f) => acc + m * TIP_LAT[f] * S, 0) / fl.length
      const len = fl.reduce((acc, f) => acc + (f === 0 ? THUMB_MCP[1] : FINGER_LY[f]) * S + o.reachRatio * TOTAL_LEN[f] * S, 0) / fl.length
      if (repE.length && s0 <= repE[repE.length - 1]) repE[repE.length - 1] = Math.max(repE[repE.length - 1], e0)
      else { repS.push(s0); repE.push(e0); repX.push(keyX); repLat.push(lat); repLen.push(len) }
    } else if (b - a >= 3 && fingersUsed.size >= 2) {
      // Round 35: a thumb-and-finger alternation on one key (1-2-1-2): no side-by-side walk, but each finger must visibly lift
      // while the other strikes (see `altLift`)
      for (let k = a; k < b; k++) entries[k].alt = true
    }
    a = b
  }
  const cosP = Math.cos(o.palmPitch)

  // Knots: one per chord.
  const kT: number[] = []
  const kX: number[] = []
  const kY: number[] = []
  const kZ: number[] = []
  const kR: number[] = []
  const kO: number[] = []
  const rotT: number[] = []
  const rotSide: number[] = []
  const rotBias: number[] = []
  const rotDyn: number[] = []
  const kLo: number[] = [] // feasible wrist-x range of the chord (+ still-held notes)
  const kHi: number[] = []
  let held: Entry[] = []
  let i = 0
  while (i < entries.length) {
    const t0 = entries[i].on
    let j = i
    while (j < entries.length && chordJoin(o, entries[j].on - t0, j > i ? Math.min(...entries.slice(i, j).map((x) => entries[j].kx - x.kx).map(Math.abs)) : 0)) j++
    held = held.filter((e) => e.off > t0)
    let sw = 0
    let sx = 0
    let sy = 0
    let sb = 0
    let sr = 0
    let so = 0
    let sow = 0
    let lo = -Infinity
    let hi = Infinity
    let yLo = -Infinity
    let yHi = Infinity
    const add = (e: Entry, w: number) => {
      const lat = m * TIP_LAT[e.f] * S
      const ly = e.f === 0 ? THUMB_MCP[1] * S : FINGER_LY[e.f] * S
      // Only the chord's own notes bound the position (held notes let go via holdStretch if the hand moves on).
      if (w === 1) {
        const slack = TIP_SLACK[e.f] * S * o.lateralSlack
        lo = Math.max(lo, e.kx - lat - slack)
        hi = Math.min(hi, e.kx - lat + slack)
        // Wrist y: close enough that the finger reaches (≤ 0.9 of its length), far enough that it isn't
        // curled past ~0.3 of it.
        const base = e.ky - ly * cosP
        yLo = Math.max(yLo, base - 0.9 * TOTAL_LEN[e.f] * S)
        yHi = Math.min(yHi, base - 0.3 * TOTAL_LEN[e.f] * S)
      }
      const reach = o.reachRatio * TOTAL_LEN[e.f] * S + (e.f === 0 ? 0 : o.reachPlan * S * Math.max(0, TOTAL_LEN[e.f] - TOTAL_LEN[1]))
      sx += w * (e.kx - lat)
      sy += w * (e.ky - ly * cosP - reach)
      sb += w * (e.black ? 1 : 0)
      if (w === 1) { so += e.over; sow++ }
      sr += w * clamp(lat / (0.4 * S), -1, 1)
      sw += w
    }
    for (const e of held) add(e, o.heldWeight)
    for (let k = i; k < j; k++) add(entries[k], 1)
    kT.push(t0)
    kX.push(sx / sw)
    // A chord too wide for any one position: pin the range to its mean.
    kLo.push(lo <= hi ? lo : sx / sw)
    kHi.push(lo <= hi ? hi : sx / sw)
    kY.push(yLo <= yHi ? clamp(sy / sw, yLo, yHi) : yLo)
    kO.push(so / Math.max(1, sow))
    kZ.push(o.wristHeight + o.blackLift * (sb / sw) + o.overLift * kO[kO.length - 1])
    kR.push(o.rollAmount * (sr / sw))
    {
      // Round 24: which side of the hand this chord is on (press-weighted: only the chord's own notes), weak fingers 4 / 5 and a
      // melody top (RH) / bottom (LH) note lean toward the little-finger side (sign m in world x).
      let side = 0
      let bias = 0
      let ex = entries[i]
      let dynS = 0
      for (let k = i; k < j; k++) {
        const e = entries[k]
        side += clamp((m * TIP_LAT[e.f] * S) / (0.4 * S), -1, 1)
        bias += m * o.rotWeak * (e.f === 4 ? 1 : e.f === 3 ? 0.5 : 0)
        dynS += e.dyn
        if (m > 0 ? e.midi > ex.midi : e.midi < ex.midi) ex = e
      }
      side /= j - i
      bias /= j - i
      if (j - i >= 2) {
        let ov = 0, od = 0
        for (let k = i; k < j; k++) if (entries[k] !== ex) { ov += entries[k].vel; od += entries[k].off - entries[k].on }
        ov /= j - i - 1
        od /= j - i - 1
        const lead = Math.max(smooth((ex.vel - ov) / 0.15), smooth((ex.off - ex.on - od) / 0.3))
        bias += m * o.rotMelody * (0.5 + 0.5 * lead)
      }
      rotT.push(t0)
      rotSide.push(side)
      rotBias.push(bias)
      rotDyn.push(clamp(dynS / (j - i), -1, 1))
    }
    for (let k = i; k < j; k++) { held.push(entries[k]); entries[k].k = kT.length - 1 }
    i = j
  }

  // Round 24: rotation value per chord. The side term only counts where the hand actually alternates sides (a repeated finger
  // or a neighbour step needs no rocking, a static tilt there only crowds the idle fingers); the weak-finger / melody bias stays.
  const rotV: number[] = rotSide.map((sd, q) => {
    const dPrev = q > 0 ? Math.abs(sd - rotSide[q - 1]) : 1
    const dNext = q + 1 < rotSide.length ? Math.abs(rotSide[q + 1] - sd) : 1
    const alt = o.rotAlt > 0 ? Math.max(smooth(dPrev / o.rotAlt), smooth(dNext / o.rotAlt)) : 1
    // (a leap is an arm move, not a rocking figure: the side term fades with the hand's own planned travel)
    const step = Math.max(q > 0 ? Math.abs(kX[q] - kX[q - 1]) : 0, q + 1 < kX.length ? Math.abs(kX[q + 1] - kX[q]) : 0)
    const stay = 1 - o.rotLeap * smooth((step - o.rotLeapAt) / o.rotLeapAt)
    return o.rotAmp * clamp(sd * alt * stay + rotBias[q], -1.3, 1.3) * (1 + o.humanize * o.rotDyn * rotDyn[q])
  })

  // Hand positions: greedily merge consecutive chords while their feasible x ranges still intersect; every chord
  // of a position shares one wrist pose (x, and the mean y / z / roll), so the arm only moves between positions
  // (and the forearm doesn't rotate note by note through a broken chord the fingers reach anyway).
  const n = kT.length
  const rawX = Float64Array.from(kX) // chord-by-chord anchors, before the positions are merged (the hand's planned path)
  let prevX = NaN
  for (let a = 0; a < n; ) {
    let lo = kLo[a]
    let hi = kHi[a]
    let b = a + 1
    while (b < n && Math.max(lo, kLo[b]) <= Math.min(hi, kHi[b])) {
      lo = Math.max(lo, kLo[b])
      hi = Math.min(hi, kHi[b])
      b++
    }
    const mid = 0.5 * (lo + hi)
    const x = Number.isNaN(prevX) ? mid : clamp(prevX, lo, hi) + o.centering * (mid - clamp(prevX, lo, hi))
    let y = 0
    let z = 0
    let r = 0
    for (let k = a; k < b; k++) { y += kY[k]; z += kZ[k]; r += kR[k] }
    for (let k = a; k < b; k++) { kX[k] = x; kY[k] = y / (b - a); kZ[k] = z / (b - a); kR[k] = r / (b - a) }
    prevX = x
    a = b
  }

  // Transition windows (anticipation).
  const kS = new Float64Array(n)
  const kD = new Float64Array(n)
  // Round 25: written end of each chord's own notes (pedal test) and the flag of knots whose departure the pedal frees.
  const chordEnd = new Float64Array(n).fill(-Infinity)
  const pedalK = new Uint8Array(n)
  const repK = new Uint8Array(n) // chords inside a repetition run: the hand slides onto the run in its last 0.15 s, so no earlier / slower departure toward one
  const chordOn = new Float64Array(n).fill(-Infinity) // last onset in each chord (a glide never leaves before it)
  for (const e of entries) { chordEnd[e.k] = Math.max(chordEnd[e.k], e.off); chordOn[e.k] = Math.max(chordOn[e.k], e.on); if (e.rep) repK[e.k] = 1 }
  for (let k = 0; k < n - 1; k++) {
    const dist = Math.hypot(kX[k + 1] - kX[k], kY[k + 1] - kY[k])
    const gap = kT[k + 1] - kT[k]
    // Never before half-way through the gap: in fast legato the current notes keep the hand; slow passages get
    // the full anticipation. Arm moves (> crossReach) may use the whole gap — the arm travels while the last
    // finger still holds, so the fingers ride along instead of reaching ahead of a hand that hasn't come.
    // Round 26: inside a run (same-direction hand moves in a fast legato passage) the hand flows from the strike: it may use
    // `departFrac` of the gap instead of half (a zigzag / leap keeps 0.5: the thumb and held fingers still need the hand).
    const dxk = kX[k + 1] - kX[k]
    let glide = false
    if (Math.abs(dxk) > 1e-6 && gap <= o.departGap) {
      let q = k - 1
      while (q >= 0 && Math.abs(kX[q + 1] - kX[q]) < 1e-6) q--
      let r = k + 1
      while (r < n - 1 && Math.abs(kX[r + 1] - kX[r]) < 1e-6) r++
      glide = (q >= 0 && (kX[q + 1] - kX[q]) * dxk > 0 && kT[q + 1] - kT[q] <= o.departGap) || (r < n - 1 && (kX[r + 1] - kX[r]) * dxk > 0 && kT[r + 1] - kT[r] <= o.departGap)
    }
    const cap = Math.abs(dxk) > o.crossReach ? gap : (glide ? o.departFrac : 0.5) * gap
    let win = Math.min(cap, Math.max(o.anticipation, ((1.5 * dist) / o.maxHandSpeed) * (1 + o.leapWin * o.leapBell * smooth((dist - o.leapD0) / Math.max(1e-6, o.leapD1 - o.leapD0)))))
    // Round 45: a long gap = the hand waits, then travels in its natural (Fitts-like) time.
    const longGap = o.holdGap > 0 && gap >= o.holdGap
    if (longGap && o.fitts > 0 && dist > 1e-6) win = Math.min(cap, win + o.fitts * (o.fittsA + o.fittsB * Math.log2(1 + dist / o.fittsW) - win))
    // Round 25: the pedal sustains this chord, so the hand need not stay on it: for a real position shift it sets off earlier
    // (up to `pedalCap` of the gap) and takes longer over it (slower, smoother; arrival unchanged).
    // (Round 45: not over a long gap, where the hand stays and only the keys are let go: the pedal frees the notes, not the hand.)
    if (longGap && o.holdPedal > 0) {
      if (pedal && o.pedalRelease > 0 && gap >= o.pedalGap && !repK[k + 1] && Math.abs(kX[k + 1] - kX[k]) >= o.pedalShift && pedalCovers(pedal, kT[k + 1] - win, chordEnd[k], o.pedalTol)) pedalK[k] = 1
    } else if (pedal && o.pedalRelease > 0 && gap >= o.pedalGap && !repK[k + 1] && Math.abs(kX[k + 1] - kX[k]) >= o.pedalShift) {
      const winP = Math.min(Math.max(cap, o.pedalCap * gap), win * o.pedalSlow)
      if (winP > win && pedalCovers(pedal, kT[k + 1] - winP, chordEnd[k], o.pedalTol)) {
        win += o.pedalRelease * (winP - win)
        pedalK[k] = 1
      }
    }
    kS[k] = kT[k + 1] - win
    if (o.departSettle > 0 && chordOn[k] > kT[k] + 1e-3 && chordOn[k] - kT[k] <= o.departSpread) kS[k] = Math.min(Math.max(kS[k], chordOn[k] + o.departSettle), kT[k + 1] - 1e-3)
    kD[k] = dist
  }
  // Round 23: travel direction per knot. Net displacement of the planned path over +-travelWindow, weighted by how monotone
  // the path is (an Alberti bass wanders back and forth: net ~ 0 relative to its length), saturated with tanh(net / travelSpan).
  const kTrav = new Float64Array(n)
  if (o.travelSpan > 0) {
    for (let k = 0; k < n; k++) {
      let lo = k, hi = k
      while (lo > 0 && kT[k] - kT[lo - 1] <= o.travelWindow) lo--
      while (hi < n - 1 && kT[hi + 1] - kT[k] <= o.travelWindow) hi++
      let path = 0
      for (let q = lo; q < hi; q++) path += Math.abs(rawX[q + 1] - rawX[q])
      const net = rawX[hi] - rawX[lo]
      kTrav[k] = path > 1e-6 ? (Math.abs(net) / path) ** 2 * Math.tanh(net / o.travelSpan) : 0
    }
  }
  if (knotsOnly) return { knotT: Float64Array.from(kT), knotS: kS, knotX: Float64Array.from(kX) }

  // Round 28: runs, hand-position groups and the Hermite nodes of the wrist path (see `flow` in MotionOptions).
  const flowSeg = new Uint8Array(n)
  const flowA = new Int32Array(n).fill(-1)
  const flowB = new Int32Array(n).fill(-1)
  const flowG = new Int32Array(n).fill(-1)
  const flowU = new Float64Array(n).fill(NaN)
  const flowRoll = new Float64Array(n).fill(NaN)
  const flowN: Float64Array[] = Array.from({ length: 6 }, () => new Float64Array(n))
  if (o.flow > 0 && n >= o.flowMinChords) {
    const cMid = new Float64Array(n)
    const cFin = new Float64Array(n)
    const cCnt = new Float64Array(n)
    for (const e of entries) { cMid[e.k] += e.midi; cFin[e.k] += e.f; cCnt[e.k]++ }
    for (let k = 0; k < n; k++) { cMid[k] /= Math.max(1, cCnt[k]); cFin[k] /= Math.max(1, cCnt[k]) }
    const okSeg = (k: number) => {
      const d = cMid[k + 1] - cMid[k]
      return kT[k + 1] - kT[k] <= o.flowGap && kT[k + 1] - kT[k] > 1e-3 && Math.abs(d) > 0.5 && Math.abs(d) <= o.flowMaxStep && cCnt[k] <= 2 && cCnt[k + 1] <= 2 && !repK[k] && !repK[k + 1] && kO[k] < 1e-3 && kO[k + 1] < 1e-3
    }
    let gid = 0
    for (let a = 0; a < n - 1; ) {
      if (!okSeg(a)) { a++; continue }
      const sg = Math.sign(cMid[a + 1] - cMid[a])
      let b = a + 1
      while (b < n - 1 && okSeg(b) && Math.sign(cMid[b + 1] - cMid[b]) === sg) b++
      if (b - a + 1 >= o.flowMinChords) {
        for (let k = a; k < b; k++) flowSeg[k] = 1
        for (let k = a; k <= b; k++) {
          flowA[k] = a
          flowB[k] = b
          if (k > a && (cFin[k] - cFin[k - 1]) * sg * m < 0) gid++
          flowG[k] = gid
        }
        gid++
        // node values: the position path smoothed in time (Gaussian, sigma = `flowSigma` mean IOIs), kept inside the chord's feasible range, ends pinned
        const src = [kX, kY, kZ]
        const sig = Math.max(1e-3, o.flowSigma * (kT[b] - kT[a]) / (b - a)) // `flowSigma` in mean inter-onset intervals of the run
        for (let c = 0; c < 3; c++) {
          let v = Array.from({ length: b - a + 1 }, (_, i) => src[c][a + i])
          const v0 = v[0], vN = v[v.length - 1]
          for (let it = 0; it < 4; it++) {
            const nv = v.map((_, i) => {
              let sw2 = 0, sv = 0
              for (let j = 0; j < v.length; j++) {
                const dtt = (kT[a + j] - kT[a + i]) / sig
                if (Math.abs(dtt) > 3) continue
                const w = Math.exp(-0.5 * dtt * dtt)
                sw2 += w; sv += w * v[j]
              }
              return sv / sw2
            })
            nv[0] = v0
            nv[nv.length - 1] = vN
            if (c === 0) for (let i = 1; i < nv.length - 1; i++) {
              const mid = 0.5 * (kLo[a + i] + kHi[a + i]), half = 0.5 * (kHi[a + i] - kLo[a + i]) * o.flowSlack
              nv[i] = clamp(nv[i], mid - half, mid + half)
            }
            v = nv
          }
          // Fritsch-Carlson monotone tangents (zero at the ends and wherever the node is not strictly between its neighbours)
          const len = v.length
          const d: number[] = []
          for (let i = 0; i + 1 < len; i++) d.push((v[i + 1] - v[i]) / (kT[a + i + 1] - kT[a + i]))
          const mt = v.map((_, i) => (i === 0 || i === len - 1 ? 0 : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2))
          for (let i = 0; i + 1 < len; i++) {
            if (Math.abs(d[i]) < 1e-12) { mt[i] = 0; mt[i + 1] = 0; continue }
            const al = mt[i] / d[i], be = mt[i + 1] / d[i]
            const r = Math.hypot(al, be)
            if (r > 3) { mt[i] = (3 * al * d[i]) / r; mt[i + 1] = (3 * be * d[i]) / r }
          }
          for (let i = 0; i < len; i++) { flowN[2 * c][a + i] = v[i]; flowN[2 * c + 1][a + i] = mt[i] }
        }
      }
      a = b
    }
  }


  // Round 25: articulation weight per segment k -> k+1 from the WRITTEN durations: the hand's last release (running max over every
  // note put down so far, so a still-held earlier note = legato) as a share of the interval to the next chord, gated by tempo.
  const stacW = new Float64Array(n)
  const stacH = new Float64Array(n)
  if (o.stacLift > 0 || o.stacPress > 0 || o.stacRel > 0 || o.stacRebound > 0) {
    let held = -Infinity
    for (let k = 0; k < n - 1; k++) {
      held = Math.max(held, chordEnd[k])
      const gap = kT[k + 1] - kT[k]
      const ratio = (held - kT[k]) / Math.max(1e-6, gap)
      stacW[k] = (1 - smooth((ratio - o.stacR0) / Math.max(1e-6, o.stacR1 - o.stacR0))) * smooth((gap - o.stacT0) / Math.max(1e-6, o.stacT1 - o.stacT0))
      stacH[k] = Math.max(held, kT[k]) - kT[k]
    }
  }

  // Arm moves: a note whose hand position jumps more than crossReach from the previous one is reached by the arm.
  for (const e of entries) e.late = e.k > 0 && Math.abs(kX[e.k] - kX[e.k - 1]) > o.crossReach

  // Crossings within reach (successive single notes): finger over the thumb toward the thumb side → wrist bends
  // toward the thumb; thumb under toward the pinky side → slightly toward the pinky. Rises while the crossing finger
  // prepares, unwinds after its note.
  const crossS: number[] = []
  const crossP: number[] = []
  const crossE: number[] = []
  const crossU: number[] = []
  for (let q = 1; q < entries.length; q++) {
    const a = entries[q - 1]
    const b = entries[q]
    if (chordJoin(o, b.on - a.on, b.kx - a.kx) || b.late) continue
    if (q + 1 < entries.length && chordJoin(o, entries[q + 1].on - b.on, entries[q + 1].kx - b.kx)) continue // b is in a chord
    const dir = m * Math.sign(b.kx - a.kx) // + = toward the pinky side
    // (full deviation from a whole step; a semitone crossing — black key just past the thumb — needs about half)
    const wide = Math.min(1, Math.abs(b.kx - a.kx) / WHITE_KEY_WIDTH)
    let u = 0
    if (a.f === 0 && b.f >= 1 && b.f <= 3 && dir < 0) { u = -o.crossOverYaw * wide; b.xover = true }
    else if (b.f === 0 && a.f >= 1 && a.f <= 3 && dir > 0) u = o.thumbUnderYaw
    if (u === 0) continue
    crossS.push(Math.max(a.on, b.on - o.prepare))
    crossP.push(b.on)
    crossE.push(b.on + o.crossRelease)
    crossU.push(u)
  }

  // A finger crossing over the thumb rides on the hand: the hand starts toward the crossing note's position right
  // after the previous note (whole gap), so the crossing finger comes over the key curled instead of reaching out.
  for (const e of entries) {
    if (!e.xover || e.k < 1) continue
    const k = e.k - 1
    if (o.xoverGap > 0 && kT[k + 1] - kT[k] > o.xoverGap) continue // (Round 45: over a long gap the hand waits, then comes over)
    kS[k] = Math.min(kS[k], kT[k])
  }

  // Wrist snap / arm drop per chord: repeated chords (same keys again within 0.4 s), arm leaps, strong notes.
  const dynK = new Float64Array(n)
  const accK = new Float64Array(n)
  const cntK = new Float64Array(n)
  const snapI = new Float64Array(n)
  const snapPre = new Float64Array(n)
  const gravW = new Float64Array(n), gravH = new Float64Array(n), gravTf = new Float64Array(n), gravTr = new Float64Array(n)
  const gravD = new Float64Array(n), gravTs = new Float64Array(n), gravR = new Float64Array(n), gravTR = new Float64Array(n)
  {
    const keysOf: string[] = new Array(n).fill('')
    const cnt = new Float64Array(n)
    const vel = new Float64Array(n)
    for (const e of entries) { dynK[e.k] += e.dyn; accK[e.k] = Math.max(accK[e.k], e.acc); cntK[e.k]++ }
    for (let k = 0; k < n; k++) dynK[k] /= Math.max(1, cntK[k])
    const xs: number[][] = Array.from({ length: n }, () => [])
    for (const e of entries) { xs[e.k].push(e.kx); cnt[e.k]++; vel[e.k] += e.vel }
    for (let k = 0; k < n; k++) { keysOf[k] = xs[k].sort((a, b) => a - b).join(','); vel[k] /= Math.max(1, cnt[k]) }
    for (let k = 0; k < n; k++) {
      const gap = k > 0 ? kT[k] - kT[k - 1] : Infinity
      const repChord = k > 0 && cnt[k] >= 2 && keysOf[k] === keysOf[k - 1] && gap < 0.4
      const leap = k > 0 && Math.abs(kX[k] - kX[k - 1]) > o.crossReach && gap < 0.5
      let I = Math.max(repChord ? 1 : 0, leap ? 0.8 : 0, smooth((vel[k] - 0.75) / 0.25))
      if (cnt[k] < 2 && !leap) I *= 0.5
      snapI[k] = I
      snapPre[k] = Math.min(o.snapTime, 0.6 * gap)
    }
    // Round 42 gravity: per strike, from the chord's loudness and the time before / after it (all build time, seeded; poseAt only evaluates the curves)
    const G = o.gravity * o.humanize
    // (Round 44: shortest written hold of each chord, to absorb the rebound of a held chord)
    const heldK = new Float64Array(n).fill(Infinity)
    if (o.repRelease > 0 && o.repAbsorb > 0) for (const e of entries) heldK[e.k] = Math.min(heldK[e.k], e.off - kT[e.k])
    if (G > 0) {
      for (let k = 0; k < n; k++) {
        const wAbs = smooth((vel[k] - o.gravityVel) / Math.max(1e-6, 1 - o.gravityVel))
        const w = Math.min(1.3, wAbs * (1 + o.gravityChord * Math.min(1, (cnt[k] - 1) / 3)))
        if (w <= 0.005) continue
        const sd = k * 13 + (m > 0 ? 211 : 263)
        const vA = 1 + o.gravityVar * (2 * seed01(sd) - 1), vT = 1 + 0.5 * o.gravityVar * (2 * seed01(sd + 1) - 1), vR = 1 + o.gravityVar * (2 * seed01(sd + 2) - 1)
        const gapP = k > 0 ? kT[k] - kT[k - 1] : Infinity
        const gapN = k < n - 1 ? kT[k + 1] - kT[k] : Infinity
        const tf = Math.min(o.gravityFall * vT, 0.5 * gapP)
        if (tf < 0.03) continue
        const q = tf / o.gravityFall
        const tr = Math.max(0, Math.min(tf * 1.1, 0.92 * gapP - tf))
        gravW[k] = G * w
        gravH[k] = G * w * o.gravityLift * q * q * vA
        gravTf[k] = tf
        gravTr[k] = tr
        // (free-fall speed at contact: 2H/tf; the give is a critically damped sink of depth D whose initial speed matches it: D e / ts = 2H / tf)
        const D = G * w * o.gravityGive * Math.min(1, q) * vA
        gravD[k] = D
        gravTs[k] = gravH[k] > 1e-9 ? Math.max(0.02, Math.E * D * tf / (2 * gravH[k])) : 0.04
        // (the rebound: a share of the lift, larger when a leap follows (its lift-off), shorter when the next chord is near, quiet and slow when the chord is held long)
        const leapN = k < n - 1 ? Math.min(1, kD[k]) : 0
        const hold = smooth((gapN - 0.7) / 0.8)
        // (how soon the hand moves on: the planned departure after this strike; a hand that stays only settles)
        const ds = k < n - 1 ? Math.max(0, kS[k] - kT[k]) : Infinity
        const stay = smooth((ds - 0.2) / 0.5)
        const TRb = Math.min(o.gravityReboundT * (1 + 0.5 * hold) * (0.9 + 0.2 * seed01(sd + 3)), 0.92 * gapN)
        if (TRb > 0.06) {
          const absorb = o.repRelease > 0 && o.repAbsorb > 0 ? o.repRelease * o.repAbsorb * smooth((heldK[k] - 0.3) / 0.3) : 0
          gravR[k] = G * w * o.gravityRebound * (gravH[k] + 0.5 * D) * (1 + o.gravityLeap * leapN) * (1 - 0.6 * hold) * (1 - 0.7 * stay) * vR * (1 - absorb)
          gravTR[k] = TRb
        }
      }
    }
  }

  // Notes still held when the hand moves on are let go once the key leaves the finger's stretched reach (pedal
  // territory), so the finger travels with the hand instead of stretching back to the old key. kS is
  // non-decreasing, so one sweep with an active list covers it.
  let active: Entry[] = []
  let next = 0
  for (let k = 0; k < n - 1; k++) {
    const flowK = o.flow > 0 && flowSeg[k] === 1
    const s0 = flowK ? kT[k] : kS[k]
    while (next < entries.length && entries[next].on <= s0) active.push(entries[next++])
    active = active.filter((e) => e.off > s0)
    if (flowK) {
      // Round 28: the run's wrist path is the Hermite glide: a still-held note is let go when that path takes its key out of reach
      const hh = kT[k + 1] - kT[k]
      const xAt = (t: number) => {
        const s1 = (t - kT[k]) / hh, s2 = s1 * s1, s3 = s2 * s1
        return (2 * s3 - 3 * s2 + 1) * flowN[0][k] + (s3 - 2 * s2 + s1) * hh * flowN[1][k] + (-2 * s3 + 3 * s2) * flowN[0][k + 1] + (s3 - s2) * hh * flowN[1][k + 1]
      }
      for (const e of active) {
        const rest = e.kx - m * TIP_LAT[e.f] * S
        const lim = TIP_SLACK[e.f] * S * o.lateralSlack * o.holdStretch
        const out = (t: number) => Math.abs(xAt(t) - rest) > lim
        if (!out(kT[k + 1])) continue
        let lo = kT[k], hi = kT[k + 1]
        if (out(lo)) hi = lo
        else for (let it = 0; it < 20; it++) { const mid = 0.5 * (lo + hi); if (out(mid)) hi = mid; else lo = mid }
        if (hi < e.off) e.off = Math.max(hi, e.on + o.minNoteDuration)
      }
      continue
    }
    const D = kX[k + 1] - kX[k]
    if (Math.abs(D) < 1e-9) continue
    const dir = Math.sign(D)
    for (const e of active) {
      // Round 25: pedal-freed departure: the pedal holds the sound, the finger lets go as the hand sets off
      if (pedalK[k] && e.off > s0 && pedalCovers(pedal, s0, e.off, o.pedalTol)) e.pedOff = Math.min(e.pedOff, s0 - o.pedalRelease * o.pedalLead + (1 - o.pedalRelease) * (e.off - s0))
      const rest = e.kx - m * TIP_LAT[e.f] * S
      const lim = TIP_SLACK[e.f] * S * o.lateralSlack * o.holdStretch
      const v = (rest + dir * lim - kX[k]) / D // smoothstep progress at which the key leaves reach
      if (v >= 1) continue
      const tRel = s0 + invSmooth(Math.max(0, v)) * (kT[k + 1] - s0)
      if (tRel < e.off) e.off = Math.max(tRel, e.on + o.minNoteDuration)
    }
  }

  // A note released while the arm is leaping away (arm move under way) is flicked off: the finger has to clear the
  // keys before the hand sweeps it sideways.
  for (const e of entries) {
    const k = upperBound(kS, e.off) - 1
    if (k >= 0 && k < n - 1 && e.off < kT[k + 1] && Math.abs(kX[k + 1] - kX[k]) > o.crossReach) e.rel = Math.min(e.rel, 0.06)
  }

  // Round 27: finger staccato weights per note (press = the note's own articulation faded by a leap into it, release = faded by a leap out of it)
  const leapFade = (d: number) => 1 - smooth((d - 0.4 * o.stacLeap) / Math.max(1e-6, 0.6 * o.stacLeap))
  const swP = new Map<Entry, number>()
  const swR = new Map<Entry, number>()
  const swA = new Map<Entry, number>()
  for (const e of entries) {
    const w = e.rep ? 0 : stacW[e.k]
    swR.set(e, w * leapFade(kD[e.k] ?? 0))
    swP.set(e, w * leapFade(e.k > 0 ? kD[e.k - 1] : 0))
    swA.set(e, clamp(1 + o.humanize * o.stacDyn * e.dyn, 0.3, 1.8) * (1 + o.humanize * o.stacVar * (2 * seed01(e.id * 11 + 5003) - 1)))
    if (w > 0) e.rel *= 1 - o.stacRel * swR.get(e)!
  }
  // Per-finger event arrays (sorted by onset).
  const lists: Entry[][] = [[], [], [], [], []]
  for (const e of entries) lists[e.f].push(e)
  const liftOf = new Map<Entry, number>()
  // (the finger's own lift shrinks where the wrist does the lifting: staccato; not in repetition runs)
  for (const l of lists) for (let q = 0; q + 1 < l.length; q++) liftOf.set(l[q], Math.max(liftScale(l[q].on, l[q].off, l[q + 1].on, o), l[q].alt ? o.altLift : 0) * (1 - (l[q].rep ? 0 : o.stacFinger * stacW[l[q].k])))
  // Round 25: apply the pedal-freed releases now (after the lift scale was measured from the written articulation)
  for (const e of entries) if (e.pedOff < e.off) e.off = Math.max(e.pedOff, e.on + o.minNoteDuration)
  // Prepare lift: a finger moving on to another key leaves the current one early enough to travel in the air.
  for (const l of lists) {
    for (let q = 0; q + 1 < l.length; q++) {
      const a = l[q]
      const b = l[q + 1]
      if (a.kx === b.kx) continue
      a.off = Math.min(a.off, Math.max(a.on + 0.6 * (b.on - a.on), b.on - o.prepareLead))
    }
  }
  const fingers: FingerTrack[] = lists.map((l) => ({
    on: Float64Array.from(l, (e) => e.on),
    off: Float64Array.from(l, (e) => e.off),
    x: Float64Array.from(l, (e) => e.kx),
    y: Float64Array.from(l, (e) => e.ky),
    top: Float64Array.from(l, (e) => e.top),
    dip: Float64Array.from(l, (e) => o.keyDip * (0.5 + 0.5 * e.vel)),
    rep: Uint8Array.from(l, (e) => (e.rep ? 1 : 0)),
    alt: Uint8Array.from(l, (e) => (e.alt ? 1 : 0)),
    calm: Float64Array.from(l, (e) => e.calm),
    late: Uint8Array.from(l, (e) => (e.late ? 1 : 0)),
    gw: new Float64Array(l.length),
    gs: Float64Array.from(l, (e) => 2 * seed01(e.id * 5 + 7711) - 1),
    xover: Uint8Array.from(l, (e) => (e.xover ? 1 : 0)),
    rel: Float64Array.from(l, (e) => e.rel),
    dyn: Float64Array.from(l, (e) => e.dyn),
    acc: Float64Array.from(l, (e) => e.acc),
    vr: Float64Array.from({ length: 3 * l.length }, (_, q) => 2 * seed01(l[(q / 3) | 0].id * 3 + (q % 3) + 9001) - 1),
    lift: Float64Array.from(l, (e) => liftOf.get(e) ?? 1),
    swP: Float64Array.from(l, (e) => swP.get(e) ?? 0),
    swR: Float64Array.from(l, (e) => swR.get(e) ?? 0),
    swA: Float64Array.from(l, (e) => swA.get(e) ?? 1),
    rb: Float64Array.from(l, (e, q) => {
      // Rebound: more with velocity and for short (staccato) notes; none inside a repetition run or when the same
      // finger comes back soon (its own next note), eased in over 0.35–0.7 s of gap.
      const next = q + 1 < l.length ? l[q + 1].on - e.off : Infinity
      const stac = 1 - smooth((e.off - e.on - 0.12) / 0.5)
      return e.rep ? 0 : o.restMotion * o.rebound * e.vel * (0.3 + 0.7 * stac) * smooth((next - 0.35) / 0.35)
    }),
  }))

  // Rests: stretches where nothing of the hand is held (running max of the releases) for at least 0.8 s.
  const gapA: number[] = []
  const gapB: number[] = []
  {
    let end = -1e9
    for (const e of entries) {
      if (e.on - end >= 0.8) { gapA.push(end); gapB.push(e.on) }
      end = Math.max(end, e.off)
    }
    gapA.push(end)
    gapB.push(1e9)
  }

  // Round 40: moves that follow each other at once in the same direction pass the strike with speed (cubic Hermite profile, matched end / start slopes)
  // instead of each coming to a full stop at its chord.
  const kM0 = new Float64Array(n)
  const kM1 = new Float64Array(n)
  if (o.smoothness > 0) {
    const len = (q: number) => Math.hypot(kX[q + 1] - kX[q], kY[q + 1] - kY[q], kZ[q + 1] - kZ[q])
    const dur = (q: number) => kT[q + 1] - kS[q]
    for (let q = 0; q + 2 < n; q++) {
      const l0 = len(q), l1 = len(q + 1), d0 = dur(q), d1 = dur(q + 1)
      if (l0 < 0.02 || l1 < 0.02 || d0 < 1e-3 || d1 < 1e-3 || flowSeg[q] || flowSeg[q + 1]) continue
      if (kS[q + 1] - kT[q + 1] > o.smoothJoin) continue
      const cos = ((kX[q + 1] - kX[q]) * (kX[q + 2] - kX[q + 1]) + (kY[q + 1] - kY[q]) * (kY[q + 2] - kY[q + 1]) + (kZ[q + 1] - kZ[q]) * (kZ[q + 2] - kZ[q + 1])) / (l0 * l1)
      if (cos < 0.3) continue
      const v = Math.min(o.smoothness, 1.25) * 0.8 * 0.5 * (l0 / d0 + l1 / d1) * cos
      kM1[q] = Math.min(2.5, (v * d0) / l0)
      kM0[q + 1] = Math.min(2.5, (v * d1) / l1)
    }
  }

  // Round 41: bell weight per big move (not inside a run, not velocity-joined), and the grasp weight of each note of the chord it arrives at
  const kBell = new Float64Array(n)
  if (o.leapBell > 0) {
    for (let q = 0; q + 1 < n; q++) {
      if (flowSeg[q] || kM0[q] !== 0 || kM1[q] !== 0 || kT[q + 1] - kS[q] < 0.05) continue
      kBell[q] = o.leapBell * smooth((kD[q] - o.leapD0) / Math.max(1e-6, o.leapD1 - o.leapD0))
    }
    const cnt = new Map<number, number>()
    for (const e of entries) cnt.set(e.k, (cnt.get(e.k) ?? 0) + 1)
    for (let f = 0; f < 5; f++) lists[f].forEach((e, q) => { if (e.k > 0) fingers[f].gw[q] = kBell[e.k - 1] * ((cnt.get(e.k) ?? 1) >= 2 ? 1 : 0.4) })
  }

  const track: HandTrack = {
    hand,
    m,
    fingers,
    knotT: Float64Array.from(kT),
    knotS: kS,
    knotM0: kM0,
    knotM1: kM1,
    knotBell: kBell,
    knotX: Float64Array.from(kX),
    knotY: Float64Array.from(kY),
    knotZ: Float64Array.from(kZ),
    knotR: Float64Array.from(kR),
    knotTrav: kTrav,
    rotT: Float64Array.from(rotT),
    rotV: Float64Array.from(rotV),
    knotDist: kD,
    flowSeg, flowA, flowB, flowG, flowU, flowRoll, flowN,
    stacW,
    stacH,
    knotO: Float64Array.from(kO),
    repS: Float64Array.from(repS),
    repE: Float64Array.from(repE),
    repX: Float64Array.from(repX),
    repLat: Float64Array.from(repLat),
    repLen: Float64Array.from(repLen),
    crossS: Float64Array.from(crossS),
    crossP: Float64Array.from(crossP),
    crossE: Float64Array.from(crossE),
    crossU: Float64Array.from(crossU),
    snapI,
    snapPre,
    gravW,
    gravH,
    gravTf,
    gravTr,
    gravD,
    gravTs,
    gravR,
    gravTR,
    dynK,
    accK,
    cntK,
    gapA: Float64Array.from(gapA),
    gapB: Float64Array.from(gapB),
    wd: o.withdraw > 0 ? buildWithdrawals(hand, m, o, kT, kX, kY, kZ, gapA, gapB, pedal, other) : new Float64Array(0),
  }
  if (o.repRelease > 0) repeatRelease(o, track)
  return track
}

/** Snap intensity of knot k: the planned one scaled by loudness (soft chords snap less, loud ones more), accented
 *  chords at least `dynSnapAccent` (fainter for a single note). Equals `snapI` when humanize is 0. */
function snapScale(h: HandTrack, k: number, o: MotionOptions): number {
  const hm = o.humanize
  const base = h.snapI[k] > 0 ? h.snapI[k] * clamp(1 + hm * o.dynSnap * h.dynK[k], 0.25, 1.5) : 0
  return Math.max(base, hm * o.dynSnapAccent * h.accK[k] * (h.cntK[k] >= 2 ? 1 : 0.6))
}

/** Wrist rise from dynamics at t (wu, >= 0): the arm-weight preparation before a strike — up over the last
 *  `dynDropTime` s before the chord, down to 0 exactly at its onset (like the snap's wind-up, which it yields to). */
function dynWrist(h: HandTrack, t: number, o: MotionOptions): number {
  const hm = o.humanize
  const kn = upperBound(h.knotT, t)
  if (hm <= 0 || kn >= h.knotT.length || kn < 0) return 0
  const w = Math.max(0, h.dynK[kn] + 0.5 * h.accK[kn]) * (1 + o.dynChord * Math.min(1, (h.cntK[kn] - 1) / 3))
  if (w <= 0) return 0
  const win = Math.min(o.dynDropTime, kn > 0 ? 0.6 * (h.knotT[kn] - h.knotT[kn - 1]) : Infinity)
  const u = (t - (h.knotT[kn] - win)) / win
  if (!(u > 0 && u < 1)) return 0
  return hm * o.dynDrop * w * (1 - Math.min(1, snapScale(h, kn, o))) * (u < 0.55 ? smooth(u / 0.55) : 1 - smooth((u - 0.55) / 0.45))
}

/** Round 42: the gravity height offset of the wrist at t (wu; + above the plan; `out[1]` = the rebound part) from the strike after t (preparation rise, accelerating fall that
 *  ends at height 0 at the strike) and the strike before t (give below the plan, critically damped, then ONE rebound bump). Smooth (C1) everywhere. */
function gravityAt(h: HandTrack, t: number, out: number[]): number {
  out[1] = 0
  const n = h.knotT.length
  const kn = upperBound(h.knotT, t)
  let z = 0
  if (kn < n && h.gravH[kn] > 0) {
    const s = h.knotT[kn] - t, tf = h.gravTf[kn], tr = h.gravTr[kn]
    if (s < tf + tr) z += h.gravH[kn] * (s <= tf ? 1 - (1 - s / tf) * (1 - s / tf) : smooth((tf + tr - s) / tr))
  }
  const kp = kn - 1
  if (kp >= 0 && (h.gravD[kp] > 0 || h.gravR[kp] > 0)) {
    const s = t - h.knotT[kp]
    const ts = h.gravTs[kp]
    if (h.gravD[kp] > 0 && s < 14 * ts) z -= h.gravD[kp] * (s / ts) * Math.exp(1 - s / ts)
    if (h.gravR[kp] > 0 && s < h.gravTR[kp]) { const sn = Math.sin((Math.PI * s) / h.gravTR[kp]); const r = h.gravR[kp] * sn * sn; z += r; out[1] = r }
  }
  out[0] = z
  return z
}

/** Round 42: share of the strike's snap wind-up / arm-weight rise that gravity replaces at t (the strike after t). */
function gravityShare(h: HandTrack, t: number, o: MotionOptions): number {
  if (o.gravity <= 0) return 0
  const kn = upperBound(h.knotT, t)
  return kn < h.knotT.length ? o.gravityMix * Math.min(1, h.gravW[kn]) : 0
}

/** Wrist snap at t: wind-up (+, lifting / extending) toward the next chord, dropping to 0 exactly at its onset, and a
 *  brief follow-through dip (−) after the previous one. */
function snapAt(h: HandTrack, t: number, o: MotionOptions): number {
  const kn = upperBound(h.knotT, t)
  let g = 0
  if (kn < h.knotT.length && snapScale(h, kn, o) > 0 && h.snapPre[kn] > 1e-3) {
    const u = (t - (h.knotT[kn] - h.snapPre[kn])) / h.snapPre[kn]
    if (u > 0 && u < 1) g += snapScale(h, kn, o) * (u < 0.6 ? smooth(u / 0.6) : 1 - smooth((u - 0.6) / 0.4))
  }
  const kp = kn - 1
  if (kp >= 0 && snapScale(h, kp, o) > 0) {
    const v = (t - h.knotT[kp]) / 0.1
    if (v > 0 && v < 1) g -= 0.3 * snapScale(h, kp, o) * Math.sin(Math.PI * v)
  }
  return g
}

/** Round 25: the staccato wrist bounce (wu, >= 0) at t: after the chord's written end the wrist rises (smooth, ~40 % of the free
 *  time) and comes back down with an accelerating fall that meets the next strike at zero height (so the strike still has its
 *  downward velocity, and every contact is where it was). Scaled by the segment's articulation weight, the next chord's loudness
 *  and a seeded per-chord variation (both x humanize), and faded for leaps (travelLift) and snaps. */
function stacBounce(h: HandTrack, t: number, o: MotionOptions): number {
  const n = h.knotT.length
  const k = upperBound(h.knotT, t) - 1
  if (k < 0 || k >= n - 1) return 0
  const w = h.stacW[k]
  if (w <= 0) return 0
  const t0 = h.knotT[k] + h.stacH[k]
  const t1 = h.knotT[k + 1]
  if (!(t > t0 && t < t1)) return 0
  const v = (t - t0) / (t1 - t0)
  const prof = v < 0.4 ? smooth(v / 0.4) : 1 - ((v - 0.4) / 0.6) ** 2
  const hm = o.humanize
  const dyn = clamp(1 + hm * o.stacDyn * h.dynK[k + 1], 0.3, 1.8)
  const vr = 1 + hm * o.stacVar * (2 * seed01(k * 5 + (h.m > 0 ? 131 : 197)) - 1)
  const leap = 1 - smooth((h.knotDist[k] - 0.4 * o.stacLeap) / Math.max(1e-6, 0.6 * o.stacLeap))
  const snap = 1 - Math.min(1, snapScale(h, k + 1, o))
  return o.stacLift * w * prof * dyn * vr * leap * snap
}

/** Summed wrist deviation of the crossing events around t (ulnar +). */
function crossingDeviation(h: HandTrack, t: number): number {
  let u = 0
  for (let k = upperBound(h.crossS, t) - 1; k >= 0 && h.crossS[k] > t - 3; k--) {
    if (t >= h.crossE[k]) continue
    const up = smooth((t - h.crossS[k]) / Math.max(0.02, h.crossP[k] - h.crossS[k]))
    const down = 1 - smooth((t - h.crossP[k]) / (h.crossE[k] - h.crossP[k]))
    u += h.crossU[k] * Math.min(up, down)
  }
  return u
}

/** Rest envelopes at t: `e` (0..1, relaxed pose) and `far` (0..1, long rests only: the hand lifts further away). Both
 *  ramp in after the last release and are gone before the next note's pre-shape glide (>= 0.45 s ahead). */
function restEnvelope(h: HandTrack, t: number): { e: number; far: number } {
  const k = upperBound(h.gapA, t) - 1
  if (k < 0 || t >= h.gapB[k]) return { e: 0, far: 0 }
  const a = h.gapA[k]
  const b = h.gapB[k]
  const e = Math.min(smooth((t - (a + 0.2)) / 0.35), 1 - smooth((t - (b - 0.8)) / 0.35))
  const long = smooth((b - a - 3) / 1.5)
  const far = long > 0 ? long * Math.min(smooth((t - (a + 1)) / 1.2), 1 - smooth((t - (b - 1.7)) / 1.2)) : 0
  return { e, far }
}

/** 0..1 envelope of the repetition runs at t, ramping over `ramp` seconds on either side. */
function repeatEnvelope(h: HandTrack, t: number, ramp: number): { env: number; k: number } {
  const k = upperBound(h.repS, t + ramp) - 1
  if (k < 0) return { env: 0, k }
  const a = smooth((t - (h.repS[k] - ramp)) / ramp)
  const b = 1 - smooth((t - h.repE[k]) / ramp)
  return { env: Math.min(a, b), k }
}

/**
 * Round 20: how much of the full finger lift a stretch between two strikes of one finger gets (0..1). Continuous in the
 * times: the inter-onset interval `ioi` (a fast passage has no time for a big stroke) and the articulation — the free
 * gap `on2 - off` as a share of the interval (legato = the key is held until the next one: the finger only clears
 * it; detached / staccato = the finger had time to lift). Real fingers stay a few mm above the keys in legato and fast
 * playing and lift high only for slow, detached, loud notes (README Round 20).
 */
function liftScale(on: number, off: number, on2: number, o: MotionOptions): number {
  const ioi = on2 - on
  const sT = smooth((ioi - o.liftT0) / (o.liftT1 - o.liftT0))
  const sA = smooth(Math.max(0, on2 - off) / Math.max(1e-6, ioi) / o.liftGap)
  return clamp(sT * (o.liftLegato + (1 - o.liftLegato) * sA), 0, 1)
}


/** Round 43: the wrist height (wu) at t as far as the strike-to-strike lifts go: the plan (travel arcs, leaps), snap wind-up, arm-weight rise and the gravity
 *  lift / fall / give / rebound (no smoothing offset, sway, rest or jitter: those are small or fade out at the strikes). */
function wristZAt(o: MotionOptions, h: HandTrack, t: number): number {
  wristPlanAt(o, h, t, rrTmp)
  const gShare = gravityShare(h, t, o)
  const snap = snapAt(h, t, o)
  let z = rrTmp[2] + o.snapLift * (snap > 0 ? snap * (1 - gShare) : snap) + dynWrist(h, t, o) * (1 - gShare)
  if (o.gravity * o.humanize > 0) z += gravityAt(h, t, rrOut)
  return z
}
const rrTmp = [0, 0, 0, 0]
const rrOut = [0, 0]
/** Round 43: a finger whose key the MIDI holds on while the wrist rises for the next strike (the gravity rebound / lift, the snap wind-up, the travel arc) is
 *  stretched between the fixed fingertip and the rising knuckle, "stuck" to the key. The key may come up early VISUALLY (the sound is the MIDI's; the lab
 *  only animates): per note, the release moves to the earlier of (a) the moment the wrist is `repRise` above its height at the strike and (b) the next
 *  onset minus `repLiftMin` (scaled down in short gaps: the finger needs release + attack to come back), but not before `repHold` after the onset, and
 *  only for notes that end by the next onset (+ `repOverlap`; a deliberate hold across it stays) or that the same finger re-strikes on the same key.
 *  Repetition / alternation runs keep their own timing. `repRelease` blends the move (0 = off). */
function repeatRelease(o: MotionOptions, h: HandTrack) {
  const nK = h.knotT.length
  if (nK < 2) return
  for (let f = 0; f < 5; f++) {
    const ft = h.fingers[f]
    const n = ft.on.length
    for (let i = 0; i < n; i++) {
      if (ft.rep[i] === 1 || ft.alt[i] === 1) continue
      const on = ft.on[i], off = ft.off[i]
      const kn = upperBound(h.knotT, on + 1e-6)
      let N = kn < nK ? h.knotT[kn] : Infinity
      const same = i + 1 < n && ft.x[i + 1] === ft.x[i]
      if (same) N = Math.min(N, ft.on[i + 1])
      if (!(N < Infinity) || N - on > o.repMaxGap) continue
      if (off > N + o.repOverlap && !same) continue
      const hold = on + Math.min(o.repHold, 0.5 * (off - on))
      const end = Math.min(off, N)
      if (end <= hold + 0.01) continue
      // Round 44: only the last `repWindow` s before the next strike count (the whole gap when shorter), against the lowest wrist height of the held part
      const winS = Math.max(hold, N - o.repWindow)
      let z0 = wristZAt(o, h, on)
      if (N - o.repWindow > hold) for (let t = on + 0.01; t < winS; t += 0.01) z0 = Math.min(z0, wristZAt(o, h, t))
      const step = Math.max(0.004, (end - winS) / 400)
      let tTrig = Infinity
      for (let t = winS; t < end; t += step) if (wristZAt(o, h, t) - z0 > o.repRise) { tTrig = t; break }
      if (tTrig === Infinity) continue
      const lead = Math.min(o.repLiftMin, 0.5 * (N - on))
      const target = Math.max(hold, Math.min(tTrig, N - lead))
      if (target < off - o.repMinGain) {
        ft.off[i] = off + o.repRelease * (target - off)
        ft.lift[i] = Math.max(ft.lift[i], liftScale(on, ft.off[i], i + 1 < n ? ft.on[i + 1] : N, o))
      }
    }
  }
}

// ---- Round 29: idle hand withdrawal ---------------------------------------------------------------------------------
/** Numbers per withdrawal: out start / end, return start / end (s; the first span has no start, the last no return: +-1e9),
 *  resting wrist (x, y, z), start lift, lateral arc, y window end / z window start / x window start (shares of the move),
 *  idle-sway scale, palm flexion, Round 36: window [tA, tB] over which the rest x travels from the out spot to the x under the hand's
 *  arrival point (still below the keys, out of sight), Round 38: the first onset after the return (the arrival x is the plan x there, not at
 *  the end of the return, where the plan still hovers where the hand left). */
const WD_STRIDE = 17
const WD_FAR = 1e9

/** Idle spans long enough to leave the keys. Pure function of the plan; the per-span seeded variation (x humanize) changes the spot,
 *  timing, speed, path shape and which part of the body leads, so no two withdrawals in a song are the same. */
function buildWithdrawals(hand: Hand, m: number, o: MotionOptions, kT: number[], kX: number[], kY: number[], kZ: number[], gapA: number[], gapB: number[], pedal?: readonly PedalRange[], other?: readonly Entry[]): Float64Array {
  const out: number[] = []
  const hv = o.withdrawVar * o.humanize
  const near = (tt: number, before: boolean) => {
    let k = 0
    for (let q = 0; q < kT.length; q++) if (before ? kT[q] <= tt + 0.05 : kT[q] <= tt + 0.05) k = q
    return k
  }
  for (let g = 0; g < gapA.length; g++) {
    const A = gapA[g], B = gapB[g]
    const first = A < -1e8, last = B > 1e8
    if (first && last) continue
    if (first ? B < o.withdrawMin : !last && B - A < o.withdrawMin) continue
    // Round 45: a pause in the music (the other hand idle too) is not a rest to leave the keys for: the hands stay until it is really long.
    if (!first && !last && o.withdrawBothMin > o.withdrawMin && B - A < o.withdrawBothMin && other && !other.some((e) => e.on < B && e.off > A)) continue
    const ss = (hand === 'R' ? 1009 : 2003) + g * 131
    const r = (i: number) => 2 * seed01(ss + i * 977) - 1
    const Px = m * (o.withdrawX + hv * 0.35 * r(0))
    const Py = KEYBOARD_Y - (o.withdrawFront + hv * 0.3 * r(1))
    const Pz = -(o.withdrawDepth + hv * 0.3 * r(2))
    const delay = o.withdrawDelay * (1 + hv * 0.6 * r(10))
    const settle = o.withdrawSettle * (1 + hv * 0.3 * r(11))
    const dist = (k: number) => Math.hypot(kX[k] - Px, kY[k] - Py, kZ[k] - Pz)
    let Tout = last || !first ? Math.max(o.withdrawMinTravel, 2.0 * dist(near(A, true)) / (o.withdrawSpeed * (1 + hv * 0.25 * r(12)))) : 0
    let Tret = last ? 0 : Math.max(o.withdrawMinTravel, 2.0 * dist(near(B, false)) / (o.withdrawSpeed * (1 + hv * 0.25 * r(13))))
    let outS = first ? -WD_FAR : A + delay
    // Round 45: the last chord still rings under the pedal: the hand stays on it until the pedal comes up.
    if (!first && o.withdrawPedal > 0 && pedal) {
      for (const r of pedal) if (r[0] <= A + o.pedalTol && r[1] > A && r[1] < B) { outS = Math.max(outS, r[1] + delay); break }
    }
    const retE = last ? WD_FAR : B - settle
    if (!first && !last) {
      const avail = retE - outS - o.withdrawHold
      if (avail < 0.85 * (Tout + Tret)) continue // (a hand never hurries by more than ~18 % over its natural speed: far spans need longer rests)
      const sc = Math.min(1, avail / (Tout + Tret))
      Tout *= sc
      Tret *= sc
    } else if (first) {
      if (retE < o.withdrawMinTravel) continue
      Tret = Math.min(Tret, retE)
    }
    const outE = first ? -WD_FAR + 1 : outS + Tout
    const retS = last ? WD_FAR : retE - Tret
    // Round 36: the rest spot drifts (below the keys, out of sight) from the out spot to the place right under the arrival point of the return
    // (`planXAt`), so the hand rises straight to where it plays instead of coming back via the middle.
    const tA = first ? -WD_FAR : outS + 0.4 * Tout
    const tB = first || last ? WD_FAR : Math.max(tA + 0.3, retS)
    out.push(
      outS, outE, retS, last ? WD_FAR : retE,
      Px, Py, Pz,
      o.withdrawLift * (1 + hv * 0.5 * r(3)),
      m * o.withdrawArc * (0.6 + hv * 0.8 * r(4)),
      0.85 + 0.05 * hv * r(5), 0.1 + 0.05 * hv * r(6), 0.2 + 0.1 * hv * r(7),
      1 + hv * 0.5 * r(8),
      o.withdrawPitch * (1 + hv * 0.3 * r(9)),
      tA, tB,
      last ? WD_FAR : B,
    )
  }
  return Float64Array.from(out)
}

/** Planned wrist x at t (knot interpolation only: no glide / jitter), the x the hand arrives at when a withdrawal ends. */
function planXAt(h: HandTrack, t: number): number {
  const n = h.knotT.length
  const k = upperBound(h.knotT, t) - 1
  if (k < 0) return h.knotX[0]
  if (k >= n - 1) return h.knotX[n - 1]
  const span = h.knotT[k + 1] - h.knotS[k]
  const u = span > 1e-9 ? smooth((t - h.knotS[k]) / span) : 1
  return h.knotX[k] + u * (h.knotX[k + 1] - h.knotX[k])
}

/** Extent of the withdrawal at t, 0 (over the keys) .. 1 (resting), and the span's index (-1 = none): out over [outS, outE], held, back over [retS, retE]. */
function withdrawQ(h: HandTrack, t: number): { q: number; i: number } {
  const n = h.wd.length / WD_STRIDE
  let lo = 0, hi = n
  while (lo < hi) { const mid = (lo + hi) >> 1; if (h.wd[mid * WD_STRIDE] <= t) lo = mid + 1; else hi = mid }
  const i = lo - 1
  if (i < 0) return { q: 0, i: -1 }
  const b = i * WD_STRIDE
  const w = h.wd
  if (t >= w[b + 3]) return { q: 0, i: -1 }
  if (t < w[b + 1]) return { q: (t - w[b]) / (w[b + 1] - w[b]), i }
  if (t < w[b + 2]) return { q: 1, i }
  return { q: 1 - (t - w[b + 2]) / (w[b + 3] - w[b + 2]), i }
}
/** Minimum-jerk profile. */
const minJerk = (u: number) => { const c = u < 0 ? 0 : u > 1 ? 1 : u; return c * c * c * (10 + c * (-15 + 6 * c)) }

/** Round 40: smoothstep blended toward the minimum-jerk profile (zero acceleration at both ends) by min(smoothness, 1). */
function easeSm(o: MotionOptions, u: number): number {
  const sm = smooth(u)
  return sm + 0.5 * Math.min(1, o.smoothness) * (minJerk(u) - sm)
}
// ---- evaluation ----------------------------------------------------------------------------------------------
type FState = { i: number; j: number; aPrev: number; dPrev: number; aNext: number; pNext: number; slow: number; pRaw: number }

function fingerState(ft: FingerTrack, t: number, o: MotionOptions, out: FState) {
  const n = ft.on.length
  const i = upperBound(ft.on, t) - 1
  let aPrev = 0
  let dPrev = 0
  if (i >= 0) {
    if (t <= ft.off[i]) {
      aPrev = 1
      // the key comes back up exactly at the note's end, so the finger lets it up just before (no lingering in a
      // key that has already risen)
      const up = Math.min(0.04, 0.5 * (ft.off[i] - ft.on[i]))
      dPrev = smooth((t - ft.on[i]) / o.dipTime) * (1 - smooth((t - (ft.off[i] - up)) / up))
    } else {
      let relT = ft.rel[i] * (1 + o.humanize * 0.5 * o.varLift * ft.vr[3 * i + 1])
      // (alternation: the finger springs up in a share of its own cycle, so there is time at the top before the next descent)
      if (o.altLift > 0 && ft.alt[i] === 1 && i + 1 < n && ft.alt[i + 1] === 1) relT = Math.min(relT, o.altRelease * (ft.on[i + 1] - ft.on[i]))
      // (Round 40: the finger lets go over a longer, minimum-jerk-blended move)
      if (o.smoothness > 0) relT = Math.min(relT * (1 + o.smoothFinger * o.smoothness), Math.max(relT, i + 1 < n ? 0.5 * (ft.on[i + 1] - ft.off[i]) : Infinity))
      aPrev = 1 - (o.smoothness > 0 ? easeSm(o, (t - ft.off[i]) / relT) : smooth((t - ft.off[i]) / relT))
      dPrev = 0
    }
  }
  const j = i + 1
  let aNext = 0
  let pNext = 0
  let slow = 0
  let pRaw = 0
  if (j < n) {
    slow = ft.calm[j]
    const walk = i >= 0 && ft.rep[i] === 1 && ft.rep[j] === 1
    // Fast re-use of the same finger: the descent can't take longer than ~60% of the gap since its last onset
    // (30% in a repetition walk, which needs the rest of the gap to curl in and swing out).
    // (loud notes come down faster, soft ones slower: `dynAttack`)
    const oa = o.attack * clamp(1 - o.humanize * o.dynAttack * (ft.dyn[j] + 0.5 * ft.acc[j]), 0.3, 2) * (1 + o.humanize * o.varTime * ft.vr[3 * j])
    const altRun = i >= 0 && o.altLift > 0 && ft.alt[i] === 1 && ft.alt[j] === 1
    let attack = i >= 0 ? Math.min(oa, (walk ? 0.3 : altRun ? o.altAttack : 0.6) * (ft.on[j] - ft.on[i])) : oa
    // Round 27: a staccato strike is a short sharp drop that accelerates into the key
    const swp = ft.swP[j]
    if (swp > 0) attack *= 1 - o.stacPress * swp
    if (ft.late[j]) attack = Math.min(attack, o.latePrepare) // arm move: the finger drops only as the hand arrives
    // Round 41: grasp — each finger's descent into the chord is a little longer or shorter (seeded; the contact time stays)
    if (o.graspStagger > 0 && ft.gw[j] > 0) attack = Math.max(0.4 * attack, attack + o.graspStagger * ft.gw[j] * ft.gs[j])
    if (attack > 1e-6) {
      const u = clamp((t - (ft.on[j] - attack)) / attack, 0, 1)
      const ac = o.stacAccel * swp
      aNext = (1 - ac) * smooth(u) + ac * u * u
    } else aNext = 1
    // Prepare: once free, glide over the next key at hover height (overlapping the lift-off, done before the
    // descent, so the shape is there first). Arm-move notes glide only at the last moment — the finger rides along
    // with the hand. In a repetition walk the first half of the free time is the curl-in, the rest the swing-out.
    const pEnd = ft.on[j] - attack
    const free = i >= 0 ? ft.off[i] : -Infinity
    // (in fast passages the glide starts later — the current notes keep the hand; full lead before a calm chord)
    let pStart = Math.max(ft.on[j] - o.prepare * (0.5 + 0.5 * slow) * (o.smoothness > 0 ? 1 + o.smoothFinger * o.smoothness : 1), walk ? free + 0.5 * (pEnd - free) : free)
    if (ft.late[j]) pStart = Math.max(pStart, pEnd - o.latePrepare)
    pStart = Math.min(pEnd - 0.02, pStart)
    pNext = o.smoothness > 0 ? easeSm(o, (t - pStart) / (pEnd - pStart)) : smooth((t - pStart) / (pEnd - pStart))
    pRaw = pNext
    // Round 41: the fingers take the chord's shape late in the travel (slow start, arrives over the keys by the descent)
    if (o.graspShape > 0 && ft.gw[j] > 0 && pNext > 0 && pNext < 1) pNext = Math.pow(pNext, 1 + o.graspShape * ft.gw[j])
    if (walk && t > ft.off[i]) {
      // curl in quickly after the release (instead of the normal slow lift)
      aPrev = 1 - smooth((t - ft.off[i]) / Math.max(0.02, pStart - ft.off[i]))
    }
  }
  out.i = i
  out.j = j
  out.aPrev = aPrev
  out.dPrev = dPrev
  out.aNext = aNext
  out.pNext = pNext
  out.pRaw = pRaw
  out.slow = slow
}

/** Solve the planar bend `b` so the chain's MCP -> tip distance equals r. Returns b (clamped). */
function solveBend(f: number, bones: number[], bmax: number, r: number): number {
  let lo = 0
  let hi = bmax
  if (chainDist(f, bones, lo) <= r) return 0
  if (chainDist(f, bones, hi) >= r) return hi
  for (let it = 0; it < 18; it++) {
    const mid = 0.5 * (lo + hi)
    if (chainDist(f, bones, mid) > r) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}

/**
 * Relaxed solution of the planar finger for a tip at in-plane height `dz` (wu, below the MCP < 0): of the chains with
 * PIP bend b in [0, bMax] that reach that height (the MCP angle follows from it), the one closest to the relaxed
 * MCP : PIP ratio `ratio`, without landing more than ~`reachTol` further out than the bMax solution (the planned hover
 * reach). `cupF` = the metacarpal's palmar tilt (the MCP angle is measured against the metacarpal).
 */
/** Relaxed PIP flexion the idle finger is steered toward (resting / functional position 15-45 deg; see README Round 19) and its tolerance. */
const RELAX_PIP = 0.55
/** Round 39: loose-fist joint angles (deg; index .. little): MCP flexion against the metacarpal, PIP (DIP follows by `jointBend`). */
const FIST_MCP = [0, 38, 38, 40, 43].map((v) => (v * Math.PI) / 180)
/** Round 39: loose-fist thumb as CMC flexion / abduction (rad) and the shared MCP / IP bend: lying against the curled index's proximal phalanx */
const FIST_THUMB = { flex: 0.5, abd: -0.38, b: 0.65 }
const FIST_PIP = [0, 58, 58, 58, 58].map((v) => (v * Math.PI) / 180)
const RELAX_PIP_TOL = 0.35
function relaxedBend(f: number, bones: number[], dz: number, bMax: number, cupF: number, ratio: number, sigma: number, reachTol: number, landsOk: (fwd: number) => boolean, pipRef = RELAX_PIP, bLo = 0): number {
  const at = (b: number) => {
    let x = 0, z = 0, a = 0
    for (let k = 0; k < bones.length; k++) {
      if (k > 0) a -= jointBend(f, k, b)
      x += bones[k] * Math.cos(a)
      z += bones[k] * Math.sin(a)
    }
    const lc = Math.hypot(x, z)
    if (Math.abs(dz) > lc) return null
    const phi = Math.asin(dz / lc)
    return { m: -(phi - Math.atan2(z, x)) - cupF, fwd: lc * Math.cos(phi) }
  }
  const ref = at(bMax)
  if (!ref) return bMax
  let best = bMax
  let bestJ = Infinity
  const N = 24
  for (let i = 0; i <= N; i++) {
    const b = bLo + ((bMax - bLo) * i) / N
    const c = at(b)
    if (!c || !landsOk(c.fwd)) continue
    const df = c.fwd - ref.fwd
    // (landing further out is penalised by reachTol; curling in toward the palm is cheap; PIP is kept near its relaxed value)
    const j = ((Math.min(0, c.m - ratio * b)) / sigma) ** 2 + (df > 0 ? df / reachTol : df / (3 * reachTol)) ** 2 + ((b - pipRef) / RELAX_PIP_TOL) ** 2
    if (j < bestJ) { bestJ = j; best = b }
  }
  return best
}

function chainDist(f: number, bones: number[], b: number): number {
  let x = 0
  let z = 0
  let a = 0
  for (let k = 0; k < bones.length; k++) {
    if (k > 0) a -= jointBend(f, k, b)
    x += bones[k] * Math.cos(a)
    z += bones[k] * Math.sin(a)
  }
  return Math.hypot(x, z)
}

const fs: FState = { i: 0, j: 0, aPrev: 0, dPrev: 0, aNext: 0, pNext: 0, slow: 0, pRaw: 0 }

/** 0..1 how far the hand is playing over the other at t (the same smoothing `handPose` applies to its `over`). */
function overAt(h: HandTrack, t: number): number {
  const n = h.knotT.length
  const k = upperBound(h.knotT, t) - 1
  if (k < 0) return h.knotO[0]
  if (k >= n - 1) return h.knotO[n - 1]
  const s = h.knotS[k]
  const span = h.knotT[k + 1] - s
  const uo = span > 1e-9 ? (t - s) / span : 1
  const o0 = h.knotO[k]
  const o1 = h.knotO[k + 1]
  return o0 + (o1 - o0) * (o1 > o0 ? smooth(uo / 0.4) : smooth((uo - 0.6) / 0.4))
}

/** Round 24: forearm rotation target at t. Each chord onset T_i holds value V_i; the value reaches V_i `rotLead` before T_i
 *  (smoothstep over min(gap, rotWindow) ending there), holds until the next transition starts, and fades to 0 after the last chord. */
function rotAt(h: HandTrack, t: number, o: MotionOptions): number {
  const T = h.rotT
  const V = h.rotV
  const n = T.length
  if (!n) return 0
  const tq = t + o.rotLead
  const i = upperBound(T, tq) - 1
  const w = (gap: number) => Math.max(1e-6, Math.min(gap, o.rotWindow))
  if (i < 0) {
    const ww = o.rotWindow
    return V[0] * smooth((tq - (T[0] - ww)) / ww)
  }
  if (i >= n - 1) return V[n - 1] * (1 - smooth((tq - T[n - 1] - 0.8) / 0.6))
  const ww = w(T[i + 1] - T[i])
  return V[i] + (V[i + 1] - V[i]) * smooth((tq - (T[i + 1] - ww)) / ww)
}

/** Round 28 build-time probe: while set, `handPose` records the solved wrist deviation / roll of a run segment instead of overriding them. */
const FLOW_GRID = 81
const FLOW_MID = [0.3, 0.6, 0.85]
let flowCap: { u: number; roll: number; grid: Float64Array | null; uLo: number; uHi: number } | null = null

/** Per hand-position group of every run: the mean of the per-strike solved wrist deviation / roll (what the per-note solve would pick, averaged). */
function computeFlowShapes(o: MotionOptions, h: HandTrack) {
  const n = h.knotT.length
  const uk = new Float64Array(n).fill(NaN)
  const rk = new Float64Array(n).fill(NaN)
  const gk: (Float64Array | null)[] = new Array(n).fill(null)
  const gm: Float64Array[][] = Array.from({ length: n }, () => []) // cost grids between chord k and k + 1 (FLOW_MID)
  let range = [0, 0]
  for (let k = 0; k < n; k++) {
    if (h.flowG[k] < 0) continue
    const a = h.flowA[k]
    const tt = k === a ? h.knotT[k] + 1e-4 : h.knotT[k] - 1e-4
    flowCap = { u: NaN, roll: NaN, grid: null, uLo: 0, uHi: 0 }
    try { handPose(o, h, tt, 0) } finally { uk[k] = flowCap.u; rk[k] = flowCap.roll; gk[k] = flowCap.grid; if (flowCap.grid) range = [flowCap.uLo, flowCap.uHi]; flowCap = null }
    // (and between this strike and the next: the next chord's fingers are being prepared there, the frames the solve would adapt in)
    if (h.flowSeg[k]) {
      for (const fr of FLOW_MID) {
        flowCap = { u: NaN, roll: NaN, grid: null, uLo: 0, uHi: 0 }
        try { handPose(o, h, h.knotT[k] + fr * (h.knotT[k + 1] - h.knotT[k]), 0) } finally { if (flowCap.grid) gm[k].push(flowCap.grid); flowCap = null }
      }
    }
  }
  // per fingering group, in chord order: grow a sub-group while ONE shape still costs at most `flowTol` beyond its strikes' individual optima
  // (summed devSolve cost); a chord that would break it starts the next sub-group (its own id, so the shape changes only between them)
  const solve = (idx: number[]) => {
    let su = 0, sr = 0, c = 0
    for (const j of idx) if (!Number.isNaN(uk[j])) { su += uk[j]; sr += rk[j]; c++ }
    const um = c ? su / c : 0
    const gs: Float64Array[] = []
    idx.forEach((j, q) => { if (gk[j]) gs.push(gk[j]!); if (o.flowMid > 0 && q + 1 < idx.length) for (const g of gm[j]) gs.push(g) })
    let best = um
    let ex = 0
    if (gs.length) {
      let bc = Infinity
      let bi = 0
      for (let i = 0; i < FLOW_GRID; i++) {
        const u = range[0] + ((range[1] - range[0]) * i) / (FLOW_GRID - 1)
        let cs = o.flowPull * (u - um) ** 2
        for (const g of gs) cs += g[i]
        if (cs < bc) { bc = cs; best = u; bi = i }
      }
      for (const g of gs) { let mn = Infinity; for (let i = 0; i < FLOW_GRID; i++) mn = Math.min(mn, g[i]); ex += g[bi] - mn }
    }
    return { best, ex, roll: c ? sr / c : NaN }
  }
  let nextId = 0
  for (let k = 0; k < n; k++) nextId = Math.max(nextId, h.flowG[k] + 1)
  for (let k = 0; k < n; ) {
    if (h.flowG[k] < 0) { k++; continue }
    const g = h.flowG[k]
    let e = k
    while (e + 1 < n && h.flowG[e + 1] === g) e++
    let simple = true
    for (let j = k; j <= e; j++) if (h.cntK[j] > o.flowShapeNotes) simple = false
    if (simple) {
      let s0 = k
      while (s0 <= e) {
        let s1 = s0
        let res = solve([s0])
        while (s1 < e) {
          const r2 = solve(Array.from({ length: s1 - s0 + 2 }, (_, i) => s0 + i))
          if (r2.ex > o.flowTol) break
          res = r2
          s1++
        }
        for (let j = s0; j <= s1; j++) { h.flowU[j] = res.best; h.flowRoll[j] = res.roll; h.flowG[j] = nextId }
        nextId++
        s0 = s1 + 1
      }
    }
    k = e + 1
  }
}

export function poseAt(motion: HandMotion, t: number): HandPoses {
  // (the hand underneath yields while the other plays over it)
  const lean = leanAt(motion, t)
  return {
    L: motion.L ? handPose(motion.opts, motion.L, t, motion.R ? overAt(motion.R, t) : 0, lean) : null,
    R: motion.R ? handPose(motion.opts, motion.R, t, motion.L ? overAt(motion.L, t) : 0, lean) : null,
  }
}

/** Finger enslaving (Hager-Ross & Schieber 2000): how strongly each finger follows a flexing neighbour (index the most
 *  independent, middle / ring the least), falling off with the distance between the fingers. */
const ENSLAVED = [0, 0.5, 0.9, 1, 0.8]


/** Round 40: position profile of segment k at normalised time tau (0..1): smoothstep, or the cubic Hermite with the matched end slopes when smoothness > 0. */
function moveU(o: MotionOptions, h: HandTrack, k: number, tau: number): number {
  const u0 = moveU0(o, h, k, tau)
  const wB = h.knotBell[k]
  if (wB <= 0) return u0
  return u0 + wB * (bellU(o, tau) - u0)
}
/** Round 41: bell-shaped velocity profile: minimum jerk in warped time (speed peaks at `leapPeak`), done `leapEarly` before the end, then a small damped overshoot that settles by the end. */
function bellU(o: MotionOptions, tau: number): number {
  const c = tau < 0 ? 0 : tau > 1 ? 1 : tau
  const te = 1 - o.leapEarly
  if (c < te) return minJerk(Math.pow(c / te, Math.log(0.5) / Math.log(clamp(o.leapPeak, 0.2, 0.8))))
  const s = (c - te) / Math.max(1e-6, 1 - te)
  const sn = Math.sin(Math.PI * s)
  return 1 + o.leapSettle * sn * sn
}
/** Round 41: extra wrist height (wu) of the arc over big move k at move time tau. */
function leapZ(o: MotionOptions, h: HandTrack, k: number, tau: number): number {
  const wB = h.knotBell[k]
  if (wB <= 0 || o.leapArc <= 0) return 0
  const c = tau < 0 ? 0 : tau > 1 ? 1 : tau
  return o.leapArc * wB * Math.min(1.5, h.knotDist[k]) * Math.sin(Math.PI * Math.pow(c, 0.85))
}
/** Round 41: how much of a bell move is under way at t (0..1): full inside the move, ramping in just before its start and out just after the strike. */
function leapW(_o: MotionOptions, h: HandTrack, t: number): number {
  const n = h.knotT.length
  if (n < 2) return 0
  const k = upperBound(h.knotT, t) - 1
  let w = 0
  if (k >= 0 && k < n - 1 && h.knotBell[k] > 0) w = h.knotBell[k] * smooth((t - (h.knotS[k] - 0.1)) / 0.1)
  else if (k + 1 < n - 1 && k >= 0 && h.knotBell[k + 1] > 0) w = h.knotBell[k + 1] * smooth((t - (h.knotS[k + 1] - 0.1)) / 0.1)
  if (k >= 1 && h.knotBell[k - 1] > 0) w = Math.max(w, h.knotBell[k - 1] * (1 - smooth((t - h.knotT[k]) / 0.06)))
  return w
}
function moveU0(o: MotionOptions, h: HandTrack, k: number, tau: number): number {
  if (o.smoothness <= 0) return smooth(tau)
  const c = tau < 0 ? 0 : tau > 1 ? 1 : tau
  const m0 = h.knotM0[k], m1 = h.knotM1[k]
  if (m0 === 0 && m1 === 0) return c * c * (3 - 2 * c)
  const c2 = c * c, c3 = c2 * c
  return (c3 - 2 * c2 + c) * m0 + (-2 * c3 + 3 * c2) + (c3 - c2) * m1
}
/** Round 40: the planned wrist x / y / z / forearm roll at tt (the same formulas as the plan block of `handPose`), for the smoothing kernel. */
function wristPlanAt(o: MotionOptions, h: HandTrack, tt: number, out: number[]) {
  const n = h.knotT.length
  const k = upperBound(h.knotT, tt) - 1
  if (k < 0) { out[0] = h.knotX[0]; out[1] = h.knotY[0]; out[2] = h.knotZ[0]; out[3] = h.knotR[0]; return }
  if (k >= n - 1) { out[0] = h.knotX[n - 1]; out[1] = h.knotY[n - 1]; out[2] = h.knotZ[n - 1]; out[3] = h.knotR[n - 1]; return }
  const s = h.knotS[k]
  const span = h.knotT[k + 1] - s
  const u = span > 1e-9 ? smooth((tt - s) / span) : 1
  const uP = span > 1e-9 ? moveU(o, h, k, (tt - s) / span) : 1
  let wx = h.knotX[k] + uP * (h.knotX[k + 1] - h.knotX[k])
  let wy = h.knotY[k] + uP * (h.knotY[k + 1] - h.knotY[k])
  let wz = h.knotZ[k] + uP * (h.knotZ[k + 1] - h.knotZ[k])
  if (o.flow > 0 && h.flowSeg[k]) {
    const hh = h.knotT[k + 1] - h.knotT[k]
    const s1 = (tt - h.knotT[k]) / hh
    const s2 = s1 * s1, s3 = s2 * s1
    const a0 = 2 * s3 - 3 * s2 + 1, a1 = s3 - 2 * s2 + s1, a2 = -2 * s3 + 3 * s2, a3 = s3 - s2
    const N = h.flowN
    const ev = (c: number) => a0 * N[2 * c][k] + a1 * hh * N[2 * c + 1][k] + a2 * N[2 * c][k + 1] + a3 * hh * N[2 * c + 1][k + 1]
    wx += o.flow * (ev(0) - wx)
    wy += o.flow * (ev(1) - wy)
    wz += o.flow * (ev(2) - wz)
  }
  const o0 = h.knotO[k], o1 = h.knotO[k + 1]
  const uo = span > 1e-9 ? (tt - s) / span : 1
  const over = o0 + (o1 - o0) * (o1 > o0 ? smooth(uo / 0.4) : smooth((uo - 0.6) / 0.4))
  wz += o.overLift * (over - (o0 + u * (o1 - o0)))
  const dyn = h.dynK[k] + u * (h.dynK[k + 1] - h.dynK[k])
  wz += o.travelLift * clamp(1 + o.humanize * o.dynTravel * dyn, 0.3, 1.6) * (1 - o.flow * o.flowLift * h.flowSeg[k]) * Math.sin(Math.PI * u) * Math.min(1, h.knotDist[k]) * (o.liftTravelMin + (1 - o.liftTravelMin) * smooth((h.knotT[k + 1] - h.knotT[k] - o.liftT0) / (o.liftT1 - o.liftT0)))
  if (h.knotBell[k] > 0 && span > 1e-9) wz += leapZ(o, h, k, (tt - s) / span)
  out[0] = wx; out[1] = wy; out[2] = wz
  out[3] = h.knotR[k] + uP * (h.knotR[k + 1] - h.knotR[k])
}
const gravOut = [0, 0]
const SM_TAPS = 4
const SM_W = (() => { const w: number[] = []; for (let i = -SM_TAPS; i <= SM_TAPS; i++) w.push(0.5 * (1 + Math.cos((Math.PI * i) / (SM_TAPS + 0.5)))); return w })()
const smTmp = [0, 0, 0, 0]
/** Round 40: half-width (s) of the wrist smoothing kernel at t: `smoothness * smoothFrac` of the local gap between chords (interpolated between segment centres so it is continuous), <= `smoothMax * smoothness`. */
function smoothHalfWidth(o: MotionOptions, h: HandTrack, t: number): number {
  const n = h.knotT.length
  if (n < 2) return 0
  const k = Math.min(n - 2, Math.max(0, upperBound(h.knotT, t) - 1))
  const g = (q: number) => h.knotT[q + 1] - h.knotT[q]
  const mid = (q: number) => 0.5 * (h.knotT[q] + h.knotT[q + 1])
  let gap = g(k)
  if (t < mid(k) && k > 0) { const a = Math.max(0, (t - mid(k - 1)) / (mid(k) - mid(k - 1))); gap = g(k - 1) + a * (g(k) - g(k - 1)) }
  else if (t >= mid(k) && k < n - 2) { const a = Math.min(1, (t - mid(k)) / (mid(k + 1) - mid(k))); gap = g(k) + a * (g(k + 1) - g(k)) }
  const W = Math.min(o.smoothness * o.smoothFrac * gap, o.smoothness * o.smoothMax)
  return o.leapBell > 0 && o.leapKernel > 0 ? W * (1 - o.leapKernel * leapW(o, h, t)) : W
}

function handPose(o: MotionOptions, h: HandTrack, t: number, yielding = 0, lean = 0): HandPose {
  const S = o.handScale
  const m = h.m

  // wrist plan
  const n = h.knotT.length
  const k = upperBound(h.knotT, t) - 1
  let wx: number, wy: number, wz: number, roll: number, over: number
  let trav = 0
  let overSettled = 0
  let swayPitch = 0
  if (k < 0) {
    wx = h.knotX[0]; wy = h.knotY[0]; wz = h.knotZ[0]; roll = h.knotR[0]; trav = h.knotTrav[0]; over = h.knotO[0]; overSettled = over
  } else if (k >= n - 1) {
    wx = h.knotX[n - 1]; wy = h.knotY[n - 1]; wz = h.knotZ[n - 1]; roll = h.knotR[n - 1]; trav = h.knotTrav[n - 1]; over = h.knotO[n - 1]; overSettled = over
  } else {
    const s = h.knotS[k]
    const span = h.knotT[k + 1] - s
    const u = span > 1e-9 ? smooth((t - s) / span) : 1
    const uP = span > 1e-9 ? moveU(o, h, k, (t - s) / span) : 1
    wx = h.knotX[k] + uP * (h.knotX[k + 1] - h.knotX[k])
    wy = h.knotY[k] + uP * (h.knotY[k + 1] - h.knotY[k])
    wz = h.knotZ[k] + uP * (h.knotZ[k + 1] - h.knotZ[k])
    if (o.flow > 0 && h.flowSeg[k]) {
      // Round 28: velocity-continuous Hermite glide through the run's nodes
      const hh = h.knotT[k + 1] - h.knotT[k]
      const s1 = (t - h.knotT[k]) / hh
      const s2 = s1 * s1, s3 = s2 * s1
      const a0 = 2 * s3 - 3 * s2 + 1, a1 = s3 - 2 * s2 + s1, a2 = -2 * s3 + 3 * s2, a3 = s3 - s2
      const N = h.flowN
      const ev = (c: number) => a0 * N[2 * c][k] + a1 * hh * N[2 * c + 1][k] + a2 * N[2 * c][k + 1] + a3 * hh * N[2 * c + 1][k + 1]
      wx += o.flow * (ev(0) - wx)
      wy += o.flow * (ev(1) - wy)
      wz += o.flow * (ev(2) - wz)
    }
    roll = h.knotR[k] + uP * (h.knotR[k + 1] - h.knotR[k])
    trav = h.knotTrav[k] + u * (h.knotTrav[k + 1] - h.knotTrav[k])
    // (rise early when moving over the other hand, come down late when leaving it, so the palm clears it en route)
    const o0 = h.knotO[k]
    const o1 = h.knotO[k + 1]
    const uo = span > 1e-9 ? (t - s) / span : 1
    over = o0 + (o1 - o0) * (o1 > o0 ? smooth(uo / 0.4) : smooth((uo - 0.6) / 0.4))
    overSettled = o0 + u * (o1 - o0)
    wz += o.overLift * (over - overSettled)
    // (soft passages travel quieter and lower, loud ones lift more)
    const dyn = h.dynK[k] + u * (h.dynK[k + 1] - h.dynK[k])
    wz += o.travelLift * clamp(1 + o.humanize * o.dynTravel * dyn, 0.3, 1.6) * (1 - o.flow * o.flowLift * h.flowSeg[k]) * Math.sin(Math.PI * u) * Math.min(1, h.knotDist[k]) * (o.liftTravelMin + (1 - o.liftTravelMin) * smooth((h.knotT[k + 1] - h.knotT[k] - o.liftT0) / (o.liftT1 - o.liftT0)))
    if (h.knotBell[k] > 0 && span > 1e-9) wz += leapZ(o, h, k, (t - s) / span)
  }

  // Round 40: zero-phase smoothing of the planned wrist path (strike times stay; the wrist is a little off the knot at the strike, the finger IK absorbs it)
  if (o.smoothness > 0 && n > 1) {
    const W = smoothHalfWidth(o, h, t)
    if (W > 1e-4) {
      let sx = 0, sy = 0, sz = 0, sr = 0, sw = 0
      for (let i = -SM_TAPS; i <= SM_TAPS; i++) {
        const w = SM_W[i + SM_TAPS]
        wristPlanAt(o, h, t + (W * i) / SM_TAPS, smTmp)
        sx += w * smTmp[0]; sy += w * smTmp[1]; sz += w * smTmp[2]; sr += w * smTmp[3]; sw += w
      }
      wristPlanAt(o, h, t, smTmp)
      // (the offset fades out around the chord onsets: the strike lands on the unsmoothed plan's position)
      let wS = 1
      if (o.smoothStrike > 0) {
        const kk = Math.max(0, upperBound(h.knotT, t) - 1)
        const dn = Math.min(Math.abs(t - h.knotT[kk]), kk + 1 < n ? Math.abs(h.knotT[kk + 1] - t) : 1e9)
        wS = 1 - o.smoothStrike * (1 - smooth((dn - 0.025) / o.smoothStrikeT))
      }
      wx += wS * (sx / sw - smTmp[0]); wy += wS * (sy / sw - smTmp[1]); wz += wS * (sz / sw - smTmp[2]); roll += wS * (sr / sw - smTmp[3])
    }
  }

  // Round 41: after landing from a big move the wrist relaxes a little into the held chord and comes back up before the next departure
  if (o.graspSettle > 0 && o.leapBell > 0 && k >= 1 && k < n && h.knotBell[k - 1] > 0) {
    const dep = k < n - 1 ? h.knotS[k] : Infinity
    wz -= o.graspSettle * h.knotBell[k - 1] * smooth((t - h.knotT[k]) / o.graspSettleT) * (1 - smooth((t - (dep - 0.1)) / 0.1))
  }

  // Round 22: each hand position differs a little from the planned one (seeded by the knot, so repeated figures are not
  // identical); the fingers' contacts are unaffected (the IK absorbs it), repetition runs stay still.
  if (o.varWrist * o.humanize > 0 && k >= 0 && k < n - 1) {
    const jit = (kk: number, c: number) => 2 * seed01(kk * 7 + c + (m > 0 ? 501 : 577)) - 1
    const uj = smooth((t - h.knotS[k]) / Math.max(1e-9, h.knotT[k + 1] - h.knotS[k]))
    const g = o.varWrist * o.humanize * (1 - repeatEnvelope(h, t, 0.15).env)
    wx += g * (jit(k, 0) + uj * (jit(k + 1, 0) - jit(k, 0)))
    wy += g * (jit(k, 1) + uj * (jit(k + 1, 1) - jit(k, 1)))
    wz += g * 0.7 * (jit(k, 2) + uj * (jit(k + 1, 2) - jit(k, 2)))
  }

  // Round 21: the hand underneath a crossing lowers its wrist and draws back toward the player, out of the way
  wz -= o.yieldDrop * yielding
  wy -= o.yieldBack * yielding

  // Round 29: an idle hand leaves the keys. The wrist blends from the planned path to the hand's resting spot (in front of the keyboard,
  // below the key tops, on its own side); the channels lead one after another (back first, then down, then sideways; reversed when it
  // returns) so the hand clears the front edge before it sinks. The idle fingers ride along (dzW) and curl loosely.
  // Round 38: after a return the plan still hovers where the hand left until just before the first note; the hand arrives at the x it
  // plays that note at and stays there (no slide in view after arrival). The correction is the plan's remaining x change to the onset.
  if (h.wd.length > 0) {
    const n = h.wd.length / WD_STRIDE
    let lo = 0, hi = n
    while (lo < hi) { const mid = (lo + hi) >> 1; if (h.wd[mid * WD_STRIDE] <= t) lo = mid + 1; else hi = mid }
    if (lo > 0) {
      const b = (lo - 1) * WD_STRIDE
      if (h.wd[b + 3] < WD_FAR && t > h.wd[b + 2] && t < h.wd[b + 16]) wx += o.withdrawReturnX * (planXAt(h, h.wd[b + 16] + 1e-4) - planXAt(h, t))
    }
  }
  let wdQ = 0
  let wdS = 0
  let wdR = 0
  let wdBack = false
  let dzW = 0
  let wdSway = 1
  let wdPitch = 0
  if (h.wd.length > 0) {
    const wq = withdrawQ(h, t)
    if (wq.i >= 0 && wq.q > 0) {
      const b = wq.i * WD_STRIDE
      const P = h.wd
      const q = wq.q
      wdQ = q
      wdS = smooth(q)
      wdR = q
      const wzK = wz
      wy += minJerk(q / P[b + 9]) * (P[b + 5] - wy)
      // (the hand sinks only once its fingertips are clear of the keys' front edge)
      const frontLen = (FINGER_LY[2] + o.reachRatio * TOTAL_LEN[2] - o.withdrawCurl * wdS) * S
      const gate = smooth((KEYBOARD_Y - 0.05 + o.withdrawGateLead - (wy + frontLen)) / 0.7)
      wz += minJerk((q - P[b + 10]) / (1 - P[b + 10])) * gate * (P[b + 6] - wz)
      const c = Math.sin(Math.PI * Math.min(1, q / 0.45))
      wz += P[b + 7] * c * c
      // (Round 36: the rest x travels from the out spot to the spot under the return's first note while the hand is down)
      const xE = P[b + 3] < WD_FAR ? P[b + 4] + o.withdrawReturnX * (planXAt(h, P[b + 16] + 1e-4) - P[b + 4]) : P[b + 4]
      const xT = t <= P[b + 14] ? P[b + 4] : t >= P[b + 15] ? xE : P[b + 4] + (xE - P[b + 4]) * minJerk((t - P[b + 14]) / (P[b + 15] - P[b + 14]))
      wx += minJerk((q - P[b + 11]) / (1 - P[b + 11])) * (xT - wx) + P[b + 8] * Math.sin(Math.PI * minJerk(q))
      dzW = wz - wzK
      wdSway = 1 + (o.withdrawSway * P[b + 12] - 1) * wdS
      wdBack = t >= P[b + 2]
      const sb = wdBack ? o.withdrawShapeByRet : o.withdrawShapeBy
      // (wrist leads the departure: a small extension as the fingers leave the keys, then it hangs flexed)
      const lead = Math.sin(Math.PI * Math.min(1, q / Math.max(0.05, sb * 1.4)))
      wdPitch = P[b + 13] * smooth(q / sb) - (wdBack ? 0.5 : 1) * o.withdrawLead * lead * lead
    }
  }

  // Repetition run: hold the ulnar tilt and slide the hand so the run's fingers (as tilted) sit over the key.
  let armOff: Vec3 | null = null
  let foreG = 0
  const foreOf = (off: Vec3) => Math.atan2(off[0], -off[1])
  // (the repetition-run slide below is tuned with the fixed forearm angle, so it keeps it with the arm model too: the hand's own yaw there is -m * tilt)
  const fore0 = Math.atan2(m * o.elbowOutward - o.elbowSwing * wx, 1)
  const rp = repeatEnvelope(h, t, 0.15)
  const tilt = o.repeatTilt * rp.env
  if (rp.env > 0) {
    const yaw = fore0 - m * o.repeatTilt
    const runX = h.repX[rp.k] - (h.repLat[rp.k] * Math.cos(yaw) - h.repLen[rp.k] * Math.sin(yaw))
    wx += rp.env * (runX - wx)
  }

  // pass 1: per-finger activity (for sympathetic motion, and the sway gate)
  const act = [0, 0, 0, 0, 0]
  const actY = [0, 0, 0, 0, 0]
  // Round 41: the reach pull below starts while the fingers still prepare over a big move's chord (the hand settles in over the travel, not in one lunge at the strike)
  const preAct = [0, 0, 0, 0, 0]
  let busy = 0
  for (let f = 0; f < 5; f++) {
    fingerState(h.fingers[f], t, o, fs)
    // a finger gliding over its next key already counts, so the wrist and the other fingers shape around it early
    act[f] = Math.max(fs.aPrev, fs.aNext, o.prepareWeight * fs.slow * fs.pNext)
    busy = Math.max(busy, act[f])
    if (o.graspReach > 0 && o.leapBell > 0 && fs.j < h.fingers[f].on.length) preAct[f] = o.graspReach * h.fingers[f].gw[fs.j] * fs.pRaw
    // Round 26: weight of the finger in the wrist-yaw plan. A finger of the NEXT chord counts from the previous strike, ramping
    // up over the whole gap (smoothstep), so the wrist deviation turns gradually instead of stepping when the finger finally
    // becomes active ~75 ms after the strike.
    actY[f] = act[f]
    if (o.yawLead > 0 && k >= 0 && k < n - 1 && fs.j < h.fingers[f].on.length && Math.abs(h.fingers[f].on[fs.j] - h.knotT[k + 1]) <= 0.03) {
      const g = h.knotT[k + 1] - h.knotT[k]
      if (g > 1e-6 && g <= o.yawLeadGap) actY[f] = Math.max(act[f], o.yawLead * smooth((t - h.knotT[k]) / g))
    }
  }

  // Procedural sway of the wrist (before the clamps and the finger IK: held fingertips keep their keys, the joints
  // absorb it, idle fingers ride along). Full at rest, reduced while fingers are active, none in a repetition run.
  // Everything is continuous in t (act[] and rp.env are), so the gate never pops.
  let swayYaw = 0
  const hm = o.humanize
  if (o.sway * hm > 0) {
    const g = o.sway * hm * (1 - rp.env) * (1 - (1 - o.swayPlaying) * busy) * wdSway
    if (g > 0) {
      const sd = m > 0 ? 11 : 53 // per hand
      const ch = (c: number, amp: number, fast: number) => swayChannel(t, sd + 31 * c, o.swayHz, amp, fast, amp * o.swaySettle) * g
      // (energy goes to sideways drift, yaw and roll; z / pitch stay small and unrelated to each other)
      wx += ch(0, o.swayDrift, o.swayFast)
      wy += ch(1, o.swayDrift * 0.6, o.swayFast * 0.6)
      wz += ch(2, o.swayDrift * o.swayVertical, o.swayFast * o.swayVertical)
      swayYaw = ch(3, o.swayAngle, o.swayAngle * 0.15)
      roll += ch(4, o.swayAngle * 0.8, o.swayAngle * 0.12)
      swayPitch = ch(5, o.swayAngle * o.swayVertical, o.swayAngle * 0.04)
    }
  }

  // Rest: the hand relaxes (rises a little, drifts back toward the player; long rests lift it away from the keys).
  const rest = restEnvelope(h, t)
  const rE = rest.e * hm * o.restMotion
  const rF = rest.far * hm * o.restMotion
  wz += o.restRise * rE + o.restFarRise * rF
  wy -= o.restBack * rE + o.restFarBack * rF

  // Round 23: the forearm rolls into the direction of travel (the side the hand is travelling toward lowers), so the fingers
  // need less spread / reach on arpeggios and runs; not inside a repetition run (the hand holds still there).
  const rollT = m * o.rollTravel * trav * (1 - rp.env) * (1 - over)
  roll += rollT
  // Round 24: the forearm rocks toward the side about to play (pure function of t: eased between chord onsets, leading each strike)
  const rotR = o.rotAmp > 0 ? rotAt(h, t, o) * (1 - o.rotTravelDamp * Math.min(1, Math.abs(trav))) * (1 - rp.env) * (1 - over) : 0
  roll += rotR
  wz += o.rotLift * 0.4 * S * Math.abs(Math.sin(rotR))
  wx += o.rotShift * S * rotR
  // (the knuckle row's lower side sinks by its half-width x sin(roll): the wrist rises by that much so the lower side keeps its height above the keys)
  wz += o.rollLift * 0.4 * S * Math.abs(Math.sin(rollT))
  // (the roll is a forearm pronation / supination: within its range)
  roll = clamp(roll, -FOREARM_ROT * o.romScale, FOREARM_ROT * o.romScale)
  let cr = Math.cos(roll)
  let sr = Math.sin(roll)
  // (the knuckles-down pitch is the last part of going over / the first part of leaving: the palm is still flat while the hands are close)
  const overP = smooth((overSettled - o.overPitchFrom) / (1 - o.overPitchFrom))
  const snap = snapAt(h, t, o)
  // Round 25: staccato wrist bounce (not inside a repetition run, not over the other hand); free fingers ride up with the hand
  const stacRise = o.stacLift > 0 ? stacBounce(h, t, o) * (1 - rp.env) * (1 - over) : 0
  wz += stacRise
  // Round 42: gravity replaces `gravityMix` of the snap wind-up / arm-weight rise at a loud strike and adds its own lift, fall, give and rebound
  const gShare = gravityShare(h, t, o)
  const gOut = gravOut
  const gz = o.gravity * hm > 0 ? gravityAt(h, t, gOut) : 0
  wz += o.snapLift * (snap > 0 ? snap * (1 - gShare) : snap) + dynWrist(h, t, o) * (1 - gShare) + o.overPitchLift * overP * FINGER_LY[2] * S * Math.sin(o.overPitch)
  wz += gz
  wy += o.gravityForward * gOut[1]
  // Wind-up: the hand lifts and extends at the wrist. Follow-through (snap < 0): the wrist gives way under the
  // knuckles, which stay at their height (the palm pitches up about them) instead of sinking and bending the
  // fingers backward at the knuckle.
  // (pitch is wrist flexion / extension: within its active range)
  const pitch0 = clamp(o.palmPitch - o.overPitch * overP - wdPitch + swayPitch + (snap > 0 ? o.snapPitch * snap : -o.snapLift * snap / (FINGER_LY[2] * S)), -WRIST_FLEX * o.romScale, WRIST_EXT * o.romScale)
  // (the palm pitches against the wrist height change: the wrist high = flexed, the knuckles rise less; the give = extended)
  const pitch = gz !== 0 ? clamp(pitch0 - o.gravityPitch * gz / (FINGER_LY[2] * S), -WRIST_FLEX * o.romScale, WRIST_EXT * o.romScale) : pitch0
  const snapRise = snap > 0 ? o.snapLift * snap + FINGER_LY[2] * S * (Math.sin(pitch0) - Math.sin(o.palmPitch - o.overPitch * overP)) : 0
  // (free fingers ride up with the wrist's gravity lift and rebound)
  const gRise = gz > 0 ? gz : 0
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  let cy = 1
  let sy = 0
  const toWorld = (lx: number, ly: number, lz: number): Vec3 => {
    lx *= m * S
    ly *= S
    lz *= S
    const x1 = lx * cr + lz * sr
    const z1 = -lx * sr + lz * cr
    const y1 = ly * cp - z1 * sp
    // yaw about the wrist's vertical axis
    return [wx + x1 * cy - y1 * sy, wy + x1 * sy + y1 * cy, wz + ly * sp + z1 * cp]
  }

  // Idle fingers are never frozen: per-finger curl / lift / spread wander of the hover target (own seed + rate per
  // finger), weighted by 1 - act so it fades out as the finger prepares / presses (a held tip keeps its key).
  const idle: Vec3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]
  if (o.sway * hm > 0 && o.swayFinger > 0) {
    const gf = o.sway * hm * o.swayFinger * (1 - rp.env)
    for (let f = 0; f < 5; f++) {
      const w = gf * (1 - act[f])
      if (w <= 0) continue
      const sd = (m > 0 ? 300 : 400) + 13 * f
      const a = f === 0 ? 1.3 : 1
      idle[f] = [w * a * 0.6 * swayChannel(t, sd, 0.6, 1, 0, 0), w * a * swayChannel(t, sd + 1, 0.6, 1, 0, 0), w * 0.5 * swayChannel(t, sd + 2, 0.6, 1, 0, 0)]
    }
  }

  const mcps: Vec3[] = []
  const tgt: Vec3[] = []
  const hov: number[] = []
  const holdingArr: boolean[] = []
  const press: number[] = []
  const S0 = [0, 0, 0, 0, 0]
  const curlVar = [0, 0, 0, 0, 0]
  // Round 22 drag: how far the wrist travelled over the last `dragLag` s (planned knots only, no sway): free fingers trail it.
  const knotPos = (tt: number, out: number[]) => {
    const kk = upperBound(h.knotT, tt) - 1
    if (kk < 0) { out[0] = h.knotX[0]; out[1] = h.knotY[0]; out[2] = h.knotZ[0]; return }
    if (kk >= n - 1) { out[0] = h.knotX[n - 1]; out[1] = h.knotY[n - 1]; out[2] = h.knotZ[n - 1]; return }
    const s0 = h.knotS[kk]
    const sp = h.knotT[kk + 1] - s0
    const uu = sp > 1e-9 ? smooth((tt - s0) / sp) : 1
    out[0] = h.knotX[kk] + uu * (h.knotX[kk + 1] - h.knotX[kk])
    out[1] = h.knotY[kk] + uu * (h.knotY[kk + 1] - h.knotY[kk])
    out[2] = h.knotZ[kk] + uu * (h.knotZ[kk + 1] - h.knotZ[kk])
  }
  const dragV = [0, 0, 0]
  if (o.drag * hm > 0) {
    const w0 = [0, 0, 0], w1 = [0, 0, 0]
    knotPos(t, w0)
    knotPos(t - o.dragLag, w1)
    const lw = o.leapDrag > 0 && o.leapBell > 0 ? 1 + o.leapDrag * leapW(o, h, t) : 1
    if (lw !== 1) knotPos(t - o.dragLag * lw, w1)
    for (let c = 0; c < 3; c++) dragV[c] = clamp(o.drag * hm * (w0[c] - w1[c]), -o.dragMax * lw, o.dragMax * lw)
  }
  const S1 = [0, 0, 0, 0, 0]
  const fistW = [0, 0, 0, 0, 0]
  const targets = () => {
    mcps.length = tgt.length = hov.length = holdingArr.length = press.length = 0
    // (rest: idle tips converge on the middle knuckles' line)
    const restX = rE > 0 || wdS > 0 || wdR > 0 ? toWorld(0.5 * (FINGER_LAT[2] + FINGER_LAT[3]), FINGER_LY[2], FINGER_LZ[2])[0] - sy * o.reachRatio * TOTAL_LEN[2] * S : 0
    for (let f = 0; f < 5; f++) {
      const mcp = f === 0 ? toWorld(THUMB_MCP[0], THUMB_MCP[1], THUMB_MCP[2]) : toWorld(FINGER_LAT[f], FINGER_LY[f], FINGER_LZ[f])
      const ft = h.fingers[f]
      fingerState(ft, t, o, fs)
      curlVar[f] = fs.j < ft.on.length ? ft.vr[3 * fs.j + 2] : 0

      // hover target (follows the hand, along its yaw), lowered by active neighbours
      const nb = Math.max(f > 0 ? act[f - 1] : 0, f < 4 ? act[f + 1] : 0) * (1 - act[f])
      let ens = 0
      if (f > 0 && o.enslave > 0 && hm > 0) for (let g = 1; g < 5; g++) if (g !== f) ens += ENSLAVED[f] * Math.exp(-0.8 * (Math.abs(f - g) - 1)) * act[g]
      const reach = o.reachRatio * TOTAL_LEN[f] * S + (f === 0 ? 0 : o.reachLong * S * Math.max(0, TOTAL_LEN[f] - TOTAL_LEN[1])) + o.sympathetic * 0.05 * nb - hm * o.enslave * Math.min(ens, 1) * (1 - act[f]) * S
      // relaxed idle fingers: shorter reach (more flexion), tips together, thumb toward the index, riding up with the hand
      const rw = (rE + rF) > 0 ? (1 - act[f]) : 0
      const dw = (1 - act[f]) * (1 - act[f])
      let hx = mcp[0] + (f === 0 ? m * THUMB_HOVER_INWARD * S : 0) - sy * reach + idle[f][0] - dw * dragV[0]
      if (rE > 0) hx += rw * rE * (f === 0 ? m * 0.14 * S : o.restSpread * (restX - hx))
      // (withdrawn: loose curled fingers, tips drawn together, thumb relaxed inward)
      // (Round 36: the loose shape is in place by `withdrawShapeBy` of the move, each finger a little after the one before, ring / little curl more)
      const wdF = wdR > 0 ? smooth((wdR - o.withdrawStagger * f / 4) / (wdBack ? o.withdrawShapeByRet : o.withdrawShapeBy)) : 0
      const rwd = wdF > 0 ? (1 - act[f]) * wdF : 0
      fistW[f] = rwd * (f === 0 ? o.withdrawFistThumb : o.withdrawFist)
      if (rwd > 0) hx += rwd * (f === 0 ? m * 0.14 * S : 0.35 * o.restSpread * (restX - hx))
      const hy = mcp[1] + cy * reach + idle[f][1] - dw * dragV[1] - rw * (o.restCurl * rE + 0.5 * o.restCurl * rF) - rwd * o.withdrawCurl * (f === 0 ? 0.3 : 1 + o.withdrawCurlTilt * (f - 1) / 3)
      // (over the other hand, the idle fingers stay up with the wrist)
      const hz = o.hoverHeight * (f === 0 ? THUMB_HOVER_Z : 1) * (1 - o.sympathetic * 0.5 * nb) + over * o.overLift - overP * o.overIdleDrop * FINGER_LY[2] * S * Math.sin(o.overPitch) + idle[f][2] - dw * dragV[2] + rw * (0.6 * o.restRise * rE + o.restFarRise * rF) + (dzW - rwd * o.withdrawDroop) * (1 - act[f])

      // blend hover -> (prepared over the next key) -> previous key -> next key
      // (a function of the finger's own time `tt`: the free finger averages a few taps around t, see below)
      const sample = (tt: number, out: number[]) => {
      fingerState(ft, tt, o, fs)
      let tx = hx, ty = hy
      const i = fs.i
      const jn = fs.j < ft.on.length
      const vLift = jn ? 1 + hm * o.varLift * ft.vr[3 * fs.j + 1] : 1
      // Round 20: between two strikes the hover / prepare heights shrink with the time and articulation available
      const ls = i >= 0 && fs.j < ft.on.length ? ft.lift[i] : 1
      const hoverCut = ls < 1 ? (1 - ls) * Math.max(0, o.hoverHeight * (f === 0 ? THUMB_HOVER_Z : 1) * (1 - o.sympathetic * 0.5 * nb) - ft.top[fs.j] - o.liftHover) : 0
      let tz = hz - hoverCut
      const prepBase = (o.liftPrepare + ls * (o.prepareHeight * o.hoverHeight - o.liftPrepare)) * vLift
      // Repetition walk: between strikes the finger rests curled in toward the palm, just above the key.
      if (fs.j < ft.on.length && ft.rep[fs.j] && i >= 0 && ft.rep[i]) {
        tx = ft.x[fs.j]
        ty = ft.y[fs.j] - o.repeatCurl
        tz = ft.top[fs.j] + (o.liftWalkMin + (0.14 - o.liftWalkMin) * ft.lift[i]) * vLift
      }
      if (fs.pNext > 0 && fs.j < ft.on.length) {
        const j = fs.j
        // (a finger crossing over the thumb waits curled and arched over it, not stretched out)
        const xo = ft.xover[j] === 1
        tx += fs.pNext * (ft.x[j] - tx)
        ty += fs.pNext * (ft.y[j] - (xo ? o.crossCurl : 0) - ty)
        tz += fs.pNext * (ft.top[j] + (xo ? o.crossArc : prepBase * clamp(1 + o.humanize * (o.dynLift * ft.dyn[j] + o.dynAccent * ft.acc[j]), 0.3, 2.5)) - tz)
      }
      if (i >= 0 && fs.aPrev > 0) {
        // Sideways the finger lets go of the old key much faster than it lifts, so it isn't dragged along — unless
        // it comes straight back to the same key (repetitions), where it stays over it.
        const back = fs.j < ft.on.length && ft.x[fs.j] === ft.x[i] && ft.on[fs.j] - ft.off[i] < o.prepare
        const before = tx
        tx += (back ? 1 : fs.aPrev * fs.aPrev * fs.aPrev) * (ft.x[i] - tx)
        // Once released, the pull back toward the old key is also capped to the finger's sideways slack (eased in
        // as it lifts, so there is no jump at the release).
        if (!back && tt > ft.off[i]) {
          const lim = Math.max(Math.abs(before - hx), TIP_SLACK[f] * S * o.lateralSlack)
          tx += (1 - fs.aPrev) * (clamp(tx, hx - lim, hx + lim) - tx)
        }
        ty += fs.aPrev * (ft.y[i] - ty)
        // (after the release the finger rises as fast as it lets go sideways, so it lifts before it sweeps across)
        tz += (tt > ft.off[i] ? Math.min(fs.aPrev, (back ? 1 : fs.aPrev * fs.aPrev * fs.aPrev) + 0.5 * fs.aPrev) : fs.aPrev) * (ft.top[i] - tz)
        tz -= ft.dip[i] * fs.dPrev
        if (ft.rep[i]) ty -= o.repeatScratch * smooth((tt - ft.on[i]) / Math.max(0.02, ft.off[i] - ft.on[i])) * fs.aPrev
      }
      let d = fs.dPrev
      if (fs.aNext > 0 && fs.j < ft.on.length) {
        const j = fs.j
        tx += fs.aNext * (ft.x[j] - tx)
        ty += fs.aNext * (ft.y[j] - ty)
        tz += fs.aNext * (ft.top[j] - tz)
        d = fs.dPrev * (1 - fs.aNext)
      }
      const holding = i >= 0 && tt <= ft.off[i]
      // (a finger not holding a key rides up with the hand through a snap's wind-up instead of hanging from it)
      if (!holding) tz += snapRise + stacRise + gRise
      // Round 27: staccato rebound: the key throws the finger up, one overshoot above the hover height that settles back (critically damped)
      if (!holding && i >= 0 && ft.swR[i] > 0 && o.stacRebound > 0) {
        const tau = (tt - ft.off[i]) / o.stacReboundT
        if (tau > 0 && tau < 12) tz += o.stacRebound * ft.swR[i] * ft.swA[i] * tau * Math.exp(1 - tau) * (1 - fs.pNext) * (1 - fs.aNext)
      }
      // release follow-through: a damped rebound above the lift path (not once the next note's glide / descent starts)
      if (!holding && i >= 0 && hm > 0 && ft.rb[i] > 0) {
        const tau = tt - ft.off[i]
        tz += hm * ft.rb[i] * Math.exp(-tau / o.reboundDecay) * Math.sin(2 * Math.PI * o.reboundHz * tau) * (1 - fs.pNext) * (1 - fs.aNext)
      }
      out[0] = tx; out[1] = ty; out[2] = tz; out[3] = holding ? 1 : 0; out[4] = d
      }
      sample(t, S0)
      // Round 22 (humanize): temporal smoothing of the free fingers' targets. A 5-tap triangular kernel around t (centre
      // shifted back a little: the fingers follow rather than lead), weighted by (1 - activity)^2, so the strike (activity 1)
      // is exactly the unsmoothed target, and a finger on a key stays put.
      const wsm = o.loose * hm * (1 - act[f]) * (1 - act[f])
      if (wsm > 1e-4 && o.looseStep > 0) {
        let sx = 0, sy2 = 0, sz = 0
        for (let k = -2; k <= 2; k++) {
          const w = 3 - Math.abs(k)
          sample(t + (k - o.looseLag) * o.looseStep, S1)
          sx += w * S1[0]; sy2 += w * S1[1]; sz += w * S1[2]
        }
        S0[0] += wsm * (sx / 9 - S0[0]); S0[1] += wsm * (sy2 / 9 - S0[1]); S0[2] += wsm * (sz / 9 - S0[2])
      }
      const tx = S0[0], ty = S0[1], tz = S0[2], holding = S0[3] === 1, d = S0[4]
      mcps.push(mcp)
      tgt.push([tx, ty, tz])
      hov.push(hx)
      holdingArr.push(holding)
      press.push(d)
    }
  }

  // Yaw: the hand turns toward where its pressing (non-thumb) fingers are pulled sideways, so the idle fingers
  // turn with it (weighted by activity, so it eases in / out), plus a held ulnar tilt through repetition runs.
  // Then, within wrist ROM, the yaw is searched so the pressing fingers need the least MCP abduction beyond their
  // ROM: a stretch the fingers can't make alone is taken by the wrist where the wrist can.
  targets()
  {
    let sw = 0
    let sa = 0
    for (let f = 1; f < 5; f++) {
      if (actY[f] <= 0) continue
      const L = FINGER_LY[f] * S + o.reachRatio * TOTAL_LEN[f] * S
      sa += actY[f] * -Math.atan2(tgt[f][0] - hov[f], L)
      sw += actY[f]
    }
    // Wrist deviation is measured against the forearm: ulnar (toward the pinky) = -m * (yaw - forearm angle).
    let fore: number
    // (inside a repetition run the hand holds still: only the fingers move)
    const wantF = sw > 0 ? (1 - rp.env) * o.yawAmount * (sa / Math.max(sw, 1)) : 0
    if (o.armModel > 0) {
      armOff = armElbowOffset(o, m, S, wx, wy, wz, lean)
      fore = foreOf(armOff)
      // Round 34: the elbow swings toward the hand's own direction (within its range), turning the forearm about the wrist
      if (o.armAlign > 0) {
        const x = wantF + m * o.armNeutralDev - fore
        const d = o.armAlign * clamp(x > o.armBand ? x - o.armBand : x < -o.armBand ? x + o.armBand : 0, -o.armSwing, o.armSwing)
        const h = Math.hypot(armOff[0], armOff[1])
        fore += d
        armOff = [h * Math.sin(fore), -h * Math.cos(fore), armOff[2]]
      }
      foreG = fore
    } else fore = Math.atan2(m * o.elbowOutward - o.elbowSwing * wx, 1)
    // Round 34: with the arm model the hand's yaw plan can follow the forearm's direction at the neutral deviation (+ the finger-driven part)
    const want = wantF + (o.armModel > 0 ? o.armYaw * (fore - m * o.armNeutralDev) : 0)
    // Round 34: the elbow can swing `armSwing` either way, so the yaw the solve may choose is that much wider than the wrist's own range;
    // what the wrist cannot take (and `armAlign` of the rest of the deviation from neutral) is handed to the elbow after the solve (see the forearm output)
    const sw0 = o.armModel > 0 ? o.armSwing * o.armWiden : 0
    const uLo = -WRIST_RADIAL * o.romScale - sw0
    const uHi = WRIST_ULNAR * o.romScale + sw0
    const u0 = clamp(-m * (want - fore) + tilt + swayYaw + m * o.devTravel * trav * (1 - rp.env), uLo, uHi)
    const setYaw = (u: number) => {
      const yaw = fore - m * u
      cy = Math.cos(yaw)
      sy = Math.sin(yaw)
      targets()
    }
    // ROM correction: turn the wrist by the activity-weighted mean of what the pressing fingers lack in MCP
    // abduction (signed; ulnar + when they point too far toward the pinky), driving that residual to zero.
    // Round 22: when a step makes the residual WORSE (|r| grew) the next step is divided by the secant estimate of its
    // steepness (and a third step is taken); converging cases are exactly the old two gain-1 steps.
    // A fast leap makes the residual steep (slope -3 and beyond), where gain-1 steps overshoot and flip the wrist between
    // its limits from one frame to the next (a ~30 deg yaw glitch = a one-frame fingertip jump of ~7 cm, ~0.5 % of the
    // tip frames in the etudes). `yawNewton` 0 = the old two gain-1 steps.
    let u = u0
    setYaw(u)
    // Round 23: the wrist deviation (and the forearm roll) is SOLVED, not just corrected: the (yaw, roll) minimising the pressing
    // fingers' MCP abduction beyond `abdSoft` of their range (squared, weighted by activity), within the wrist / forearm range,
    // with a weak pull back to what the planner proposed (so with no excess nothing moves, and the cost is smooth in t).
    // The pressing targets are fixed in the world, only the knuckles move with the hand, so each evaluation is a few trig calls.
    if ((o.devSolve > 0 || o.rollSolve > 0 || o.wristLead > 0) && sw > 0) {
      const roll0 = roll
      const rLo = Math.max(roll0 - o.rollSolve, -FOREARM_ROT * o.romScale)
      const rHi = Math.min(roll0 + o.rollSolve, FOREARM_ROT * o.romScale)
      const press: number[] = []
      for (let f = 1; f < 5; f++) if (actY[f] > 0) press.push(f)
      const thumbSlack = TIP_SLACK[0] * S * o.lateralSlack
      const tolHalf = [0, 0, 0, 0, 0]
      for (const f of press) tolHalf[f] = (isBlackAt(tgt[f][0], tgt[f][1]) ? BLACK_KEY_WIDTH : WHITE_KEY_WIDTH) / 2
      const cost = (uu: number, rr: number, dxl: number) => {
        const yaw = fore - m * uu
        const cyv = Math.cos(yaw), syv = Math.sin(yaw)
        const crv = Math.cos(rr), srv = Math.sin(rr)
        const fw = Math.atan2(-m * syv, cyv)
        let c = 0
        for (const f of press) {
          const lx = m * S * FINGER_LAT[f], ly = S * FINGER_LY[f], lz = S * FINGER_LZ[f]
          const x1 = lx * crv + lz * srv
          const z1 = -lx * srv + lz * crv
          const y1 = ly * cp - z1 * sp
          const mx = wx + dxl + x1 * cyv - y1 * syv
          const my = wy + x1 * syv + y1 * cyv
          const rel = Math.atan2(m * (tgt[f][0] - mx), tgt[f][1] - my) - fw
          const e = Math.max(0, rel - abdC[f] * o.abdAboutMc - MCP_ABD[f][1] * o.romScale * o.abdSoft) + Math.max(0, -MCP_ABD[f][0] * o.romScale * o.abdSoft - (rel - abdC[f] * o.abdAboutMc))
          // The excess is counted as the sideways miss it causes (reach x angle) in key half-widths, so a narrow black key weighs more
          // than a white one and the wrist balances the fingers' misses instead of piling them on one finger. (Huber: a finger heading
          // for a key far beyond its range pulls with a bounded force instead of dragging the hand along.)
          const mi = (Math.hypot(tgt[f][0] - mx, tgt[f][1] - my) * e) / tolHalf[f]
          c += actY[f] * actY[f] * (mi < 1 ? mi * mi : 2 * mi - 1 + 0.3 * (mi - 1) * (mi - 1))
        }
        // (the thumb's tip may sit this far sideways from its resting spot; beyond it the CMC would be over-stretched)
        if (act[0] > 0 && o.thumbLeadWeight > 0) {
          const lx = m * S * TIP_LAT[0]
          const x1 = lx * crv
          const rx = wx + dxl + x1 * cyv - (THUMB_MCP[1] * S * cp) * syv
          const ry = wy + x1 * syv + (THUMB_MCP[1] * S * cp) * cyv
          const lat = ((tgt[0][0] - rx) * cyv + (tgt[0][1] - ry) * syv) * m
          const e = Math.max(0, Math.abs(lat) - thumbSlack) / (0.9 * S)
          c += o.thumbLeadWeight * act[0] * e * e
        }
        return c + o.devSolveHold * (uu - u0) ** 2 + o.rollSolveHold * (rr - roll0) ** 2 + o.wristLeadHold * dxl * dxl
      }
      const gold = (f1d: (x: number) => number, a: number, b: number) => {
        const g = 0.6180339887
        let x1 = b - g * (b - a), x2 = a + g * (b - a)
        let v1 = f1d(x1), v2 = f1d(x2)
        for (let it = 0; it < 16; it++) {
          if (v1 < v2) { b = x2; x2 = x1; v2 = v1; x1 = b - g * (b - a); v1 = f1d(x1) }
          else { a = x1; x1 = x2; v1 = v2; x2 = a + g * (b - a); v2 = f1d(x2) }
        }
        return 0.5 * (a + b)
      }
      let us = u0
      let rs = roll0
      let ds = 0
      for (let pass = 0; pass < 2; pass++) {
        if (o.devSolve > 0) us = gold((x) => cost(x, rs, ds), uLo, uHi)
        if (o.rollSolve > 0) rs = gold((x) => cost(us, x, ds), rLo, rHi)
        if (o.wristLead > 0) ds = gold((x) => cost(us, rs, x), -o.wristLead, o.wristLead)
      }
      u = us
      roll = rs
      if (flowCap) {
        // build-time probe: the devSolve cost over the whole deviation range at this strike (roll / lateral offset as solved)
        flowCap.grid = new Float64Array(FLOW_GRID)
        flowCap.uLo = uLo
        flowCap.uHi = uHi
        for (let i = 0; i < FLOW_GRID; i++) flowCap.grid[i] = cost(uLo + ((uHi - uLo) * i) / (FLOW_GRID - 1), rs, ds)
      }
      cr = Math.cos(roll)
      sr = Math.sin(roll)
      wx += ds
      setYaw(u)
    }
    // Round 28: inside a run the hand shape (wrist deviation + forearm roll) is one value per hand-position group, changing only around the shift.
    if (o.flow > 0 && o.flowShape > 0 && k >= 0 && k < n - 1 && h.flowSeg[k]) {
      if (flowCap) { flowCap.u = u; flowCap.roll = roll }
      else {
        const a = h.flowA[k], b = h.flowB[k]
        const w = smooth((t - h.knotT[a]) / o.flowRamp) * smooth((h.knotT[b] - t) / o.flowRamp)
        // (a group that cannot hold one shape keeps the per-strike solve: its target is the solved value itself)
        const uu = Number.isNaN(h.flowU[k]) ? u : h.flowU[k], rr = Number.isNaN(h.flowRoll[k]) ? roll : h.flowRoll[k]
        if (w > 0) {
          let U = uu, R = rr
          if (h.flowG[k] !== h.flowG[k + 1]) {
            const gap = h.knotT[k + 1] - h.knotT[k]
            const wd = Math.max(1e-6, o.flowShift * gap)
            const q = smooth((t - (0.5 * (h.knotT[k] + h.knotT[k + 1]) - 0.5 * wd)) / wd)
            U = uu + q * ((Number.isNaN(h.flowU[k + 1]) ? u : h.flowU[k + 1]) - uu)
            R = rr + q * ((Number.isNaN(h.flowRoll[k + 1]) ? roll : h.flowRoll[k + 1]) - rr)
          }
          u = clamp(u + o.flowShape * w * (U - u), uLo, uHi)
          roll = clamp(roll + o.flowRollShare * o.flowShape * w * (R - roll), -FOREARM_ROT * o.romScale, FOREARM_ROT * o.romScale)
          cr = Math.cos(roll)
          sr = Math.sin(roll)
          setYaw(u)
        }
      }
    }
    let uPrev = 0
    let rPrev = 0
    let rho = 1
    let diverged = false
    const legacy = o.devSolve > 0 ? 0 : 1 // (the solve above replaces the two correction steps)
    for (let it = 0; it < (diverged ? 3 : 2) * legacy; it++) {
      const fwd = Math.atan2(-m * sy, cy)
      let need = 0
      let w = 0
      for (let f = 1; f < 5; f++) {
        if (act[f] <= 0) continue
        const rel = Math.atan2(m * (tgt[f][0] - mcps[f][0]), tgt[f][1] - mcps[f][1]) - fwd
        need += act[f] * (Math.max(0, rel - MCP_ABD[f][1] * o.romScale) - Math.max(0, -MCP_ABD[f][0] * o.romScale - rel))
        w += act[f]
      }
      if (need === 0) break
      const r = (1 - rp.env) * need / Math.max(1, w)
      if (o.yawNewton > 0 && it > 0 && u !== uPrev) {
        if (Math.abs(r) > Math.abs(rPrev)) diverged = true
        if (diverged) rho = clamp(-(r - rPrev) / (u - uPrev), 1, 12)
      }
      uPrev = u
      rPrev = r
      u = clamp(u + r / rho, uLo, uHi)
      setYaw(u)
    }
    // Crossings bend the wrist on top (after the ROM correction, which would otherwise undo them: the crossing
    // finger reaching over the thumb reads as MCP over-abduction).
    const cross = crossingDeviation(h, t)
    if (cross !== 0) {
      // A finger crossing over turns the hand about the thumb (which holds its key), not about the wrist.
      const pivot = toWorld(THUMB_MCP[0], THUMB_MCP[1], THUMB_MCP[2])
      const yaw = fore - m * clamp(u + cross, uLo, uHi)
      cy = Math.cos(yaw)
      sy = Math.sin(yaw)
      if (cross < 0) {
        const moved = toWorld(THUMB_MCP[0], THUMB_MCP[1], THUMB_MCP[2])
        wx += pivot[0] - moved[0]
        wy += pivot[1] - moved[1]
      }
      targets()
    }
  }

  // Reach: a pressing finger whose key is beyond its straightened length (the thumb measured from its CMC, which
  // swings below) pulls the hand in toward the keys and down — never sideways, so the other fingers keep their keys.
  {
    let fwd = 0
    let down = 0
    const cmc0 = toWorld(THUMB_CMC[0], THUMB_CMC[1], THUMB_CMC[2])
    for (let f = 0; f < 5; f++) {
      const aR = preAct[f] > act[f] ? preAct[f] : act[f]
      if (aR <= 0) continue
      const base = f === 0 ? cmc0 : mcps[f]
      const len = 0.97 * (f === 0 ? THUMB_REACH : CHAIN_LEN[f]) * S
      const v = [tgt[f][0] - base[0], tgt[f][1] - base[1], tgt[f][2] - base[2]]
      const d = Math.hypot(v[0], v[1], v[2])
      if (d <= len) continue
      const k = aR * (1 - len / d)
      fwd = Math.max(fwd, k * v[1])
      down = Math.min(down, k * v[2])
    }
    // (no further in than leaves every pressing finger room to curl onto its key)
    for (let f = 1; f < 5 && fwd > 0; f++) {
      if (act[f] < 0.5 && o.smoothness <= 0) continue
      const capF = Math.max(0, tgt[f][1] - mcps[f][1] - 0.25 * BONES[f].reduce((a, c) => a + c, 0) * S)
      // (Round 40: the cap fades in over act 0.4..0.5 instead of switching at 0.5: that switch was a step in the wrist)
      if (o.smoothness > 0) fwd += smooth((act[f] - 0.4) / 0.1) * (Math.min(fwd, capF) - fwd)
      else fwd = Math.min(fwd, capF)
    }
    if (fwd > 0 || down < 0) {
      wy += fwd
      // (not over the other hand, where dropping would put the palm onto it)
      wz += (1 - over) * Math.max(down, -0.15)
      targets()
    }
  }

  // Fan: idle fingers carry along nearby pressing fingers' remaining sideways offset (kernel-weighted, so it
  // fades smoothly with activity), then neighbouring non-thumb tips keep their order with a minimum gap — a
  // pressing middle finger never slides under the idle ring / little fingers.
  const tx = tgt.map((v) => v[0])
  for (let f = 1; f < 5; f++) {
    if (act[f] >= 1) continue
    let num = 0
    let den = 0.05
    for (let g = 1; g < 5; g++) {
      if (g === f || act[g] <= 0) continue
      const k = act[g] * Math.exp(-0.7 * (Math.abs(f - g) - 1))
      num += k * (tgt[g][0] - hov[g])
      den += k
    }
    tx[f] += (1 - act[f]) * (1 - rp.env) * o.fanFollow * (num / den)
  }
  // Order by direction: seen from above, each non-thumb finger (MCP -> tip) must point at least as far toward the
  // pinky side as its thumb-side neighbour. Idle fingers are turned to satisfy it (keeping their reach), weighted
  // by idleness so it stays continuous; pressing fingers stay on their keys.
  const ty = tgt.map((v) => v[1])
  const dirOf = (f: number) => Math.atan2(m * (tx[f] - mcps[f][0]), ty[f] - mcps[f][1])
  // (off inside repetition runs: there the fingers take turns on one key, staggered in depth, not side by side)
  const aimAt = (f: number, phi: number) => {
    const w = (1 - act[f]) * (1 - rp.env)
    const r = Math.hypot(tx[f] - mcps[f][0], ty[f] - mcps[f][1])
    tx[f] += w * (mcps[f][0] + m * r * Math.sin(phi) - tx[f])
    ty[f] += w * (mcps[f][1] + r * Math.cos(phi) - ty[f])
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let f = 2; f < 5; f++) {
      const need = dirOf(f - 1) + o.fanMargin
      if (dirOf(f) < need) aimAt(f, need)
    }
    for (let f = 3; f >= 1; f--) {
      const need = dirOf(f + 1) - o.fanMargin
      if (dirOf(f) > need) aimAt(f, need)
    }
  }

  // MCP sideways ROM: every non-thumb finger's direction (relative to the hand's forward axis) is clamped; a
  // pressing finger that would need more falls short of its key rather than taking an impossible shape.
  const fwd = Math.atan2(-m * sy, cy)
  for (let f = 1; f < 5; f++) {
    const rel = dirOf(f) - fwd
    const cm = abdC[f] * o.abdAboutMc
    const lim = clamp(rel, cm - MCP_ABD[f][0] * o.romScale, cm + MCP_ABD[f][1] * o.romScale)
    if (lim !== rel) {
      const r = Math.hypot(tx[f] - mcps[f][0], ty[f] - mcps[f][1])
      tx[f] = mcps[f][0] + m * r * Math.sin(fwd + lim)
      ty[f] = mcps[f][1] + r * Math.cos(fwd + lim)
    }
  }

  // (in front of the keyboard's edge there are no keys to clear)
  BLACK_FLOOR = o.blackFloor
  const tf = wdQ > 0 ? tipFloorFree : tipFloor
  // world -> hand-local (unscaled, R-hand frame): the inverse of toWorld
  const toLocal = (p: Vec3): [number, number, number] => {
    const d0 = p[0] - wx, d1 = p[1] - wy, d2 = p[2] - wz
    const x1 = d0 * cy + d1 * sy
    const y1 = -d0 * sy + d1 * cy
    const ly = y1 * cp + d2 * sp
    const z1 = -y1 * sp + d2 * cp
    return [(x1 * cr - z1 * sr) / (m * S), ly / S, (x1 * sr + z1 * cr) / S]
  }

  // Ring / little metacarpals flex at their CMC joints (the palm cups) when their finger's key is beyond its
  // straightened reach from the resting knuckle; weighted by activity, the ring following the little part-way.
  const cup = CUP_REST.slice()
  for (let f = 3; f < 5; f++) {
    if (act[f] <= 0) continue
    const d = Math.hypot(tx[f] - mcps[f][0], ty[f] - mcps[f][1], tgt[f][2] - mcps[f][2])
    const e = clamp((d - 0.97 * CHAIN_LEN[f] * S) / (0.5 * METACARPAL[f] * S), 0, 1)
    cup[f] = Math.max(cup[f], CUP_REST[f] + act[f] * e * (CUP_MAX[f] - CUP_REST[f]))
  }
  cup[3] = Math.max(cup[3], CUP_REST[3] + 0.4 * (cup[4] - CUP_REST[4]))
  for (let f = 3; f < 5; f++) {
    const hd = metacarpalHead(f, cup[f])
    mcps[f] = toWorld(hd[0], hd[1], hd[2])
  }

  // palm normal (hand frame +z in world), for the fingers' hinge planes
  const o0 = toWorld(0, 0, 0)
  const o1 = toWorld(0, 0, 1)
  const nl = Math.hypot(o1[0] - o0[0], o1[1] - o0[1], o1[2] - o0[2])
  const palmN: Vec3 = [(o1[0] - o0[0]) / nl, (o1[1] - o0[1]) / nl, (o1[2] - o0[2]) / nl]

  // Round 39: the loose-fist chain of finger f as joint angles: hinge plane along the finger's own metacarpal (no sideways fan),
  // fixed MCP / PIP flexion. `dir` / `up` / angles are returned too so the playing chain can be blended toward it joint by joint.
  const fistDirOf = (f: number): Vec3 => {
    const az = abdC[f] * o.abdAboutMc
    const r0 = FLEX_ROLL[f]
    const w0 = toWorld(0, 0, 0)
    const w1 = toWorld(Math.sin(az) * Math.cos(r0), Math.cos(az), -Math.sin(az) * Math.sin(r0))
    const l = Math.hypot(w1[0] - w0[0], w1[1] - w0[1], w1[2] - w0[2]) || 1
    return [(w1[0] - w0[0]) / l, (w1[1] - w0[1]) / l, (w1[2] - w0[2]) / l]
  }
  const fingers: Vec3[][] = []
  let thumbRef: Vec3[] | undefined
  {
    // Thumb: CMC flexion / abduction (+ coupled pronation) and the MCP / IP bend, solved in the hand frame.
    // (a thumb not holding a key keeps clear of the key surfaces it passes over)
    if (!holdingArr[0]) tgt[0][2] = Math.max(tgt[0][2], tf(tx[0], ty[0], fingerRadius(0, 1, S)))
    const tsW = o.thumbSide
    const tsR = o.thumbIpRest * (Math.PI / 180)
    let th = solveThumb(toLocal([tx[0], ty[0], tgt[0][2]]), o.romScale, tsW, tsR)
    let chain = thumbChain(th).map((v) => toWorld(v[0], v[1], v[2]))
    // The thumb lies on its side, nearly flat: if its (thicker) MCP / IP / bones would sink below the surface the pad
    // rests on,
    // lift the target by that much and solve again, so the side of the thumb lies on the key instead of in it.
    // (each joint and points along the bone after it, with its capsule radius, against the key surfaces at rest —
    // the neighbouring keys don't go down with the pressed one; t along the drawn chain)
    const pad = tgt[0][2] - fingerRadius(0, 1, S)
    const surface = (pad > 0.5 * BLACK_KEY_THICKNESS ? BLACK_KEY_THICKNESS : 0) * (wdQ > 0 ? clamp(tf(tx[0], ty[0], fingerRadius(0, 1, S)) / fingerRadius(0, 1, S), 0, 1) : 1)
    let sink = 0
    for (let k = 1; k < 3; k++) {
      for (const h of k === 2 ? [0, 0.5, 0.75] : [0, 0.5]) {
        const z = chain[k][2] + h * (chain[k + 1][2] - chain[k][2])
        sink = Math.max(sink, surface - (z - fingerRadius(0, (k + h) / 3, S)))
      }
    }
    if (sink > 0) {
      th = solveThumb(toLocal([tx[0], ty[0], tgt[0][2] + sink]), o.romScale, tsW, tsR)
      chain = thumbChain(th).map((v) => toWorld(v[0], v[1], v[2]))
    }
    // Round 39: withdrawn, the thumb's joint angles blend toward the loose fist (the tip IK cannot reach across the palm: CMC limits)
    if (fistW[0] > 0) {
      const k = fistW[0]
      th = { ...th, flex: th.flex + k * (FIST_THUMB.flex - th.flex), abd: th.abd + k * (FIST_THUMB.abd - th.abd), b: th.b + k * (FIST_THUMB.b - th.b) }
      chain = thumbChain(th).map((v) => toWorld(v[0], v[1], v[2]))
    }
    fingers.push(chain)
    if (tsW > 0) {
      const w0 = toWorld(0, 0, 0)
      thumbRef = thumbRefs(th).map((v) => {
        const q = toWorld(v[0], v[1], v[2])
        const l = Math.hypot(q[0] - w0[0], q[1] - w0[1], q[2] - w0[2]) || 1
        return [(q[0] - w0[0]) / l, (q[1] - w0[1]) / l, (q[2] - w0[2]) / l] as Vec3
      })
    }
  }
  for (let f = 1; f < 5; f++) {
    const mcp = mcps[f]
    const ty_ = ty[f]
    // (a finger not holding a key keeps clear of the key surfaces it passes over — e.g. sweeping sideways across a
    // black key after letting go of a white one; at its own black key the floor is exactly its press height)
    const tz = holdingArr[f] ? tgt[f][2] : Math.max(tgt[f][2], tf(tx[f], ty[f], fingerRadius(f, 1, S)))
    const tx_ = tx[f]

    // planar IK from the MCP
    const bones = BONES[f]
    // The fingers bend as hinges in the plane through the target that contains the palm normal (so PIP / DIP never
    // bend sideways relative to the hand).
    // (the ring / little MCP axes roll dorsally, so those fingers flex toward the thumb side: tilt the hinge plane's
    // normal toward the little finger by the axis roll)
    let up = palmN
    if (FLEX_ROLL[f] !== 0) {
      const u0 = toWorld(0, 0, 0)
      const u1 = toWorld(Math.sin(FLEX_ROLL[f]), 0, Math.cos(FLEX_ROLL[f]))
      const ul = Math.hypot(u1[0] - u0[0], u1[1] - u0[1], u1[2] - u0[2])
      up = [(u1[0] - u0[0]) / ul, (u1[1] - u0[1]) / ul, (u1[2] - u0[2]) / ul]
    }
    const vx = tx_ - mcp[0], vy = ty_ - mcp[1], vz = tz - mcp[2]
    const dz = vx * up[0] + vy * up[1] + vz * up[2]
    let dx = vx - up[0] * dz
    let dy = vy - up[1] * dz
    let dw = vz - up[2] * dz
    let hd = Math.hypot(dx, dy, dw)
    if (hd < 1e-6) { dx = 0; dy = 1; dw = 0; hd = 1 } else { dx /= hd; dy /= hd; dw /= hd }
    // Round 22: a finger that is not pressing stays curved. Its approach / leave target is pulled in toward the knuckle
    // (same height) until the chain needs at least `curlFloor` of PIP flexion, instead of reaching out straight over the
    // next key; the pull fades with activity ((1 - act)^2), so the strike lands exactly on the key. Only where the landing
    // point is clear of the key surfaces.
    const curlFl = o.curlFloor
    if (curlFl > 0 && dz < -0.05 * S) {
      const rCap = chainDist(f, bones, Math.min(curlFl, PIP_MAX[f] * o.romScale)) * S
      // (a hanging finger: the pull fades out as the tip nears straight below the knuckle, where it would otherwise snap)
      const wc = smooth((1 - clamp(act[f], 0, 1)) / 0.55) * (wdQ > 0 ? smooth((rCap - Math.abs(dz)) / (0.3 * rCap)) : 1)
      if (wc > 1e-4 && Math.hypot(hd, dz) > rCap && Math.abs(dz) < rCap) {
        const r1 = Math.hypot(hd, dz)
        const rn = r1 - wc * (r1 - rCap)
        const hn = Math.sqrt(Math.max(0, rn * rn - dz * dz))
        // (the whole in-plane vector shrinks: keeping its sideways part swung the finger out sideways, past the little
        // finger's MCP hyperextension limit)
        const kap = hn / hd
        let nx = dx * hd * kap, ny = dy * hd * kap, nz = dw * hd * kap
        // (the hinge basis stays orthonormal: the direction is made perpendicular to `up` again, at the length hn)
        const pu = nx * up[0] + ny * up[1] + nz * up[2]
        nx -= pu * up[0]; ny -= pu * up[1]; nz -= pu * up[2]
        const hl = Math.hypot(nx, ny, nz)
        if (hl > 1e-6) {
          nx *= hn / hl; ny *= hn / hl; nz *= hn / hl
          const lx = mcp[0] + nx + up[0] * dz, ly = mcp[1] + ny + up[1] * dz, lz = mcp[2] + nz + up[2] * dz
          if (lz >= tf(lx, ly, fingerRadius(f, 1, S)) - 1e-3) { dx = nx / hn; dy = ny / hn; dw = nz / hn; hd = hn }
        }
      }
    }
    const r = Math.hypot(hd, dz)
    const ang = Math.atan2(dz, hd)
    let b = solveBend(f, bones, PIP_MAX[f] * o.romScale, r / S)
    // A finger not pressing flexes like a relaxed hand: more at the knuckle, less at the tip joints (it then lands a
    // little further out at the same height — the chain-longer-than-r branch below keeps the tip's height).
    const wRel = o.relaxFlex * (1 - clamp(act[f], 0, 1)) ** 2
    if (wRel > 0 && b > 0 && dz < -0.05 * S) {
      // (it must not land on a key surface it would sink into: the clearance floor is checked at the landing point)
      const landsOk = (fwd: number) => {
        const F = fwd * S
        return mcp[2] + dw * F + up[2] * dz >= tf(mcp[0] + dx * F + up[0] * dz, mcp[1] + dy * F + up[1] * dz, fingerRadius(f, 1, S)) - 1e-3
      }
      b += wRel * (relaxedBend(f, bones, dz / S, b, cup[f], o.relaxRatio, o.relaxSigma, o.relaxReach, landsOk, RELAX_PIP + hm * o.varCurl * curlVar[f], Math.min(b, curlFl)) - b)
    }
    // angle offset of the tip direction for this bend
    let ex = 0, ez = 0, a = 0
    for (let q = 0; q < bones.length; q++) {
      if (q > 0) a -= jointBend(f, q, b)
      ex += bones[q] * Math.cos(a)
      ez += bones[q] * Math.sin(a)
    }
    // MCP flexion / hyperextension relative to the palm plane (the fingers' plane already measures from it).
    // A key closer than the fully curled finger: keep the tip at the key's height and let it land a little further out,
    // instead of pointing the over-long chain at the key and through it.
    const lc = Math.hypot(ex, ez) * S
    const free = lc > r + 1e-6
      ? Math.asin(clamp(dz / lc, -1, 1)) - Math.atan2(ez, ex)
      : ang - Math.atan2(ez, ex)
    // (limits are relative to the finger's own metacarpal, which a cupped ring / little CMC tilts palmar by cup[f])
    const a1 = clamp(free, -MCP_FLEX[f] * o.romScale - cup[f], MCP_HYPER[f] * o.romScale - cup[f] - HYPER_MARGIN)
    if (a1 !== free) {
      // MCP at its limit: re-pick the bend for that fixed base angle so the tip gets as close to the target as it
      // can (otherwise the bend chosen for the unclamped base swings the tip past it, e.g. into the keys). Height
      // counts more than reach: a finger that can't extend further at the knuckle straightens and lands a little
      // further out rather than dropping into the keys.
      const tipErr = (bb: number) => {
        let px = 0, pz = 0, aa = a1
        for (let q = 0; q < bones.length; q++) {
          if (q > 0) aa -= jointBend(f, q, bb)
          px += bones[q] * S * Math.cos(aa)
          pz += bones[q] * S * Math.sin(aa)
        }
        return Math.hypot(px - hd, 4 * (pz - dz))
      }
      let lo = 0, hi = PIP_MAX[f] * o.romScale
      for (let it = 0; it < 24; it++) {
        const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3
        if (tipErr(m1) < tipErr(m2)) hi = m2
        else lo = m1
      }
      b = 0.5 * (lo + hi)
    }
    const chain: Vec3[] = [mcp]
    let px = 0, pz = 0
    // Round 39: withdrawn, the joint angles blend toward the loose fist (direction along the metacarpal, fixed MCP / PIP flexion) instead of
    // following the tip IK, whose hinge-plane yaw is ill-conditioned for a hanging finger (it fanned ring / little ~45 deg)
    let aU = a1
    const fw = fistW[f]
    if (fw > 0) {
      const fd = fistDirOf(f)
      let nx = dx + fw * (fd[0] - dx), ny = dy + fw * (fd[1] - dy), nz = dw + fw * (fd[2] - dw)
      const nl = Math.hypot(nx, ny, nz) || 1
      dx = nx / nl; dy = ny / nl; dw = nz / nl
      aU = a1 + fw * (-FIST_MCP[f] - cup[f] - a1)
      b = b + fw * (Math.min(FIST_PIP[f], PIP_MAX[f] * o.romScale) - b)
    }
    a = aU
    for (let q = 0; q < bones.length; q++) {
      if (q > 0) a -= jointBend(f, q, b)
      px += bones[q] * S * Math.cos(a)
      pz += bones[q] * S * Math.sin(a)
      chain.push([mcp[0] + dx * px + up[0] * pz, mcp[1] + dy * px + up[1] * pz, mcp[2] + dw * px + up[2] * pz])
    }
    fingers.push(chain)
    // (lab-only debug hook for scripts/diag-one.ts; drop when porting)
  }

  // forearm
  let elbow: Vec3
  if (armOff) {
    // Round 34: the elbow takes what the wrist cannot (with `armWiden` the solve may pick a deviation beyond the wrist's range), swinging the forearm
    // about the wrist: the hand is unchanged, the reading against the forearm (measure.ts) stays inside the wrist's range.
    const yawF = Math.atan2(sy, cy)
    let uT = m * (foreG - yawF)
    uT = Math.atan2(Math.sin(uT), Math.cos(uT))
    const wLo = -WRIST_RADIAL * o.romScale, wHi = WRIST_ULNAR * o.romScale
    const eU = clamp(0, uT - wHi, uT - wLo)
    const hh = Math.hypot(armOff[0], armOff[1])
    const ph = foreG - m * eU
    elbow = [wx + hh * Math.sin(ph), wy - hh * Math.cos(ph), wz + armOff[2]]
  } else {
    const lat = m * o.elbowOutward - o.elbowSwing * wx
    const dl = Math.hypot(lat, 1, 0.15)
    const fl = o.forearmLength * S
    elbow = [wx + (lat / dl) * fl, wy - (1 / dl) * fl, wz - (0.15 / dl) * fl]
  }

  const bases = [THUMB_CMC, ...[1, 2, 3, 4].map(metacarpalBase)].map((v) => toWorld(v[0], v[1], v[2]))
  return thumbRef ? { hand: h.hand, elbow, wrist: [wx, wy, wz], bases, fingers, press, thumbRef } : { hand: h.hand, elbow, wrist: [wx, wy, wz], bases, fingers, press }
}

// Re-export for convenience of callers that build plans by hand.
export type { Finger }
