import { MuxerEmptyOutput } from '../errors'
import type { AudioTrackConfig, VideoCodecConfig } from './types'

export type MuxerLike = {
  addVideoChunk: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void
  addAudioChunk: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void
  finalize: () => Promise<Blob>
}

export type MuxerParams = {
  config: VideoCodecConfig
  fps: number
  audio: AudioTrackConfig
}

export async function createMuxer({ config, fps, audio }: MuxerParams): Promise<MuxerLike> {
  // Loaded on demand so the muxer stays out of the startup bundle.
  const {
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacket,
    EncodedVideoPacketSource,
    Mp4OutputFormat,
    Output,
    WebMOutputFormat,
  } = await import('mediabunny')
  // `in-memory` fast start puts moov before mdat (progressive playback).
  const format =
    config.container === 'mp4'
      ? new Mp4OutputFormat({ fastStart: 'in-memory' })
      : new WebMOutputFormat()
  const output = new Output({ format, target: new BufferTarget() })
  const video = new EncodedVideoPacketSource(config.muxVideoCodec)
  output.addVideoTrack(video, { frameRate: fps })
  const sound = audio ? new EncodedAudioPacketSource(config.muxAudioCodec) : null
  if (sound) output.addAudioTrack(sound)

  // Mediabunny's `start` / `add` are async but encoder output
  // callbacks are sync, so every call is serialised on one chain
  // (preserves decode order per track). The first failure poisons the
  // chain and resurfaces from `finalize`.
  let chain: Promise<void> = output.start()
  const enqueue = (fn: () => Promise<void>) => {
    chain = chain.then(fn)
    // Keep the rejection on `chain` for finalize, but don't report it
    // as unhandled in the meantime.
    chain.catch(() => {})
  }

  return {
    addVideoChunk: (c, meta) => {
      const packet = EncodedPacket.fromEncodedChunk(c)
      enqueue(() => video.add(packet, meta))
    },
    addAudioChunk: (c, meta) => {
      if (!sound) return
      const packet = EncodedPacket.fromEncodedChunk(c)
      enqueue(() => sound.add(packet, meta))
    },
    finalize: async () => {
      try {
        await chain
      } catch (e) {
        await output.cancel().catch(() => {})
        throw e
      }
      await output.finalize()
      const buffer = (output.target as InstanceType<typeof BufferTarget>).buffer
      if (!buffer) throw new MuxerEmptyOutput()
      return new Blob([buffer], { type: config.mime })
    },
  }
}
