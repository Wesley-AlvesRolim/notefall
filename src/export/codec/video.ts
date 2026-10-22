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

/**
 * Which codec presets this browser can actually encode (video at
 * 1080p30 + the paired audio codec). Used to disable the dialog's
 * unavailable choices.
 */
export async function probeVideoCodecs(): Promise<Record<VideoCodec, boolean>> {
  const result: Record<VideoCodec, boolean> = {
    h264: false,
    vp9: false,
    av1: false,
  }
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') {
    return result
  }
  await Promise.all(
    (Object.keys(VIDEO_CODECS) as VideoCodec[]).map(async (codec) => {
      result[codec] = await isCodecSupported(codec)
    }),
  )
  return result
}

async function isCodecSupported(codec: VideoCodec): Promise<boolean> {
  const { audioCodec, audioSampleRate } = VIDEO_CODECS[codec].config
  try {
    const [videoSupport, audioSupport] = await Promise.all([
      VideoEncoder.isConfigSupported(
        videoEncoderConfig(codec, 1920, 1080, 30, 8000),
      ),
      AudioEncoder.isConfigSupported({
        codec: audioCodec,
        sampleRate: audioSampleRate,
        numberOfChannels: 2,
        bitrate: 192_000,
      }),
    ])
    return videoSupport.supported === true && audioSupport.supported === true
  } catch {
    return false
  }
}
