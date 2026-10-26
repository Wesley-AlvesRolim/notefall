/**
 * Caustics — a seamlessly tiling "light under water" pattern generator (the `water` note pattern).
 *
 * Technique (classic "caustics by refracted grid"):
 *  1. A periodic, animated height field is rendered into a float texture. It is a sum of a few layers of
 *     tileable 3D gradient noise: x/y are periodic over the unit tile (integer lattice period), z is time
 *     (also periodic, so the phase can wrap without a seam or float-precision growth).
 *  2. A regular grid of vertices (one per height texel, plus a wrapped margin so displaced triangles near the
 *     tile edge still cover the opposite side) is pushed sideways by the refracted-light offset `-k·∇h`.
 *  3. Each vertex carries the light-focusing factor `1 / |det J|`, where `J = I - k·Hessian(h)` is the Jacobian
 *     of the displacement map: where neighbouring rays converge the area shrinks and the light gets brighter.
 *  4. The displaced grid is drawn with additive blending, so folded (overlapping) regions sum up into the bright
 *     caustic lines. Flat water has intensity `BASE`.
 *  5. The splat target is multisampled (4×), so the fold edges come out anti-aliased instead of as texel stairs.
 *     Pick `size` so a texel is about one screen pixel where the tile is shown (1024 for the large tiles the note
 *     looks use; at 512 a magnified tile shows the stairs plainly).
 *
 * Params:
 *  - density:    cell density multiplier (≈ number of cells across the tile scales linearly with it)
 *  - speed:      animation rate
 *  - height:     wave height → how strongly light is focused → sharpness of the bright lines
 *  - minOpacity: alpha floor (alpha = c·(1 − m) + m)
 */
import * as THREE from 'three'

/** One noise layer of the height field. `freq` is in cells per tile at density 1. */
interface Layer {
  freq: number
  weight: number
  /** z (time) advance per second at speed 1, in noise-lattice units */
  evolve: number
  /** sideways drift per second at speed 1 (uv units, divided by density) and its direction in degrees */
  drift: number
  dir: number
  /** integer lattice rotation (a, b): the noise lattice is rotated by atan2(b, a) and scaled by |(a, b)|; integer
   *  entries keep it periodic over the unit tile while hiding the lattice-axis streaks of gradient noise */
  rot: [number, number]
}

const LAYERS: Layer[] = [
  { freq: 13.5, weight: 1.0, evolve: 0.7, drift: 0.03, dir: 20, rot: [2, 1] },
  { freq: 18, weight: 0.9, evolve: 0.75, drift: 0.03, dir: 200, rot: [-1, 2] },
  { freq: 29.5, weight: 0.8, evolve: 0.65, drift: 0.0, dir: -70, rot: [1, 1] },
]
/** Time-axis period of the noise lattice (integer → the phase wraps seamlessly). */
const Z_PERIOD = 64
/** Brightness of undisturbed (flat) water. */
const BASE = 0.3
/** Per-vertex intensity clamp before additive accumulation. */
const VERTEX_CLAMP = 1.0
/** Tuning: strength = refraction strength at height 1, freqScale scales LAYERS[].freq. */
const TUNING = { strength: 0.05, freqScale: 1, base: 0.3, clamp: 1 }
/** Max sideways displacement in uv units (also sizes the wrapped grid margin). */
const MAX_OFFSET = 0.08

const heightFrag = /* glsl */ `
precision highp float;
precision highp int;
uniform float uGrid;
layout(location = 0) out highp vec4 outColor;
uniform vec4 uLayerA[${LAYERS.length}]; // periodLo, periodHi, mixHi, amplitude (already / D²)
uniform vec4 uLayerB[${LAYERS.length}]; // shift.xy (uv), z (time phase), layer seed
uniform vec2 uLayerRot[${LAYERS.length}]; // integer rotation (a, b)

// Integer avalanche hash (xorshift-multiply mix).
uint mixHash(uvec3 v) {
  uint h = v.x * 0x8da6b343u ^ v.y * 0xd8163841u ^ v.z * 0xcb1ab31fu;
  h ^= h >> 16; h *= 0x7feb352du;
  h ^= h >> 15; h *= 0x846ca68bu;
  h ^= h >> 16;
  return h;
}

// Pseudo-random unit gradient for a lattice corner.
vec3 cornerGrad(ivec3 c, uint seed) {
  uint h = mixHash(uvec3(c) + uvec3(seed * 1031u, seed * 2713u, seed * 4447u));
  float a = float(h & 0xffffu) * (6.2831853 / 65535.0);
  float z = float(h >> 16) * (2.0 / 65535.0) - 1.0;
  float r = sqrt(max(0.0, 1.0 - z * z));
  return vec3(r * cos(a), r * sin(a), z);
}

ivec3 wrapI(ivec3 c, ivec3 per) { return ((c % per) + per) % per; }

// "Surflet" gradient noise, periodic with integer period 'per' on every axis: every lattice corner contributes a
// linear ramp dot(g, d) under a radially symmetric falloff (1 - |d|²)⁴ (zero, with zero derivatives, at |d| = 1, so
// only the 8 corners of the enclosing cell matter). Unlike classic tensor-product (fade-curve) gradient noise, its
// curvature does not vanish on lattice planes — that showed up as faint straight "flat water" streaks.
float periodicNoise(vec3 p, ivec3 per, uint seed) {
  vec3 fl = floor(p);
  ivec3 i = ivec3(fl);
  vec3 f = p - fl;
  float n = 0.0;
  for (int k = 0; k < 8; k++) {
    ivec3 o = ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    vec3 d = f - vec3(o);
    float w = max(0.0, 1.0 - dot(d, d));
    w *= w;
    n += w * w * dot(cornerGrad(wrapI(i + o, per), seed), d);
  }
  return n * 2.5;
}

float layerNoise(vec3 p, ivec3 per, uint seed) { return periodicNoise(p, per, seed); }

void main() {
  // texel i <-> uv i / grid, matching the grid vertices that read it back
  vec2 uv = (gl_FragCoord.xy - 0.5) / uGrid;
  float h = 0.0;
  for (int k = 0; k < ${LAYERS.length}; k++) {
    vec4 A = uLayerA[k];
    vec4 B = uLayerB[k];
    vec2 q = fract(uv + B.xy);
    vec2 ab = uLayerRot[k];
    q = vec2(ab.x * q.x - ab.y * q.y, ab.y * q.x + ab.x * q.y);
    uint seed = uint(B.w);
    // cross-fade between the two neighbouring integer frequencies so density varies continuously
    float n = 0.0;
    if (A.z < 0.999) n += (1.0 - A.z) * layerNoise(vec3(q * A.x, B.z), ivec3(int(A.x), int(A.x), ${Z_PERIOD}), seed);
    if (A.z > 0.001) n += A.z * layerNoise(vec3(q * A.y, B.z), ivec3(int(A.y), int(A.y), ${Z_PERIOD}), seed + 7u);
    // two independent noises mixed linearly lose variance mid-fade; renormalise so focusing stays constant
    h += A.w * n * inversesqrt((1.0 - A.z) * (1.0 - A.z) + A.z * A.z);
  }
  outColor = vec4(h, 0.0, 0.0, 1.0);
}`

const gridVert = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uHeight;
uniform int uGrid;
uniform float uK, uMaxOff, uBase, uClamp;
out float vI;

float hAt(ivec2 c) { return texelFetch(uHeight, ((c % uGrid) + uGrid) % uGrid, 0).r; }

void main() {
  ivec2 c = ivec2(position.xy);
  float G = float(uGrid);
  float h0 = hAt(c);
  float hpx = hAt(c + ivec2(1, 0)), hmx = hAt(c - ivec2(1, 0));
  float hpy = hAt(c + ivec2(0, 1)), hmy = hAt(c - ivec2(0, 1));
  float hpp = hAt(c + ivec2(1, 1)), hpm = hAt(c + ivec2(1, -1));
  float hmp = hAt(c + ivec2(-1, 1)), hmm = hAt(c + ivec2(-1, -1));
  vec2 grad = vec2(hpx - hmx, hpy - hmy) * (0.5 * G);
  float hxx = (hpx - 2.0 * h0 + hmx) * G * G;
  float hyy = (hpy - 2.0 * h0 + hmy) * G * G;
  float hxy = (hpp - hpm - hmp + hmm) * (0.25 * G * G);

  // refracted light lands at p - k·∇h (small-angle approximation)
  vec2 off = -uK * grad;
  float len = length(off);
  if (len > uMaxOff) off *= uMaxOff / len;

  // focusing: light through a cell spreads over |det J| of its original area
  float det = (1.0 - uK * hxx) * (1.0 - uK * hyy) - uK * uK * hxy * hxy;
  vI = min(uBase / max(abs(det), 1e-4), uClamp);

  vec2 p = vec2(c) / G + off;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const gridFrag = /* glsl */ `
precision highp float;
uniform float uMinOpacity;
in float vI;
layout(location = 0) out highp vec4 outColor;
void main() {
  float c = max(vI, 0.0);
  outColor = vec4(vec3(c), c * (1.0 - uMinOpacity) + uMinOpacity);
}`

export class Caustics {
  readonly texture: THREE.Texture
  readonly size: number
  readonly gridSize: number
  /** integrated animation time (seconds at speed 1), for HUDs */
  time = 0

  private renderer: THREE.WebGLRenderer
  private heightRT: THREE.WebGLRenderTarget
  private outRT: THREE.WebGLRenderTarget
  private heightMat: THREE.ShaderMaterial
  private gridMat: THREE.ShaderMaterial
  private heightScene = new THREE.Scene()
  private gridScene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private params = { density: 0.33, speed: 0.75 * 0.75, height: 1, minOpacity: 1 }
  private shift = LAYERS.map(() => new THREE.Vector2())
  private zPhase = LAYERS.map((_, i) => i * 13.7)

  constructor(renderer: THREE.WebGLRenderer, size = 512) {
    this.renderer = renderer
    this.size = size
    // one grid vertex per output texel up to 512 (~360k vertices at 512 incl. the wrapped margin); 1024 uses a
    // half-res grid (~2 px triangles), which looks the same and keeps the vertex count at the 512 level
    const G = (this.gridSize = size > 512 ? Math.round(size / 2) : Math.max(64, Math.round(size)))

    this.heightRT = new THREE.WebGLRenderTarget(G, G, {
      type: THREE.FloatType,
      format: THREE.RedFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      generateMipmaps: false,
    })
    this.outRT = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      generateMipmaps: false,
      // 4× MSAA on the splat: the fold edges of the displaced grid are triangle edges, so without coverage AA every
      // caustic line edge is a 1-texel binary staircase; magnified ~1.5–3 screen px per texel on the notes that read
      // as jagged bands. Resolved into the texture by three after each render.
      samples: 4,
    })
    this.outRT.texture.colorSpace = THREE.NoColorSpace
    this.texture = this.outRT.texture

    const quad = new THREE.PlaneGeometry(2, 2)
    this.heightMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uGrid: { value: G },
        uLayerA: { value: LAYERS.map(() => new THREE.Vector4()) },
        uLayerB: { value: LAYERS.map(() => new THREE.Vector4()) },
        uLayerRot: { value: LAYERS.map((L) => new THREE.Vector2(L.rot[0], L.rot[1])) },
      },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: heightFrag,
      depthTest: false,
      depthWrite: false,
    })
    const hq = new THREE.Mesh(quad, this.heightMat)
    hq.frustumCulled = false
    this.heightScene.add(hq)

    // grid: (G + 2M + 1)² vertices addressed by integer cell coordinate in [-M, G + M]
    const M = Math.ceil(MAX_OFFSET * G) + 2
    const N = G + 2 * M
    const pos = new Float32Array((N + 1) * (N + 1) * 3)
    for (let j = 0; j <= N; j++)
      for (let i = 0; i <= N; i++) {
        const v = (j * (N + 1) + i) * 3
        pos[v] = i - M
        pos[v + 1] = j - M
      }
    const idx = new Uint32Array(N * N * 6)
    let w = 0
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i
        idx[w++] = a; idx[w++] = a + 1; idx[w++] = a + N + 1
        idx[w++] = a + 1; idx[w++] = a + N + 2; idx[w++] = a + N + 1
      }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setIndex(new THREE.BufferAttribute(idx, 1))
    this.gridMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uHeight: { value: this.heightRT.texture },
        uGrid: { value: G },
        uK: { value: 0 },
        uMaxOff: { value: MAX_OFFSET },
        uBase: { value: BASE },
        uClamp: { value: VERTEX_CLAMP },
        uMinOpacity: { value: 1 },
      },
      vertexShader: gridVert,
      fragmentShader: gridFrag,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const grid = new THREE.Mesh(geo, this.gridMat)
    grid.frustumCulled = false
    this.gridScene.add(grid)

    this.render()
  }

  setParams(p: { density?: number; speed?: number; height?: number; minOpacity?: number }): void {
    const P = this.params
    if (p.density !== undefined) P.density = Math.min(4, Math.max(0.1, p.density))
    if (p.speed !== undefined) P.speed = Math.max(0, p.speed)
    if (p.height !== undefined) P.height = Math.max(0, p.height)
    if (p.minOpacity !== undefined) P.minOpacity = Math.min(1, Math.max(0, p.minOpacity))
  }

  update(dt: number): void {
    const P = this.params
    const st = Math.max(0, dt) * P.speed
    this.time += st
    LAYERS.forEach((L, i) => {
      // evolve the noise along its periodic time axis; wrap so the phase never grows
      this.zPhase[i] = (this.zPhase[i] + st * L.evolve) % Z_PERIOD
      const r = (L.dir * Math.PI) / 180
      const d = (st * L.drift) / P.density
      const s = this.shift[i]
      s.set(fract(s.x - Math.sin(r) * d), fract(s.y - Math.cos(r) * d))
    })
    this.render()
  }

  private render(): void {
    const P = this.params
    const A = this.heightMat.uniforms.uLayerA.value as THREE.Vector4[]
    const B = this.heightMat.uniforms.uLayerB.value as THREE.Vector4[]
    LAYERS.forEach((L, i) => {
      const D = Math.max(1, L.freq * TUNING.freqScale * P.density)
      // lattice cells per tile = s · |(a, b)|, s integer (the noise period)
      const s = Math.max(1, D / Math.hypot(L.rot[0], L.rot[1]))
      const lo = Math.floor(s)
      // amplitude ∝ 1/D² keeps the curvature (and thus the focusing) independent of density
      A[i].set(lo, lo + 1, s - lo, L.weight / (D * D))
      B[i].set(this.shift[i].x, this.shift[i].y, this.zPhase[i], i + 1)
    })
    this.gridMat.uniforms.uK.value = TUNING.strength * P.height
    this.gridMat.uniforms.uBase.value = TUNING.base
    this.gridMat.uniforms.uClamp.value = TUNING.clamp
    this.gridMat.uniforms.uMinOpacity.value = P.minOpacity

    const r = this.renderer
    const prevRT = r.getRenderTarget()
    const prevAuto = r.autoClear
    const prevColor = r.getClearColor(new THREE.Color())
    const prevAlpha = r.getClearAlpha()
    r.autoClear = false
    r.setRenderTarget(this.heightRT)
    r.render(this.heightScene, this.camera)
    r.setRenderTarget(this.outRT)
    r.setClearColor(0x000000, 0)
    r.clear(true, false, false)
    r.render(this.gridScene, this.camera)
    r.setRenderTarget(prevRT)
    r.setClearColor(prevColor, prevAlpha)
    r.autoClear = prevAuto
  }

  dispose(): void {
    this.heightRT.dispose()
    this.outRT.dispose()
    this.heightMat.dispose()
    this.gridMat.dispose()
    this.heightScene.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
    this.gridScene.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
  }
}

function fract(x: number): number {
  return x - Math.floor(x)
}
