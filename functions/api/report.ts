// Cloudflare Pages Function: POST /api/report
//
// Files a bug report / feature request from the in-app form as a PUBLIC
// GitHub issue and returns { url, number }. The browser never sees the
// token. Secrets / variables (Pages project → Settings → Variables):
//   GITHUB_TOKEN      fine-grained token, this repo only, Issues: read & write
//   TURNSTILE_SECRET  Cloudflare Turnstile secret key (spam check)
//   GITHUB_REPO       optional, defaults to ekkx/notefall
// Without GITHUB_TOKEN the endpoint answers { error: 'unconfigured' } and
// the app falls back to GitHub's own issue form.

interface Env {
  GITHUB_TOKEN?: string
  TURNSTILE_SECRET?: string
  GITHUB_REPO?: string
}

interface Body {
  kind?: unknown
  title?: unknown
  description?: unknown
  details?: unknown
  expected?: unknown
  environment?: unknown
  website?: unknown
  turnstileToken?: unknown
}

// Keep in sync with REPORT_LIMITS in src/feedback/report.ts.
const TITLE_MAX = 120
const TEXT_MAX = 5000
const ENV_MAX = 2000

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

// A form anyone can post to must not be able to ping people: break
// @mentions (and team mentions) with a zero-width space.
const defuse = (s: string) => s.replace(/@(?=[A-Za-z0-9-])/g, '@​')

async function turnstileOk(secret: string, token: string, ip: string | null): Promise<boolean> {
  const form = new FormData()
  form.append('secret', secret)
  form.append('response', token)
  if (ip) form.append('remoteip', ip)
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
  if (!res.ok) return false
  const data = (await res.json()) as { success?: boolean }
  return data.success === true
}

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  if (!env.GITHUB_TOKEN) return json({ error: 'unconfigured' }, 503)

  // Only the app itself (same origin) may post.
  const origin = request.headers.get('Origin')
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: 'origin' }, 403)

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return json({ error: 'invalid' }, 400)
  }
  // Honeypot: a hidden field people never fill.
  if (text(body.website, 200)) return json({ error: 'invalid' }, 400)

  const kind = body.kind === 'feature' ? 'feature' : body.kind === 'bug' ? 'bug' : null
  const title = text(body.title, TITLE_MAX).replace(/\s+/g, ' ')
  const description = text(body.description, TEXT_MAX)
  if (!kind || !title || !description) return json({ error: 'invalid' }, 400)

  if (env.TURNSTILE_SECRET) {
    const token = text(body.turnstileToken, 4096)
    const ok = token !== '' && (await turnstileOk(env.TURNSTILE_SECRET, token, request.headers.get('CF-Connecting-IP')))
    if (!ok) return json({ error: 'verification' }, 403)
  }

  const details = text(body.details, TEXT_MAX)
  const expected = text(body.expected, TEXT_MAX)
  const environment = text(body.environment, ENV_MAX).replace(/`/g, "'")
  const section = (heading: string, value: string) => `### ${heading}\n\n${value ? defuse(value) : '_No response_'}`
  const parts =
    kind === 'bug'
      ? [section('What happened?', description), section('Steps to reproduce', details), section('Expected behavior', expected)]
      : [section('Problem / idea', description), section('How it could work', details)]
  if (environment) parts.push(`### Environment\n\n\`\`\`text\n${environment}\n\`\`\``)
  parts.push('---\n_Sent from the in-app feedback form._')

  const repo = env.GITHUB_REPO || 'ekkx/notefall'
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'notefall-feedback',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: `${kind === 'bug' ? '[Bug]' : '[Feature]'} ${defuse(title)}`,
      body: parts.join('\n\n'),
      labels: [kind === 'bug' ? 'bug' : 'enhancement', 'from-app'],
    }),
  })
  if (!res.ok) return json({ error: 'github', status: res.status }, 502)
  const issue = (await res.json()) as { html_url: string; number: number }
  return json({ url: issue.html_url, number: issue.number })
}
