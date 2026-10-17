import { VIDEO_CODECS } from './codecs'
import type { VideoCodec } from './types'

export function isVideoExportSupported(): boolean {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof AudioEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof AudioData !== 'undefined' &&
    typeof EncodedVideoChunk !== 'undefined'
  )
}

export function videoEncoderConfig(
  codec: VideoCodec,
  width: number,
  height: number,
  fps: number,
  bitrateKbps: number,
): VideoEncoderConfig {
  return {
    codec: VIDEO_CODECS[codec].pickCodecString(width, height, fps),
    width,
    height,
    bitrate: bitrateKbps * 1000,
    framerate: fps,
    ...(codec === 'h264' ? { avc: { format: 'avc' as const } } : {}),
  }
}
