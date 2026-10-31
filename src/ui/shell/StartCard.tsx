import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../../store'
import { DEMOS } from '../../demos'
import { recorder } from '../../audio/recorder'
import { midiInput } from '../../audio/midiInput'
import { toggleRecord } from '../../audio/recordControl'
import { loadDemoProject, openProject } from '../../projects/actions'
import { Button, Icon, Menu, MenuItem, MenuTrigger, Popover } from '../kit'
import { showAlert } from '../confirm'
import { MOD } from './platform'

const subscribeRecorder = (cb: () => void) => recorder.addListener(cb)
const recording = () => recorder.getState() === 'recording'

/** Name of the connected MIDI keyboard, or null. */
function useMidiDeviceName(): string | null {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    const read = () => {
      const id = midiInput.getActiveDeviceId()
      setName(id ? (midiInput.getDevices().find((d) => d.id === id)?.name ?? null) : null)
    }
    read()
    return midiInput.addListener(read)
  }, [])
  return name
}

/**
 * What an empty notefall shows in the middle of the canvas: three ways to get a song in.
 * Gone the moment a song loads (and while a take is being recorded).
 */
export function StartCard() {
  const { t } = useTranslation('common')
  const song = useStore((s) => s.song)
  const countingIn = useStore((s) => s.countInBeat > 0)
  const isRecording = useSyncExternalStore(subscribeRecorder, recording)
  const device = useMidiDeviceName()
  if (song || isRecording || countingIn) return null

  const onOpen = async () => {
    const result = await openProject()
    if (result.kind === 'error') {
      void showAlert({ title: result.title ?? t('startCard.couldNotOpenTitle'), message: result.message, tone: 'error' })
    }
  }
  const onDemo = async (label: string, url: string) => {
    const result = await loadDemoProject(label, url)
    if (result.kind === 'error') {
      void showAlert({ title: t('startCard.couldNotLoadDemoTitle'), message: result.message, tone: 'error' })
    }
  }
  const action = 'h-12 w-full justify-start rounded-[12px] px-4'

  return (
    <div className="pointer-events-none fixed inset-0 z-20 grid place-items-center p-6">
      <section
        aria-labelledby="nf-start-title"
        className="nf-glass pointer-events-auto box-border grid w-[520px] max-w-full gap-4 rounded-panel px-7 py-[26px] text-body text-ink"
      >
        <div className="grid gap-2">
          <h2 id="nf-start-title" className="text-display">
            {t('startCard.title')}
          </h2>
          <p className="text-ink-muted">{t('startCard.text')}</p>
        </div>
        <div className="grid gap-2">
          <Button variant="field" icon={<Icon.FileIcon />} hint={`${MOD}O`} className={action} onPress={() => void onOpen()}>
            {t('startCard.open')}
          </Button>
          {DEMOS.length > 0 && (
            <MenuTrigger>
              <Button variant="field" icon={<Icon.PlayIcon />} hint={<Icon.ChevronRightIcon className="h-4 w-4" />} className={action}>
                {t('startCard.demo')}
              </Button>
              <Popover placement="bottom start" className="rounded-[14px]">
                <Menu aria-label={t('startCard.demoMenu')} className="max-h-72 min-w-[300px]">
                  {DEMOS.map((demo) => (
                    <MenuItem key={demo.url} textValue={demo.label} onAction={() => void onDemo(demo.label, demo.url)}>
                      {demo.label}
                    </MenuItem>
                  ))}
                </Menu>
              </Popover>
            </MenuTrigger>
          )}
          {midiInput.isSupported() && (
            <Button
              variant="field"
              icon={<span className="h-2.5 w-2.5 rounded-full bg-record" />}
              hint={device ? t('startCard.deviceConnected', { name: device }) : undefined}
              className={action}
              onPress={() => void toggleRecord()}
            >
              {t('startCard.record')}
            </Button>
          )}
        </div>
        <p className="text-caption text-ink-faint">{t('startCard.note')}</p>
      </section>
    </div>
  )
}
