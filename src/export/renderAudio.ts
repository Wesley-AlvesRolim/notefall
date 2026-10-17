import type { ParsedSong } from '../midi/types'
import type { Settings } from '../store'
import { raceWithAbort } from './async'
import { AudioRenderAborted } from './errors'
import { loadOfflinePiano } from './synth/piano'
import { scheduleSongNotes, scheduleUserAudio } from './synth/schedule'
import { computeExportTimeline } from './timeline'
import type { AudioRenderProgress, OfflinePiano, UserAudioTrack } from './synth/types'

export type { AudioRenderProgress, UserAudioTrack }

/**
 * Offline render of `song` with the given `settings` into a stereo
 * `AudioBuffer`. Mirrors the realtime AudioEngine's scheduling so the
 * exported audio sounds identical to live playback at rate=1, with the
 * same per-note attack lookahead, stop buffer, and pedal-sustain
 * semantics.
 *
 * Live (touch / MIDI input) notes are NOT rendered — only the song
 * timeline. Loop / playbackRate / fast-forward are also ignored: a
 * single linear pass from t=0 through `song.duration + TAIL_SECONDS`.
 *
 * Implemented as a single `OfflineAudioContext.startRendering()` call.
 * That means everything must be scheduled up-front; we don't get
 * incremental progress callbacks during the render itself, only the
 * up-front sample-load progress.
 */
export async function renderSongAudio(
  song: ParsedSong,
  settings: Settings,
  sampleRate: number,
  onProgress?: (p: AudioRenderProgress) => void,
  signal?: AbortSignal,
  userAudio?: UserAudioTrack | null,
): Promise<AudioBuffer> {
  if (signal?.aborted) throw new AudioRenderAborted()
  const timeline = computeExportTimeline(song, settings, userAudio ?? null)
  const { totalDuration } = timeline
  const length = Math.max(1, Math.ceil(totalDuration * sampleRate))

  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length,
    sampleRate,
  })

  // Mirror the realtime engine's master × midi × enabled stacking so
  // an export sounds the same as live playback. midiEnabled = false
  // produces a silent sampler track (the user audio still mixes,
  // matching the user's intent of "synced accompaniment, no synth").
  const samplerGain = settings.midiEnabled
    ? settings.volume * settings.midiVolume
    : 0

  // When the sampler track is muted (volume = 0) we skip loading the
  // ~60 MB sample set AND scheduling notes entirely. The render
  // collapses to "userAudio mix + silence" — orders of magnitude
  // faster, and audibly identical to the muted render.
  let piano: OfflinePiano | null = null
  if (samplerGain > 0) {
    piano = await loadOfflinePiano(ctx, settings, samplerGain, onProgress, signal)
  } else {
    // Emit a synthetic "loaded" pulse so progress UI doesn't sit on
    // 0/1 — the modal's audio-fraction calculation expects to see
    // the loading sub-phase complete.
    onProgress?.({ phase: 'loading', loaded: 1, total: 1 })
  }

  if (userAudio) scheduleUserAudio(ctx, userAudio, settings, timeline)
  if (piano) scheduleSongNotes(piano, song, settings, timeline)

  if (signal?.aborted) {
    piano?.dispose()
    throw new AudioRenderAborted()
  }

  // Poll `ctx.currentTime` to report rendering progress. OfflineAudioContext
  // doesn't fire a progress event, but `currentTime` does advance during
  // rendering (the engine processes blocks off the main thread and updates
  // the timeline). 100 ms is fine-grained enough for a smooth progress bar
  // without burning main-thread cycles. We always emit a final 1.0 after
  // the promise resolves so the bar settles at 100% before the modal
  // dismisses.
  onProgress?.({ phase: 'rendering', progress: 0 })
  const renderPromise = ctx.startRendering()
  const pollHandle = window.setInterval(() => {
    onProgress?.({
      phase: 'rendering',
      progress: Math.min(1, ctx.currentTime / totalDuration),
    })
  }, 100)
  let buffer: AudioBuffer
  try {
    // Race the offline render against the abort signal — once
    // `startRendering()` is called there's no way to actually stop
    // the offline context, but at least surface the cancel
    // synchronously so the modal dismisses immediately, and tear
    // down the piano + chain so the still-pending render finishes
    // near-instantly with silence rather than burning CPU on the
    // convolver + voice graph.
    buffer = await raceWithAbort(renderPromise, signal, () => new AudioRenderAborted())
  } catch (e) {
    // dispose() severs the entire effect chain — see sampler.ts.
    // Without this, the OfflineAudioContext can hog CPU for tens of
    // seconds after Cancel, leaving the page unresponsive even
    // through a reload (the browser's reload waits for the running
    // task to yield).
    piano?.dispose()
    throw e
  } finally {
    window.clearInterval(pollHandle)
  }
  onProgress?.({ phase: 'rendering', progress: 1 })

  // Belt-and-suspenders: if abort fired in the narrow window between
  // raceWithAbort resolving and now, still dispose + bail.
  if (signal?.aborted) {
    piano?.dispose()
    throw new AudioRenderAborted()
  }

  onProgress?.({ phase: 'done' })

  // Free the smplr-internal AudioNodes once rendering is complete. The
  // OfflineAudioContext itself is single-use and will be GC'd once we
  // return.
  piano?.dispose()

  return buffer
}
