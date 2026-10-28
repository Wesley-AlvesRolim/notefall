// Dev mode switch. Exists only in dev builds: with `import.meta.env.DEV` false every export is a constant and the
// bundler drops the dev UI (src/dev/boot.ts is only reachable through a DEV-guarded dynamic import in main.tsx).
//
// Switch: Ctrl+Alt+D, or `?dev=1` / `?dev=0` in the URL (both persist in localStorage `nf:dev`).
// With dev tools off the app behaves exactly like production.

const KEY_ON = 'nf:dev'
const KEY_NOAUDIO = 'nf:dev:noaudio'

const subs = new Set<() => void>()

function read(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}
function write(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

let enabled = import.meta.env.DEV && read(KEY_ON, false)
let noAudio = import.meta.env.DEV && read(KEY_NOAUDIO, true)

if (import.meta.env.DEV && typeof location !== 'undefined') {
  const q = new URLSearchParams(location.search).get('dev')
  if (q === '1' || q === '0') {
    enabled = q === '1'
    write(KEY_ON, enabled)
  }
}

export function devToolsEnabled(): boolean {
  return import.meta.env.DEV && enabled
}

/** True when the engine should run the timeline without loading or playing the piano samples. */
export function devNoAudio(): boolean {
  return import.meta.env.DEV && enabled && noAudio
}

export function setDevTools(on: boolean): void {
  if (!import.meta.env.DEV || enabled === on) return
  enabled = on
  write(KEY_ON, on)
  subs.forEach((f) => f())
}

export function setDevNoAudio(on: boolean): void {
  if (!import.meta.env.DEV || noAudio === on) return
  noAudio = on
  write(KEY_NOAUDIO, on)
  subs.forEach((f) => f())
}

export function subscribeDevMode(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}
