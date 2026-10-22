/** Encoder backpressure threshold, shared by the video and audio encode loops. */
export const MAX_ENCODE_QUEUE = 4

/**
 * Race a promise against an AbortSignal so that cancel is responsive
 * even during long awaits (sample fetching, OfflineAudioContext.
 * startRendering(), encoder flushes) we can't otherwise interrupt. The
 * underlying promise keeps running in the background — caller is
 * responsible for letting that GPU/network/audio work get GC'd by
 * dropping references to the OfflineAudioContext / encoder it's tied
 * to. `onAbort` builds the caller's own error type so each pipeline's
 * failure mode stays distinct.
 */
export function raceWithAbort<T>(
  p: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => Error,
): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(onAbort())
  return new Promise<T>((resolve, reject) => {
    p.then(resolve, reject)
    signal.addEventListener('abort', () => reject(onAbort()), { once: true })
  })
}

/**
 * Yield to the event loop so DOM events (notably the Cancel button's
 * click) can be processed mid-render. Uses MessageChannel rather than
 * `setTimeout(0)` because the HTML spec clamps nested setTimeouts at
 * ≥4 ms after 5 levels of nesting — adds up to many seconds across an
 * 18 000-frame render. MessageChannel-postMessage has no such clamp
 * and runs in the next macrotask. The channel + handler are reused
 * across calls so we don't allocate per frame.
 */
const _yieldChannel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null
export function yieldToEventLoop(): Promise<void> {
  if (!_yieldChannel) {
    return new Promise<void>((r) => setTimeout(r, 0))
  }
  return new Promise<void>((resolve) => {
    _yieldChannel.port1.onmessage = () => {
      _yieldChannel.port1.onmessage = null
      resolve()
    }
    _yieldChannel.port2.postMessage(null)
  })
}
