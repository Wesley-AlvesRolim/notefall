import type { VideoCodecMap } from './types'

/**
 * Per-codec container + audio pairing.
 *
 * `pickCodecString` steps the H.264 level up by macroblocks/s:
 *   4.0 → 1080p30, 4.1 → 1080p60, 5.0 → 4K30, 5.1 → 4K60
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
}
