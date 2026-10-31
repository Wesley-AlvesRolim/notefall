import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Slider, SliderThumb, SliderTrack } from 'react-aria-components'
import { useStore } from '../store'
import { previewNote } from '../audio/preview'
import { deleteNotes, setNotesVelocity } from '../midi/edit'
import { midiToName } from '../midi/noteName'
import { selectionScreenRect } from '../scene/selectionBounds'
import { notifyNotesDeleted } from './editor/deleteToast'
import { Button, Icon, Panel } from './kit'

const CARD_W = 252
const GAP = 14
const PAD = 8

const toMidiVel = (v: number) => Math.max(1, Math.min(127, Math.round(v * 127)))

/**
 * The card beside the selected notes while paused: header, velocity (value field + slider) and
 * Delete. It tracks the selection's on-screen bounding box every frame (seek / scroll move the
 * notes), sits on the side with room and is hidden while a pointer gesture is in flight.
 *
 * Velocity: dragging shifts every selected note by the same delta (differences kept, clamped
 * 1..127); typing a number sets them all. One gesture = one undo entry (snapshot at the first
 * change, previews during, nothing to commit afterwards).
 */
export function SelectionCard({ wrapEl }: { wrapEl: HTMLElement | null }) {
  const { t } = useTranslation('editor')
  const song = useStore((s) => s.song)
  const selection = useStore((s) => s.selection)
  const transport = useStore((s) => s.transport)
  const transpose = useStore((s) => s.settings.transpose)

  const selected = useMemo(
    () => (song ? song.notes.filter((n) => selection.has(n.id)) : []),
    [song, selection],
  )
  const open = !!wrapEl && !!song && transport !== 'playing' && selected.length > 0

  const cardRef = useRef<HTMLDivElement>(null)
  const pointerDownRef = useRef(false)

  // Pointer gestures on the canvas (new note, move, marquee, eraser) hide the card; presses on the
  // card itself (slider drag) must not.
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      if (cardRef.current?.contains(e.target as Node)) return
      pointerDownRef.current = true
    }
    const up = () => {
      pointerDownRef.current = false
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
      pointerDownRef.current = false
    }
  }, [open])

  // Placement loop.
  useLayoutEffect(() => {
    if (!open || !wrapEl) return
    let raf = 0
    const place = () => {
      raf = requestAnimationFrame(place)
      const card = cardRef.current
      if (!card) return
      const rect = selectionScreenRect()
      const w = wrapEl.getBoundingClientRect()
      const h = card.offsetHeight
      const hide = !rect || pointerDownRef.current || !!useStore.getState().rangeSelectRect
      if (hide || !rect) {
        card.style.visibility = 'hidden'
        return
      }
      const l = rect.left - w.left
      const r = rect.right - w.left
      const top = rect.top - w.top
      const bottom = rect.bottom - w.top
      if (r < 0 || l > w.width || bottom < 0 || top > w.height) {
        card.style.visibility = 'hidden'
        return
      }
      const roomRight = w.width - PAD - (r + GAP)
      const roomLeft = l - GAP - PAD
      let x: number
      if (roomRight >= CARD_W) x = r + GAP
      else if (roomLeft >= CARD_W) x = l - GAP - CARD_W
      else x = roomRight >= roomLeft ? r + GAP : l - GAP - CARD_W
      x = Math.max(PAD, Math.min(x, w.width - CARD_W - PAD))
      const cy = (Math.max(top, 0) + Math.min(bottom, w.height)) / 2
      const y = Math.max(PAD, Math.min(cy - h / 2, w.height - h - PAD))
      card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
      card.style.visibility = 'visible'
    }
    place()
    return () => cancelAnimationFrame(raf)
  }, [open, wrapEl])

  // Velocity preview ticker: replays the selection every 500 ms while the slider is dragged so the
  // loudness change is audible (distinct pitches only).
  const previewTimer = useRef<number | null>(null)
  const firePreview = () => {
    const st = useStore.getState()
    if (!st.song || st.selection.size === 0) return
    const seen = new Set<number>()
    for (const n of st.song.notes) {
      if (!st.selection.has(n.id)) continue
      const midi = n.midi + st.settings.transpose
      if (seen.has(midi)) continue
      seen.add(midi)
      void previewNote(midi, n.velocity, 200)
    }
  }
  const startPreviewLoop = () => {
    if (previewTimer.current !== null) return
    firePreview()
    previewTimer.current = window.setInterval(firePreview, 500)
  }
  const stopPreviewLoop = () => {
    if (previewTimer.current !== null) {
      window.clearInterval(previewTimer.current)
      previewTimer.current = null
    }
  }
  useEffect(() => stopPreviewLoop, [])

  // Slider gesture: base song + the selection's midpoint when it started.
  const gesture = useRef<{ base: NonNullable<typeof song>; mid: number } | null>(null)

  const vels = selected.map((n) => toMidiVel(n.velocity))
  const lo = vels.length ? Math.min(...vels) : 1
  const hi = vels.length ? Math.max(...vels) : 1
  const mixed = lo !== hi
  const mid = (lo + hi) / 2

  const onSlide = (raw: number | number[]) => {
    const value = typeof raw === 'number' ? raw : raw[0]
    const st = useStore.getState()
    if (!st.song) return
    if (!gesture.current) {
      st.pushUndoSnapshot(st.song)
      gesture.current = { base: st.song, mid }
    }
    const { base, mid: mid0 } = gesture.current
    const delta = Math.round(value - mid0)
    st.setSongPreview(
      setNotesVelocity(base, st.selection, (v) => {
        const nv = Math.max(1, Math.min(127, Math.round(v * 127) + delta))
        return nv / 127
      }),
    )
    startPreviewLoop()
  }
  const onSlideEnd = () => {
    gesture.current = null
    stopPreviewLoop()
  }

  const setAll = (value: number) => {
    const st = useStore.getState()
    if (!st.song) return
    const v = Math.max(1, Math.min(127, Math.round(value)))
    const next = setNotesVelocity(st.song, st.selection, () => v / 127)
    if (next === st.song) return
    st.pushUndoSnapshot(st.song)
    st.setSongPreview(next)
    firePreview()
  }

  const doDelete = () => {
    const st = useStore.getState()
    if (!st.song || st.selection.size === 0) return
    const count = st.selection.size
    const next = deleteNotes(st.song, st.selection)
    if (next === st.song) return
    st.applySongEdit(next)
    st.replaceSelection([])
    notifyNotesDeleted(count)
  }

  if (!open) return null

  const count = selected.length
  return (
    <Panel
      strong
      ref={cardRef}
      role="group"
      aria-label={t('selection.groupLabel', { count })}
      className="absolute left-0 top-0 z-50 invisible"
      style={{ width: CARD_W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex items-baseline justify-between px-4 pb-1 pt-[14px] font-semibold">
        <span>{t('selection.notes', { count })}</span>
        {count === 1 && (
          <span className="font-normal text-ink-muted">{midiToName(selected[0].midi + transpose)}</span>
        )}
      </div>
      <div className="grid gap-[14px] px-4 pb-[14px] pt-2">
        {/* Hand / Finger rows go here once notes carry hand + finger data (not in the data model yet). */}
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-muted">{t('selection.velocity')}</span>
            <VelocityField lo={lo} hi={hi} onCommit={setAll} />
          </div>
          <Slider
            aria-label={t(mixed ? 'selection.velocityRange' : 'selection.velocity')}
            value={mid}
            minValue={1}
            maxValue={127}
            step={1}
            onChange={onSlide}
            onChangeEnd={onSlideEnd}
          >
            <SliderTrack className="relative h-5 w-full cursor-ew-resize touch-none">
              {({ state }) => {
                const pct = (v: number) => ((v - 1) / 126) * 100
                return (
                  <>
                    <div className="absolute inset-x-0 top-2 h-1 rounded-sm bg-fill-track" />
                    {mixed ? (
                      <div
                        className="absolute top-2 h-1 rounded-sm bg-ink-muted"
                        style={{ left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%` }}
                      />
                    ) : (
                      <div
                        className="absolute left-0 top-2 h-1 rounded-sm bg-ink"
                        style={{ width: `${state.getThumbPercent(0) * 100}%` }}
                      />
                    )}
                    <SliderThumb
                      className={
                        'top-[10px] h-4 w-4 rounded-round bg-ink shadow-[var(--shadow-knob)] nf-focus outline-none' +
                        (mixed ? ' opacity-0 data-[dragging]:opacity-100' : '')
                      }
                    />
                  </>
                )
              }}
            </SliderTrack>
          </Slider>
        </div>
      </div>
      <div className="border-t border-glass-edge p-1.5">
        <Button
          variant="danger"
          className="w-full justify-start rounded-[10px]"
          icon={<Icon.TrashIcon />}
          hint="⌫"
          onPress={doDelete}
        >
          {t('selection.delete', { count })}
        </Button>
      </div>
    </Panel>
  )
}

/** Value field: the single value, or "64–92" when mixed; typing a number sets every selected note. */
function VelocityField({ lo, hi, onCommit }: { lo: number; hi: number; onCommit: (v: number) => void }) {
  const { t } = useTranslation('editor')
  const display = lo === hi ? String(lo) : `${lo}–${hi}`
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft !== null) {
      const n = Number(draft)
      if (draft.trim() !== '' && Number.isFinite(n)) onCommit(n)
    }
    setDraft(null)
  }
  return (
    <input
      aria-label={t('selection.velocity')}
      inputMode="numeric"
      value={draft ?? display}
      onFocus={(e) => {
        setDraft('')
        e.currentTarget.select()
      }}
      onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') {
          setDraft(null)
          e.currentTarget.blur()
        }
        e.stopPropagation()
      }}
      placeholder={display}
      className="nf-focus h-[26px] min-w-16 max-w-20 rounded-field bg-fill-field px-2 text-right text-ink outline-none placeholder:text-ink"
    />
  )
}
