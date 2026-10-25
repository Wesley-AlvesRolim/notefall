import { KEY_COUNT } from './layout'

/**
 * Per-key light level multiplier while a key lifts between same-pitch
 * repeats (1 = full). Written each frame by `Keyboard`, which owns the
 * lift; read by `LandingFlashes` so the flash — the light source — dims
 * together with the key glow and the light / shadow it casts on the keys.
 * `Keyboard` mounts before `LandingFlashes`, so both read the same frame's
 * value.
 */
export const retriggerDip = new Float32Array(KEY_COUNT).fill(1)
