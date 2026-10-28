import type * as THREE from 'three'

/**
 * Whether a draw into `rt` should output LINEAR colour (the composer's buffer) instead of sRGB-encoded (the canvas).
 * The hands' motion-blur targets stand in for the canvas when Bloom is off: they are flagged `nfEncoded` and hold
 * sRGB-encoded values, so alpha-blended layers (glows, particles, labels) blend exactly as on the canvas.
 */
export const isLinearTarget = (rt: THREE.WebGLRenderTarget | null): boolean => !!rt && !(rt as { nfEncoded?: boolean }).nfEncoded
