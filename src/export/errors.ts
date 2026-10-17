/**
 * Thrown when the caller's `AbortSignal` aborts during a render. Surfaces
 * so the UI layer can skip the download and quietly tear down the modal
 * without the generic "could not export audio" error toast.
 */
export class AudioRenderAborted extends Error {
  constructor() {
    super('Audio render aborted')
    this.name = 'AudioRenderAborted'
  }
}

export class VideoRenderAborted extends Error {
  constructor() {
    super('Video render aborted')
    this.name = 'VideoRenderAborted'
  }
}
