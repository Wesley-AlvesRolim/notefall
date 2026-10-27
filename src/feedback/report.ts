import { hasFileSystemAccess } from '../projects/io'

// In-app bug reports / feature requests. The form posts to the Pages
// Function at `/api/report` (functions/api/report.ts), which files a
// public GitHub issue and returns its URL. Only what the user typed and
// (if they keep it ticked) the device block below is sent — never their
// notes, recordings, projects or settings.

export const REPO_URL = 'https://github.com/ekkx/notefall'
export const ISSUES_URL = `${REPO_URL}/issues`

export type ReportKind = 'bug' | 'feature'

export interface ReportFields {
  kind: ReportKind
  title: string
  /** bug: what happened · feature: the problem / idea */
  description: string
  /** bug: steps to reproduce · feature: how it could work */
  details: string
  /** bug only: what was expected instead */
  expected: string
  /** the device block, or '' when the user unticked it */
  environment: string
  /** honeypot (a hidden field); the server drops reports that fill it */
  website?: string
}

/** GPU name from WebGL, when the browser exposes it. */
function gpuName(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    if (!gl) return 'no WebGL'
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return String(name)
  } catch {
    return 'unknown'
  }
}

/**
 * Device info attached to reports. Kept narrow: browser, screen, GPU and
 * the capabilities notefall depends on — nothing about the user's content.
 */
export function buildEnvironmentBlock(): string {
  const w = window.innerWidth
  const h = window.innerHeight
  const webCodecs = typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined'
  return [
    `notefall: ${__APP_COMMIT__}`,
    `User-Agent: ${navigator.userAgent}`,
    `Language: ${navigator.language}`,
    `Viewport: ${w}×${h} (DPR ${window.devicePixelRatio})`,
    `Screen: ${screen.width}×${screen.height}`,
    `GPU: ${gpuName()}`,
    `File System Access: ${hasFileSystemAccess() ? 'yes' : 'no'}`,
    `Web MIDI: ${'requestMIDIAccess' in navigator ? 'yes' : 'no'}`,
    `WebCodecs: ${webCodecs ? 'yes' : 'no'}`,
  ].join('\n')
}

/**
 * GitHub's own "new issue" form for the same kind, with the device block
 * pre-filled (`bug.yml` / `feature.yml` both have an `environment` field).
 * The fallback when the in-app form can't reach the server.
 */
export function githubIssueUrl(kind: ReportKind, environment = buildEnvironmentBlock()): string {
  return `${REPO_URL}/issues/new?template=${kind}.yml&environment=${encodeURIComponent(environment)}`
}

export type SubmitResult =
  | { kind: 'ok'; url: string; number: number }
  /** the server isn't there (dev server, not configured) — offer GitHub instead */
  | { kind: 'unavailable' }
  | { kind: 'error'; reason: 'verification' | 'invalid' | 'server' | 'network' }

export async function submitReport(fields: ReportFields, turnstileToken: string | null): Promise<SubmitResult> {
  let res: Response
  try {
    res = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...fields, turnstileToken }),
    })
  } catch {
    return { kind: 'error', reason: 'network' }
  }
  // Vite's dev server answers unknown paths with index.html, and an
  // unconfigured deployment with 404 / 503.
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return { kind: 'unavailable' }
  let data: { url?: string; number?: number; error?: string }
  try {
    data = await res.json()
  } catch {
    return { kind: 'unavailable' }
  }
  if (res.ok && data.url && typeof data.number === 'number') return { kind: 'ok', url: data.url, number: data.number }
  if (data.error === 'unconfigured') return { kind: 'unavailable' }
  if (data.error === 'verification') return { kind: 'error', reason: 'verification' }
  if (res.status === 400) return { kind: 'error', reason: 'invalid' }
  return { kind: 'error', reason: 'server' }
}

/** Field limits, shared with the server. */
export const REPORT_LIMITS = { title: 120, text: 5000 } as const
