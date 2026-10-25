/**
 * Bundled demo projects. Drop `.nfz` files into `src/demos/` and they
 * appear in the Toolbar's "Demo Songs" menu automatically — Vite's
 * `import.meta.glob(?url)` resolves each file to a hashed asset URL at
 * build time, so demos ship as static assets alongside the app.
 *
 * Menu labels come from each project's manifest `name` (loaded
 * lazily — see `loadDemoManifestNames`). Until the manifest fetch
 * resolves, the filename (minus `.nfz`, underscores → spaces) is used
 * as a placeholder so the menu is functional offline / on slow
 * networks. Sort by filename so the order is deterministic and
 * editable (prefix files with `01-`, `02-`, …).
 */

import { strFromU8, Unzip, UnzipInflate } from 'fflate'

const modules = import.meta.glob('./demos/*.nfz', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

export type DemoEntry = {
  /** Fallback label derived from the filename. Replaced once the
   *  manifest fetch resolves and reveals a real project name. */
  fallbackLabel: string
  url: string
}

function deriveFallback(path: string): string {
  const file = path.split('/').pop() ?? path
  const base = file.replace(/\.nfz$/i, '')
  return base.replace(/_/g, ' ')
}

export const DEMOS: DemoEntry[] = Object.entries(modules)
  .map(([path, url]) => ({ fallbackLabel: deriveFallback(path), url }))
  .sort((a, b) => a.fallbackLabel.localeCompare(b.fallbackLabel))

/**
 * Stream a demo and pull out just its `manifest.json`, cancelling the
 * download as soon as that entry is decoded. `pack` writes the
 * manifest as the first zip entry, so this reads a few KB even when
 * the demo bundles a multi-MB audio track — the menu fetches every
 * demo on mount, and a full download there would cost each visitor
 * the whole audio file just to show a label. Resolves `null` if the
 * stream ends without a manifest.
 */
async function fetchManifestText(url: string): Promise<string | null> {
  const res = await fetch(url)
  if (!res.ok || !res.body) return null
  const reader = res.body.getReader()
  let text: string | null = null
  const parts: Uint8Array[] = []
  const unzip = new Unzip((file) => {
    if (file.name !== 'manifest.json') return
    file.ondata = (err, chunk, final) => {
      if (err) throw err
      parts.push(chunk)
      if (!final) return
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
      let off = 0
      for (const p of parts) {
        all.set(p, off)
        off += p.length
      }
      text = strFromU8(all)
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      unzip.push(value ?? new Uint8Array(0), done)
      if (text !== null || done) break
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
  return text
}

/**
 * Read just the `manifest.json` from each demo, returning a
 * `url → manifest.name` map. Failures (network, malformed zip,
 * missing/invalid manifest) drop silently — the caller falls back to
 * the filename label. Each demo is fetched in parallel; the whole
 * call resolves once every entry has settled.
 */
export async function loadDemoManifestNames(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await Promise.all(
    DEMOS.map(async (demo) => {
      try {
        const text = await fetchManifestText(demo.url)
        if (text === null) return
        const parsed = JSON.parse(text) as { name?: unknown }
        if (typeof parsed.name === 'string' && parsed.name.length > 0) {
          out.set(demo.url, parsed.name)
        }
      } catch {
        // ignore — fallback label is used
      }
    }),
  )
  return out
}
