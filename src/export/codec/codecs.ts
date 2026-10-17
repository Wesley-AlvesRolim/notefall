import type { VideoCodecMap } from './types'

/**
 * Per-codec container + audio pairing. H.264 / AAC is the most
 * widely playable, but Firefox-based browsers have no AAC encoder (and
 * H.264 there depends on the OpenH264 plugin). VP9 / AV1 + Opus are
 * royalty-free and encoded in software everywhere WebCodecs ships, so
 * they are the portable choice.
 * Opus only accepts 48 kHz-family rates; AAC export stays at 44.1 kHz.
 *
 * `pickCodecString` steps the level up by throughput budget:
 * ≤1080p30 → 4.0, ≤1080p60 → 4.1, above → 5.1 (H.264 uses
 * macroblocks/s; VP9 / AV1 use luma samples/s).
 */
export const VIDEO_CODECS: VideoCodecMap = {
  h264: {
    config: {
      container: 'mp4',
      ext: 'mp4',
      mime: 'video/mp4',
      audioCodec: 'mp4a.40.2',
      audioSampleRate: 44_100,
    },
    pickCodecString(width, height, fps) {
      const macroblocksPerSec = ((width * height) / 256) * fps
      if (macroblocksPerSec <= 245_760) return 'avc1.640028'
      if (macroblocksPerSec <= 491_520) return 'avc1.640029'
      if (macroblocksPerSec <= 589_824) return 'avc1.640032'
      return 'avc1.640033'
    },
  },
  vp9: {
    config: {
      container: 'webm',
      ext: 'webm',
      mime: 'video/webm',
      audioCodec: 'opus',
      audioSampleRate: 48_000,
    },
    pickCodecString(width, height, fps) {
      return ['vp09.00.40.08', 'vp09.00.41.08', 'vp09.00.51.08'][lumaTier(width, height, fps)]
    },
  },
  av1: {
    config: {
      container: 'webm',
      ext: 'webm',
      mime: 'video/webm',
      audioCodec: 'opus',
      audioSampleRate: 48_000,
    },
    pickCodecString(width, height, fps) {
      return ['av01.0.08M.08', 'av01.0.09M.08', 'av01.0.13M.08'][lumaTier(width, height, fps)]
    },
  },
}

function lumaTier(width: number, height: number, fps: number): 0 | 1 | 2 {
  const lumaPerSec = width * height * fps
  return lumaPerSec <= 83_558_400 ? 0 : lumaPerSec <= 160_432_128 ? 1 : 2
}
