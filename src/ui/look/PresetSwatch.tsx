import { useState } from 'react'
import { Radio, RadioGroup } from 'react-aria-components'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { Settings } from '../../store'
import { NOTE_LOOK_PRESETS, NOTE_LOOK_PRESET_NAMES, type NoteLookPreset } from '../../notes/looks/noteLook'

/** Presets shown before "More looks" (the spec's cap for the panel). */
const VISIBLE = 8

// Thumbnails rendered by the real note shader (three notes in a neutral warm white, no
// particles or guide lines), regenerated with _local/redesign/tools/capture-preset-thumbs.mjs
// whenever a preset changes. The chip tints them with the current note colours.
const THUMBS = import.meta.glob('./presets/*.jpg', { eager: true, query: '?url', import: 'default' }) as Record<
  string,
  string
>
const thumbUrl = (name: NoteLookPreset): string | undefined => THUMBS[`./presets/${name}.jpg`]

type LookLike = Pick<Settings, 'noteMaterial' | 'noteShape'>

/** The preset picture for a look that matches none: the first preset of the same material and shape. */
function nearestPreset(look: LookLike): NoteLookPreset {
  return (
    NOTE_LOOK_PRESET_NAMES.find(
      (n) => NOTE_LOOK_PRESETS[n].noteMaterial === look.noteMaterial && NOTE_LOOK_PRESETS[n].noteShape === look.noteShape,
    ) ??
    NOTE_LOOK_PRESET_NAMES.find((n) => NOTE_LOOK_PRESETS[n].noteMaterial === look.noteMaterial) ??
    NOTE_LOOK_PRESET_NAMES[0]
  )
}

/** The rendered preset, tinted by the current note colours (multiply keeps the shading, takes the hue). */
function Thumb({ name, colors }: { name: NoteLookPreset; colors: string[] }) {
  const tint =
    colors.length > 1 ? `linear-gradient(90deg, ${colors.join(', ')})` : (colors[0] ?? 'transparent')
  return (
    <span className="relative block h-14 overflow-hidden rounded-tab bg-fill-well">
      <img src={thumbUrl(name)} alt="" draggable={false} className="h-full w-full object-cover" />
      <span aria-hidden className="absolute inset-0 mix-blend-multiply" style={{ background: tint }} />
      {/* Ring above the tint so it stays ink. */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-tab shadow-[inset_0_0_0_1.5px_transparent] transition-shadow duration-150 group-data-[hovered]:shadow-[inset_0_0_0_1.5px_var(--glass-edge)] group-data-[selected]:!shadow-[inset_0_0_0_1.5px_var(--ink)]"
      />
    </span>
  )
}

/**
 * The note-look presets as a radio grid of chips. `value` is the matching preset or 'custom' (a look matching
 * none: it gets a chip of its own, pictured by the nearest preset, and nothing else is selected).
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
  /** Colours of the current note colouring, left to right. */
  colors: string[]
  label: string
}) {
  const { t } = useTranslation('inspector')
  const [more, setMore] = useState(false)
  const selectedIdx = value === 'custom' ? -1 : NOTE_LOOK_PRESET_NAMES.indexOf(value)
  const expanded = more || selectedIdx >= VISIBLE
  const names = expanded ? NOTE_LOOK_PRESET_NAMES : NOTE_LOOK_PRESET_NAMES.slice(0, VISIBLE)
  const chipClass =
    'group nf-focus grid cursor-pointer gap-[5px] rounded-tab text-center text-caption text-ink-muted outline-none transition-colors duration-150 data-[hovered]:text-ink data-[selected]:text-ink'
  return (
    <div className="grid gap-2">
      <RadioGroup
        aria-label={label}
        value={value === 'custom' ? null : value}
        onChange={(v) => onChange(v as NoteLookPreset)}
        className="grid grid-cols-4 gap-2"
      >
        {value === 'custom' && (
          <div role="presentation" data-selected className={clsx(chipClass, 'cursor-default text-ink')}>
            <Thumb name={nearestPreset(look)} colors={colors} />
            {t('look.presets.custom')}
          </div>
        )}
        {names.map((name) => (
          <Radio key={name} value={name} className={chipClass}>
            <Thumb name={name} colors={colors} />
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
