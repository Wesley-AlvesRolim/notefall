/**
 * LightsPattern — a seamlessly tiling, animated "bokeh lights" pattern (the `lights` note pattern): soft glowing discs
 * that drift, breathe and twinkle while still tiling perfectly. The note shader may also scroll it sideways.
 *
 * Technique: one full-screen fragment pass. Three layers of jittered cell grids (integer cells per tile, cell index
 * wrapped → periodic), one disc per occupied cell. Each disc has hash-seeded size, brightness and core sharpness; its
 * centre orbits a small Lissajous path, and its brightness / radius pulse, all with an integer number of cycles per
 * `T_PERIOD` so the time phase wraps seamlessly. Each layer also drifts by a whole number of tiles per period
 * (gentle parallax). Profile = soft-edged plateau + faint halo; discs combine with a screen blend
 * (1 − Π(1 − bᵢ·fᵢ)), so overlaps brighten without clipping hard; a faint wide halo per disc fills the gaps with
 * a dim haze. 3×3 neighbour cells per layer → 27 disc evaluations per texel.
 *
 * Params (setParams):
 *  - speed:        animation rate multiplier (1 = default gentle motion)
 *  - density:      disc density multiplier (cells per tile scale with it and disc size with 1/density). Quantised to
 *                  even integer cells per tile per layer.
 *  - transparency: optional. Output is rgb = T + (1 − T)·v, alpha = (1 − T) + T·v. Default 0 → rgb = pattern,
 *                  alpha = 1.
 */
import * as THREE from 'three'

/** Time period (seconds at speed 1) over which every animated phase wraps exactly. */
const T_PERIOD = 120

interface Layer {
  /** cells per tile at density 1 */
  cells: number
  /** disc radius range, in cell units */
  rMin: number
  rMax: number
  /** probability that a cell holds a disc */
  presence: number
  /** brightness range */
  bMin: number
  bMax: number
  /** centre jitter (± cell fraction) and orbit amplitude (cell units) */
  jitter: number
  orbit: number
  /** whole tiles drifted per T_PERIOD (x, y) */
  drift: [number, number]
}

const LAYERS: Layer[] = [
  // main field: nearly one disc per cell, small jitter → evenly packed
  { cells: 12, rMin: 0.4, rMax: 0.62, presence: 0.95, bMin: 0.6, bMax: 1.0, jitter: 0.27, orbit: 0.12, drift: [0, 1] },
  // a few large soft ones
  { cells: 6, rMin: 0.3, rMax: 0.4, presence: 0.2, bMin: 0.7, bMax: 1.0, jitter: 0.3, orbit: 0.1, drift: [1, 0] },
  // sparse small bright sparks in the gaps
  { cells: 14, rMin: 0.26, rMax: 0.36, presence: 0.22, bMin: 0.85, bMax: 1.0, jitter: 0.3, orbit: 0.15, drift: [-1, 1] },
]

/** Tuning. */
const TUNING = {
  /** overall brightness */
  gain: 1,
  /** output gamma (v^gamma) */
  gamma: 1,
  /** scales each disc's plateau (0 = pure soft falloff, 1 = crisp-edged discs) */
  sharpness: 0.5,
}

const frag = /* glsl */ `
precision highp float;
precision highp int;
uniform float uSize, uT, uGain, uGamma, uSharp, uTT;
uniform vec4 uLayerA[${LAYERS.length}]; // cells (integer), rMin, rMax, presence
uniform vec4 uLayerB[${LAYERS.length}]; // bMin, bMax, shift.xy (uv)
uniform vec2 uLayerC[${LAYERS.length}]; // jitter, orbit
layout(location = 0) out highp vec4 outColor;

const float TAU = 6.2831853;
uint mixHash(uvec3 v) {
  uint h = v.x * 0x8da6b343u ^ v.y * 0xd8163841u ^ v.z * 0xcb1ab31fu;
  h ^= h >> 16; h *= 0x7feb352du;
  h ^= h >> 15; h *= 0x846ca68bu;
  h ^= h >> 16;
  return h;
}
float rnd(uint h, uint salt) { return float(mixHash(uvec3(h, salt, 0x3c6ef372u)) & 0xffffffu) / 16777216.0; }
// sine with an integer number of cycles in [kLo, kHi] per T_PERIOD and a random phase
float wave(uint h, uint salt, float kLo, float kHi) {
  float k = floor(mix(kLo, kHi + 0.999, rnd(h, salt)));
  return sin(TAU * (fract(k * uT / ${T_PERIOD.toFixed(1)}) + rnd(h, salt + 1u)));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  float keep = 1.0; // Π(1 − bᵢ·fᵢ)
  for (int l = 0; l < ${LAYERS.length}; l++) {
    vec4 A = uLayerA[l];
    vec4 B = uLayerB[l];
    int n = int(A.x);
    vec2 q = fract(uv + B.zw) * A.x; // cell units
    ivec2 c0 = ivec2(floor(q));
    for (int j = -1; j <= 1; j++)
      for (int i = -1; i <= 1; i++) {
        ivec2 c = c0 + ivec2(i, j);
        ivec2 w = ((c % n) + n) % n;
        uint h = mixHash(uvec3(uvec2(w), uint(l) * 0x9e3779b9u + 0x1234567u));
        if (rnd(h, 1u) > A.w) continue;
        // centre: jittered, orbiting a small Lissajous path
        // odd rows shifted half a cell (±¼ each way) → a hex-like packing without straight columns
        vec2 ctr = vec2(c) + vec2(0.25 + 0.5 * float(w.y & 1) , 0.5);
        ctr += (vec2(rnd(h, 2u), rnd(h, 3u)) - 0.5) * (2.0 * uLayerC[l].x);
        ctr += uLayerC[l].y * vec2(wave(h, 4u, 2.0, 7.0), wave(h, 6u, 2.0, 7.0));
        float r = mix(A.y, A.z, rnd(h, 8u)) * (1.0 + 0.1 * wave(h, 9u, 3.0, 9.0));
        float b = mix(B.x, B.y, rnd(h, 11u)) * (0.82 + 0.18 * wave(h, 12u, 3.0, 12.0));
        float d = length(q - ctr) / r;
        // hot-core glow: a Gaussian whose centre over-exposes to white, blended with a soft-edged plateau
        float plateau = mix(0.1, 0.7, rnd(h, 14u));
        float f = mix(exp(-3.0 * d * d), smoothstep(1.0, plateau, d), 0.6 * uSharp) + 0.1 * exp(-1.2 * d * d);
        keep *= 1.0 - clamp(1.3 * b * f, 0.0, 1.0);
      }
  }
  float v = pow(clamp((1.0 - keep) * uGain, 0.0, 1.0), uGamma);
  outColor = vec4(vec3(uTT + (1.0 - uTT) * v), (1.0 - uTT) + uTT * v);
}`

export class LightsPattern {
  readonly texture: THREE.Texture
  readonly size: number
  /** integrated, wrapped animation time (seconds at speed 1) */
  time = 0

  private renderer: THREE.WebGLRenderer
  private target: THREE.WebGLRenderTarget
  private material: THREE.ShaderMaterial
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private params = { speed: 1, density: 1, transparency: 0 }

  constructor(renderer: THREE.WebGLRenderer, size = 512) {
    this.renderer = renderer
    this.size = size
    this.target = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      generateMipmaps: false,
    })
    this.target.texture.colorSpace = THREE.NoColorSpace
    this.texture = this.target.texture
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uSize: { value: size },
        uT: { value: 0 },
        uGain: { value: 1 },
        uGamma: { value: 1 },
        uSharp: { value: 0.5 },
        uTT: { value: 0 },
        uLayerA: { value: LAYERS.map(() => new THREE.Vector4()) },
        uLayerB: { value: LAYERS.map(() => new THREE.Vector4()) },
        uLayerC: { value: LAYERS.map((L) => new THREE.Vector2(L.jitter, L.orbit)) },
      },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: frag,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    })
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material)
    quad.frustumCulled = false
    this.scene.add(quad)
    this.render()
  }

  setParams(p: { speed?: number; density?: number; transparency?: number }): void {
    const P = this.params
    if (p.speed !== undefined) P.speed = Math.max(0, p.speed)
    if (p.density !== undefined) P.density = Math.min(4, Math.max(0.1, p.density))
    if (p.transparency !== undefined) P.transparency = Math.min(1, Math.max(0, p.transparency))
  }

  update(dt: number): void {
    this.time = (this.time + Math.max(0, dt) * this.params.speed) % T_PERIOD
    this.render()
  }

  private render(): void {
    const P = this.params
    const U = this.material.uniforms
    const A = U.uLayerA.value as THREE.Vector4[]
    const B = U.uLayerB.value as THREE.Vector4[]
    const ph = this.time / T_PERIOD
    LAYERS.forEach((L, i) => {
      // even cell counts keep the alternating row shift periodic
      const n = Math.max(2, 2 * Math.round((L.cells * P.density) / 2))
      A[i].set(n, L.rMin, L.rMax, L.presence)
      B[i].set(L.bMin, L.bMax, fract(L.drift[0] * ph), fract(L.drift[1] * ph))
    })
    U.uT.value = this.time
    U.uGain.value = TUNING.gain
    U.uGamma.value = TUNING.gamma
    U.uSharp.value = TUNING.sharpness
    U.uTT.value = P.transparency

    const r = this.renderer
    const prevRT = r.getRenderTarget()
    const prevAuto = r.autoClear
    const prevScissor = r.getScissorTest()
    r.autoClear = false
    r.setScissorTest(false)
    r.setRenderTarget(this.target)
    r.render(this.scene, this.camera)
    r.setRenderTarget(prevRT)
    r.setScissorTest(prevScissor)
    r.autoClear = prevAuto
  }

  dispose(): void {
    this.target.dispose()
    this.material.dispose()
    this.scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
  }
}

function fract(x: number): number {
  return x - Math.floor(x)
}
