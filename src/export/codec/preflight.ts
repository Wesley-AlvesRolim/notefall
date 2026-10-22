import i18n from '../../i18n'
import { VIDEO_CODECS } from './codecs'
import { isVideoExportSupported, videoEncoderConfig } from './video'
import type { AudioTrackConfig, VideoCodec, VideoEncoderSettings } from './types'

/** "VP9 or AV1" — the other presets, to suggest as alternatives. */
function otherCodecs(codec: VideoCodec): string {
  return (Object.keys(VIDEO_CODECS) as VideoCodec[])
    .filter((c) => c !== codec)
    .map((c) => c.toUpperCase())
    .join(i18n.t('dialogs:export.preflight.or'))
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
    throw new Error(i18n.t('dialogs:export.preflight.noWebCodecs'))
  }

  const { codec, width, height, fps, bitrateKbps } = video
  const videoOk = await isVideoConfigSupported(
    videoEncoderConfig(codec, width, height, fps, bitrateKbps),
  )
  if (!videoOk) {
    throw new Error(
      i18n.t('dialogs:export.preflight.videoUnsupported', {
        codec: codec.toUpperCase(),
        width,
        height,
        fps,
        alternatives: otherCodecs(codec),
      }),
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
      i18n.t('dialogs:export.preflight.audioUnsupported', {
        audioCodec,
        codec: codec.toUpperCase(),
        alternatives: otherCodecs(codec),
      }),
    )
  }
}
