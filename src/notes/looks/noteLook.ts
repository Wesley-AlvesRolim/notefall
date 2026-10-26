import { WHITE_KEY_WIDTH } from '../../keyboard/layout'
import type { Settings } from '../../store'

/**
 * Note looks — the lit / reflective note surface.
 *
 * `flat` is the plain tinted note (the Emissive gain drives Bloom). `reflective` lights the note's SDF bevel and a
 * baked bump map with a key + fill light and reflects an animated light pattern off it: the pattern is anchored on
 * screen (`notePatternLock` = 0) or carried with the note (1), and its lookup point is bent by the surface normal so
 * the bevel and every bump facet each pick up a different part of it. Highlights go toward white (sheen) instead of
 * being multiplied by the tint. Optional layers on top: a soft cloudy volume, white-hot highlight cores, frosted
 * glass, an outline ring outside the body and a thick-glass rim band inside it. With `noteMergeRadius` > 0 (round
 * shape) touching notes fuse like liquid (looks/merge.ts).
 *
 * `sprite` is the flat "2D" look: a soft-lit rounded slab (rounded-over rim normal → key + fill light + gloss, floored
 * at the ambient level, then a tone ramp that saturates at the tint and beyond it only whitens), optionally hollowed
 * into a ring, with an embossed silk texture, a moving shimmer, an outline band and a glow halo (drawn by a second
 * pass). It uses the shared key light / fill intensity / ambient / corner radius; its own keys are `note2d*`. See `noteShader.ts` for the formula.
 */
export type NoteMaterial = 'flat' | 'reflective' | 'realistic' | 'sprite'
/** 2D outline band: whole = straddles the edge over the rim, half = lies outside the body. */
export type Note2dOutline = 'off' | 'whole' | 'half'
/** round = rounded box + SDF bevel; gem = octagon with cut-gem crown facets; angled = a hollow steep frame. */
export type NoteShape = 'round' | 'gem' | 'angled'
/** Animated light pattern: water caustics, crystal shards, or bokeh lights. */
export type NotePattern = 'water' | 'crystal' | 'lights'
/** Baked normal map: none = smooth, hammered = planished cups, cast = few shallow dents + grain, crystal = cut facets. */
export type NoteBump = 'none' | 'hammered' | 'cast' | 'crystal'
/** Realistic material map set (albedo / metal-smoothness / normal / emissive): marble scales or volcanic glass. */
export type NoteSurface = 'scales' | 'volcanic'

/** Every setting a look preset writes. */
export const NOTE_LOOK_KEYS = [
  'noteMaterial',
  'noteShape',
  'noteCornerRadius',
  'noteBevelWidth',
  'noteBevelDepth',
  'noteBevelProfile',
  'noteBevelSoftness',
  'noteBevelReflect',
  'noteRimShade',
  'noteRimFade',
  'noteLightIntensity',
  'noteLightAzimuth',
  'noteLightElevation',
  'noteFillIntensity',
  'noteAmbient',
  'noteReflectivity',
  'noteSheen',
  'noteTransparency',
  'noteSaturation',
  'noteSurface',
  'noteAlbedoGain',
  'noteSpecular',
  'noteEmission',
  'noteSurfaceContrast',
  'noteSurfaceCells',
  'noteSurfaceIrregularity',
  'notePattern',
  'notePatternDrift',
  'noteSilk',
  'noteSilkScale',
  'noteSilkSpeed',
  'notePatternScale',
  'notePatternDensity',
  'notePatternSharpness',
  'notePatternContrast',
  'notePatternBrightness',
  'notePatternSpeed',
  'notePatternLock',
  'notePatternDistortion',
  'notePatternAmount',
  'notePatternKnee',
  'notePatternKneeSoftness',
  'notePatternRibbon',
  'noteBump',
  'noteBumpScale',
  'noteBumpDepth',
  'noteBumpSoftness',
  'noteBumpMelt',
  'noteBumpScatter',
  'noteFacetEdges',
  'noteCloud',
  'noteCloudScale',
  'noteCloudSoftness',
  'noteCloudClear',
  'noteHighlight',
  'noteHighlightThreshold',
  'noteHighlightSoftness',
  'noteFrost',
  'noteFrostGrain',
  'noteFrostScale',
  'noteFrostVeil',
  'noteOutlineWidth',
  'noteOutlineBrightness',
  'noteOutlineColor',
  'noteOutlineBlend',
  'noteOutlineReflect',
  'noteRimBand',
  'noteRimBandBrightness',
  'noteRimBandColor',
  'noteRimBandBlend',
  'noteRimGap',
  'noteRimGapDark',
  'noteMergeRadius',
  'noteMergeColorSpread',
  'noteMergeSameKey',
  'noteMergeLegatoClose',
  'noteMergeCrease',
  'note2dRimWidth',
  'note2dRimTilt',
  'note2dHollow',
  'note2dFillAzimuth',
  'note2dFillElevation',
  'note2dGloss',
  'note2dGlossPower',
  'note2dExposure',
  'note2dWhiten',
  'note2dWhitenStart',
  'note2dKeySplit',
  'note2dShimmer',
  'note2dShimmerGain',
  'note2dShimmerScale',
  'note2dShimmerSpeed',
  'note2dShimmerLock',
  'note2dTexture',
  'note2dTextureScale',
  'note2dTextureStretch',
  'note2dTextureContrast',
  'note2dTextureGain',
  'note2dTextureRelief',
  'note2dTextureSpeed',
  'note2dTextureLock',
  'note2dOutline',
  'note2dOutlineWidth',
  'note2dOutlineTint',
  'note2dOutlineShade',
  'note2dOutlineGrey',
  'note2dOutlineBrightness',
  'note2dOutlineRelief',
  'note2dGlow',
  'note2dGlowRadius',
  'note2dGlowTail',
  'note2dGlowWhiten',
  'note2dGlowBoost',
] as const satisfies readonly (keyof Settings)[]

export type NoteLookKey = (typeof NOTE_LOOK_KEYS)[number]
export type NoteLook = Pick<Settings, NoteLookKey>

/**
 * Look lengths. The preset table below writes them in WHITE-KEY WIDTHS so the numbers stay readable; `toSettings`
 * converts them to world units.
 */
const LENGTH_KEYS = [
  'noteCornerRadius',
  'noteBevelWidth',
  'notePatternScale',
  'notePatternDrift',
  'noteSilkScale',
  'noteBumpScale',
  'noteCloudScale',
  'noteFrostScale',
  'noteOutlineWidth',
  'noteRimBand',
  'noteRimGap',
  'noteMergeRadius',
  'note2dRimWidth',
  'note2dHollow',
  'note2dShimmerScale',
  'note2dTextureScale',
  'note2dOutlineWidth',
  'note2dGlowRadius',
] as const satisfies readonly NoteLookKey[]

const BASE_LOOK: NoteLook = {
  noteMaterial: 'flat',
  noteShape: 'round',
  noteCornerRadius: 0.2,
  noteBevelWidth: 0.16,
  noteBevelDepth: 1.6,
  noteBevelProfile: 0,
  noteBevelSoftness: 0.5,
  noteBevelReflect: 1,
  noteRimShade: 0,
  noteRimFade: 1,
  noteLightIntensity: 0.5,
  noteLightAzimuth: -20,
  noteLightElevation: 35,
  noteFillIntensity: 0.1,
  noteAmbient: 0,
  noteReflectivity: 1,
  noteSheen: 0.3,
  noteTransparency: 0,
  noteSaturation: 1,
  noteSurface: 'scales',
  noteAlbedoGain: 1.6,
  noteSpecular: 0.5,
  noteEmission: 0,
  noteSurfaceContrast: 1,
  noteSurfaceCells: 0,
  noteSurfaceIrregularity: 0,
  notePattern: 'water',
  notePatternDrift: 0,
  noteSilk: 0,
  noteSilkScale: 12,
  noteSilkSpeed: 1,
  notePatternScale: 28,
  notePatternDensity: 0.33,
  notePatternSharpness: 1,
  notePatternContrast: 1.25,
  notePatternBrightness: 0.25,
  notePatternSpeed: 0.56,
  notePatternLock: 0.5,
  notePatternDistortion: 0.12,
  notePatternAmount: 1,
  notePatternKnee: 0,
  notePatternKneeSoftness: 0.3,
  notePatternRibbon: 0,
  noteBump: 'hammered',
  noteBumpScale: 13,
  noteBumpDepth: 1,
  noteBumpSoftness: 0,
  noteBumpMelt: 0,
  noteBumpScatter: false,
  noteFacetEdges: 0,
  noteCloud: 0,
  noteCloudScale: 3,
  noteCloudSoftness: 0.6,
  noteCloudClear: 0,
  noteHighlight: 0,
  noteHighlightThreshold: 0.7,
  noteHighlightSoftness: 0.45,
  noteFrost: 0,
  noteFrostGrain: 0,
  noteFrostScale: 0.04,
  noteFrostVeil: 0,
  noteOutlineWidth: 0,
  noteOutlineBrightness: 1,
  noteOutlineColor: '#ffffff',
  noteOutlineBlend: 0.8,
  noteOutlineReflect: 1,
  noteRimBand: 0,
  noteRimBandBrightness: 1,
  noteRimBandColor: '#ffffff',
  noteRimBandBlend: 0,
  noteRimGap: 0.05,
  noteRimGapDark: 0.5,
  noteMergeRadius: 0,
  noteMergeColorSpread: 1,
  noteMergeSameKey: false,
  noteMergeLegatoClose: 0,
  noteMergeCrease: 0,
  note2dRimWidth: 0.17,
  note2dRimTilt: 62,
  note2dHollow: 0,
  note2dFillAzimuth: 140,
  note2dFillElevation: 48,
  note2dGloss: 0.12,
  note2dGlossPower: 24,
  note2dExposure: 1.65,
  note2dWhiten: 0.6,
  note2dWhitenStart: 0.66,
  note2dKeySplit: 0,
  note2dShimmer: 0,
  note2dShimmerGain: 1.15,
  note2dShimmerScale: 2.5,
  note2dShimmerSpeed: 0.5,
  note2dShimmerLock: 1,
  note2dTexture: false,
  note2dTextureScale: 1.6,
  note2dTextureStretch: 3,
  note2dTextureContrast: 0.55,
  note2dTextureGain: 1.25,
  note2dTextureRelief: 0.5,
  note2dTextureSpeed: 0.12,
  note2dTextureLock: 1,
  note2dOutline: 'off',
  note2dOutlineWidth: 0.12,
  note2dOutlineTint: 1,
  note2dOutlineShade: 0.5,
  note2dOutlineGrey: 0.3,
  note2dOutlineBrightness: 1,
  note2dOutlineRelief: 0,
  note2dGlow: 0,
  note2dGlowRadius: 0.22,
  note2dGlowTail: 0.35,
  note2dGlowWhiten: 0.15,
  note2dGlowBoost: 1,
}

function toSettings(o: Partial<NoteLook>): NoteLook {
  const look = { ...BASE_LOOK, ...o }
  for (const k of LENGTH_KEYS) look[k] *= WHITE_KEY_WIDTH
  return look
}

// Bumped / mapped looks read their maps in the per-key song-space frame: in the note-local frame every note reads the
// same narrow vertical strip of the map, so chords repeat one interior and a near-vertical crease in that strip shows
// as a line down the middle of every note.
const SCATTER = { noteBumpScatter: true } as const

// Smooth water surface: the rounded rim bends the pattern into bright streaks.
const SMOOTH = { noteBump: 'none', notePatternLock: 0.85, noteLightIntensity: 0.4, noteFillIntensity: 0.15 } as const
// Gem-cut facet bump; strong bend so every facet picks its own part of the pattern.
const ICE = {
  noteMaterial: 'reflective', noteBump: 'crystal', noteCornerRadius: 0.23, noteBevelWidth: 0.26, noteBevelDepth: 1.8,
  noteBumpScale: 9, noteBumpDepth: 1.6, notePatternLock: 0.85, notePatternDistortion: 0.5, notePatternDensity: 0.15,
  notePatternSharpness: 1.25, notePatternContrast: 1.9, notePatternBrightness: 0.2, noteSheen: 0.5,
  noteLightIntensity: 0.55, noteFillIntensity: 0, noteSaturation: 1.25, ...SCATTER,
} as const

// Base of the 2D looks (the shared light keys take the 2D defaults).
const SPRITE = {
  noteMaterial: 'sprite', noteCornerRadius: 0.29, noteLightIntensity: 0.7, noteLightAzimuth: -20,
  noteLightElevation: 36, noteFillIntensity: 0.3, noteAmbient: 0.3,
} as const

export const NOTE_LOOK_PRESETS = {
  // the app default: a soft-lit 2D slab
  plain: toSettings({ ...SPRITE, noteCornerRadius: 0.27, noteLightElevation: 46, note2dKeySplit: 0.1 }),
  ripple: toSettings({
    ...SMOOTH, noteMaterial: 'reflective', noteBevelWidth: 0.2, noteBevelDepth: 2.4, notePatternDistortion: 0.15,
    notePatternScale: 32, notePatternSharpness: 0.8, notePatternContrast: 1.7, notePatternBrightness: 0.45,
    noteSheen: 0.45, noteRimShade: 0.15, noteSaturation: 1.15,
  }),
  pool: toSettings({
    ...SMOOTH, noteMaterial: 'reflective', noteBevelWidth: 0.25, noteBevelDepth: 2.5, notePatternDistortion: 0.2,
    notePatternScale: 60, notePatternSharpness: 2.5, notePatternContrast: 2, notePatternBrightness: 0.45,
    noteSheen: 0.6, notePatternSpeed: 0.53, noteRimFade: 0.5, noteRimShade: 0.3, notePatternKnee: 0.8,
  }),
  // the smooth surface + pattern-driven transparency + a faint outline
  lens: toSettings({
    ...SMOOTH, noteMaterial: 'reflective', noteCornerRadius: 0.21, noteBevelWidth: 0.35, noteBevelDepth: 0.5,
    notePatternDistortion: 0.15, notePatternScale: 40, notePatternDensity: 0.5, notePatternSharpness: 0.9,
    notePatternContrast: 2, notePatternBrightness: 0.5, noteSheen: 0.45, noteTransparency: 0.6,
    noteLightIntensity: 0.7, noteFillIntensity: 0, noteSaturation: 1.35, notePatternSpeed: 0.4,
    noteOutlineWidth: 0.05, noteOutlineBrightness: 0.4, noteOutlineBlend: 0.9,
  }),
  beaten: toSettings({ noteMaterial: 'reflective', ...SCATTER }),
  cast: toSettings({
    noteMaterial: 'reflective', noteBump: 'cast', noteBumpScale: 8, noteBumpDepth: 0.8, notePatternDistortion: 0.08,
    notePatternContrast: 1.6, notePatternBrightness: 0.2, noteLightIntensity: 0.45, noteFillIntensity: 0.2, ...SCATTER,
  }),
  ice: toSettings(ICE),
  iceRim: toSettings({
    ...ICE, noteOutlineWidth: 0.05, noteOutlineBrightness: 0.8, noteOutlineBlend: 1, noteOutlineColor: '#e6e6e6',
  }),
  // cut gem: octagon outline + crown facets, shard light pattern fully carried by the note
  jewel: toSettings({
    noteMaterial: 'reflective', noteShape: 'gem', noteCornerRadius: 0.3, noteBevelWidth: 0.26, noteBevelDepth: 0.78,
    noteBump: 'none', notePattern: 'crystal', notePatternScale: 19, notePatternDensity: 0.5, notePatternSpeed: 0.6,
    notePatternLock: 1, notePatternDistortion: 0.3, notePatternContrast: 1.8, notePatternBrightness: 0.1,
    noteSheen: 0.8, noteLightIntensity: 0.7, noteFillIntensity: 0.12,
  }),
  // hollow angled frame lit straight on, bokeh lights scrolling sideways
  frame: toSettings({
    noteMaterial: 'reflective', noteShape: 'angled', noteCornerRadius: 0.33, noteBevelWidth: 0.02 / WHITE_KEY_WIDTH, noteBevelDepth: 3.1,
    noteBump: 'none', notePattern: 'lights', notePatternDrift: 1.3, notePatternScale: 55, notePatternLock: 0.5,
    notePatternDistortion: 0.1, notePatternContrast: 1.1, notePatternBrightness: 0.2, noteSheen: 0.4,
    noteLightIntensity: 0.8, noteLightElevation: 90, noteFillIntensity: 0,
  }),
  // realistic map sets under the lights pattern × the silk note texture; at note scale the "scales" map reads as
  // veined grey marble with glowing seams, hence the name
  marble: toSettings({
    noteMaterial: 'realistic', noteSurface: 'scales', noteAlbedoGain: 2.2, noteSpecular: 0.5, noteEmission: 0.15,
    noteBevelWidth: 0.2, noteBevelDepth: 1.6, noteBumpScale: 30, noteBumpDepth: 0.5, notePattern: 'lights',
    notePatternDrift: 1.3, notePatternScale: 25, notePatternLock: 0.5, notePatternDistortion: 0.1, noteSilk: 0.5,
    noteSilkScale: 6, noteSilkSpeed: 0.5, notePatternContrast: 1.2, notePatternBrightness: 0.25, noteSheen: 0.1,
    noteLightIntensity: 0.5, noteFillIntensity: 0.15, noteAmbient: 0.3, notePatternAmount: 0.3,
    noteSurfaceContrast: 2.5, noteSaturation: 1.25, noteRimShade: 0.3, ...SCATTER,
  }),
  volcanic: toSettings({
    noteMaterial: 'realistic', noteSurface: 'volcanic', noteAlbedoGain: 3.5, noteSpecular: 0.1, noteEmission: 0,
    noteBevelWidth: 0.2, noteBevelDepth: 1.4, noteBumpScale: 22.4, noteBumpDepth: 0.35, noteBumpSoftness: 0.8,
    notePattern: 'lights', notePatternDrift: 1.3, notePatternScale: 25, notePatternLock: 0.5,
    notePatternDistortion: 0.1, noteSilk: 0.3, noteSilkScale: 6, noteSilkSpeed: 0.4, notePatternContrast: 1.2,
    notePatternBrightness: 0.3, noteSheen: 0, noteLightIntensity: 0.5, noteFillIntensity: 0.15, noteAmbient: 0.1,
    noteSurfaceContrast: 2, notePatternAmount: 0.2, noteSaturation: 1.3, noteRimShade: 0.35, noteSurfaceCells: 12,
    noteSurfaceIrregularity: 1, ...SCATTER,
  }),
  // rounded translucent slabs: thin pale-cyan glass rim, big soft crystalline blobs inside, frosted
  seaGlass: toSettings({
    noteMaterial: 'reflective', noteCornerRadius: 0.35, noteBevelWidth: 0.15, noteBevelDepth: 1.5, noteBump: 'crystal',
    noteBumpScale: 24, noteBumpDepth: 1.4, noteBumpSoftness: 0.3, notePatternLock: 0.85, notePatternDistortion: 0.5,
    notePatternScale: 45, notePatternSharpness: 0.6, notePatternAmount: 0.8, notePatternContrast: 2.2,
    notePatternBrightness: 0.05, noteSheen: 0.45, noteTransparency: 0.5, noteSaturation: 0.9,
    noteLightIntensity: 0.8, noteRimBand: 0.02, noteRimBandBlend: 1, noteRimGap: 0.024,
    noteRimBandBrightness: 0.9, noteCloudClear: 0.6, noteCloud: 0.7, noteCloudScale: 1.3, noteCloudSoftness: 0.45,
    noteHighlight: 1.2, noteHighlightThreshold: 0.56, noteHighlightSoftness: 0.78, noteBumpMelt: 0.2,
    notePatternKnee: 1.2, notePatternKneeSoftness: 0.5, noteFrost: 0.25, noteFrostGrain: 0.5, noteFrostScale: 0.03,
    noteFrostVeil: 0.3, noteBumpScatter: true, noteFacetEdges: 5, noteMergeRadius: 0.2,
    // outline off (width 0); its values are kept for when it is switched on
    noteOutlineBrightness: 0.8, noteOutlineColor: '#e0fff8', noteOutlineBlend: 0.1, noteOutlineReflect: 0.5,
  }),
} satisfies Record<string, NoteLook>

export type NoteLookPreset = keyof typeof NOTE_LOOK_PRESETS
export const NOTE_LOOK_PRESET_NAMES = Object.keys(NOTE_LOOK_PRESETS) as NoteLookPreset[]

/** The preset the given settings currently match exactly (float tolerance), or null when edited. */
export function matchNoteLookPreset(s: NoteLook): NoteLookPreset | null {
  for (const name of NOTE_LOOK_PRESET_NAMES) {
    const p = NOTE_LOOK_PRESETS[name]
    const same = NOTE_LOOK_KEYS.every((k) => {
      const a = p[k]
      const b = s[k]
      return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : a === b
    })
    if (same) return name
  }
  return null
}

const LIGHT_KEYS = [
  'noteLightIntensity',
  'noteLightAzimuth',
  'noteLightElevation',
  'noteFillIntensity',
  'noteAmbient',
] as const satisfies readonly NoteLookKey[]
type MaterialFamily = 'none' | 'lit' | 'sprite'
const materialFamily = (m: NoteMaterial): MaterialFamily =>
  m === 'sprite' ? 'sprite' : m === 'reflective' || m === 'realistic' ? 'lit' : 'none'

/**
 * The 2D and the lit materials share the light keys but want very different values, so switching the Material
 * alone (not via a preset) brings in the new family's default lights (2D: `plain`, lit: the base reflective look);
 * a switch within a family keeps the current lights.
 */
export function lightsForMaterialSwitch(from: NoteMaterial, to: NoteMaterial): Partial<NoteLook> {
  const family = materialFamily(to)
  if (family === 'none' || family === materialFamily(from)) return {}
  const src = family === 'sprite' ? NOTE_LOOK_PRESETS.plain : NOTE_LOOK_PRESETS.beaten
  const out: Partial<NoteLook> = {}
  for (const k of LIGHT_KEYS) (out as Record<string, unknown>)[k] = src[k]
  return out
}
