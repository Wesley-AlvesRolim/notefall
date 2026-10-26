import * as THREE from 'three'
import { Caustics } from './caustics'
import { CrystalLight } from './crystalLight'
import { LightsPattern } from './lightsPattern'
import { makeHammeredNormal } from './hammeredNormal'
import { makeCrystalNormal } from './crystalNormal'
import { makeScalesMaps, makeVolcanicMaps, SilkTexture, type RealisticMaps } from './realistic'
import type { NoteBump, NotePattern, NoteSurface } from './noteLook'

function constantTexture(r: number, g: number, b: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.needsUpdate = true
  return t
}

/** One light-pattern generator behind a common interface. */
type PatternGen = {
  texture: THREE.Texture
  /** speed / density / sharpness are the look settings; each generator maps them onto its own params */
  update(dt: number, speed: number, density: number, sharpness: number): void
  dispose(): void
}

function makePattern(renderer: THREE.WebGLRenderer, source: NotePattern): PatternGen {
  if (source === 'crystal') {
    const g = new CrystalLight(renderer, 512)
    return {
      texture: g.texture,
      // the generator's own time runs at textureSpeed / 0.8; the look presets were tuned with speed = 0.75·that
      update: (dt, speed, density) => {
        g.setParams({ textureSpeed: speed / 0.75, textureDensity: density, textureTransparency: 0 })
        g.update(dt)
      },
      dispose: () => g.dispose(),
    }
  }
  if (source === 'lights') {
    const g = new LightsPattern(renderer, 512)
    return {
      texture: g.texture,
      // look speed 0.5625 = generator speed 1; look density 0.33 = generator density 1
      update: (dt, speed, density) => {
        g.setParams({ speed: speed / 0.5625, density: density / 0.33, transparency: 0 })
        g.update(dt)
      },
      dispose: () => g.dispose(),
    }
  }
  // ~1 texel per screen pixel on the large water tiles
  const g = new Caustics(renderer, 1024)
  return {
    texture: g.texture,
    update: (dt, speed, density, sharpness) => {
      g.setParams({ density, speed, height: sharpness, minOpacity: 1 })
      g.update(dt)
    },
    dispose: () => g.dispose(),
  }
}

/**
 * GPU resources of the lit note looks, owned by FallingNotes. Everything is created on first use and kept, so
 * switching back is free and a flat look never allocates any of it:
 *  - the animated light patterns (one per source; only the active one is ticked),
 *  - the baked bump maps and realistic map sets (each baked once — a bake is a few fullscreen passes, not cheap on
 *    slow GPUs),
 *  - the animated silk note texture.
 */
export class NoteLookResources {
  /** Flat tangent normal: bound while the look has no bump. */
  readonly flatNormal = constantTexture(128, 128, 255)
  /** Mid-grey stand-in for the pattern while no lit look is active. */
  readonly greyPattern = constantTexture(90, 90, 90)
  readonly white = constantTexture(255, 255, 255)
  readonly black = constantTexture(0, 0, 0)
  private patterns = new Map<NotePattern, PatternGen>()
  private bumps = new Map<Exclude<NoteBump, 'none'>, THREE.Texture>()
  private surfaces = new Map<string, RealisticMaps>()
  private silk: SilkTexture | null = null

  constructor(private renderer: THREE.WebGLRenderer) {}

  private gen(source: NotePattern): PatternGen {
    let g = this.patterns.get(source)
    if (!g) {
      g = makePattern(this.renderer, source)
      this.patterns.set(source, g)
    }
    return g
  }

  /** The light pattern of `source`, created on the first call. */
  pattern(source: NotePattern): THREE.Texture {
    return this.gen(source).texture
  }

  /** Advance the `source` pattern by `dt` seconds (sharpness = water wave height, density = cells per tile). */
  tickPattern(source: NotePattern, dt: number, speed: number, density: number, sharpness: number): void {
    this.patterns.get(source)?.update(dt, speed, density, sharpness)
  }

  bump(kind: NoteBump): THREE.Texture {
    if (kind === 'none') return this.flatNormal
    let t = this.bumps.get(kind)
    if (!t) {
      t =
        kind === 'crystal'
          ? makeCrystalNormal(this.renderer, { size: 1024, seed: 3, scale: 9, depth: 0.5 })
          : makeHammeredNormal(
              this.renderer,
              kind === 'cast'
                ? { size: 512, seed: 7, dentScale: 3, dentDepth: 0.3, grain: 1 }
                : { size: 512, seed: 1, dentScale: 16, dentDepth: 0.5, grain: 0.3 },
            )
      this.bumps.set(kind, t)
    }
    return t
  }

  /** Realistic map set; `cells` (0 = the set's default) and `irregularity` are bake parameters (cache key). */
  surface(set: NoteSurface, cells: number, irregularity: number): RealisticMaps {
    const c = Math.max(0, Math.round(cells))
    const key = `${set}:${c}:${irregularity}`
    let m = this.surfaces.get(key)
    if (!m) {
      // more cells per tile (a longer repeat at the same cell size) needs proportionally more texels
      const base = set === 'scales' ? 1024 : 512
      const def = set === 'scales' ? 7 : 6
      const size = Math.min(2048, base * 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(c, def) / def))))
      const opts = { size, seed: 1, cells: c, irregularity }
      m = set === 'scales' ? makeScalesMaps(this.renderer, opts) : makeVolcanicMaps(this.renderer, opts)
      this.surfaces.set(key, m)
    }
    return m
  }

  /** The silk note texture, created on the first call. */
  silkTexture(): THREE.Texture {
    if (!this.silk) this.silk = new SilkTexture(this.renderer, 512)
    return this.silk.texture
  }

  tickSilk(dt: number): void {
    this.silk?.update(dt)
  }

  dispose(): void {
    for (const g of this.patterns.values()) g.dispose()
    this.patterns.clear()
    for (const t of this.bumps.values()) t.dispose()
    this.bumps.clear()
    for (const m of this.surfaces.values()) m.dispose()
    this.surfaces.clear()
    this.silk?.dispose()
    this.silk = null
    this.flatNormal.dispose()
    this.greyPattern.dispose()
    this.white.dispose()
    this.black.dispose()
  }
}
