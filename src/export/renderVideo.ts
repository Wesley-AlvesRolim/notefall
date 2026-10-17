import * as THREE from 'three'
import type { ParsedSong } from '../midi/types'
import type { Settings } from '../store'
import { VirtualClock, resetActiveClock, setActiveClock } from '../audio/clock'
import { audioEngine } from '../audio/engine'
import { getR3FState } from '../scene/exportBridge'
import { AudioRenderAborted, VideoRenderAborted } from './errors'
import { renderSongAudio } from './renderAudio'
import { MAX_ENCODE_QUEUE, raceWithAbort, yieldToEventLoop } from './async'
import { encodeAudioBuffer } from './codec/audio'
import { computeExportTimeline } from './timeline'
import type { UserAudioTrack } from './synth/types'
import { VIDEO_CODECS } from './codec/codecs'
import { isVideoExportSupported, probeVideoCodecs, videoEncoderConfig } from './codec/video'
import { createMuxer } from './codec/muxer'
import { assertEncodersSupported } from './codec/preflight'
import type { AudioTrackConfig, VideoCodec } from './codec/types'

export { VIDEO_CODECS, isVideoExportSupported, probeVideoCodecs }
export type { AudioTrackConfig }

/** 1 keyframe per second is a comfortable seeking interval. */
const KEYFRAME_INTERVAL_SECONDS = 1

/**
 * Weights for combining audio and video into one progress bar. The
 * audio path runs in parallel with the video path (OfflineAudioContext
 * renders off the main thread; sample fetches happen in the background)
 * so this is just a UX hint — neither finishes "first" in any
 * deterministic way. The audio side covers loading + render + AAC
 * encode; the video side is the dominant frame loop, so it gets the
 * larger share.
 */
const AUDIO_PROGRESS_WEIGHT = 0.4
const VIDEO_PROGRESS_WEIGHT = 0.6

export type VideoRenderProgress =
  | { phase: 'preparing' }
  | { phase: 'rendering'; progress: number }
  | { phase: 'finalizing' }
  | { phase: 'done' }

export type VideoRenderOptions = {
  codec: VideoCodec
  width: number
  height: number
  fps: number
  videoBitrateKbps: number
  /** `null` to omit the audio track entirely. */
  audio: AudioTrackConfig
  /**
   * Optional user-provided accompaniment buffer to mix alongside the
   * sampled piano. Routed through `renderSongAudio` only — the video
   * pass doesn't see the audio buffer directly. Ignored when
   * `audio === null` (no audio track wanted).
   */
  userAudio?: UserAudioTrack | null
  signal?: AbortSignal
  onProgress?: (p: VideoRenderProgress) => void
}

/**
 * Offline-render the loaded song's visualizer + sampled audio into a
 * single video file — MP4 (H.264 + AAC) or WebM (VP9 / AV1 + Opus),
 * per `VIDEO_CODECS[codec]`. Audio and video render in
 * parallel — the offline AudioContext processes off the main thread
 * while the video frame loop steps R3F on the main thread — so total
 * wall-clock time ≈ max(audio_time, video_time) instead of the sum.
 *
 * Pipeline:
 *   1. Save R3F renderer / clock / camera / frameloop state for
 *      restoration. Disarm `THREE.Clock.autoStart` so its `getDelta()`
 *      doesn't pollute `state.clock.elapsedTime` with wall-clock
 *      seconds in the override path.
 *   2. Install a `VirtualClock` and put the audio engine into silent
 *      export mode.
 *   3. Kick off `renderSongAudio` — runs in its own
 *      `OfflineAudioContext`, doesn't touch the realtime engine.
 *   4. Configure VideoEncoder, switch R3F to `frameloop="never"`, and
 *      step `(totalDuration * fps)` frames in parallel with (3).
 *   5. After the video loop finishes, await the audio buffer (likely
 *      already done by then), encode it as AAC chunks into the same
 *      muxer.
 *   6. Flush both encoders, finalize the muxer, restore R3F state.
 */
export async function renderSongVideo(
  song: ParsedSong,
  settings: Settings,
  options: VideoRenderOptions,
): Promise<Blob> {
  const { codec, width, height, fps, videoBitrateKbps, audio, userAudio, signal, onProgress } = options
  if (signal?.aborted) throw new VideoRenderAborted()
  const onAbort = () => new VideoRenderAborted()

  await assertEncodersSupported(
    { codec, width, height, fps, bitrateKbps: videoBitrateKbps },
    audio,
  )

  const codecInfo = VIDEO_CODECS[codec].config

  const r3f = getR3FState()
  if (!r3f) {
    throw new Error('The 3D scene is not mounted yet. Try again in a moment.')
  }
  const { gl, camera } = r3f

  onProgress?.({ phase: 'preparing' })

  // Snapshot R3F state for restoration.
  const prevSize = new THREE.Vector2()
  gl.getSize(prevSize)
  const prevPixelRatio = gl.getPixelRatio()
  const prevFrameloop = r3f.frameloop
  const isPerspective = (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true
  const prevAspect = isPerspective ? (camera as THREE.PerspectiveCamera).aspect : 1

  const prevClockAutoStart = r3f.clock.autoStart
  const prevClockRunning = r3f.clock.running
  const prevClockElapsed = r3f.clock.elapsedTime
  const prevClockOldTime = r3f.clock.oldTime
  r3f.clock.stop()
  r3f.clock.autoStart = false
  r3f.clock.elapsedTime = 0
  r3f.clock.oldTime = 0

  const clock = new VirtualClock()
  setActiveClock(clock)
  audioEngine.beginExportPlayback()

  const muxer = createMuxer({ codec, width, height, fps, audio })

  let videoEncoderError: Error | null = null
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      videoEncoderError = e instanceof Error ? e : new Error(String(e))
    },
  })

  // The audio encoder is only constructed when an audio track is
  // wanted. Lazy-construction lets the no-audio path skip
  // `new AudioEncoder({...})` and `audioEncoder.close()` entirely so
  // there's no chance of an unused encoder leaking warnings.
  let audioEncoderError: Error | null = null
  const audioEncoder = audio
    ? new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => {
          audioEncoderError = e instanceof Error ? e : new Error(String(e))
        },
      })
    : null

  // ──────────────────────────────────────────────────────────────────
  // Combined progress. Audio and video render concurrently when both
  // tracks are wanted. The bar is a weighted sum of two independent
  // fractions; in the audio-disabled case, the audio weight collapses
  // to 0 and the bar is pure video progress.
  // ──────────────────────────────────────────────────────────────────
  const audioWeight = audio ? AUDIO_PROGRESS_WEIGHT : 0
  const videoWeight = audio ? VIDEO_PROGRESS_WEIGHT : 1
  let audioFraction = audio ? 0 : 1
  let videoFraction = 0
  let lastEmitted = -1
  const emitOverall = () => {
    const overall = audioWeight * audioFraction + videoWeight * videoFraction
    if (overall - lastEmitted > 0.005 || overall === 1) {
      lastEmitted = overall
      onProgress?.({ phase: 'rendering', progress: overall })
    }
  }

  // Within the audio path: loading 35% / offline render 55% / AAC encode 10%.
  const setAudioFraction_loading = (f: number) => {
    audioFraction = 0.35 * f
    emitOverall()
  }
  const setAudioFraction_render = (f: number) => {
    audioFraction = 0.35 + 0.55 * f
    emitOverall()
  }
  const setAudioFraction_encode = (f: number) => {
    audioFraction = 0.9 + 0.1 * f
    emitOverall()
  }

  try {
    // Kick off the audio render IN PARALLEL with the video pass when
    // audio is wanted. Skipped entirely otherwise — saves ~60 MB
    // sample fetch + offline render time.
    const audioRenderPromise: Promise<AudioBuffer> | null = audio
      ? renderSongAudio(
          song,
          settings,
          audio.sampleRate,
          (p) => {
            if (p.phase === 'loading') {
              setAudioFraction_loading(p.total > 0 ? p.loaded / p.total : 0)
            } else if (p.phase === 'rendering') {
              setAudioFraction_render(p.progress)
            }
          },
          signal,
          userAudio ?? null,
        )
      : null
    // Attach a no-op rejection handler so an early abort doesn't
    // surface as an unhandled rejection before we await it.
    audioRenderPromise?.catch(() => undefined)

    // Configure the video encoder + R3F renderer for the video pass.
    gl.setSize(width, height, false)
    gl.setPixelRatio(1)
    if (isPerspective) {
      const cam = camera as THREE.PerspectiveCamera
      cam.aspect = width / height
      cam.updateProjectionMatrix()
    }
    r3f.set({ frameloop: 'never' })

    videoEncoder.configure(videoEncoderConfig(codec, width, height, fps, videoBitrateKbps))

    // Same window as the audio render (MIDI offset / trim / speed
    // automation / accompaniment tail + TAIL_SECONDS) so the final
    // visual matches the audio tail instead of freezing on the last
    // MIDI frame while the audio keeps playing.
    const { totalDuration } = computeExportTimeline(song, settings, userAudio ?? null)
    const totalFrames = Math.max(1, Math.ceil(totalDuration * fps))
    const usPerFrame = Math.round(1_000_000 / fps)
    const keyframeInterval = Math.max(1, Math.round(KEYFRAME_INTERVAL_SECONDS * fps))

    for (let n = 0; n < totalFrames; n++) {
      if (signal?.aborted) throw new VideoRenderAborted()
      if (videoEncoderError) throw videoEncoderError

      const t = n / fps
      clock.setTime(t)
      // Pass SECONDS to advance — see the autoStart=false comment
      // above. delta in useFrame becomes 1/fps in seconds.
      r3f.advance(t, true)

      const frame = new VideoFrame(gl.domElement, {
        timestamp: n * usPerFrame,
        duration: usPerFrame,
      })

      while (videoEncoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
        await yieldToEventLoop()
        if (signal?.aborted) {
          frame.close()
          throw new VideoRenderAborted()
        }
        if (videoEncoderError) {
          frame.close()
          throw videoEncoderError
        }
      }

      videoEncoder.encode(frame, { keyFrame: n % keyframeInterval === 0 })
      frame.close()

      // Yield once per frame so DOM events (Cancel click) get
      // processed and the video encoder's output handler can run
      // between our encode calls. MessageChannel-postMessage is
      // ~zero-overhead; setTimeout(0) would compound to many seconds
      // across an 18 000-frame render due to the spec's nested-
      // timeout clamp.
      await yieldToEventLoop()

      videoFraction = (n + 1) / totalFrames
      emitOverall()
    }

    await raceWithAbort(videoEncoder.flush(), signal, onAbort)
    if (videoEncoderError) throw videoEncoderError

    // Audio AAC encode pass. Skipped entirely when audio is disabled.
    if (audioEncoder && audioRenderPromise && audio) {
      // Now await the audio buffer (might already be done from the
      // parallel render). The race makes Cancel responsive even if the
      // audio side is still inside `startRendering()`.
      const audioBuffer = await raceWithAbort(
        audioRenderPromise.catch((e) => {
          if (e instanceof AudioRenderAborted) throw new VideoRenderAborted()
          throw e
        }),
        signal,
        onAbort,
      )

      audioEncoder.configure({
        codec: codecInfo.audioCodec,
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: audioBuffer.numberOfChannels,
        bitrate: audio.bitrateKbps * 1000,
      })

      await encodeAudioBuffer({
        encoder: audioEncoder,
        buffer: audioBuffer,
        assertAlive: () => {
          if (signal?.aborted) throw new VideoRenderAborted()
          if (audioEncoderError) throw audioEncoderError
        },
        signal,
        onAbort,
        onProgress: setAudioFraction_encode,
      })
    }

    onProgress?.({ phase: 'finalizing' })
    const blob = muxer.finalize()
    onProgress?.({ phase: 'done' })
    return blob
  } finally {
    try {
      if (videoEncoder.state !== 'closed') videoEncoder.close()
    } catch {
      /* ignore */
    }
    try {
      if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close()
    } catch {
      /* ignore */
    }
    try {
      audioEngine.endExportPlayback()
    } catch {
      /* ignore */
    }
    resetActiveClock()
    try {
      if (isPerspective) {
        const cam = camera as THREE.PerspectiveCamera
        cam.aspect = prevAspect
        cam.updateProjectionMatrix()
      }
      gl.setPixelRatio(prevPixelRatio)
      gl.setSize(prevSize.x, prevSize.y, false)
      r3f.clock.elapsedTime = prevClockElapsed
      r3f.clock.oldTime = prevClockOldTime
      r3f.clock.autoStart = prevClockAutoStart
      if (prevClockRunning) {
        r3f.clock.oldTime = performance.now()
        r3f.clock.running = true
      }
      r3f.set({ frameloop: prevFrameloop })
      r3f.invalidate()
    } catch {
      /* ignore */
    }
  }
}
