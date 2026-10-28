// Dev-only tuning panel (lil-gui). Controls are generated from the hand pipeline's defaults objects; edits go to
// hands/tuning.ts, which build.ts merges in (the Hands component rebuilds the motion when the tuning version bumps).
import GUI, { type Controller } from 'lil-gui'
import { audioEngine } from '../audio/engine'
import { lastBuild } from '../hands/build'
import { DEFAULT_FINGERING_OPTIONS } from '../hands/fingering'
import { DEFAULT_MOTION_OPTIONS, poseAt } from '../hands/pose'
import { DEFAULT_REACH_OPTIONS } from '../hands/reach'
import { DEFAULT_SPLIT_OPTIONS } from '../hands/split'
import { getAllTuning, resetTuning, setTuning, subscribeTuning, type TuningGroup } from '../hands/tuning'
import { devNoAudio, setDevNoAudio, setDevTools } from './mode'

const STORE_KEY = 'nf:dev:tuning'
const POS_KEY = 'nf:dev:panel' // { x, y, open }

const GROUPS: { id: TuningGroup; label: string; defaults: Record<string, number | boolean> }[] = [
  { id: 'motion', label: 'Motion (pose.ts)', defaults: DEFAULT_MOTION_OPTIONS as never },
  { id: 'split', label: 'Split L/R (split.ts)', defaults: DEFAULT_SPLIT_OPTIONS as never },
  { id: 'reach', label: 'Reach (reach.ts)', defaults: DEFAULT_REACH_OPTIONS as never },
  { id: 'fingering', label: 'Fingering (fingering.ts)', defaults: DEFAULT_FINGERING_OPTIONS as never },
]
// Driven by the Inspector, not tunable here.
const SKIP = new Set(['humanize'])

function rangeFor(d: number): { min: number; max: number; step: number } {
  if (d === 0) return { min: -1, max: 1, step: 0.01 }
  const mag = Math.abs(d)
  const step = Number.isInteger(d) && mag >= 5 ? 1 : mag >= 20 ? 0.5 : mag >= 2 ? 0.05 : mag >= 0.2 ? 0.005 : 0.001
  return d > 0 ? { min: 0, max: d * 3, step } : { min: d * 3, max: -d * 3, step }
}

function restore(): void {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as Partial<Record<TuningGroup, Record<string, number | boolean>>>
    for (const g of GROUPS) for (const [k, v] of Object.entries(saved[g.id] ?? {})) if (k in g.defaults) setTuning(g.id, k, v)
  } catch {
    /* ignore */
  }
}

function changedJson(): string {
  const all = getAllTuning()
  const out: Record<string, unknown> = {}
  for (const g of GROUPS) if (Object.keys(all[g.id]).length) out[g.id] = all[g.id]
  return JSON.stringify(out, null, 2)
}

function loadPos(): { x: number; y: number; open: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null')
    if (v && typeof v.x === 'number' && typeof v.y === 'number') return { x: v.x, y: v.y, open: v.open !== false }
  } catch {
    /* ignore */
  }
  return { x: window.innerWidth - 336, y: 8, open: true }
}
function savePos(el: HTMLElement, open: boolean): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ x: el.offsetLeft, y: el.offsetTop, open }))
  } catch {
    /* ignore */
  }
}
/** Positions the panel and keeps its title bar inside the viewport. */
function placePanel(el: HTMLElement, x: number, y: number): void {
  const w = el.offsetWidth || 320
  el.style.right = 'auto'
  el.style.left = `${Math.max(0, Math.min(x, window.innerWidth - Math.min(w, 120)))}px`
  el.style.top = `${Math.max(0, Math.min(y, window.innerHeight - 28))}px`
}
/** Drag by the title bar; a drag does not toggle the collapse (click is swallowed once). */
function enableDrag(gui: GUI, root: HTMLElement): () => void {
  const title = gui.$title
  title.style.cursor = 'move'
  title.style.touchAction = 'none'
  let start: { px: number; py: number; x: number; y: number } | null = null
  let moved = false
  const down = (e: PointerEvent) => {
    start = { px: e.clientX, py: e.clientY, x: root.offsetLeft, y: root.offsetTop }
    moved = false
    title.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent) => {
    if (!start) return
    const dx = e.clientX - start.px
    const dy = e.clientY - start.py
    if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return
    moved = true
    placePanel(root, start.x + dx, start.y + dy)
  }
  const up = () => {
    if (start && moved) savePos(root, !gui._closed)
    start = null
  }
  const click = (e: MouseEvent) => {
    if (moved) {
      e.stopImmediatePropagation()
      moved = false
    }
  }
  title.addEventListener('pointerdown', down)
  title.addEventListener('pointermove', move)
  title.addEventListener('pointerup', up)
  title.addEventListener('pointercancel', up)
  title.addEventListener('click', click, true)
  return () => {}
}

export function openDevPanel(): { destroy: () => void } {
  restore()
  const gui = new GUI({ title: 'notefall dev', width: 320, autoPlace: false })
  document.body.appendChild(gui.domElement)
  const root = gui.domElement
  root.style.cssText += ';position:fixed;z-index:1000;max-height:calc(100vh - 16px);overflow-y:auto'
  const saved = loadPos()
  placePanel(root, saved.x, saved.y)
  if (!saved.open) gui.close()
  gui.onOpenClose((g) => {
    if (g === gui) savePos(root, gui._closed === false)
  })
  const dragCleanup = enableDrag(gui, root)
  const onResize = () => {
    placePanel(root, root.offsetLeft, root.offsetTop)
    savePos(root, !gui._closed)
  }
  window.addEventListener('resize', onResize)
  const style = document.createElement('style')
  style.textContent = '.lil-gui .nf-changed .name{color:#7cc4ff;cursor:pointer}.lil-gui .nf-changed .name:hover{text-decoration:underline}'
  gui.domElement.appendChild(style)

  // --- mode ---
  const mode = { noAudio: devNoAudio(), off: () => setDevTools(false) }
  const fMode = gui.addFolder('Mode')
  fMode.add(mode, 'noAudio').name('No audio (skip sample load)').onChange((v: boolean) => setDevNoAudio(v))
  fMode.add(mode, 'off').name('Dev tools off (Ctrl+Alt+D)')

  // --- readouts ---
  const ro = { fps: 0, frameMs: 0, buildMs: 0, builds: 0, notes: 0, unreachable: 0, poseMs: 0 }
  const fRo = gui.addFolder('Readouts')
  for (const k of Object.keys(ro) as (keyof typeof ro)[]) fRo.add(ro, k).disable().listen()
  let raf = 0
  let last = performance.now()
  let acc = 0
  let frames = 0
  const loop = (t: number) => {
    const dt = t - last
    last = t
    ro.frameMs = Math.round(dt * 10) / 10
    acc += dt
    frames++
    if (acc >= 500) {
      ro.fps = Math.round((frames * 1000) / acc)
      acc = 0
      frames = 0
      ro.buildMs = Math.round(lastBuild.ms * 10) / 10
      ro.builds = lastBuild.count
      ro.notes = lastBuild.notes
      ro.unreachable = lastBuild.unreachable
      if (lastBuild.motion) {
        const st = audioEngine.currentSongTime()
        const t0 = performance.now()
        for (let i = 0; i < 20; i++) poseAt(lastBuild.motion, st + i * 0.01)
        ro.poseMs = Math.round(((performance.now() - t0) / 20) * 1000) / 1000
      }
    }
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)

  // --- search ---
  const search = document.createElement('div')
  search.style.cssText = 'display:flex;gap:4px;padding:4px 6px;position:sticky;top:0;z-index:2;background:var(--background-color)'
  const input = document.createElement('input')
  input.type = 'search'
  input.placeholder = 'Search parameters…'
  input.style.cssText = 'flex:1;min-width:0;font:inherit;padding:3px 6px;background:var(--widget-color);color:var(--text-color);border:0;border-radius:3px;outline:none'
  const clear = document.createElement('button')
  clear.textContent = '×'
  clear.title = 'Clear'
  clear.style.cssText = 'font:inherit;border:0;border-radius:3px;background:var(--widget-color);color:var(--text-color);cursor:pointer;padding:0 8px'
  search.append(input, clear)
  gui.$children.prepend(search)
  input.addEventListener('keydown', (e) => e.stopPropagation()) // keep PC-keyboard piano / shortcuts out of the box
  const openBefore = new Map<GUI, boolean>()
  let searching = false
  const applySearch = () => {
    const q = input.value.trim().toLowerCase()
    if (q && !searching) for (const f of gui.foldersRecursive()) openBefore.set(f, !f._closed)
    for (const f of gui.foldersRecursive().reverse()) {
      const folderHit = q !== '' && f._title.toLowerCase().includes(q)
      let any = false
      for (const c of f.controllers) {
        const hit = !q || folderHit || c.property.toLowerCase().includes(q) || c._name.toLowerCase().includes(q)
        c.show(hit)
        any ||= hit
      }
      for (const sub of f.folders) any ||= !sub.domElement.hidden
      f.show(!q || any)
      if (q && any) f.open()
    }
    if (!q && searching) for (const [f, o] of openBefore) f.open(o)
    searching = q !== ''
  }
  input.addEventListener('input', applySearch)
  clear.addEventListener('click', () => { input.value = ''; applySearch(); input.focus() })

  // --- tuning ---
  const persist = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(getAllTuning()))
    } catch {
      /* ignore */
    }
  }
  const refreshers: (() => void)[] = []
  const fTune = gui.addFolder('Hands tuning (dev only)')
  for (const g of GROUPS) {
    const folder = fTune.addFolder(g.label).close()
    const cur: Record<string, number | boolean> = {}
    for (const [key, def] of Object.entries(g.defaults)) {
      if (SKIP.has(key) || (typeof def !== 'number' && typeof def !== 'boolean')) continue
      cur[key] = getAllTuning()[g.id][key] ?? def
      let c: Controller
      if (typeof def === 'number') {
        const r = rangeFor(def)
        c = folder.add(cur, key, r.min, r.max, r.step)
      } else c = folder.add(cur, key)
      const refresh = () => {
        const changed = cur[key] !== def
        c.name(changed ? `↺ ${key}` : key)
        c.domElement.classList.toggle('nf-changed', changed)
      }
      c.onChange((v: number | boolean) => {
        setTuning(g.id, key, v === def ? undefined : v)
        refresh()
      })
      c.$name.addEventListener('click', () => {
        if (cur[key] === def) return
        cur[key] = def
        setTuning(g.id, key, undefined)
        c.updateDisplay()
        refresh()
      })
      refresh()
      refreshers.push(() => {
        cur[key] = getAllTuning()[g.id][key] ?? def
        c.updateDisplay()
        refresh()
      })
    }
    folder.add({ reset: () => { resetTuning(g.id); refreshers.forEach((f) => f()) } }, 'reset').name('↺ reset this folder')
  }
  const actions = {
    copy: () => void navigator.clipboard?.writeText(changedJson()).catch(() => {}),
    log: () => console.log(changedJson()),
    resetAll: () => { resetTuning(); refreshers.forEach((f) => f()) },
  }
  fTune.add(actions, 'copy').name('Copy JSON of changed values')
  fTune.add(actions, 'log').name('Log changed values to console')
  fTune.add(actions, 'resetAll').name('↺ reset everything')
  const unsub = subscribeTuning(persist)

  return {
    destroy: () => {
      cancelAnimationFrame(raf)
      dragCleanup()
      window.removeEventListener('resize', onResize)
      unsub()
      resetTuning() // dev off = production behaviour (the saved copy in localStorage stays for next time)
      gui.destroy()
    },
  }
}
