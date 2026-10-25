import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string }

// Short commit hash of the build, shown in the Help menu and attached to
// issue reports. CI hosts expose the SHA as an env var (the checkout may
// be shallow or lack .git); locally ask git, marking uncommitted changes
// with `-dirty` so a report from a dev build isn't mistaken for that commit.
function buildCommit(): string {
  const fromEnv = process.env.VITE_COMMIT_SHA ?? process.env.CF_PAGES_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA
  if (fromEnv) return fromEnv.slice(0, 7)
  try {
    const hash = execSync('git rev-parse --short=7 HEAD', { encoding: 'utf-8' }).trim()
    const dirty = execSync('git status --porcelain', { encoding: 'utf-8' }).trim() !== ''
    return dirty ? `${hash}-dirty` : hash
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(buildCommit()),
  },
  server: {
    port: 5173,
    // Dev-only proxy to the sample CDN. The R2 bucket's CORS allow-list
    // is locked to https://notefall.app, so a direct fetch from
    // http://localhost:* is blocked. Routing through the dev server
    // makes the request same-origin from the browser's perspective.
    // Production builds go to the CDN directly (no proxy involved).
    proxy: {
      '/samples-cdn': {
        target: 'https://samples.notefall.app',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/samples-cdn/, ''),
      },
    },
  },
})
