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

type FileContainer = VideoCodecConfig['container']
type Mediabunny = typeof import('mediabunny')
type OutputFormat = InstanceType<Mediabunny['OutputFormat']>

export async function createMuxer({ config, fps, audio }: MuxerParams): Promise<MuxerLike> {
  // Loaded on demand so the muxer stays out of the startup bundle.
  const mediabunny = await import('mediabunny')
  const { BufferTarget, EncodedAudioPacketSource, EncodedPacket, EncodedVideoPacketSource, Output } =
    mediabunny

  const target = new BufferTarget()
  const output = new Output({ format: chooseOutputFormat(mediabunny, config.container), target })

  const video = new EncodedVideoPacketSource(config.muxVideoCodec)
  output.addVideoTrack(video, { frameRate: fps })
  const sound = audio ? new EncodedAudioPacketSource(config.muxAudioCodec) : null
  if (sound) output.addAudioTrack(sound)

  const queue = createSerialQueue(output.start())

  return {
    addVideoChunk: (chunk, meta) => {
      const packet = EncodedPacket.fromEncodedChunk(chunk)
      queue.enqueue(() => video.add(packet, meta))
    },
    addAudioChunk: (chunk, meta) => {
      if (!sound) return
      const packet = EncodedPacket.fromEncodedChunk(chunk)
      queue.enqueue(() => sound.add(packet, meta))
    },
    finalize: async () => {
      try {
        await queue.drain()
      } catch (e) {
        await output.cancel().catch(() => {})
        throw e
      }
      await output.finalize()
      if (!target.buffer) throw new MuxerEmptyOutput()
      return new Blob([target.buffer], { type: config.mime })
    },
  }
}

// Mediabunny's `start` / `add` are async but encoder output
// callbacks are sync, so every call is serialised on one chain
// (preserves decode order per track). The first failure poisons the
// chain and resurfaces from `drain`.
function createSerialQueue(first: Promise<void>) {
  let chain = first
  return {
    enqueue: (fn: () => Promise<void>) => {
      chain = chain.then(fn)
      // Keep the rejection on `chain` for drain, but don't report it
      // as unhandled in the meantime.
      chain.catch(() => {})
    },
    drain: () => chain,
  }
}

function chooseOutputFormat(
  { Mp4OutputFormat, WebMOutputFormat }: Mediabunny,
  container: FileContainer,
): OutputFormat {
  const formats: Record<FileContainer, () => OutputFormat> = {
    // `in-memory` fast start puts moov before mdat (progressive playback).
    mp4: () => new Mp4OutputFormat({ fastStart: 'in-memory' }),
    webm: () => new WebMOutputFormat(),
  }
  return formats[container]()
}
