import * as THREE from 'three'

/**
 * The "realistic" note material: procedural, seamlessly tiling map sets for a `scales` (veined marble scales with
 * glowing seams) and a `volcanic` (faceted volcanic glass with iridescent veins) look, an animated "silk" note texture,
 * and the GLSL shading function that combines them.
 *
 * Everything is generated on the GPU in fullscreen fragment passes into RGBA8 render targets (mipmapped, repeat
 * wrap). No image assets are read.
 *
 * ── Map channel conventions ─────────────────────────────────────────────────────────────────────────────────────
 *   albedo   rgb = base colour, DISPLAY space (sRGB-encoded values used as-is), roughly grey so the note tint carries
 *            the hue; a = 1.
 *   gloss    r = metallic (0..1), g = smoothness (0..1), b = 0, a = smoothness (duplicate of g).
 *            REALISTIC_SHADING_GLSL reads r and g.
 *   normal   tangent-space normal, OpenGL convention (+x right, +y UP = towards the top of the texture / screen),
 *            standard encoding rgb = n * 0.5 + 0.5 (so a flat texel is (0.5, 0.5, 1.0)); a = 1.
 *   emissive rgb = emission strength (grey, mostly black, peaks ≈ 0.65), display space; a = 1. Scales only.
 * Texture v = 0 is the bottom row (render-target orientation; no flipY), matching uv = worldXY / tileSize.
 *
 * ── Technique ───────────────────────────────────────────────────────────────────────────────────────────────────
 * Both materials are built on a periodic Voronoi lattice (cell centres jittered on an integer lattice whose
 * coordinates are wrapped by the period, so the whole map tiles). The Voronoi uses an ANISOTROPIC metric
 * (distance = |M·d| with M stretching along one direction) — the metric is translation-invariant, so cells can be
 * elongated along any diagonal while the map still tiles exactly. A two-pass search returns the nearest centre and
 * the exact distance to the nearest cell border in metric space; the border distance drives every map:
 *   scales:   elongated, tilted "scales" → height = rounded dome over the border distance, tilted along the
 *             elongation (overlapping-scale feel) + low terrace ripples (strata lines); emissive = soft glowing
 *             seams + faint echo lines; albedo = cloudy grey + fine ridged marble veins; gloss = metallic 1,
 *             smoothness high with slightly duller seams.
 *   volcanic: isotropic pebbles → height = per-cell tilted facet that rises away from the border (sharp creases)
 *             + grain; albedo = dark glass, lighter seams with a thin-film (cosine palette) iridescence; gloss =
 *             metallic varied by fbm, smoothness high with dull blotches and fine hairline cracks.
 * The normal map is the central difference of the height field at ±1 texel (wrapped).
 * The input domain is gently warped by periodic fbm so the cells never read as a lattice.
 *
 * SilkTexture: tileable, animated grey "silk" — ridged periodic 3D gradient noise (x/y periodic, z = time),
 * with higher x than y lattice frequency so filaments run vertically, domain-warped by a slower noise that also
 * drifts upwards. Re-rendered on every update(dt).
 */

export type RealisticMaps = {
  albedo: THREE.Texture
  /** r = metallic, g = smoothness (also copied to a). */
  gloss: THREE.Texture
  /** tangent-space, OpenGL (+y up), rgb = n·0.5 + 0.5 */
  normal: THREE.Texture
  emissive?: THREE.Texture
  /** frees every texture / render target of the set */
  dispose(): void
}

/** cells: lattice cells per tile edge (0 / omitted = the material's default: scales 7, volcanic 6) — raise it together
 *  with the tile size to push the visible repeat further apart; irregularity 0..1: cell-size variance (low-frequency
 *  domain warp) + full centre jitter (0 = as originally tuned). */
export type RealisticOpts = { size?: number; seed?: number; cells?: number; irregularity?: number }

// ---- shared GLSL ------------------------------------------------------------------------------------------------
const LIB = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uSeed;
uniform float uTexel;     // 1 / size
uniform int uMap;         // 0 albedo, 1 gloss, 2 normal, 3 emissive
uniform float uStrength;  // normal slope gain
uniform float uCells;     // > 0: cells per tile edge (overrides the material's default lattice period)
uniform float uIrr;       // irregularity 0..1: low-frequency domain warp (cell-size variance) + full jitter

vec2 hash22(vec2 c) {
  vec2 p = vec2(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)));
  return fract(sin(p + uSeed * vec2(17.31, 9.73)) * 43758.5453);
}
float hash12(vec2 c) { return hash22(c + 3.7).x; }

// periodic value noise, x in lattice units, period P (integer)
float vnoise(vec2 x, float P) {
  vec2 i = floor(x), f = x - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash12(mod(i, P)), b = hash12(mod(i + vec2(1, 0), P));
  float c = hash12(mod(i + vec2(0, 1), P)), d = hash12(mod(i + vec2(1, 1), P));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// fbm over tile coordinates uv in [0,1): octave k has integer frequency f0·2^k, so every octave tiles
float fbm(vec2 uv, float f0, int oct) {
  float s = 0.0, a = 0.5, n = 0.0, f = f0;
  for (int k = 0; k < 6; k++) {
    if (k >= oct) break;
    s += a * vnoise(uv * f + float(k) * 7.13, f);
    n += a; a *= 0.5; f *= 2.0;
  }
  return s / n;
}
// 1 at the crest of a ridge, 0 away from it
float ridged(vec2 uv, float f0, int oct) {
  float s = 0.0, a = 0.5, n = 0.0, f = f0;
  for (int k = 0; k < 6; k++) {
    if (k >= oct) break;
    float v = vnoise(uv * f + float(k) * 3.71 + 11.0, f);
    s += a * (1.0 - abs(v * 2.0 - 1.0));
    n += a; a *= 0.55; f *= 2.0;
  }
  return s / n;
}

// Periodic Voronoi in lattice coords x ∈ [0,P)², metric |M·d|.
// returns (nearest distance, soft border distance, cell hash, 0) — distances in metric space;
// dc = metric-space offset from the nearest centre to x; id = wrapped cell id.
vec4 voronoi(vec2 x, float P, mat2 M, float jit, float salt, out vec2 dc, out vec2 id) {
  vec2 i = floor(x), f = x - i;
  float best = 1e9;
  vec2 bm = vec2(0.0), bid = vec2(0.0);
  for (int yy = -VR; yy <= VR; yy++) for (int xx = -VR; xx <= VR; xx++) {
    vec2 g = vec2(float(xx), float(yy));
    vec2 cid = mod(i + g, P);
    vec2 o = g + 0.5 + jit * (hash22(cid + salt) - 0.5) - f;
    vec2 m = M * o;
    float d = dot(m, m);
    if (d < best) { best = d; bm = m; bid = cid; }
  }
  float bs = 0.0;   // soft-min of the border distances → rounded cell corners (VK = rounding radius)
  for (int yy = -VR; yy <= VR; yy++) for (int xx = -VR; xx <= VR; xx++) {
    vec2 g = vec2(float(xx), float(yy));
    vec2 cid = mod(i + g, P);
    vec2 o = g + 0.5 + jit * (hash22(cid + salt) - 0.5) - f;
    vec2 m = M * o;
    vec2 dm = m - bm;
    if (dot(dm, dm) > 1e-6) bs += exp(-dot(0.5 * (bm + m), normalize(dm)) / VK);
  }
  float bd = max(-VK * log(max(bs, 1e-20)), 0.0);
  dc = -bm; id = bid;
  return vec4(sqrt(best), bd, hash12(bid + salt * 1.3), 0.0);
}
`

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

/** main(): field(uv) → (height, border, cellHash, aux); the material supplies albedoOf / glossOf / emissiveOf. */
const MAIN = /* glsl */ `
void main() {
  vec2 uv = vUv;
  if (uMap == 2) {
    float e = uTexel;
    float hl = field(fract(uv - vec2(e, 0.0))).x, hr = field(fract(uv + vec2(e, 0.0))).x;
    float hd = field(fract(uv - vec2(0.0, e))).x, hu = field(fract(uv + vec2(0.0, e))).x;
    vec2 g = vec2(hr - hl, hu - hd) / (2.0 * e);   // d height / d tile
    vec3 n = normalize(vec3(-g * uStrength, 1.0));
    gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
    return;
  }
  vec4 F = field(uv);
  if (uMap == 0) gl_FragColor = vec4(albedoOf(uv, F), 1.0);
  else if (uMap == 1) { vec2 mg = glossOf(uv, F); gl_FragColor = vec4(mg.x, mg.y, 0.0, mg.y); }
  else gl_FragColor = vec4(vec3(emissiveOf(uv, F)), 1.0);
}
`

// ---- scales -----------------------------------------------------------------------------------------------------
// Elongated scales leaning "\" (long axis from upper-left to lower-right), ~9 lattice cells per tile edge.
const SCALES = /* glsl */ `
#define VR 3
#define VK 0.09
mat2 metric() {
  vec2 u = normalize(vec2(0.42, -1.0));          // elongation direction
  vec2 v = vec2(-u.y, u.x);
  float s = sqrt(3.2);                            // aspect ≈ 3.2 : 1
  // M = diag(1/s, s) in the (u, v) frame
  return mat2(u.x / s * u.x + v.x * s * v.x, u.x / s * u.y + v.x * s * v.y,
              u.y / s * u.x + v.y * s * v.x, u.y / s * u.y + v.y * s * v.y);
}
vec4 field(vec2 uv) {
  float P = uCells > 0.5 ? uCells : 7.0;
  vec2 w = vec2(fbm(uv, 2.0, 4), fbm(uv + 0.37, 2.0, 4)) - 0.5;
  vec2 w2 = vec2(fbm(uv + 0.5, 6.0, 2), fbm(uv + 0.17, 6.0, 2)) - 0.5;
  vec2 wl = vec2(fbm(uv + 0.13, 1.0, 3), fbm(uv + 0.71, 1.0, 3)) - 0.5;
  vec2 x = fract(uv + w * 0.16 + w2 * 0.03 + wl * uIrr * 0.5) * P;
  vec2 dc, id;
  vec4 V = voronoi(x, P, metric(), mix(0.95, 1.0, uIrr), 0.0, dc, id);
  float b = V.y;
  // rounded dome rising from the seam, tilted along the scale so neighbours seem to overlap
  vec2 u = normalize(vec2(0.42, -1.0));
  float dome = 1.0 - exp(-b * 3.2);
  float tilt = clamp(dot(dc, u) * 0.35, -0.6, 0.6) * (0.4 + 0.6 * V.z);
  float h = dome * (0.75 + tilt);
  // strata: low ripples that follow the height contours (perturbed so they don't read as perfect rings)
  float wob = fbm(uv + 0.61, 12.0, 3);
  h += 0.022 * sin(h * 46.0 + wob * 9.0) * smoothstep(0.02, 0.3, b);
  h /= P;                                         // cell units → tile units
  return vec4(h, b, V.z, wob);
}
vec3 albedoOf(vec2 uv, vec4 F) {
  float cloud = fbm(uv + 0.13, 4.0, 5);
  float g = 0.56 + (cloud - 0.5) * 0.22;
  // fine marble veins: thin ridged-noise crests, warped
  vec2 wv = vec2(fbm(uv + 0.71, 5.0, 3), fbm(uv + 0.29, 5.0, 3)) - 0.5;
  float r = ridged(fract(uv + wv * 0.15), 6.0, 4);
  g += pow(r, 9.0) * 0.32;
  g += pow(ridged(fract(uv * 1.0 + wv * 0.3 + 0.5), 14.0, 2), 14.0) * 0.12;
  // the seams of the scales are a little lighter
  g += exp(-F.y / 0.09) * 0.07;
  return vec3(clamp(g, 0.45, 0.85));
}
vec2 glossOf(vec2 uv, vec4 F) {
  float s = 0.95 - 0.03 * exp(-F.y / 0.06) - 0.08 * (fbm(uv + 0.9, 6.0, 4) - 0.5) + 0.02 * F.z;
  return vec2(1.0, clamp(s, 0.75, 1.0));
}
float emissiveOf(vec2 uv, vec4 F) {
  float b = F.y;
  // per-stretch intensity so some seams glow and some fade out
  float k = smoothstep(0.3, 0.75, fbm(uv + 0.47, 5.0, 4)) * (0.35 + 0.65 * fract(F.z * 7.3));
  float core = exp(-b / 0.022);
  float halo = exp(-b / 0.1) * 0.22;
  float echo = exp(-abs(b - 0.16) / 0.018) * 0.18 * (0.5 + 0.5 * sin(F.w * 20.0));
  float e = (core + halo + echo) * mix(0.03, 1.0, k * k);
  return clamp(e * 0.8, 0.0, 0.7);
}
`

// ---- volcanic ---------------------------------------------------------------------------------------------------
const VOLCANIC = /* glsl */ `
#define VR 2
#define VK 0.05
vec4 field(vec2 uv) {
  float P = uCells > 0.5 ? uCells : 6.0;
  vec2 w = vec2(fbm(uv, 3.0, 3), fbm(uv + 0.37, 3.0, 3)) - 0.5;
  // irregularity: a tile-periodic low-frequency warp squeezes / stretches whole regions → pebble sizes vary
  // plus a mid-frequency warp (≈ P/3 per tile) of up to ~0.35 cell, so neighbouring pebbles differ in size and shape
  vec2 wl = vec2(fbm(uv + 0.13, 1.0, 3), fbm(uv + 0.71, 1.0, 3)) - 0.5;
  float fm = max(2.0, floor(P / 3.0));
  vec2 wm = vec2(fbm(uv + 0.29, fm, 2), fbm(uv + 0.83, fm, 2)) - 0.5;
  vec2 x = fract(uv + w * 0.12 + uIrr * (wl * 0.5 + wm * 1.2 / P)) * P;
  vec2 dc, id;
  vec4 V = voronoi(x, P, mat2(1.0, 0.18, 0.0, 1.05), mix(0.92, 1.0, uIrr), 5.0, dc, id);
  float b = V.y;
  vec2 g = (hash22(id + 17.0) - 0.5) * 1.5;      // per-pebble facet tilt
  // rounded pebble: a pillow that rises off the crease and flattens inside, a paraboloid crown around the cell
  // centre (−F1², continuous across borders) and a per-pebble tilt that fades in with the pillow
  float pillow = 1.0 - pow(1.0 - min(b / 0.4, 1.0), 2.0);
  float h = pillow * (0.45 + 0.35 * dot(g, dc) + 0.2 * V.z) - 0.35 * V.x * V.x;
  h += 0.035 * (fbm(uv + 0.19, 24.0, 3) - 0.5);   // glassy grain
  h /= P;
  return vec4(h, b, V.z, fbm(uv + 0.83, 4.0, 4));
}
vec3 albedoOf(vec2 uv, vec4 F) {
  float b = F.y;
  float base = 0.30 + (F.w - 0.5) * 0.12 + (F.z - 0.5) * 0.04;
  // light seams: a sharp core and a wide soft halo, plus a finer secondary vein net
  float seam = exp(-b / 0.06) * 0.16 + exp(-b / 0.22) * 0.14;
  vec2 dc2, id2;
  vec2 x2 = fract(uv + (vec2(fbm(uv + 0.5, 6.0, 3), fbm(uv + 0.2, 6.0, 3)) - 0.5) * 0.06) * 19.0;
  vec4 V2 = voronoi(x2, 19.0, mat2(1.0), 0.9, 9.0, dc2, id2);
  seam += exp(-V2.y / 0.05) * 0.06 * smoothstep(0.4, 0.7, F.w);
  seam *= mix(0.35, 1.3, smoothstep(0.3, 0.7, fbm(uv + 0.33, 4.0, 4)));
  // thin-film iridescence on the seams
  float ph = fbm(uv + 0.11, 7.0, 3) * 2.2 + b * 2.5;
  vec3 film = 0.5 + 0.5 * cos(6.2832 * (ph + vec3(0.0, 0.33, 0.67)));
  vec3 c = vec3(base) * vec3(1.03, 1.0, 0.97);
  c += seam * mix(vec3(1.0, 0.93, 0.84), film * 1.2, 0.28);
  c += exp(-b / 0.03) * 0.05 * film;                // a faint rainbow fringe right on the crease
  c += (fbm(uv + 0.77, 64.0, 2) - 0.5) * 0.05;    // speckle
  return clamp(c, 0.24, 0.72);
}
vec2 glossOf(vec2 uv, vec4 F) {
  float metal = 0.64 + (fbm(uv + 0.41, 3.0, 4) - 0.5) * 0.45;
  float s = 0.92;
  float blot = fbm(uv + 0.58, 3.0, 6);
  s -= 0.4 * smoothstep(0.48, 0.72, blot) + 0.18 * smoothstep(0.3, 0.5, blot);  // dull blotches
  float crack = pow(ridged(fract(uv + 0.21), 9.0, 3), 26.0);
  s -= 0.75 * crack * smoothstep(0.35, 0.6, fbm(uv + 0.05, 4.0, 2));  // hairline cracks, in patches
  return vec2(clamp(metal, 0.4, 0.88), clamp(s, 0.0, 0.96));
}
float emissiveOf(vec2 uv, vec4 F) { return 0.0; }
`

function makeRT(size: number, mips = true) {
  return new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    magFilter: THREE.LinearFilter,
    minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
    generateMipmaps: mips,
    depthBuffer: false,
    colorSpace: THREE.NoColorSpace,
  })
}

const fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

function renderPass(renderer: THREE.WebGLRenderer, material: THREE.Material, rt: THREE.WebGLRenderTarget) {
  const scene = new THREE.Scene()
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  quad.frustumCulled = false
  scene.add(quad)
  const prev = renderer.getRenderTarget()
  const prevAuto = renderer.autoClear
  renderer.autoClear = true
  renderer.setRenderTarget(rt)
  renderer.render(scene, fsCamera)
  renderer.setRenderTarget(prev)
  renderer.autoClear = prevAuto
  quad.geometry.dispose()
}

function bakeSet(renderer: THREE.WebGLRenderer, body: string, opts: RealisticOpts, strength: number, emissive: boolean, name: string): RealisticMaps {
  const size = Math.max(16, Math.round(opts.size ?? 1024))
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    // the material body starts with its '#define VR <n>' (Voronoi search radius), which LIB needs
    fragmentShader: body.split('\n').filter((l) => l.startsWith('#define')).join('\n') + LIB
      + body.split('\n').filter((l) => !l.startsWith('#define')).join('\n') + MAIN,
    uniforms: {
      uSeed: { value: (opts.seed ?? 1) % 1000 },
      uTexel: { value: 1 / size },
      uMap: { value: 0 },
      uStrength: { value: strength },
      uCells: { value: opts.cells ?? 0 },
      uIrr: { value: Math.min(1, Math.max(0, opts.irregularity ?? 0)) },
    },
    depthTest: false,
    depthWrite: false,
  })
  const rts: THREE.WebGLRenderTarget[] = []
  const bake = (map: number, label: string) => {
    const rt = makeRT(size)
    mat.uniforms.uMap.value = map
    renderPass(renderer, mat, rt)
    rt.texture.name = `${name}_${label}`
    rts.push(rt)
    return rt.texture
  }
  const out: RealisticMaps = {
    albedo: bake(0, 'albedo'),
    gloss: bake(1, 'gloss'),
    normal: bake(2, 'normal'),
    dispose: () => { for (const r of rts) r.dispose() },
  }
  if (emissive) out.emissive = bake(3, 'emissive')
  mat.dispose()
  return out
}

/** Scales: veined grey marble scales, metallic 1, high smoothness, glowing seams in `emissive`. Default size 1024. */
export function makeScalesMaps(renderer: THREE.WebGLRenderer, opts: RealisticOpts = {}): RealisticMaps {
  return bakeSet(renderer, SCALES, opts, 0.12, true, 'scales')
}

/** Volcanic: faceted dark glass with iridescent light seams; no emissive. Default size 1024 (512 is plenty). */
export function makeVolcanicMaps(renderer: THREE.WebGLRenderer, opts: RealisticOpts = {}): RealisticMaps {
  return bakeSet(renderer, VOLCANIC, opts, 0.75, false, 'volcanic')
}

// ---- animated note texture --------------------------------------------------------------------------------------
const SILK_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTime;

vec3 g3(vec3 c) {
  vec3 p = vec3(dot(c, vec3(127.1, 311.7, 74.7)), dot(c, vec3(269.5, 183.3, 246.1)), dot(c, vec3(113.5, 271.9, 124.6)));
  return normalize(fract(sin(p) * 43758.5453) * 2.0 - 1.0 + 1e-4);
}
// gradient noise, periodic in x/y with integer periods P, free in z (time); ≈ [-0.7, 0.7]
float gnoise(vec3 x, vec2 P) {
  vec3 i = floor(x), f = x - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n[8];
  for (int k = 0; k < 8; k++) {
    vec3 o = vec3(float(k - (k / 2) * 2), float((k / 2) - (k / 4) * 2), float(k / 4));
    vec3 c = vec3(mod(i.xy + o.xy, P), i.z + o.z);
    n[k] = dot(g3(c), f - o);
  }
  return mix(mix(mix(n[0], n[1], u.x), mix(n[2], n[3], u.x), u.y), mix(mix(n[4], n[5], u.x), mix(n[6], n[7], u.x), u.y), u.z);
}
void main() {
  vec2 uv = vUv;
  float t = uTime;
  // slow warp field, drifting upwards
  vec2 wp = vec2(3.0, 2.0);
  vec2 w = vec2(gnoise(vec3(uv * wp + vec2(0.0, -t * 0.05), t * 0.11), wp),
                gnoise(vec3(uv * wp + vec2(5.2, 1.3 - t * 0.05), t * 0.11 + 7.0), wp));
  vec2 q = uv + w * vec2(0.08, 0.2);
  // vertical filaments: ridged noise with more lattice cells across x than along y
  float lines = 0.0, halo = 0.0;
  vec2 F[4];
  F[0] = vec2(6.0, 1.0); F[1] = vec2(11.0, 2.0); F[2] = vec2(19.0, 3.0); F[3] = vec2(32.0, 5.0);
  float amp = 1.0;
  for (int k = 0; k < 4; k++) {
    vec2 Pk = F[k];
    float n = gnoise(vec3(q * Pk + vec2(0.0, -t * 0.03 * float(k + 1)), t * (0.16 + 0.07 * float(k)) + float(k) * 9.1), Pk);
    float r = clamp(1.0 - abs(n) * 2.2, 0.0, 1.0);
    lines += amp * pow(r, 10.0);
    halo += amp * pow(r, 2.5);
    amp *= 0.6;
  }
  float broad = gnoise(vec3(uv * vec2(2.0, 1.0), t * 0.07 + 3.0), vec2(2.0, 1.0));
  float v = 0.3 + 0.12 * halo + 0.4 * lines + 0.2 * broad;
  v = clamp(v, 0.12, 1.0);
  gl_FragColor = vec4(vec3(v), 1.0);
}
`

/**
 * Animated note texture: tileable grey flowing "silk" filaments
 * (mean ≈ 0.45, highlights → 1). `texture` is display space, rgb grey, a = 1, repeat-wrapped and mipmapped.
 * Call update(dt) once per frame (seconds); the animation is a pure function of the integrated time.
 */
export class SilkTexture {
  readonly texture: THREE.Texture
  time = 0
  private rt: THREE.WebGLRenderTarget
  private mat: THREE.ShaderMaterial
  private scene = new THREE.Scene()
  private quad: THREE.Mesh

  constructor(private renderer: THREE.WebGLRenderer, size = 512) {
    this.rt = makeRT(Math.max(16, Math.round(size)))
    this.rt.texture.name = 'silkTexture'
    this.texture = this.rt.texture
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: SILK_FRAG, uniforms: { uTime: { value: 0 } }, depthTest: false, depthWrite: false })
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
    this.render()
  }

  update(dt: number) {
    this.time += Math.min(Math.max(dt, 0), 0.25)
    this.render()
  }

  private render() {
    this.mat.uniforms.uTime.value = this.time % 4096
    const r = this.renderer
    const prev = r.getRenderTarget(), prevAuto = r.autoClear
    r.autoClear = true
    r.setRenderTarget(this.rt)
    r.render(this.scene, fsCamera)
    r.setRenderTarget(prev)
    r.autoClear = prevAuto
  }

  dispose() {
    this.rt.dispose()
    this.mat.dispose()
    this.quad.geometry.dispose()
  }
}

// ---- shading ----------------------------------------------------------------------------------------------------
/**
 * Realistic note shading. Paste into a fragment shader (GLSL ES 1/3 both fine) and call `realisticShade`.
 * All colour inputs and the result are DISPLAY space (sRGB-encoded values used as-is — same convention as the
 * reflective look in noteShader.ts); linearise only the final colour if the target is a linear buffer. The result may exceed 1 so bloom
 * can pick up highlights; alpha is the caller's.
 *
 * Coordinate frame: "display space" = screen-aligned, +x right, +y up, +z towards the viewer (notes are
 * axis-aligned quads, so the screen axes are the tangent frame).
 *
 *   vec3 realisticNormal(vec3 geomN, vec4 normalTexel, float depth)
 *     geomN       the note's geometric normal (e.g. the SDF bevel normal), unit, z > 0
 *     normalTexel a raw sample of RealisticMaps.normal
 *     depth       bump strength (1 = as baked; ~0.5–1.5 useful)
 *     → perturbed unit normal (slopes add, so the bevel keeps its shape)
 *
 *   vec2 realisticEnvBend(vec3 N, float amount)
 *     → offset to ADD to the caller's light-pattern / note-texture lookup coordinates so the reflection is bent by
 *       the surface (amount in lookup units at slope 1). Sample the pattern there and pass it as `env`.
 *
 *   vec3 realisticShade(vec3 tint, vec3 albedo, vec4 gloss, vec3 N, vec3 emissive, vec3 env,
 *                       RealisticLights L, RealisticParams P)
 *     tint      note colour
 *     albedo    RealisticMaps.albedo sample (rgb)
 *     gloss     RealisticMaps.gloss sample (r = metallic, g = smoothness)
 *     N         from realisticNormal
 *     emissive  RealisticMaps.emissive sample (vec3(0) when the set has none)
 *     env       the reflected environment = light pattern (× note texture, if used), mean ≈ 0.5, highlights ≥ 1
 *     L.keyDir / L.fillDir  unit directions TOWARDS the lights (display space), L.key / L.fill intensities,
 *     L.ambient ambient level
 *     P.albedoGain   overall albedo multiplier (≈ 1.6 scales, 2.0 volcanic with the baked maps)
 *     P.reflectivity weight of the environment reflection
 *     P.specular     weight of the key/fill highlights
 *     P.emission     emissive multiplier (0 = off)
 *     P.sheen        how strongly hot env spots push towards white (scaled by smoothness)
 *     P.contrast     env contrast around 0.5 (applied before the smoothness flattening)
 *
 * Model: base = tint·albedo·gain. Metals reflect in the base colour, dielectrics in a faint grey; rough
 * texels see a flattened (≈ blurred) environment, smooth texels the full-contrast pattern. Diffuse fades out with
 * metallic. Key/fill add Lambert + a normalised Blinn-Phong lobe whose exponent follows smoothness; a mild
 * grazing-angle boost makes bevels and bump flanks catch more light. Emission is tinted, with a white core where it
 * is strong. Finally hot env spots blend toward white (sheen) and very dark env slightly deepens the colour.
 */
export const REALISTIC_SHADING_GLSL = /* glsl */ `
struct RealisticLights { vec3 keyDir; float key; vec3 fillDir; float fill; float ambient; };
struct RealisticParams { float albedoGain; float reflectivity; float specular; float emission; float sheen; float contrast; };

vec3 realisticNormal(vec3 geomN, vec4 normalTexel, float depth) {
  vec3 t = normalTexel.xyz * 2.0 - 1.0;
  vec2 slope = geomN.xy / max(geomN.z, 0.2) + t.xy / max(t.z, 0.25) * depth;
  return normalize(vec3(slope, 1.0));
}

vec2 realisticEnvBend(vec3 N, float amount) { return N.xy / max(N.z, 0.25) * amount; }

float realisticLobe(vec3 N, vec3 Ldir, float s) {
  vec3 H = normalize(Ldir + vec3(0.0, 0.0, 1.0));
  float e = exp2(3.0 + 8.0 * s);                       // 8 … 2048
  return pow(max(dot(N, H), 0.0), e) * min((e + 8.0) / 25.0, 12.0) * step(0.0, dot(N, Ldir));
}

vec3 realisticShade(vec3 tint, vec3 albedo, vec4 gloss, vec3 N, vec3 emissive, vec3 env, RealisticLights L, RealisticParams P) {
  float metal = clamp(gloss.r, 0.0, 1.0);
  float sm = clamp(gloss.g, 0.0, 1.0);
  vec3 base = tint * albedo * P.albedoGain;

  // environment: contrast, then roughness flattens it toward its mean (stand-in for a blurred lookup)
  vec3 e = (env - 0.5) * P.contrast + 0.5;
  float eLum = dot(e, vec3(0.3333));
  e = mix(vec3(eLum) * 0.85 + 0.075, e, sm * sm);
  float graze = pow(1.0 - clamp(N.z, 0.0, 1.0), 2.0);
  vec3 F0 = mix(vec3(0.08), base, metal);
  vec3 refl = mix(F0, vec3(max(max(F0.r, F0.g), F0.b)), graze * 0.6) * (1.0 + graze) * e * P.reflectivity;

  // lights
  float k = max(dot(N, L.keyDir), 0.0) * L.key;
  float f = max(dot(N, L.fillDir), 0.0) * L.fill;
  vec3 diff = base * (1.0 - 0.8 * metal) * (L.ambient + k + f);
  vec3 spec = mix(vec3(0.5), base, metal) * P.specular
    * (realisticLobe(N, L.keyDir, sm) * L.key + realisticLobe(N, L.fillDir, sm) * L.fill);

  vec3 col = diff + refl + spec;

  // emission: tinted glow, whiter where strong
  vec3 em = emissive * P.emission;
  col += em * (tint + em * 0.8);

  // hot spots of the environment go toward white; deep shadows deepen a little
  float hot = smoothstep(0.75, 1.35, eLum);
  col += (1.0 - clamp(col, 0.0, 1.0)) * hot * P.sheen * sm;
  col *= mix(0.8, 1.0, smoothstep(0.05, 0.4, eLum));
  return max(col, 0.0);
}
`
