export type VideoCodec = 'h264'

export type VideoCodecConfig = {
  container: 'mp4'
  ext: 'mp4'
  mime: 'video/mp4'
  audioCodec: 'mp4a.40.2'
  audioSampleRate: 44_100
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
