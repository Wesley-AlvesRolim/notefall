import { audioBufferToWav } from 'smplr'
import type { ParsedSong } from '../midi/types'
import type { Settings } from '../store'
import { AudioRenderAborted } from './errors'
import { renderSongAudio, type AudioRenderProgress, type UserAudioTrack } from './renderAudio'
import { DEFAULT_SAMPLE_RATE } from './synth/consts'
import { defaultExportFileName, triggerDownload } from './download'

export type AudioExportResult =
  | { kind: 'ok' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

/**
 * Render the loaded song to a WAV blob and trigger a browser download.
 * Phase 2 of the video-export feature: validates that the offline audio
 * pipeline (smplr + OfflineAudioContext + the engine's effect chain)
 * produces audible output that matches live playback. The eventual
 * video-export pipeline will reuse `renderSongAudio` and feed the
 * resulting `AudioBuffer` into the muxer instead of writing a WAV.
 */
export async function exportSongToWav(
  song: ParsedSong,
  settings: Settings,
  options?: {
    sampleRate?: number
    fileName?: string
    onProgress?: (p: AudioRenderProgress) => void
    signal?: AbortSignal
    userAudio?: UserAudioTrack | null
  },
): Promise<AudioExportResult> {
  try {
    const buffer = await renderSongAudio(
      song,
      settings,
      options?.sampleRate ?? DEFAULT_SAMPLE_RATE,
      options?.onProgress,
      options?.signal,
      options?.userAudio ?? null,
    )
    if (options?.signal?.aborted) return { kind: 'cancelled' }
    const blob = audioBufferToWav(buffer)
    const fileName = options?.fileName ?? defaultExportFileName(song.name, 'wav')
    triggerDownload(blob, fileName)
    return { kind: 'ok' }
  } catch (e) {
    if (e instanceof AudioRenderAborted) return { kind: 'cancelled' }
    const message = e instanceof Error ? e.message : String(e)
    return { kind: 'error', message }
  }
}
