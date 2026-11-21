import i18n from '../../i18n'
import { useStore } from '../../store'
import { showAlert } from '../../ui/confirm'
import { track } from '../../usage'
import { audioEngine } from '../engine'
import { SALAMANDER_SOURCE, type PianoSource } from '../pianoSource'
import { useSoundfont } from './store'
import { defaultPresetKey } from './toPreset'
import type { SoundfontFile } from './types'

/** The preset to play: the chosen one if the file has it, else the file's default. */
export function chosenPresetKey(file: SoundfontFile, chosen: string | null): string {
  return chosen !== null && file.presets.some((p) => p.key === chosen)
    ? chosen
    : defaultPresetKey(file.presets)
}

/** The sample set the current session should play (also what an export renders with). */
export function currentPianoSource(): PianoSource {
  const { file } = useSoundfont.getState()
  if (!file) return SALAMANDER_SOURCE
  return {
    kind: 'sf2',
    file,
    presetKey: chosenPresetKey(file, useStore.getState().settings.soundfontPreset),
  }
}

/**
 * Keeps the audio engine's piano in step with the loaded SoundFont and its
 * chosen preset. Until the piano has been loaded once (the first play or
 * key press) a change only records the choice, so nothing is downloaded or
 * built before it's wanted; after that the piano is rebuilt, with the
 * loading island shown meanwhile. Returns the unsubscribe.
 */
export function startSoundfontSync(): () => void {
  let lastFile: SoundfontFile | null = null
  let lastKey: string | null = null
  let pending = 0

  const rebuild = async (source: PianoSource) => {
    const store = useStore.getState()
    pending++
    store.setLoadStatus({ state: 'loading', loaded: 0, total: 1 })
    try {
      await audioEngine.setInstrument(source, (p) =>
        store.setLoadStatus({ state: 'loading', loaded: p.loaded, total: p.total }),
      )
    } catch (e) {
      // The file parsed but can't be played: drop it, which sends the
      // piano back to the built-in one through the subscription below.
      const detail = e instanceof Error ? e.message : String(e)
      const name = useSoundfont.getState().fileName ?? ''
      track('error_surfaced', { context: 'soundfont' })
      useSoundfont.getState().clearFromLoad()
      void showAlert({
        title: i18n.t('dialogs:actions.couldNotLoadSoundfontTitle'),
        message: i18n.t('dialogs:actions.couldNotLoadSoundfontMessage', { name, detail }),
        tone: 'error',
      })
    } finally {
      // A newer change may still be loading; only the last one reports ready.
      if (--pending === 0) {
        useStore
          .getState()
          .setLoadStatus(audioEngine.hasSampler() ? { state: 'ready' } : { state: 'idle' })
      }
    }
  }

  const apply = () => {
    const { file } = useSoundfont.getState()
    const key = file
      ? chosenPresetKey(file, useStore.getState().settings.soundfontPreset)
      : null
    if (file === lastFile && key === lastKey) return
    lastFile = file
    lastKey = key
    const source: PianoSource = file
      ? { kind: 'sf2', file, presetKey: key as string }
      : SALAMANDER_SOURCE
    if (audioEngine.hasSampler()) void rebuild(source)
    else void audioEngine.setInstrument(source)
  }

  const offFile = useSoundfont.subscribe(apply)
  const offSettings = useStore.subscribe(apply)
  return () => {
    offFile()
    offSettings()
  }
}
