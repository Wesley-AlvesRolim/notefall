import * as THREE from 'three'

/**
 * Procedural, tileable "hammered / beaten metal" tangent-space normal map.
 *
 * Model: the sheet starts flat and every hammer blow presses a shallow paraboloid cup into it. The surface is the
 * (smoothed) lower envelope of all cups, so neighbouring blows meet in soft creases — the same faceted-cup look as
 * real planished copper. Blow centres sit on a jittered periodic lattice (period = `dentScale` cells per tile) so the
 * map wraps seamlessly; each blow gets its own radius of curvature and depth, which makes some cups swallow their
 * neighbours and yields the mixed large / small facet sizes. A faint periodic value-noise fbm adds micro-grain.
 *
 * Everything runs in one fullscreen fragment pass: height is evaluated at the texel and its four neighbours and the
 * normal comes from central differences. Output goes to an RGBA8 render target with mipmaps.
 */
export type HammeredOpts = {
  /** Texture size in px (square). Default 512. */
  size?: number
  /** Random seed; any number. Default 1. */
  seed?: number
  /** Hammer blows per tile edge (lattice period). Default 16. */
  dentScale?: number
  /** Bump strength 0..1. Default 0.5. */
  dentDepth?: number
  /** Fine micro-roughness 0..1. Default 0.3. */
  grain?: number
}

export const HAMMERED_DEFAULTS: Required<HammeredOpts> = {
  size: 512,
  seed: 1,
  dentScale: 16,
  dentDepth: 0.5,
  grain: 0.3,
}

/** Slope gain at dentDepth = 1 (tuned by eye for a planished-copper look). */
const STRENGTH = 0.19

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uCells;   // small-blow lattice period (blows per tile edge), integer
  uniform float uCellsBig; // large, faint blow lattice period, integer
  uniform float uCellsTiny; // tiny pit lattice period, integer
  uniform float uSeed;
  uniform float uDepth;
  uniform float uGrain;
  uniform float uStrength;

  // Hash on a lattice coordinate; cell coords are wrapped by the caller so every field is periodic.
  vec3 hash3(vec2 c, float salt) {
    vec3 p = vec3(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)), dot(c, vec2(419.2, 371.9)));
    return fract(sin(p + uSeed * 17.31 + salt) * 43758.5453);
  }
  float hash1(vec2 c, float period) {
    c = mod(c, period);
    return fract(sin(dot(c, vec2(12.9898, 78.233)) + uSeed * 3.7) * 43758.5453);
  }

  // Height + gradient of the beaten sheet; p in lattice units with period 'cells'.
  // Surface = smooth lower envelope of per-blow paraboloid cups. The quadratic smooth-min has the handy property
  // that its gradient is exactly the blend-weighted mix of the two input gradients, so we get analytic normals
  // in a single pass (no extra height taps).
  vec3 blows(vec2 p, float cells, float salt, float k) {
    vec2 ip = floor(p);
    vec2 fp = p - ip;
    vec3 acc = vec3(0.6, 0.0, 0.0); // (height, d/dx, d/dy); flat sheet level above every cup centre
    for (int j = -2; j <= 2; j++) {
      for (int i = -2; i <= 2; i++) {
        vec2 o = vec2(float(i), float(j));
        vec3 r = hash3(mod(ip + o, cells), salt);
        vec2 d = fp - (o + 0.15 + 0.7 * r.xy);             // offset from the jittered blow centre
        float curv = mix(0.6, 1.5, r.z);                    // tighter cup = smaller hammer face
        float floorZ = -mix(0.0, 0.3, fract(r.z * 7.13 + r.x)); // per-blow depth
        vec3 cup = vec3(floorZ + curv * dot(d, d), 2.0 * curv * d);
        float h = clamp(0.5 + 0.5 * (cup.x - acc.x) / k, 0.0, 1.0);
        acc = vec3(mix(cup.x, acc.x, h) - k * h * (1.0 - h), mix(cup.yz, acc.yz, h));
      }
    }
    return acc;
  }

  // Periodic value noise with analytic gradient (for the micro-grain).
  vec3 vnoise(vec2 p, float period) {
    vec2 i = floor(p), f = p - i;
    vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
    float a = hash1(i, period), b = hash1(i + vec2(1, 0), period);
    float c = hash1(i + vec2(0, 1), period), d = hash1(i + vec2(1, 1), period);
    float v = a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
    vec2 g = du * vec2(b - a + (a - b - c + d) * u.y, c - a + (a - b - c + d) * u.x);
    return vec3(v, g);
  }

  void main() {
    vec2 uv = vUv;
    // Gentle periodic warp so the lattice never reads as a grid (its derivative is ignored; it is tiny).
    vec2 w = vec2(vnoise(uv * 4.0, 4.0).x, vnoise(uv * 4.0 + 19.7, 4.0).x) - 0.5;
    vec2 q = fract(uv + w * 0.03);

    // Gradients below are in tile units: a lattice field f(p * N) / N has gradient grad_p f.
    // Three blow sizes: faint large planishing marks, the main dents, and tiny peening pits inside them.
    vec3 big = blows(q * uCellsBig, uCellsBig, 5.3, 0.12);
    vec3 main = blows(q * uCells, uCells, 0.0, 0.06);
    vec3 tiny = blows(q * uCellsTiny, uCellsTiny, 9.1, 0.05);
    vec2 g = main.yz + 0.7 * big.yz + 0.5 * tiny.yz;

    // Micro-grain: two octaves of fine periodic value noise, slope scaled by its frequency.
    vec2 gg = vec2(0.0);
    float f = 64.0, amp = 1.0;
    for (int o = 0; o < 2; o++) { gg += amp * vnoise(q * f, f).yz; f *= 2.0; amp *= 0.6; }
    g += uGrain * 0.06 * gg;

    vec3 n = normalize(vec3(-g * uDepth * uStrength, 1.0));
    gl_FragColor = vec4(n.xy * 0.5 + 0.5, n.z, 1.0);
  }
`

/** Bake a hammered-metal normal map on the GPU. The returned texture owns a render target; dispose() the texture. */
export function makeHammeredNormal(renderer: THREE.WebGLRenderer, opts: HammeredOpts = {}): THREE.Texture {
  const o = { ...HAMMERED_DEFAULTS, ...opts }
  const size = Math.max(4, Math.round(o.size))
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearMipmapLinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
    colorSpace: THREE.NoColorSpace,
  })

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uCells: { value: Math.max(1, Math.round(o.dentScale)) },
      uSeed: { value: o.seed % 1000 },
      uDepth: { value: o.dentDepth },
      uGrain: { value: o.grain },
      uCellsBig: { value: Math.max(1, Math.round(o.dentScale / 2.3)) },
      uCellsTiny: { value: Math.max(1, Math.round(o.dentScale * 2.6)) },
      uStrength: { value: STRENGTH },
    },
    depthTest: false,
    depthWrite: false,
  })
  const scene = new THREE.Scene()
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  quad.frustumCulled = false
  scene.add(quad)
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  const prevTarget = renderer.getRenderTarget()
  const prevAutoClear = renderer.autoClear
  renderer.autoClear = true
  renderer.setRenderTarget(rt)
  renderer.render(scene, camera)
  renderer.setRenderTarget(prevTarget)
  renderer.autoClear = prevAutoClear

  material.dispose()
  quad.geometry.dispose()

  const tex = rt.texture
  tex.name = 'hammeredNormal'
  // Disposing the texture should also free the framebuffer that backs it.
  let freed = false
  tex.addEventListener('dispose', () => {
    if (freed) return
    freed = true
    rt.dispose()
  })
  return tex
}
