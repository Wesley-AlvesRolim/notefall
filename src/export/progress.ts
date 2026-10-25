/**
 * Weights for combining audio and video into one progress bar. The
 * audio path runs in parallel with the video path (OfflineAudioContext
 * renders off the main thread; sample fetches happen in the background)
 * so this is just a UX hint — neither finishes "first" in any
 * deterministic way. The audio side covers loading + render + encode;
 * the video side is the dominant frame loop, so it gets the larger
 * share.
 */
const AUDIO_PROGRESS_WEIGHT = 0.4
const VIDEO_PROGRESS_WEIGHT = 0.6

/** Within the audio path: loading 35% / offline render 55% / encode 10%. */
const AUDIO_LOADING_SHARE = 0.35
const AUDIO_RENDER_SHARE = 0.55
const AUDIO_ENCODE_SHARE = 0.1

/** Minimum change before re-emitting, so the UI isn't flooded per frame. */
const EMIT_STEP = 0.005

export type AvRenderProgress = {
  audioLoading: (fraction: number) => void
  audioRender: (fraction: number) => void
  audioEncode: (fraction: number) => void
  video: (fraction: number) => void
}

/**
 * Single monotonic progress bar for a concurrent audio + video render:
 * a weighted sum of two independent fractions. Without an audio track
 * the audio weight collapses to 0 and the bar is pure video progress.
 */
export function createAvRenderProgress(
  hasAudio: boolean,
  emit: (overall: number) => void,
): AvRenderProgress {
  const audioWeight = hasAudio ? AUDIO_PROGRESS_WEIGHT : 0
  const videoWeight = hasAudio ? VIDEO_PROGRESS_WEIGHT : 1
  let audioFraction = hasAudio ? 0 : 1
  let videoFraction = 0
  let lastEmitted = -1

  const update = () => {
    const overall = audioWeight * audioFraction + videoWeight * videoFraction
    if (overall - lastEmitted > EMIT_STEP || overall === 1) {
      lastEmitted = overall
      emit(overall)
    }
  }

  return {
    audioLoading: (f) => {
      audioFraction = AUDIO_LOADING_SHARE * f
      update()
    },
    audioRender: (f) => {
      audioFraction = AUDIO_LOADING_SHARE + AUDIO_RENDER_SHARE * f
      update()
    },
    audioEncode: (f) => {
      audioFraction = AUDIO_LOADING_SHARE + AUDIO_RENDER_SHARE + AUDIO_ENCODE_SHARE * f
      update()
    },
    video: (f) => {
      videoFraction = f
      update()
    },
  }
}
