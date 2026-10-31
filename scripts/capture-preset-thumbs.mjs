/**
 * Re-renders the note-look preset thumbnails shown in Customize → Notes → Style
 * (`src/ui/look/presets/<preset>.jpg`, 144 × 112) with the real note shader.
 * Run it whenever a preset in `src/notes/looks/noteLook.ts` changes or one is added.
 *
 *   npm run dev                                   # in another terminal
 *   npx -y -p playwright-core node scripts/capture-preset-thumbs.mjs
 *
 * Options (env): CHROME = path to a Chrome / Chromium binary (default: the macOS Google Chrome
 * path), URL = the dev server (default http://localhost:5173), COLOR = the neutral note colour the
 * thumbnails are drawn in (the chip tints them with the user's colours, so keep it warm white).
 *
 * Uses the dev build's `window.__nfDev` hooks (`?dev=1`), so it only works against `npm run dev`.
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = process.env.URL || 'http://localhost:5173'
const COLOR = process.env.COLOR || '#e6e0d4'
const OUT = resolve('src/ui/look/presets')
const W = 144
const H = 112

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 3 })
await page.addInitScript(() => localStorage.setItem('nf:lang', 'en'))
await page.goto(`${URL}/?dev=1`)
await page.waitForSelector('canvas')
await page.waitForTimeout(1500)
// No UI over the picture.
await page.addStyleTag({ content: '.lil-gui, .nf-glass, .nf-glass-strong { display: none !important; }' })

const names = await page.evaluate(async () => {
  const url = performance
    .getEntriesByType('resource')
    .map((e) => e.name)
    .find((n) => n.includes('/src/notes/looks/noteLook.ts'))
  const m = await import(url)
  window.__presets = m
  return m.NOTE_LOOK_PRESET_NAMES
})

// Three short notes on C4 / E4 / G4, in the air at t = 0; no particles or guide lines.
await page.evaluate((color) => {
  const { store } = window.__nfDev
  const notes = [
    { id: 1, midi: 60, time: 0.62, duration: 0.34, velocity: 0.8, track: 0 },
    { id: 2, midi: 64, time: 0.5, duration: 0.6, velocity: 0.8, track: 0 },
    { id: 3, midi: 67, time: 0.7, duration: 0.2, velocity: 0.8, track: 0 },
  ]
  store
    .getState()
    .setSong({ name: 'thumb', duration: 3, notes, pedals: [], tracks: [{ name: 'T', hasNotes: true }] }, { resetTimeline: true })
  store.getState().updateSettings({
    noteColorMode: 'solid',
    noteColor: color,
    trackColors: {},
    particlesEnabled: false,
    octaveLinesEnabled: false,
  })
}, COLOR)
await page.waitForTimeout(800)

// Frame the three notes with a margin, at the thumbnail's aspect.
const box = await page.evaluate(() => {
  const { store, selectionScreenRect } = window.__nfDev
  store.getState().replaceSelection([1, 2, 3])
  const r = selectionScreenRect()
  store.getState().replaceSelection([])
  return r
})
const cx = (box.left + box.right) / 2
const cy = (box.top + box.bottom) / 2
const scale = Math.max((box.right - box.left + 20) / (W / 2), (box.bottom - box.top + 20) / (H / 2))
const clip = { x: cx - (W / 2) * scale / 2, y: cy - (H / 2) * scale / 2, width: (W / 2) * scale, height: (H / 2) * scale }

// Resizes a PNG to W × H and returns JPEG bytes (done in the page: no image library needed).
const toJpeg = (png) =>
  page.evaluate(
    async ({ b64, w, h }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const ctx = c.getContext('2d')
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, w, h)
      return c.toDataURL('image/jpeg', 0.82).split(',')[1]
    },
    { b64: png.toString('base64'), w: W, h: H },
  )

for (const name of names) {
  await page.evaluate((n) => window.__nfDev.store.getState().updateSettings({ ...window.__presets.NOTE_LOOK_PRESETS[n] }), name)
  await page.waitForTimeout(700)
  const jpeg = await toJpeg(await page.screenshot({ clip }))
  writeFileSync(resolve(OUT, `${name}.jpg`), Buffer.from(jpeg, 'base64'))
  console.log(`wrote src/ui/look/presets/${name}.jpg`)
}
await browser.close()
