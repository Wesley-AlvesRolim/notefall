import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import clsx from 'clsx'
import { useShallow } from 'zustand/react/shallow'
import { useTranslation } from 'react-i18next'
import { useStore, type Settings } from '../../store'
import { ColorPickerPopover, SearchableBlock } from '../controls'

type Keys = readonly (keyof Settings)[]

/** CSS for the bar: the stops sorted by position; `softness` < 1 holds each colour over part of its gap. */
function barBackground(stops: { p: number; c: string }[], softness: number): string {
  const sorted = [...stops].sort((a, b) => a.p - b.p)
  const hold = (1 - Math.max(0, Math.min(1, softness))) / 2
  const parts: string[] = []
  sorted.forEach((s, i) => {
    const prev = sorted[i - 1]
    const next = sorted[i + 1]
    const lo = prev ? (s.p - prev.p) * hold : 0
    const hi = next ? (next.p - s.p) * hold : 0
    parts.push(`${s.c} ${((s.p - lo) * 100).toFixed(2)}%`, `${s.c} ${((s.p + hi) * 100).toFixed(2)}%`)
  })
  return `linear-gradient(90deg, ${parts.join(', ')})`
}

/** Effective (targeted keyframe over base) values of `keys`, as an array. */
function useEffectiveValues(keys: Keys): unknown[] {
  return useStore(
    useShallow((st) => {
      const time = st.editingKeyframeTime
      const kf = time === null ? undefined : st.settings.settingsKeyframes.find((p) => Math.abs(p.time - time) < 1e-6)
      return keys.map((k) => (kf && k in kf.settings ? kf.settings[k] : st.settings[k]))
    }),
  )
}

const write = (patch: Partial<Settings>) => useStore.getState().updateSettings(patch)

/**
 * Direct editor for a 2-5 stop gradient: the bar shows the result, each stop is a handle dragged sideways (one undo
 * entry per drag or key press); a click opens that stop's colour picker. The per-stop rows below keep exact values.
 */
export function GradientStops({
  colorKeys,
  posKeys,
  count,
  softnessKey,
  angleKey,
  label,
}: {
  colorKeys: Keys
  posKeys: Keys
  count: number
  softnessKey: keyof Settings
  /** The note gradient's angle; the end labels only show while the gradient runs left to right. */
  angleKey?: keyof Settings
  label: string
}) {
  const { t } = useTranslation('inspector')
  const n = Math.max(2, Math.min(5, count))
  const colors = useEffectiveValues(colorKeys) as string[]
  const positions = useEffectiveValues(posKeys) as number[]
  const [softness, angle] = useEffectiveValues(angleKey ? [softnessKey, angleKey] : [softnessKey]) as number[]
  const barRef = useRef<HTMLDivElement>(null)
  const handleRefs = useRef<(HTMLDivElement | null)[]>([])
  const drag = useRef<{ i: number; x0: number; moved: boolean } | null>(null)
  const [open, setOpen] = useState<number | null>(null)

  const stops = Array.from({ length: n }, (_, i) => ({ p: positions[i], c: colors[i] }))
  const leftToRight = angle === undefined || Math.cos((angle * Math.PI) / 180) > 0.7

  const setPos = (i: number, p: number) => write({ [posKeys[i]]: Math.round(Math.max(0, Math.min(1, p)) * 100) / 100 })

  const onDown = (i: number, e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus()
    drag.current = { i, x0: e.clientX, moved: false }
  }
  const onMove = (i: number, e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const bar = barRef.current
    if (!d || d.i !== i || !bar) return
    if (!d.moved) {
      if (Math.abs(e.clientX - d.x0) < 3) return
      d.moved = true
      useStore.getState().beginSettingsEdit()
    }
    const r = bar.getBoundingClientRect()
    setPos(i, (e.clientX - r.left) / r.width)
  }
  const onUp = (i: number) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.moved) useStore.getState().endSettingsEdit()
    else setOpen(i)
  }
  const onKey = (i: number, e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.01
    let next: number | null = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = positions[i] - step
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = positions[i] + step
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = 1
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setOpen(i)
      return
    }
    if (next === null) return
    e.preventDefault()
    const s = useStore.getState()
    s.beginSettingsEdit()
    setPos(i, next)
    s.endSettingsEdit()
  }

  return (
    <SearchableBlock label={label}>
      <div className="grid gap-1.5 pb-1.5 pt-1">
        <div
          ref={barRef}
          className="relative h-[30px] touch-none rounded-field"
          style={{ background: barBackground(stops, softness) }}
        >
          {stops.map((s, i) => (
            <div
              key={i}
              ref={(el) => {
                handleRefs.current[i] = el
              }}
              role="slider"
              tabIndex={0}
              aria-label={t('coloring.stopHandle', { n: i + 1 })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(s.p * 100)}
              aria-valuetext={`${Math.round(s.p * 100)}%`}
              onPointerDown={(e) => onDown(i, e)}
              onPointerMove={(e) => onMove(i, e)}
              onPointerUp={() => onUp(i)}
              onPointerCancel={() => {
                if (drag.current?.moved) useStore.getState().endSettingsEdit()
                drag.current = null
              }}
              onKeyDown={(e) => onKey(i, e)}
              className={clsx(
                'nf-focus absolute -top-1 h-[38px] w-4 -translate-x-1/2 cursor-ew-resize touch-none box-border rounded-lg border-2 border-ink shadow-knob outline-none',
              )}
              style={{ left: `${s.p * 100}%`, background: s.c }}
            />
          ))}
        </div>
        {leftToRight && (
          <div className="flex justify-between text-caption text-ink-faint">
            <span>{t('coloring.lowestKey')}</span>
            <span>{t('coloring.highestKey')}</span>
          </div>
        )}
        {open !== null && (
          <ColorPickerPopover
            triggerRef={{ current: handleRefs.current[open] }}
            isOpen
            onOpenChange={(o) => {
              if (!o) setOpen(null)
            }}
            label={t('coloring.stopColor', { n: open + 1 })}
            value={colors[open]}
            onChange={(v) => write({ [colorKeys[open]]: v })}
          />
        )}
      </div>
    </SearchableBlock>
  )
}
