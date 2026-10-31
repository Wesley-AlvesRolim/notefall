import { useState, type CSSProperties } from 'react'
import { Radio, RadioGroup } from 'react-aria-components'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { Settings } from '../../store'
import { NOTE_LOOK_PRESETS, NOTE_LOOK_PRESET_NAMES, type NoteLookPreset } from '../../notes/looks/noteLook'

/** Presets shown before "More looks" (the spec's cap for the panel). */
const VISIBLE = 8
const BAR_HEIGHTS = [60, 85, 40]

type LookLike = Pick<
  Settings,
  | 'noteMaterial'
  | 'noteShape'
  | 'noteCornerRadius'
  | 'noteTransparency'
  | 'noteBump'
  | 'noteSheen'
  | 'noteAmbient'
  | 'noteLightIntensity'
  | 'noteOutlineWidth'
>

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    amount >= 0 ? clamp(c + (255 - c) * amount) : clamp(c * (1 + amount)),
  )
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

/** One bar's CSS: a gradient approximation of the look's material feel in the given colour. */
function barStyle(look: LookLike, color: string, height: number): CSSProperties {
  const style: CSSProperties = { height: `${height}%`, borderRadius: Math.max(2, Math.min(4.5, look.noteCornerRadius * 16)) }
  if (look.noteShape === 'angled') {
    // hollow angled frame
    style.background = 'transparent'
    style.boxShadow = `inset 0 0 0 2px ${color}`
    return style
  }
  if (look.noteShape === 'gem') style.clipPath = 'polygon(25% 0, 75% 0, 100% 18%, 100% 82%, 75% 100%, 25% 100%, 0 82%, 0 18%)'
  const base = look.noteMaterial === 'realistic' ? shade(color, -0.35) : color
  const top = shade(color, look.noteMaterial === 'sprite' ? 0.3 : 0.55)
  const bottom = shade(color, -0.3)
  const layers: string[] = []
  if (look.noteMaterial === 'reflective' && look.noteSheen > 0.3) {
    layers.push('linear-gradient(115deg, transparent 30%, rgb(255 255 255 / 0.5) 45%, transparent 60%)')
  }
  if (look.noteBump !== 'none' && look.noteMaterial !== 'sprite') {
    layers.push('repeating-linear-gradient(60deg, rgb(255 255 255 / 0.16) 0 1.5px, transparent 1.5px 4px)')
  }
  if (look.noteMaterial === 'realistic') {
    layers.push(`linear-gradient(${shade(color, 0.2)}, ${base})`)
  } else {
    layers.push(`linear-gradient(${top}, ${look.noteMaterial === 'sprite' ? base : bottom})`)
  }
  style.background = layers.join(',')
  if (look.noteTransparency > 0) style.opacity = 1 - Math.min(0.5, look.noteTransparency * 0.6)
  return style
}

/** Three bars in the look's feel and the given colours (the current note colouring). */
function Thumb({ look, colors }: { look: LookLike; colors: string[] }) {
  return (
    <span className="flex h-14 items-end justify-center gap-1 rounded-tab border-[1.5px] border-transparent bg-fill-well p-[7px] box-border group-data-[selected]:border-ink">
      {BAR_HEIGHTS.map((h, i) => (
        <i key={i} className="block w-[9px]" style={barStyle(look, colors[i] ?? colors[0], h)} />
      ))}
    </span>
  )
}

/**
 * The note-look presets as a radio grid of chips. `value` is the matching preset or 'custom' (a look matching
 * none: it gets a chip of its own, drawn from the current look, and nothing else is selected).
 */
export function PresetSwatch({
  value,
  onChange,
  look,
  colors,
  label,
}: {
  value: NoteLookPreset | 'custom'
  onChange: (v: NoteLookPreset) => void
  /** The current look, for the Custom chip's picture. */
  look: LookLike
  /** Three colours of the current note colouring, one per bar. */
  colors: string[]
  label: string
}) {
  const { t } = useTranslation('inspector')
  const [more, setMore] = useState(false)
  const selectedIdx = value === 'custom' ? -1 : NOTE_LOOK_PRESET_NAMES.indexOf(value)
  const expanded = more || selectedIdx >= VISIBLE
  const names = expanded ? NOTE_LOOK_PRESET_NAMES : NOTE_LOOK_PRESET_NAMES.slice(0, VISIBLE)
  const chipClass =
    'group nf-focus grid cursor-pointer gap-[5px] rounded-tab text-center text-caption text-ink-muted outline-none data-[selected]:text-ink'
  return (
    <div className="grid gap-2">
      <RadioGroup
        aria-label={label}
        value={value === 'custom' ? null : value}
        onChange={(v) => onChange(v as NoteLookPreset)}
        className="grid grid-cols-4 gap-2"
      >
        {value === 'custom' && (
          <div role="presentation" data-selected className={clsx(chipClass, 'group cursor-default text-ink')}>
            <Thumb look={look} colors={colors} />
            {t('look.presets.custom')}
          </div>
        )}
        {names.map((name) => (
          <Radio key={name} value={name} className={chipClass}>
            <Thumb look={NOTE_LOOK_PRESETS[name]} colors={colors} />
            <span className="truncate">{t(`look.presets.${name}`)}</span>
          </Radio>
        ))}
      </RadioGroup>
      {NOTE_LOOK_PRESET_NAMES.length > VISIBLE && selectedIdx < VISIBLE && (
        <button
          type="button"
          onClick={() => setMore((m) => !m)}
          aria-expanded={more}
          className="nf-focus w-fit cursor-pointer rounded-field border-0 bg-transparent px-1 text-caption text-ink-muted outline-none hover:text-ink"
        >
          {more ? t('look.fewerLooks') : t('look.moreLooks')}
        </button>
      )}
    </div>
  )
}
