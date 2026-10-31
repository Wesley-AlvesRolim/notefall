import * as THREE from 'three'
import { audioEngine } from '../audio/engine'
import { buildSpeedMap } from '../midi/speedMap'
import { noteVisualBounds, NOTE_PLANE_Z } from '../notes/positions'
import { useStore } from '../store'
import { getR3FState } from './exportBridge'
import { getResolvedSettings } from './automatedSettings'
import { noteById } from '../midi/noteHands'

// Called every frame while the selection card is up: build the speed map only when it changes.
let speedMapKey: unknown = null
let speedMapValue: ReturnType<typeof buildSpeedMap> | null = null
function speedMapFor(points: Parameters<typeof buildSpeedMap>[0]) {
  if (points !== speedMapKey || !speedMapValue) {
    speedMapKey = points
    speedMapValue = buildSpeedMap(points)
  }
  return speedMapValue
}

export type ScreenRect = { left: number; top: number; right: number; bottom: number }

/**
 * Client-space bounding box of the selected notes' on-screen rectangles, projected with the live
 * R3F camera (lens shift included), or null when nothing selected is visible. Cheap enough to
 * call every frame while the selection card is up.
 */
export function selectionScreenRect(): ScreenRect | null {
  const r3f = getR3FState()
  const { song, selection } = useStore.getState()
  if (!r3f || !song || selection.size === 0) return null
  // The geometry as drawn this frame (keyframes can animate fall time, width, keyboard position).
  const settings = getResolvedSettings()
  const canvas = r3f.gl.domElement.getBoundingClientRect()
  if (canvas.width === 0 || canvas.height === 0) return null
  const ctx = { speedMap: speedMapFor(settings.midiSpeedAutomation), midiOffset: settings.midiOffsetSec }
  const tl = audioEngine.currentSongTime()
  const cam = r3f.camera
  cam.updateMatrixWorld()
  const out: ScreenRect = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
  const vec = new THREE.Vector3()
  for (const id of selection) {
    const n = noteById(song, id)
    if (!n) continue
    const b = noteVisualBounds(n, tl, settings, ctx)
    if (!b) continue
    for (const x of [b.xMin, b.xMax]) {
      for (const y of [b.yMin, b.yMax]) {
        vec.set(x, y, NOTE_PLANE_Z).project(cam)
        const sx = canvas.left + ((vec.x + 1) / 2) * canvas.width
        const sy = canvas.top + ((1 - vec.y) / 2) * canvas.height
        if (sx < out.left) out.left = sx
        if (sx > out.right) out.right = sx
        if (sy < out.top) out.top = sy
        if (sy > out.bottom) out.bottom = sy
      }
    }
  }
  return out.left === Infinity ? null : out
}
