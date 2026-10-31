import * as THREE from 'three'
import { isLinearTarget } from '../scene/linearTarget'
import { KEYBOARD_LAYOUT, KEY_COUNT, MIDI_MIN } from '../keyboard/layout'
import { pitchLabel, type Accidental, type PitchLabelFormat } from '../midi/noteName'

// Pitch-name labels shared by the falling notes and the keys: one atlas
// texture with a cell per key, and an instanced quad material that draws
// a cell per instance.
//
// The atlas is drawn synchronously with a system font (no web-font load),
// so the first exported frame already has its labels. Channels are masks,
// not colours: R = the glyph fill; G = a stepped distance ramp around it
// (1 at the glyph edge falling to 0 at OUTLINE_MAX_PX, 0 inside the glyph),
// so the shader can cut an outline of any width up to the maximum.

const COLS = 8
/** Cells after the 88 key names: finger numbers 1–5 (see `fingerGlyph`). */
const FINGER_CELLS = 5
const ROWS = Math.ceil((KEY_COUNT + FINGER_CELLS) / COLS)

/** Atlas cell of a finger number (1–5). */
export const fingerGlyph = (finger: number) => KEY_COUNT + finger - 1
const CELL_W = 160
const CELL_H = 64
const FONT_PX = 46
const OUTLINE_MAX_PX = 12
// Glyphs are drawn slightly condensed so two- and three-character names
// still read on the narrow black-key notes.
const CONDENSE = 0.82
/** Quad width / height: every quad covers its whole cell. */
export const LABEL_CELL_ASPECT = CELL_W / CELL_H
/** Width both outline sides add at full outline width, per cell height. */
export const LABEL_OUTLINE_ASPECT = (OUTLINE_MAX_PX * 2) / CELL_H

export interface LabelAtlas {
  texture: THREE.CanvasTexture
  /** Per key index: drawn text width (without outline) / cell height. */
  textAspect: Float32Array
}

const atlases = new Map<string, LabelAtlas>()

/** The atlas for one naming scheme, built on first use and kept. */
export function labelAtlas(format: PitchLabelFormat, accidental: Accidental): LabelAtlas {
  const id = `${format}/${accidental}`
  const cached = atlases.get(id)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = COLS * CELL_W
  canvas.height = ROWS * CELL_H
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.font = `700 ${FONT_PX}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  const textAspect = new Float32Array(KEY_COUNT + FINGER_CELLS)
  for (let i = 0; i < KEY_COUNT + FINGER_CELLS; i++) {
    const text = i < KEY_COUNT ? pitchLabel(MIDI_MIN + i, format, accidental) : String(i - KEY_COUNT + 1)
    const cx = (i % COLS) * CELL_W + CELL_W / 2
    const cy = Math.floor(i / COLS) * CELL_H + CELL_H / 2
    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(CONDENSE, 1)
    // widest (dimmest) ring first, each narrower ring brighter on top
    for (let px = OUTLINE_MAX_PX; px >= 1; px--) {
      ctx.lineWidth = px * 2
      ctx.strokeStyle = `rgb(0, ${Math.round((255 * (OUTLINE_MAX_PX - px + 1)) / OUTLINE_MAX_PX)}, 0)`
      ctx.strokeText(text, 0, 0)
    }
    ctx.fillStyle = '#ff0000'
    ctx.fillText(text, 0, 0)
    ctx.restore()
    textAspect[i] = (ctx.measureText(text).width * CONDENSE) / CELL_H
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.NoColorSpace
  texture.anisotropy = 4
  const atlas = { texture, textAspect }
  atlases.set(id, atlas)
  return atlas
}

/** Note-label glyph height at size 1 (world units). */
const NOTE_LABEL_HEIGHT = 0.22

/** Glyph height of a note label: the size, shrunk so the text and its
 *  outline fit in 95 % of the note width. */
export function noteLabelHeight(atlas: LabelAtlas, key: number, noteWidth: number, size: number, outline: number) {
  return Math.min(
    NOTE_LABEL_HEIGHT * Math.max(size, 0.05),
    (noteWidth * 0.95) / (atlas.textAspect[key] + Math.min(Math.max(outline, 0), 1) * LABEL_OUTLINE_ASPECT),
  )
}

/** Shortest note that still carries its label(s): `lines` labels stacked (pitch + finger = 2). With
 *  labels on, notes are drawn at least this long (display only; the sound is untouched). */
export function noteLabelMinLength(labelHeight: number, lines = 1) {
  return labelHeight * 1.15 * lines
}

/** What a note label shows: its pitch, its finger number (notes with one), or both stacked. */
export type NoteLabelContent = 'pitch' | 'finger' | 'both'

interface NoteLabelSettings {
  noteLabelsEnabled: boolean
  noteLabelContent: NoteLabelContent
  noteLabelFormat: PitchLabelFormat
  noteLabelAccidental: Accidental
  noteLabelSize: number
  noteLabelOutlineWidth: number
}

/** Minimum drawn note length for one key's labels (0 when labels are off). */
export function noteLabelMinLengthAt(s: NoteLabelSettings, widthScale: number, key: number) {
  if (!s.noteLabelsEnabled) return 0
  const atlas = labelAtlas(s.noteLabelFormat, s.noteLabelAccidental)
  const w = KEYBOARD_LAYOUT.keys[key].width * widthScale
  return noteLabelMinLength(
    noteLabelHeight(atlas, key, w, s.noteLabelSize, s.noteLabelOutlineWidth),
    s.noteLabelContent === 'both' ? 2 : 1,
  )
}

/** `noteLabelMinLengthAt` for every key, into `out`. */
export function noteLabelMinLengths(s: NoteLabelSettings, widthScale: number, out: Float32Array) {
  for (let i = 0; i < KEY_COUNT; i++) out[i] = noteLabelMinLengthAt(s, widthScale, i)
  return out
}

const LABEL_VERTEX = /* glsl */ `
  attribute float iGlyph;
  attribute float iAlpha;
  attribute vec3 iColor;
  uniform vec2 uGrid;
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vWorldY;
  void main() {
    vec2 cell = vec2(mod(iGlyph, uGrid.x), floor(iGlyph / uGrid.x));
    // canvas rows run top-down; the texture is flipped (v = 1 at the top)
    vUv = vec2((cell.x + uv.x) / uGrid.x, 1.0 - (cell.y + 1.0 - uv.y) / uGrid.y);
    vAlpha = iAlpha;
    vColor = iColor;
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorldY = world.y;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const LABEL_FRAGMENT = /* glsl */ `
  uniform sampler2D uAtlas;
  uniform float uOutline;      // outline width, 0..1 of OUTLINE_MAX_PX
  uniform vec3 uOutlineColor;  // sRGB
  uniform float uClipY;
  uniform float uLinearTarget;
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vWorldY;
  void main() {
    if (vWorldY < uClipY) discard;
    vec2 m = texture2D(uAtlas, vUv).rg;
    float cut = 1.0 - uOutline;
    float ring = uOutline > 0.0 ? smoothstep(cut - 0.06, cut + 0.06, m.g) : 0.0;
    float a = clamp(m.r + ring, 0.0, 1.0) * vAlpha;
    if (a < 0.003) discard;
    // fill colour over the ring colour (weighted mix of the two masks)
    vec3 rgb = (vColor * m.r + uOutlineColor * ring) / max(m.r + ring, 1e-4);
    if (uLinearTarget > 0.5) rgb = pow(rgb, vec3(2.2));
    gl_FragColor = vec4(rgb, a);
  }
`

/** Instanced label material. `iColor` is sRGB; `uClipY` hides fragments below it. */
export function createLabelMaterial(): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: null },
      uGrid: { value: new THREE.Vector2(COLS, ROWS) },
      uOutline: { value: 0 },
      uOutlineColor: { value: new THREE.Vector3(0, 0, 0) },
      uClipY: { value: -1e9 },
      uLinearTarget: { value: 0 },
    },
    vertexShader: LABEL_VERTEX,
    fragmentShader: LABEL_FRAGMENT,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  })
  return material
}

/** Instanced quad mesh for labels with its per-instance attribute arrays. */
export function createLabelMesh(maxInstances: number) {
  const geometry = new THREE.PlaneGeometry(1, 1)
  const glyphs = new Float32Array(maxInstances)
  const alphas = new Float32Array(maxInstances)
  const colors = new Float32Array(maxInstances * 3)
  const attrs = [
    new THREE.InstancedBufferAttribute(glyphs, 1),
    new THREE.InstancedBufferAttribute(alphas, 1),
    new THREE.InstancedBufferAttribute(colors, 3),
  ]
  for (const a of attrs) a.setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('iGlyph', attrs[0])
  geometry.setAttribute('iAlpha', attrs[1])
  geometry.setAttribute('iColor', attrs[2])
  const material = createLabelMaterial()
  const mesh = new THREE.InstancedMesh(geometry, material, maxInstances)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false
  mesh.raycast = () => {}
  mesh.count = 0
  mesh.onBeforeRender = (renderer) => {
    material.uniforms.uLinearTarget.value = isLinearTarget(renderer.getRenderTarget()) ? 1 : 0
  }
  return {
    mesh,
    material,
    glyphs,
    alphas,
    colors,
    /** Flag the attributes for upload after a frame's writes. */
    commit(count: number) {
      mesh.count = count
      mesh.instanceMatrix.needsUpdate = true
      for (const a of attrs) a.needsUpdate = true
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}

export type LabelMesh = ReturnType<typeof createLabelMesh>
