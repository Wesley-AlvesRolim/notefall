// Mirror engine.ts. The lookahead has no audible-click concern in an
// offline render (samples are perfectly quantum-aligned), but matching
// the live engine's offset means a re-rendered take lines up sample-
// for-sample with what the user heard during preview.
export const LOOKAHEAD = 0.015
export const STOP_BUFFER = 0.02

/**
 * Default sample rate for offline audio export. 44.1 kHz is CD quality
 * and keeps `OfflineAudioContext.startRendering()` noticeably faster
 * than 48 kHz on Chrome's main-thread implementation — the convolution
 * reverb cost scales linearly with sample rate, and the dominant cost
 * during export is convolution, not voice scheduling. The audible
 * difference vs. 48 kHz is below human-hearing thresholds for piano
 * material; the video pass overrides this to match its codec's rate.
 */
export const DEFAULT_SAMPLE_RATE = 44_100
