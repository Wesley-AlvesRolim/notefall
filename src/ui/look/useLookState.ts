import { useShallow } from 'zustand/react/shallow'
import { useStore, type Settings } from '../../store'

const LOOK_KEYS = [
  'noteMaterial',
  'noteShape',
  'noteCornerRadius',
  'noteTransparency',
  'noteBump',
  'noteSheen',
  'noteAmbient',
  'noteLightIntensity',
  'noteOutlineWidth',
] as const

const COLOR_KEYS = [
  'noteColorMode',
  'noteColor',
  'noteGradientStops',
  'noteGradientColor1',
  'noteGradientColor2',
  'noteGradientColor3',
  'noteGradientColor4',
  'noteGradientColor5',
  'noteRandomCount',
  'noteRandomColor1',
  'noteRandomColor2',
  'noteRandomColor3',
  'noteRandomColor4',
  'noteRandomColor5',
  'noteHandColorL',
  'noteHandColorR',
] as const

/** The settings as shown: the targeted keyframe's snapshot over the base look, picked to `keys`. */
function pickEffective<K extends keyof Settings>(st: ReturnType<typeof useStore.getState>, keys: readonly K[]) {
  const time = st.editingKeyframeTime
  const kf = time === null ? undefined : st.settings.settingsKeyframes.find((p) => Math.abs(p.time - time) < 1e-6)
  const out = {} as Pick<Settings, K>
  for (const k of keys) out[k] = (kf && k in kf.settings ? kf.settings[k] : st.settings[k]) as Settings[K]
  return out
}

/** The look keys the preset thumbnails are drawn from. */
export function useEffectiveLook() {
  return useStore(useShallow((st) => pickEffective(st, LOOK_KEYS)))
}

/** Three colours of the current note colouring (one per thumbnail bar). */
export function useBarColors(): string[] {
  const c = useStore(useShallow((st) => pickEffective(st, COLOR_KEYS)))
  if (c.noteColorMode === 'gradient') {
    const stops = [c.noteGradientColor1, c.noteGradientColor2, c.noteGradientColor3, c.noteGradientColor4, c.noteGradientColor5]
    const n = Math.max(2, Math.min(5, Math.round(c.noteGradientStops)))
    return [stops[0], stops[Math.floor((n - 1) / 2)], stops[n - 1]]
  }
  if (c.noteColorMode === 'random') {
    const pal = [c.noteRandomColor1, c.noteRandomColor2, c.noteRandomColor3, c.noteRandomColor4, c.noteRandomColor5]
    const n = Math.max(1, Math.min(5, Math.round(c.noteRandomCount)))
    return [pal[0], pal[1 % n], pal[2 % n]]
  }
  if (c.noteColorMode === 'hand') return [c.noteHandColorL, c.noteHandColorR, c.noteHandColorR]
  return [c.noteColor, c.noteColor, c.noteColor]
}
