import * as THREE from 'three'

/**
 * Procedural, tileable "crystal / cut ice" tangent-space normal map.
 *
 * Model: the surface is the upper envelope of many convex, gem-cut "stones". Each stone sits on a jittered periodic
 * lattice cell and is a convex polyhedral cap: the min of a slightly tilted top facet, a ring of shallow crown facets
 * and a ring of steeper girdle facets, each plane with its own azimuth, slope and offset. Taking the max over the
 * neighbouring stones makes them meet in sharp V-creases, and because every term is a plane the result is exactly
 * piecewise-flat — constant normal per facet, crisp edges — like cut ice. A second, finer stone layer sunk
 * a little lower pokes up only in the valleys between the big stones, giving the mixed large / small facet sizes.
 *
 * Heights are compared in tile units (lattice height / period), but facet slopes are lattice-independent, so `scale`
 * changes facet count without changing how strongly they tilt. The normal is taken analytically from the winning
 * plane (no finite differences), averaged over a 4-tap rotated-grid supersample so facet edges are antialiased.
 *
 * Alpha carries a baked facet-edge map, stored as 1 − edge (so a map without one, alpha 1, has no edges): a thin
 * line along every crease, strong in proportion to the slope change across it. Because every facet is a plane, the
 * distance to a crease is exact from the two planes meeting there (height gap / slope difference), so the line is
 * smooth and anti-aliased at bake time — deriving it in the note shader from `fwidth` of the map slope steps per
 * 2×2 pixel quad.
 * One fullscreen fragment pass into an RGBA8 render target with mipmaps.
 */
export type CrystalBumpOpts = {
  /** Texture size in px (square). Default 1024. */
  size?: number
  /** Random seed; any number. Default 1. */
  seed?: number
  /** Large stones per tile edge (lattice period). Default 9. */
  scale?: number
  /** Bump strength 0..1 (facet tilt). Default 0.5. */
  depth?: number
}

export const CRYSTAL_BUMP_DEFAULTS: Required<CrystalBumpOpts> = {
  size: 1024,
  seed: 1,
  scale: 9,
  depth: 0.5,
}

/** Slope gain at depth = 1 (tuned by eye). */
const STRENGTH = 0.62

/** Facet-edge strength ramp over the slope change across a crease (slope units of the baked map). */
const EDGE_LO = 0.1
const EDGE_HI = 0.45
/** Facet-edge line profile: full strength within EDGE_IN texels of the crease, gone at EDGE_OUT. */
const EDGE_IN = 0
const EDGE_OUT = 0.75

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uCells;     // big-stone lattice period (integer)
  uniform float uCellsFine; // fine-stone lattice period (integer)
  uniform float uSeed;
  uniform float uGain;      // depth * strength
  uniform vec2 uTexel;      // 1 / size
  uniform float uSize;      // texels per tile edge

  // Facet-edge line: strength from the slope change across the crease (in the shader's slope units), profile from
  // the distance to it in texels.
  const float EDGE_LO = ${EDGE_LO.toFixed(4)}, EDGE_HI = ${EDGE_HI.toFixed(4)};
  const float EDGE_IN = ${EDGE_IN.toFixed(4)}, EDGE_OUT = ${EDGE_OUT.toFixed(4)};
  float gEdge; // strongest crease line at the current tap
  // One crease candidate: the active plane is 'gap' (tile-height units, ≥ 0) away from a plane whose slope differs
  // by dg (per tile) — the crease line between them lies gap / |dg| tiles away.
  void crease(float gap, vec2 dg) {
    float dl = length(dg);
    if (dl < 1e-5) return;
    float px = max(gap, 0.0) / dl * uSize;
    gEdge = max(gEdge, smoothstep(EDGE_LO, EDGE_HI, dl * uGain) * (1.0 - smoothstep(EDGE_IN, EDGE_OUT, px)));
  }

  vec4 hash4(vec2 c, float salt) {
    vec4 p = vec4(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)), dot(c, vec2(419.2, 371.9)), dot(c, vec2(73.7, 251.3)));
    return fract(sin(p + uSeed * 17.31 + salt) * 43758.5453);
  }
  vec4 hash4b(vec2 c, float salt) { return hash4(c + 0.37 * salt, salt + 3.1); }

  // One stone: convex polyhedral cap centred at 0 (d = offset from its centre, lattice units).
  // Returns (height, dh/dx, dh/dy) of the active (lowest) plane. edges > 0: also scores the creases between that
  // plane and the others (sz / cells turn the stone's local heights into tile units).
  vec3 stoneImpl(vec2 d, vec2 cell, float salt, vec3 act, float edges) {
    vec4 r0 = hash4(cell, salt);
    vec4 r1 = hash4b(cell, salt + 1.0);
    // Top facet: random tilt, so even the crown table catches light differently per stone.
    vec2 tg = (r1.xy - 0.5) * 0.35;
    d -= (r1.zw - 0.5) * 0.3; // off-centre apex
    float top = 0.4 + 0.12 * r0.z;
    vec3 best = vec3(top + dot(tg, d), tg);
    if (edges > 0.0) crease((best.x - act.x) * edges, best.yz - act.yz);
    float rot = r0.w * 6.2831853;
    // Crown: 4 shallow facets close to the centre.
    for (int k = 0; k < 4; k++) {
      float fk = float(k);
      vec4 rk = hash4(cell + vec2(fk * 7.0 + 1.0, 3.0), salt + 5.0);
      float a = rot + (fk + 0.7 * (rk.x - 0.5)) * 1.5707963;
      vec2 dir = vec2(cos(a), sin(a));
      float sl = mix(0.12, 0.6, rk.y);
      float h = top + sl * (mix(-0.05, 0.12, rk.w) - dot(dir, d));
      if (h < best.x) best = vec3(h, -sl * dir);
      if (edges > 0.0) crease((h - act.x) * edges, -sl * dir - act.yz);
    }
    // Girdle: 5 steeper facets further out, rotated against the crown, forming the valley walls.
    for (int k = 0; k < 5; k++) {
      float fk = float(k);
      vec4 rk = hash4(cell + vec2(fk * 7.0 + 2.0, 17.0), salt + 9.0);
      float a = rot + (fk + 0.5 + 0.7 * (rk.x - 0.5)) * 1.2566371;
      vec2 dir = vec2(cos(a), sin(a));
      float sl = mix(0.6, 1.0, rk.y);
      float h = top + sl * (mix(0.3, 0.45, rk.w) - dot(dir, d));
      if (h < best.x) best = vec3(h, -sl * dir);
      if (edges > 0.0) crease((h - act.x) * edges, -sl * dir - act.yz);
    }
    return best;
  }
  vec3 stone(vec2 d, vec2 cell, float salt) { return stoneImpl(d, cell, salt, vec3(0.0), 0.0); }

  // Upper envelope of stones on a period-'cells' lattice; height returned in tile units. Also scores the creases of
  // the winning plane (within its stone and against the other stones) into gEdge.
  vec3 layer(vec2 uv, float cells, float salt) {
    vec2 p = uv * cells;
    // 4x4 neighbourhood centred on the nearest lattice corner (stones reach ~1.5 cells from their own cell).
    vec2 ip = floor(p - 0.5), fp = p - ip;
    vec3 acc = vec3(-1e9, 0.0, 0.0);
    vec3 st[16];
    vec2 wd = vec2(0.0), wc = vec2(0.0);
    float wsz = 1.0;
    for (int j = -1; j <= 2; j++) {
      for (int i = -1; i <= 2; i++) {
        vec2 o = vec2(float(i), float(j));
        vec2 cell = mod(ip + o, cells);
        vec4 r = hash4(cell, salt + 11.0);
        vec2 d = fp - (o + 0.1 + 0.8 * r.xy);
        // Size variation: scale the stone's footprint (heights scale with it, slopes stay).
        float sz = mix(0.85, 1.15, r.z);
        vec3 s = stone(d / sz, cell, salt);
        s.x *= sz;
        st[(j + 1) * 4 + i + 1] = s;
        if (s.x > acc.x) { acc = s; wd = d / sz; wc = cell; wsz = sz; }
      }
    }
    // creases against the neighbouring stones (the active plane of each, linearised there) …
    for (int n = 0; n < 16; n++) crease((acc.x - st[n].x) / cells, acc.yz - st[n].yz);
    // … and between the winning plane and the other facets of its own stone
    stoneImpl(wd, wc, salt, vec3(acc.x / wsz, acc.yz), wsz / cells);
    acc.x /= cells;
    return acc;
  }

  vec2 slopeAt(vec2 uv) {
    gEdge = 0.0;
    vec3 big = layer(uv, uCells, 0.0);
    float eBig = gEdge;
    gEdge = 0.0;
    vec3 fine = layer(uv, uCellsFine, 29.0);
    fine.x -= 0.16 / uCells; // sunk: only rises in valleys between big stones
    // only the visible layer's creases count, plus the one where the two layers meet
    gEdge = fine.x > big.x ? gEdge : eBig;
    crease(abs(fine.x - big.x), fine.yz - big.yz);
    return fine.x > big.x ? fine.yz : big.yz;
  }

  void main() {
    // 4-tap rotated-grid supersample of the (discontinuous) slope field.
    vec2 g = vec2(0.0);
    float e = 0.0;
    g += slopeAt(fract(vUv + uTexel * vec2( 0.125,  0.375))); e += gEdge;
    g += slopeAt(fract(vUv + uTexel * vec2(-0.375,  0.125))); e += gEdge;
    g += slopeAt(fract(vUv + uTexel * vec2(-0.125, -0.375))); e += gEdge;
    g += slopeAt(fract(vUv + uTexel * vec2( 0.375, -0.125))); e += gEdge;
    g *= 0.25;
    vec3 n = normalize(vec3(-g * uGain, 1.0));
    gl_FragColor = vec4(n.xy * 0.5 + 0.5, n.z, 1.0 - 0.25 * e);
  }
`

/** Bake a crystal / cut-ice normal map on the GPU. The returned texture owns a render target; dispose() the texture. */
export function makeCrystalNormal(renderer: THREE.WebGLRenderer, opts: CrystalBumpOpts = {}): THREE.Texture {
  const o = { ...CRYSTAL_BUMP_DEFAULTS, ...opts }
  const size = Math.max(4, Math.round(o.size))
  const cells = Math.max(1, Math.round(o.scale))
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
      uCells: { value: cells },
      uCellsFine: { value: Math.max(2, Math.round(cells * 2.2)) },
      uSeed: { value: o.seed % 1000 },
      uGain: { value: Math.max(0, o.depth) * STRENGTH },
      uTexel: { value: new THREE.Vector2(1 / size, 1 / size) },
      uSize: { value: size },
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
  tex.name = 'crystalNormal'
  let freed = false
  tex.addEventListener('dispose', () => {
    if (freed) return
    freed = true
    rt.dispose()
  })
  return tex
}
