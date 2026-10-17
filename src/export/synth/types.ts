export type AudioRenderProgress =
  | { phase: 'loading'; loaded: number; total: number }
  | { phase: 'rendering'; progress: number }
  | { phase: 'done' }

/**
 * User-provided accompaniment mixed alongside the sampled piano. Times
 * are in seconds on the export timeline (`offsetSec`) or in the
 * buffer's own time (`trimStartSec` / `trimEndSec`).
 */
export type UserAudioTrack = {
  buffer: AudioBuffer
  offsetSec: number
  volume: number
  trimStartSec: number
  trimEndSec: number | null
}
