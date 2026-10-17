import { VIDEO_CODECS } from './codecs'
import { isVideoExportSupported, videoEncoderConfig } from './video'
import type { AudioTrackConfig, VideoCodec, VideoEncoderSettings } from './types'

/** "VP9 or AV1" — the other presets, to suggest as alternatives. */
function otherCodecs(codec: VideoCodec): string {
  return (Object.keys(VIDEO_CODECS) as VideoCodec[])
    .filter((c) => c !== codec)
    .map((c) => c.toUpperCase())
    .join(' or ')
}

async function isVideoConfigSupported(config: VideoEncoderConfig): Promise<boolean> {
  const { supported } = await VideoEncoder.isConfigSupported(config).catch(() => ({
    supported: false,
  }))
  return supported === true
}

async function isAudioConfigSupported(config: AudioEncoderConfig): Promise<boolean> {
  const { supported } = await AudioEncoder.isConfigSupported(config).catch(() => ({
    supported: false,
  }))
  return supported === true
}

/**
 * Fail early with a specific message. Browsers expose the WebCodecs
 * classes but may lack a given codec (e.g. Firefox has no AAC encoder),
 * so each encoder config is probed before any render work starts.
 */
export async function assertEncodersSupported(
  video: VideoEncoderSettings,
  audio: AudioTrackConfig,
): Promise<void> {
  if (!isVideoExportSupported()) {
    throw new Error(
      'Video export needs WebCodecs (Chrome / Edge / Safari 16.4+). In this browser you can still export "Audio only" (WAV).',
    )
  }

  const { codec, width, height, fps, bitrateKbps } = video
  const videoOk = await isVideoConfigSupported(
    videoEncoderConfig(codec, width, height, fps, bitrateKbps),
  )
  if (!videoOk) {
    throw new Error(
      `This browser cannot encode ${codec.toUpperCase()} video at ${width}×${height} @ ${fps} fps. Try ${otherCodecs(codec)}, or lower the resolution / frame rate.`,
    )
  }

  if (!audio) return
  const { audioCodec } = VIDEO_CODECS[codec].config
  const audioOk = await isAudioConfigSupported({
    codec: audioCodec,
    sampleRate: audio.sampleRate,
    numberOfChannels: 2,
    bitrate: audio.bitrateKbps * 1000,
  })
  if (!audioOk) {
    throw new Error(
      `This browser cannot encode the ${audioCodec} audio track that ${codec.toUpperCase()} export needs. Try ${otherCodecs(codec)}, export "Video only", or export "Audio only" (WAV).`,
    )
  }
}
