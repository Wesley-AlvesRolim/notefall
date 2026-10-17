import { ArrayBufferTarget as Mp4Target, Muxer as Mp4Muxer } from 'mp4-muxer'
import { VIDEO_CODECS } from './codecs'
import type { AudioTrackConfig, VideoCodec } from './types'

export type MuxerLike = {
  addVideoChunk: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void
  addAudioChunk: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void
  finalize: () => Blob
}

export type MuxerParams = {
  codec: VideoCodec
  width: number
  height: number
  fps: number
  audio: AudioTrackConfig
}

export function createMuxer(params: MuxerParams): MuxerLike {
  const { mime } = VIDEO_CODECS[params.codec].config
  const { muxer, target } = mp4(params)
  return {
    addVideoChunk: (c, meta) => muxer.addVideoChunk(c, meta),
    addAudioChunk: (c, meta) => muxer.addAudioChunk(c, meta),
    finalize: () => {
      muxer.finalize()
      return new Blob([target.buffer], { type: mime })
    },
  }
}

function mp4({ width, height, fps, audio }: MuxerParams) {
  const target = new Mp4Target()
  const muxer = new Mp4Muxer({
    target,
    video: { codec: 'avc', width, height, frameRate: fps },
    // Omit the audio track entirely when audio is disabled — a
    // silent MP4 with just the video stream.
    ...(audio && {
      audio: { codec: 'aac' as const, numberOfChannels: 2, sampleRate: audio.sampleRate },
    }),
    fastStart: 'in-memory',
  })
  return { muxer, target }
}
