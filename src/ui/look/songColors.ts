import { useStore, type Settings } from '../../store'

const HEX_RE = /^#[0-9a-f]{6}$/i

/** The settings as the Inspector shows them: the targeted keyframe's snapshot over the base look. */
function effectiveSettings(): Settings {
  const st = useStore.getState()
  const time = st.editingKeyframeTime
  if (time === null) return st.settings
  const kf = st.settings.settingsKeyframes.find((p) => Math.abs(p.time - time) < 1e-6)
  return kf ? { ...st.settings, ...kf.settings } : st.settings
}

/**
 * Colours the current look actually draws with (the picker's "In this song" row): the active note colouring, the
 * hit line's own colour when its mode uses one, the background and the enabled effects' explicit solid colours.
 * Deduped case-insensitively, `exclude` (the colour being edited) left out, at most 12.
 */
export function collectSongColors(exclude: string): string[] {
  const s = effectiveSettings()
  const song = useStore.getState().song
  const seen = new Set<string>([exclude.toLowerCase()])
  const out: string[] = []
  const add = (v: unknown) => {
    if (typeof v !== 'string' || !HEX_RE.test(v)) return
    const k = v.toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    out.push(k)
  }

  if (s.noteColorMode === 'solid') {
    add(s.noteColor)
    song?.tracks.forEach((t, idx) => {
      if (t.hasNotes) add(s.trackColors[String(idx)])
    })
  } else if (s.noteColorMode === 'gradient') {
    const n = Math.round(s.noteGradientStops)
    ;[s.noteGradientColor1, s.noteGradientColor2, s.noteGradientColor3, s.noteGradientColor4, s.noteGradientColor5]
      .slice(0, n)
      .forEach(add)
  } else {
    const n = Math.round(s.noteRandomCount)
    ;[s.noteRandomColor1, s.noteRandomColor2, s.noteRandomColor3, s.noteRandomColor4, s.noteRandomColor5]
      .slice(0, n)
      .forEach(add)
  }

  if (s.hitLineEnabled) {
    if (s.hitLineColorMode === 'solid' || (s.hitLineColorMode === 'note' && s.noteColorMode === 'random')) {
      add(s.hitLineColor)
    } else if (s.hitLineColorMode === 'gradient') {
      const n = Math.round(s.hitLineGradientStops)
      ;[
        s.hitLineGradientColor1,
        s.hitLineGradientColor2,
        s.hitLineGradientColor3,
        s.hitLineGradientColor4,
        s.hitLineGradientColor5,
      ]
        .slice(0, n)
        .forEach(add)
    }
  }
  add(s.backgroundColor)
  if (s.particlesEnabled && !s.particleColorFollowNote) add(s.particleColor)
  if (s.flashEnabled && !s.flashFollowNote) add(s.flashColor)
  if (s.keyGlowEnabled && !s.keyGlowFollowNote) add(s.keyGlowColor)
  if (s.edgeEnabled) add(s.noteEdgeColor)
  if (s.noteLabelsEnabled) add(s.noteLabelColor)
  return out.slice(0, 12)
}
