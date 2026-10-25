export type VideoCodec = 'h264' | 'vp9' | 'av1'

export type VideoEncoderSettings = {
  codec: VideoCodec
  width: number
  height: number
  fps: number
  bitrateKbps: number
}

export type VideoCodecConfig = {
  container: 'mp4' | 'webm'
  ext: 'mp4' | 'webm'
  mime: 'video/mp4' | 'video/webm'
  audioCodec: 'mp4a.40.2' | 'opus'
  /** Muxer-side codec ids (mediabunny naming, not WebCodecs strings). */
  muxVideoCodec: 'avc' | 'vp9' | 'av1'
  muxAudioCodec: 'aac' | 'opus'
  audioSampleRate: 44_100 | 48_000
}

export type VideoCodecStrategy = {
  config: VideoCodecConfig
  pickCodecString: (width: number, height: number, fps: number) => string
}

export type VideoCodecMap = Record<VideoCodec, VideoCodecStrategy>

/**
 * Optional audio track config. `null` produces a silent video — the
 * muxer is built without an audio track, the offline audio render is
 * skipped entirely (saves the ~60 MB sample fetch + the
 * convolution-reverb cost), and the progress bar reflects video work
 * only.
 */
export type AudioTrackConfig = {
  sampleRate: number
  bitrateKbps: number
} | null
