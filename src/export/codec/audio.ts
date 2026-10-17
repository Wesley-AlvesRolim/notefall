import { MAX_ENCODE_QUEUE, raceWithAbort, yieldToEventLoop } from '../async'

/** Samples per encoder frame. AAC's natural frame size is 1024. */
const AUDIO_CHUNK_SAMPLES = 1024

export type EncodeAudioBufferParams = {
  encoder: AudioEncoder
  buffer: AudioBuffer
  /** Throws (abort / encoder error) to stop the loop between chunks. */
  assertAlive: () => void
  signal?: AbortSignal
  onAbort: () => Error
  onProgress?: (fraction: number) => void
}

/**
 * Feed an already-configured `AudioEncoder` with `buffer` in
 * `AUDIO_CHUNK_SAMPLES`-sized `f32-planar` chunks, then flush. Applies
 * the same queue backpressure as the video frame loop so a long song
 * doesn't pile thousands of `AudioData` objects into the encoder.
 */
export async function encodeAudioBuffer({
  encoder,
  buffer,
  assertAlive,
  signal,
  onAbort,
  onProgress,
}: EncodeAudioBufferParams): Promise<void> {
  const numChannels = buffer.numberOfChannels
  const totalSamples = buffer.length
  const channelData: Float32Array[] = []
  for (let c = 0; c < numChannels; c++) {
    channelData.push(buffer.getChannelData(c))
  }
  for (let off = 0; off < totalSamples; off += AUDIO_CHUNK_SAMPLES) {
    assertAlive()
    const chunkLen = Math.min(AUDIO_CHUNK_SAMPLES, totalSamples - off)
    const planar = new Float32Array(chunkLen * numChannels)
    for (let c = 0; c < numChannels; c++) {
      planar.set(channelData[c].subarray(off, off + chunkLen), c * chunkLen)
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: buffer.sampleRate,
      numberOfFrames: chunkLen,
      numberOfChannels: numChannels,
      timestamp: Math.round((off / buffer.sampleRate) * 1_000_000),
      data: planar,
    })
    encoder.encode(audioData)
    audioData.close()

    while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
      await yieldToEventLoop()
      assertAlive()
    }

    onProgress?.((off + chunkLen) / totalSamples)
  }
  await raceWithAbort(encoder.flush(), signal, onAbort)
  assertAlive()
}
