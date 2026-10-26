/**
 * CrystalLight — a seamlessly tiling "light on a faceted gem surface" pattern generator (the `crystal` note pattern).
 *
 * Technique ("studio-lit low-poly sheet"):
 *  1. A periodic triangulated sheet: an N×N lattice (N even) on offset rows (a triangular lattice), wrapped on the
 *     unit tile. Every vertex gets a hash-seeded jitter, a sideways slide and a height, animated by sines whose
 *     frequencies are an integer number of cycles per `T_PERIOD`, so the time phase wraps without a seam.
 *  2. The sheet is rasterised straight into the output render target — 3×3 instanced copies so triangles that
 *     straddle the tile edge also cover the opposite side, MSAA for clean facet edges. Each fragment gets exact
 *     distances to its triangle's three edges (corner k carries its altitude to edge k, the others 0).
 *  3. Shards: each lattice cell holds two triangles sharing a diagonal. A per-cell hash merges about half of the
 *     cells into one quad shard (shared averaged normal, no edge on the diagonal), so the surface is a mix of
 *     triangles and larger quads.
 *  4. Shading per shard: flat shard normal + a slight dome (gradient sheen inside the facet) + a chamfer band of
 *     outward tilt along every visible edge (inset "frame" that catches its own glints) + a thin dark seam. The
 *     normal's mirror direction is lit by a key light (sharp glint + lobes) whose azimuth rotates with a per-shard
 *     random phase/rate, and by a per-shard drifting set of soft bands (a striped soft-box), so facets flash
 *     independently, like cut stones turning in light.
 *  5. Tone: v = x·I / (1 + x·I); alpha = clamp(T·(0.5v + 0.5) + (1 − T)) with T = textureTransparency.
 *
 * Params:
 *  - textureSpeed:        animation rate (time advances at textureSpeed / 0.8)
 *  - textureDensity:      shard density; lattice N = nearest even integer to 13.5 · density. Quantised: the sheet is
 *                         rebuilt when N changes, so density steps.
 *  - textureTransparency: alpha from luminosity (0 = opaque)
 */
import * as THREE from 'three'

/** Time period (seconds at speed 1) over which every animated phase wraps exactly. */
const T_PERIOD = 240
/** Lattice cells across the tile at density 1. */
const CELLS_AT_DENSITY_1 = 13.5

/** Tuning. */
const TUNING = {
  /** vertex jitter, ± cell fraction */
  jitter: 0.22,
  /** vertex slide amplitude, cell units */
  slide: 0.16,
  /** vertex height amplitude, cell units (→ facet tilt) */
  height: 0.9,
  /** fraction of cells merged into one quad shard */
  merge: 0.5,
  /** dome curvature (normal tilt per cell from the shard centroid) → gradient sheen inside facets */
  dome: 0.3,
  /** chamfer band width at visible edges (cell units) and its outward normal tilt */
  bevelWidth: 0.1,
  bevelTilt: 0.6,
  /** light strengths */
  key: 1,
  bands: 1,
  intensity: 1.6,
}

const sheetVert = /* glsl */ `
precision highp float;
precision highp int;
uniform int uN;
uniform float uT, uJitter, uSlide, uHeight, uMerge, uKeyEl;
in vec2 aA, aB, aC; // this triangle: A = corner opposite the cell diagonal, B–C = the diagonal (lattice coords)
in vec2 aD;         // the other triangle's opposite corner (for merged quads)
in vec2 aCell;      // lattice cell (wrapped by the shader)
in vec2 iOff;       // tile copy offset (−1 / 0 / 1)
flat out vec3 vN;     // shard normal
flat out vec3 vVis;   // edge visibility (edge k opposite corner k)
flat out vec4 vEN01;  // outward 2D normals of edges 0, 1
flat out vec2 vEN2;   // … and 2
flat out vec3 vKey;   // this shard's key-light direction
flat out vec3 vBand;  // this shard's band direction (xy) and phase (z)
out vec3 vEdge;       // distances to edges (uv units)
out vec2 vLocal;      // offset from the shard centroid (cell units)

const float TAU = 6.2831853;
uint mixHash(uvec3 v) {
  uint h = v.x * 0x8da6b343u ^ v.y * 0xd8163841u ^ v.z * 0xcb1ab31fu;
  h ^= h >> 16; h *= 0x7feb352du;
  h ^= h >> 15; h *= 0x846ca68bu;
  h ^= h >> 16;
  return h;
}
float rnd(uint h, uint salt) { return float(mixHash(uvec3(h, salt, 0x51ed27u)) & 0xffffffu) / 16777216.0; }
// integer number of cycles in [kLo, kHi] per T_PERIOD → phase in cycles, wraps with the time accumulator
float cycles(uint h, uint salt, float kLo, float kHi) {
  return fract(floor(mix(kLo, kHi + 0.999, rnd(h, salt))) * uT / ${T_PERIOD.toFixed(1)} + rnd(h, salt + 1u));
}
float wave(uint h, uint salt, float kLo, float kHi) { return sin(TAU * cycles(h, salt, kLo, kHi)); }

ivec2 wrapC(ivec2 c) { return ((c % uN) + uN) % uN; }
uint vHash(ivec2 c) { return mixHash(uvec3(uvec2(wrapC(c)), 0x2c1b3c6du)); }
vec3 vpos(ivec2 c) {
  uint h = vHash(c);
  vec2 p = vec2(float(c.x) + 0.5 * float(wrapC(c).y & 1), float(c.y));
  p += (vec2(rnd(h, 1u), rnd(h, 2u)) - 0.5) * 2.0 * uJitter;
  float a = TAU * rnd(h, 3u);
  p += vec2(cos(a), sin(a)) * (uSlide * wave(h, 4u, 5.0, 22.0));
  float z = uHeight * (0.7 * wave(h, 6u, 8.0, 36.0) + 0.3 * wave(h, 8u, 24.0, 64.0));
  return vec3(p, z) / float(uN);
}
vec3 faceNormal(vec3 a, vec3 b, vec3 c) {
  vec3 n = normalize(cross(b - a, c - a));
  return n.z < 0.0 ? -n : n;
}
vec2 outward(vec2 e0, vec2 e1, vec2 away) {
  vec2 d = e1 - e0;
  vec2 n = normalize(vec2(d.y, -d.x));
  return dot(n, away - e0) > 0.0 ? -n : n;
}
void main() {
  int k = int(position.x + 0.5);
  float half_ = position.y;
  vec3 pa = vpos(ivec2(aA)), pb = vpos(ivec2(aB)), pc = vpos(ivec2(aC));
  uint ch = mixHash(uvec3(uvec2(wrapC(ivec2(aCell))), 0x6a09e667u));
  bool merged = rnd(ch, 1u) < uMerge;
  vec3 fn = faceNormal(pa, pb, pc);
  vec2 cen = (pa.xy + pb.xy + pc.xy) / 3.0;
  uint shard = ch ^ (half_ > 0.5 ? 0x9e3779b9u : 0u);
  if (merged) {
    vec3 pd = vpos(ivec2(aD));
    fn = normalize(fn + faceNormal(pd, pc, pb));
    cen = (pa.xy + pb.xy + pc.xy + pd.xy) * 0.25;
    shard = ch;
  }
  vN = fn;
  vec2 a = pa.xy, b = pb.xy, c = pc.xy;
  float area2 = abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  vec3 alt = area2 / max(vec3(length(c - b), length(a - c), length(b - a)), 1e-6);
  vEdge = vec3(k == 0 ? alt.x : 0.0, k == 1 ? alt.y : 0.0, k == 2 ? alt.z : 0.0);
  vEN01 = vec4(outward(b, c, a), outward(c, a, b));
  vEN2 = outward(a, b, c);
  vVis = vec3(merged ? 0.0 : 1.0, 1.0, 1.0);

  // per-shard lights: key azimuth turns at its own integer rate with its own phase; bands drift likewise
  float az = TAU * cycles(shard, 11u, 14.0, 30.0) * (rnd(shard, 13u) < 0.5 ? -1.0 : 1.0);
  float el = uKeyEl + 0.25 * (rnd(shard, 14u) - 0.5);
  vKey = vec3(cos(az) * sin(el), sin(az) * sin(el), cos(el));
  float bd = TAU * rnd(shard, 15u);
  vBand = vec3(cos(bd), sin(bd), TAU * cycles(shard, 16u, 6.0, 18.0));

  vec2 pk = k == 0 ? a : k == 1 ? b : c;
  vLocal = (pk - cen) * float(uN);
  vec2 p = pk + iOff;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const sheetFrag = /* glsl */ `
precision highp float;
precision highp int;
uniform int uN;
uniform float uDome, uBevelW, uBevelTilt, uKeyGain, uBandGain, uIntensity, uAlphaT;
flat in vec3 vN;
flat in vec3 vVis;
flat in vec4 vEN01;
flat in vec2 vEN2;
flat in vec3 vKey;
flat in vec3 vBand;
in vec3 vEdge;
in vec2 vLocal;
layout(location = 0) out highp vec4 outColor;

void main() {
  vec3 dv = mix(vec3(1e3), vEdge * float(uN), vVis); // cell units; hidden diagonal → far away
  vec3 n = normalize(vN + vec3(vLocal * uDome, 0.0));
  float d; vec2 en;
  if (dv.x < dv.y && dv.x < dv.z) { d = dv.x; en = vEN01.xy; }
  else if (dv.y < dv.z) { d = dv.y; en = vEN01.zw; }
  else { d = dv.z; en = vEN2; }
  // chamfer: a band of constant outward tilt along the edge (inset frame), thin dark seam at the edge itself
  float aa = 3.0 * fwidth(d); // keep the thin transitions ≥ ~3 texels so they don't alias at low resolutions
  float bev = 1.0 - smoothstep(uBevelW - max(uBevelW * 0.25, aa), uBevelW, d);
  n = normalize(n + vec3(en * (uBevelTilt * bev), 0.0));
  float seam = smoothstep(0.0, max(0.03, aa), d);

  // mirror direction (viewer straight above the sheet)
  vec3 R = reflect(vec3(0.0, 0.0, -1.0), n);
  float kd = max(dot(R, vKey), 0.0);
  float x = uKeyGain * (pow(kd, 150.0) * 2.0 + pow(kd, 24.0) * 1.0 + pow(kd, 4.0) * 0.15);
  // striped soft-box: wide bands over mirror directions → a facet holds a flat grey that brightens / dims as a
  // band passes; the dome turns it into a gradient across the facet
  float s = 0.5 + 0.5 * sin(dot(R.xy, vBand.xy) * 6.0 + vBand.z);
  x += uBandGain * 0.6 * pow(smoothstep(0.45, 0.97, s), 1.5);
  // polished chamfers read brighter than the facet face; the seam itself stays dark
  x *= (1.0 + 0.4 * bev) * mix(0.3, 1.0, seam);
  float v = x * uIntensity / (1.0 + x * uIntensity);
  v = v == v ? v : 0.0;
  outColor = vec4(vec3(v), clamp(uAlphaT * (0.5 * v + 0.5) + (1.0 - uAlphaT), 0.0, 1.0));
}`

export class CrystalLight {
  readonly texture: THREE.Texture
  readonly size: number
  /** integrated, wrapped animation time (seconds at speed 1) */
  time = 0

  private renderer: THREE.WebGLRenderer
  private target: THREE.WebGLRenderTarget
  private material: THREE.ShaderMaterial
  private mesh: THREE.Mesh
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private params = { textureSpeed: 1, textureDensity: 1, textureTransparency: 0 }
  private n = 0

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
      samples: 4,
    })
    this.target.texture.colorSpace = THREE.NoColorSpace
    this.texture = this.target.texture
    const u = (value: unknown) => ({ value })
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uN: u(2), uT: u(0), uJitter: u(0), uSlide: u(0), uHeight: u(0), uMerge: u(0), uKeyEl: u(0.6),
        uDome: u(0), uBevelW: u(0), uBevelTilt: u(0), uKeyGain: u(1), uBandGain: u(1), uIntensity: u(1), uAlphaT: u(0),
      },
      vertexShader: sheetVert,
      fragmentShader: sheetFrag,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NoBlending,
    })
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material)
    this.mesh.frustumCulled = false
    this.scene.add(this.mesh)
    this.render()
  }

  setParams(p: { textureSpeed?: number; textureDensity?: number; textureTransparency?: number }): void {
    const P = this.params
    if (p.textureSpeed !== undefined) P.textureSpeed = Math.max(0, p.textureSpeed)
    if (p.textureDensity !== undefined) P.textureDensity = Math.min(4, Math.max(0.05, p.textureDensity))
    if (p.textureTransparency !== undefined) P.textureTransparency = Math.min(1, Math.max(0, p.textureTransparency))
  }

  update(dt: number): void {
    this.time = (this.time + (Math.max(0, dt) * this.params.textureSpeed) / 0.8) % T_PERIOD
    this.render()
  }

  /** (Re)build the triangle list for an N×N offset-row lattice (N even): two triangles per cell. */
  private buildSheet(N: number): void {
    // per triangle: A (opposite the diagonal), B, C (diagonal), D (other triangle's A), cell, half
    const tris: number[][] = []
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        // even rows (unshifted) → diagonal (i+1, j)–(i, j+1); odd rows (shifted) → diagonal (i, j)–(i+1, j+1)
        const [b, c, o1, o2] =
          (j & 1) === 0
            ? [[i + 1, j], [i, j + 1], [i, j], [i + 1, j + 1]]
            : [[i, j], [i + 1, j + 1], [i, j + 1], [i + 1, j]]
        tris.push([...o1, ...b, ...c, ...o2, i, j, 0])
        tris.push([...o2, ...b, ...c, ...o1, i, j, 1])
      }
    const T = tris.length
    const pos = new Float32Array(T * 9)
    const attr = ['aA', 'aB', 'aC', 'aD', 'aCell'].map(() => new Float32Array(T * 6))
    for (let t = 0; t < T; t++)
      for (let k = 0; k < 3; k++) {
        const v = t * 3 + k
        pos[v * 3] = k
        pos[v * 3 + 1] = tris[t][10]
        for (let a = 0; a < 5; a++) {
          attr[a][v * 2] = tris[t][a * 2]
          attr[a][v * 2 + 1] = tris[t][a * 2 + 1]
        }
      }
    const off: number[] = []
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) off.push(x, y)
    const geo = new THREE.InstancedBufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    ;['aA', 'aB', 'aC', 'aD', 'aCell'].forEach((name, a) => geo.setAttribute(name, new THREE.BufferAttribute(attr[a], 2)))
    geo.setAttribute('iOff', new THREE.InstancedBufferAttribute(new Float32Array(off), 2))
    geo.instanceCount = 9
    this.mesh.geometry.dispose()
    this.mesh.geometry = geo
    this.n = N
  }

  private render(): void {
    const P = this.params
    const N = Math.max(2, 2 * Math.round((CELLS_AT_DENSITY_1 * P.textureDensity) / 2))
    if (N !== this.n) this.buildSheet(N)
    const U = this.material.uniforms
    const K = TUNING
    U.uN.value = N
    U.uT.value = this.time
    U.uJitter.value = K.jitter
    U.uSlide.value = K.slide
    U.uHeight.value = K.height
    U.uMerge.value = K.merge
    U.uDome.value = K.dome
    U.uBevelW.value = K.bevelWidth
    U.uBevelTilt.value = K.bevelTilt
    U.uKeyGain.value = K.key
    U.uBandGain.value = K.bands
    U.uIntensity.value = K.intensity
    U.uAlphaT.value = P.textureTransparency
    // key elevation breathes slowly (integer cycles per period)
    U.uKeyEl.value = 0.6 + 0.15 * Math.sin((2 * Math.PI * 7 * this.time) / T_PERIOD)

    const r = this.renderer
    const prevRT = r.getRenderTarget()
    const prevAuto = r.autoClear
    const prevScissor = r.getScissorTest()
    const prevColor = r.getClearColor(new THREE.Color())
    const prevAlpha = r.getClearAlpha()
    r.autoClear = false
    r.setScissorTest(false)
    r.setRenderTarget(this.target)
    r.setClearColor(0x000000, 1)
    r.clear(true, false, false)
    r.render(this.scene, this.camera)
    r.setRenderTarget(prevRT)
    r.setClearColor(prevColor, prevAlpha)
    r.setScissorTest(prevScissor)
    r.autoClear = prevAuto
  }

  dispose(): void {
    this.target.dispose()
    this.material.dispose()
    this.mesh.geometry.dispose()
  }
}
