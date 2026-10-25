import * as THREE from 'three'
import { KEYBOARD_Y, NOTE_HIT_Y } from '../keyboard/layout'

// Hard cap on how far above the hit line the "visible top" is allowed
// to grow. Without it, steep look-up angles produce ray-plane misses
// (the top NDC ray runs past the horizon) or massive intersection
// distances that would spawn / persist huge counts of falling notes
// off-screen. The cap converts that into a steady ceiling.
export const MAX_LIVE_VISIBLE_ABOVE_HIT = 30

const _pos = new THREE.Vector3()
const _target = new THREE.Vector3()
const _view = new THREE.Vector3()
const _right = new THREE.Vector3()
const _camUp = new THREE.Vector3()
const _rayDir = new THREE.Vector3()
const _worldUp = new THREE.Vector3(0, 1, 0)

/**
 * Apply a view shift (fraction of the viewport height, + = up) as a
 * lens shift: the frustum window slides vertically while the camera
 * keeps its position and aim, so the picture moves on screen with no
 * extra perspective (the keyboard does not tilt to show its back).
 * Stored on `camera.view`, which `updateProjectionMatrix` honours, so
 * R3F resizes and the exporter's aspect change keep the shift.
 */
export function applyViewShift(camera: THREE.PerspectiveCamera, shiftY: number) {
  const current = camera.view?.offsetY ?? 0
  if (current === shiftY) return
  // fullHeight 1 makes offsetY a fraction of the view height; three.js
  // lowers the frustum top by offsetY · height, so + moves content up.
  camera.view =
    shiftY === 0
      ? null
      : {
          enabled: true,
          fullWidth: 1,
          fullHeight: 1,
          offsetX: 0,
          offsetY: shiftY,
          width: 1,
          height: 1,
        }
  camera.updateProjectionMatrix()
}

/**
 * Top / bottom edges of the shifted view in units of tan(fovV/2):
 * the unshifted view spans [-1, 1]; a shift of `s` screen heights moves
 * that window by -2s (content up = window down).
 */
export function viewTopScale(shiftY: number): number {
  return 1 - 2 * shiftY
}
export function viewBottomScale(shiftY: number): number {
  return 1 + 2 * shiftY
}

type ViewShiftInput = {
  keyboardScreenY: number
  cameraPos: readonly [number, number, number]
  cameraLookAt: readonly [number, number, number]
  cameraFov: number
}

// Unshifted NDC y of the world point (0, y, 0) for the given camera.
function ndcY(s: ViewShiftInput, y: number): number {
  _pos.set(s.cameraPos[0], s.cameraPos[1], s.cameraPos[2])
  _target.set(s.cameraLookAt[0], s.cameraLookAt[1], s.cameraLookAt[2])
  _view.copy(_target).sub(_pos)
  if (_view.lengthSq() < 1e-12) return 0
  _view.normalize()
  _right.crossVectors(_view, _worldUp)
  if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0)
  _right.normalize()
  _camUp.crossVectors(_right, _view).normalize()
  _rayDir.set(0, y, 0).sub(_pos)
  const depth = _rayDir.dot(_view)
  if (depth < 1e-6) return 0
  const tanHalfV = Math.tan((s.cameraFov * Math.PI) / 360)
  return _rayDir.dot(_camUp) / (depth * tanHalfV)
}

/**
 * View shift that puts the keyboard at `keyboardScreenY`: 0 = the
 * keyboard's front edge on the bottom of the view, 1 = its back edge
 * (the hit line) on the top, linear in between. Measured at the
 * keyboard's horizontal centre for the current camera.
 */
export function keyboardViewShift(s: ViewShiftInput): number {
  const atBottom = (-1 - ndcY(s, KEYBOARD_Y)) / 2
  const atTop = (1 - ndcY(s, NOTE_HIT_Y)) / 2
  return atBottom + (atTop - atBottom) * s.keyboardScreenY
}

/**
 * World-Y of the highest point the camera can see at depth `noteZ`.
 *
 * Computed by reconstructing the camera's view basis from settings
 * (pos / lookAt / FOV / view shift), forming the top-center NDC ray
 * (view + camUp · tan(fovV/2) · viewTopScale), and intersecting it with the plane
 * z = noteZ. Returns a hard cap (`hitY + MAX_LIVE_VISIBLE_ABOVE_HIT`)
 * when the ray runs past the horizon, so callers see a smooth ceiling
 * instead of a snap-shorter when the camera tilts steeply upward.
 *
 * Aspect is irrelevant — only the vertical FOV affects how far up the
 * top of the frustum reaches. Doesn't need the THREE camera object,
 * so it's safe to call during React render as well as useFrame.
 */
export function computeLiveVisibleTop(
  cameraPos: readonly [number, number, number],
  cameraLookAt: readonly [number, number, number],
  cameraFov: number,
  noteZ: number,
  hitY: number,
  viewShiftY = 0,
): number {
  const cap = hitY + MAX_LIVE_VISIBLE_ABOVE_HIT
  _pos.set(cameraPos[0], cameraPos[1], cameraPos[2])
  _target.set(cameraLookAt[0], cameraLookAt[1], cameraLookAt[2])
  _view.copy(_target).sub(_pos)
  if (_view.lengthSq() < 1e-12) return cap
  _view.normalize()
  _right.crossVectors(_view, _worldUp)
  if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0)
  _right.normalize()
  _camUp.crossVectors(_right, _view).normalize()
  const tanHalfV = Math.tan((cameraFov * Math.PI) / 360) * viewTopScale(viewShiftY)
  _rayDir.copy(_view).addScaledVector(_camUp, tanHalfV)
  if (Math.abs(_rayDir.z) > 1e-4) {
    const tHit = (noteZ - _pos.z) / _rayDir.z
    if (tHit > 0 && Number.isFinite(tHit)) {
      return Math.min(cap, _pos.y + tHit * _rayDir.y)
    }
  }
  return cap
}
