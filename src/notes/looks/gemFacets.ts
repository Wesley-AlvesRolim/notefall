// Analytic faceted note normals for the single-quad SDF note (note shapes `gem` and `angled`), computed per
// fragment from the note-local position alone — no mesh, no extra attribute, no texture.
//
// ---- gem (GEM_FACETS_GLSL) -------------------------------------------------------------------------------------------
// Outline: a rectangle with 45° chamfered corners (an octagon), corner leg `corner` (world units).
// Inside, every point gets its inset distance δ = −max(planeDist_i) over the octagon's edge lines (exact for a convex
// polygon: the level sets of δ are the inward offsets of the outline, still octagons). The crown is a height h(δ) that
// is piecewise LINEAR in δ over [0, bevel] (three rings, steep → shallow toward the middle) and constant (the table) for
// δ ≥ bevel. Because both the active edge line and the ring are piecewise constant, ∇h is piecewise constant ⇒ every
// (ring × edge) cell is a planar facet with a hard crease — table + 3 rings × 8 edges, like a cut gem — and because
// δ / bevel / corner are world distances the crown keeps its size as the note stretches (only the table and the
// straight runs grow). Short notes (halfSize < bevel) degrade gracefully into a ridge with no table.
// Anti-aliasing: the normal itself stays hard; gemFacets also returns the facet across the nearest crease + a 1 px
// box-filter weight, and the caller shades both and mixes the COLOURS (an interpolated normal passes through the
// specular lobe and draws a bright seam along every crease).
//
// ---- angled (ANGLED_FACETS_GLSL) ------------------------------------------------------------------------------------
// A hollow FRAME: one steep outward-tilted band of width `bevel` with rounded corners, an inner crest, and nothing in
// the middle (what is behind shows through). Analytically: rounded-box SDF d; band −bevel < d < 0; normal =
// normalize(slope·∇d, 1). Coverage must come from `angledFrameSdf` (the hole).
//
// Conventions: p = note-local position (note centre = 0), halfSize = half the note's W × H, all lengths in the same
// (world) units. Returned normals are unit, +z toward the viewer, xy in the note plane (x right, y up).

export const GEM_FACETS_GLSL = /* glsl */ `
// ring layout of the crown, as fractions of the bevel width (outer → inner) and slope multipliers (mean slope = 1)
#ifndef GEM_RING1
#define GEM_RING1 0.5
#define GEM_RING2 0.8
#define GEM_SLOPE0 1.37
#define GEM_SLOPE1 0.80
#define GEM_SLOPE2 0.38
#endif

// Outline SDF of the chamfered rectangle (polygonal: exact inside, a lower bound outside — fine for 1 px AA coverage).
float gemOutlineSdf(vec2 p, vec2 halfSize, float corner) {
  vec2 q = abs(p);
  float c = clamp(corner, 0.0, min(halfSize.x, halfSize.y));
  float dc = (q.x + q.y - (halfSize.x + halfSize.y - c)) * 0.70710678;
  return max(max(q.x - halfSize.x, q.y - halfSize.y), dc);
}

float gemRingSlope(float ring) {
  return ring < 0.5 ? GEM_SLOPE0 : (ring < 1.5 ? GEM_SLOPE1 : (ring < 2.5 ? GEM_SLOPE2 : 0.0));
}
float gemFacetKey(float ring, float e, vec2 s) {
  if (ring > 2.5) return 0.0;                                   // the table is one facet
  // a side facet spans two quadrants: key it by the side it lies on only (x sides by sign x, y sides by sign y)
  float quad = e == 0.0 ? (s.x > 0.0 ? 0.0 : 1.0)
             : (e == 2.0 ? (s.y > 0.0 ? 0.0 : 2.0) : (s.x > 0.0 ? 0.0 : 1.0) + (s.y > 0.0 ? 0.0 : 2.0));
  return 1.0 + ring * 12.0 + quad * 3.0 + e;
}

// Full version. Returns the HARD unit facet normal (constant per facet).
//   id    facet id: 0 = table, 1.. = crown ring × edge × side (an integer in a float, stable per facet)
//   edge  world distance to the nearest facet crease (0 on it; the outline is not a crease — use gemOutlineSdf)
//   nB, idB, wB  the facet across that nearest crease and its box-filter weight for a crease AA of width aa
//         (world units, ≈ 1 px; 0 → wB = 0). Anti-alias by SHADING twice: col = mix(shade(n), shade(nB), wB).
//         Do NOT blend the normals: an interpolated normal sweeps through the specular lobe and draws a bright seam.
vec3 gemFacets(vec2 p, vec2 halfSize, float bevel, float table, float corner, float aa,
               out float id, out float edge, out vec3 nB, out float idB, out float wB) {
  vec2 s = vec2(p.x > 0.0 ? 1.0 : -1.0, p.y > 0.0 ? 1.0 : -1.0);
  vec2 q = abs(p);
  float c = clamp(corner, 0.0, min(halfSize.x, halfSize.y));
  // signed distances to the three edge lines of this quadrant (outward normals NX, NC, NY)
  const vec2 NX = vec2(1.0, 0.0), NY = vec2(0.0, 1.0), NC = vec2(0.70710678, 0.70710678);
  float dx = q.x - halfSize.x;
  float dy = q.y - halfSize.y;
  float dc = (q.x + q.y - (halfSize.x + halfSize.y - c)) * 0.70710678;
  float dmax = max(dx, max(dy, dc));
  float delta = max(-dmax, 0.0);                                 // inset distance from the outline
  float e = dx >= dmax ? 0.0 : (dy >= dmax ? 2.0 : 1.0);         // active edge line: 0 = x side, 1 = chamfer, 2 = y side
  float b = max(bevel, 1e-6), r1 = b * GEM_RING1, r2 = b * GEM_RING2;
  float ring = delta < r1 ? 0.0 : (delta < r2 ? 1.0 : (delta < b ? 2.0 : 3.0));
  // runner-up edge line → the mitre crease between the two closest edge lines
  float d2; vec2 n1, n2; float e2;
  if (e == 0.0)      { n1 = NX; if (dy > dc) { d2 = dy; n2 = NY; e2 = 2.0; } else { d2 = dc; n2 = NC; e2 = 1.0; } }
  else if (e == 2.0) { n1 = NY; if (dx > dc) { d2 = dx; n2 = NX; e2 = 0.0; } else { d2 = dc; n2 = NC; e2 = 1.0; } }
  else               { n1 = NC; if (dx > dy) { d2 = dx; n2 = NX; e2 = 0.0; } else { d2 = dy; n2 = NY; e2 = 2.0; } }
  float mitre = (dmax - d2) / max(length(n1 - n2), 1e-4);
  // nearest ring line and the ring on its other side
  float bnd = abs(delta - r1) < abs(delta - r2) ? r1 : (abs(delta - r2) < abs(delta - b) ? r2 : b);
  float ringd = abs(delta - bnd);
  float ring2 = delta < bnd ? ring + 1.0 : ring - 1.0;

  float sl = gemRingSlope(ring) * table;
  vec3 n = normalize(vec3(s * n1 * sl, 1.0));
  id = gemFacetKey(ring, e, s);
  // inside the table the mitre lines are not creases (flat)
  bool acrossMitre = ring < 2.5 && mitre < ringd;
  edge = acrossMitre ? mitre : ringd;
  if (acrossMitre) { nB = normalize(vec3(s * n2 * sl, 1.0)); idB = gemFacetKey(ring, e2, s); }
  else { nB = normalize(vec3(s * n1 * gemRingSlope(ring2) * table, 1.0)); idB = gemFacetKey(ring2, e, s); }
  wB = aa > 0.0 ? clamp(0.5 - edge / aa, 0.0, 0.5) : 0.0;
  return n;
}

`

export const ANGLED_FACETS_GLSL = /* glsl */ `
float angledBoxSdf(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
// Coverage SDF of the hollow frame (outer rounded box minus its inward offset by bevel). < 0 = on the frame.
float angledFrameSdf(vec2 p, vec2 halfSize, float bevel, float radius) {
  float r = clamp(radius, 0.0, min(halfSize.x, halfSize.y));
  float d = angledBoxSdf(p, halfSize, r);
  return max(d, -d - bevel);
}
// Normal of the frame's single steep outward band: normalize(slope · ∇d, 1). Smooth cone at the corners, a hard
// crease only at the crest (inner edge). Valid where angledFrameSdf < 0.
vec3 angledNormal(vec2 p, vec2 halfSize, float bevel, float radius, float slope) {
  float r = clamp(radius, 0.0, min(halfSize.x, halfSize.y));
  vec2 s = vec2(p.x > 0.0 ? 1.0 : -1.0, p.y > 0.0 ? 1.0 : -1.0);
  vec2 q = abs(p) - halfSize + r;
  vec2 g;
  if (q.x > 0.0 && q.y > 0.0) g = normalize(q);
  else g = q.x > q.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  return normalize(vec3(s * g * slope, 1.0));
}
`
