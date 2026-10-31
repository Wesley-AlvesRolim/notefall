import { useTranslation } from 'react-i18next'

import { Button, LogoMark } from './kit'
import { MonitorIcon } from './icons'

/**
 * Shown when the browser can't provide a WebGL context — typically
 * because the user has "Use hardware acceleration when available"
 * disabled and their browser also refuses the software fallback (or
 * has WebGL itself blocked). Without this fallback the canvas mounts
 * but renders to a black surface and the rest of the UI feels broken
 * for no obvious reason.
 *
 * Pairs with `UnsupportedScreen` (small viewport): both are pre-mount
 * gates so the 3D scene + audio engine never initialise on systems
 * that can't show the result.
 */
export function WebGLUnavailableScreen() {
  const { t } = useTranslation('screens')
  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto bg-canvas px-6 py-8 text-ink">
      <div className="nf-glass-strong grid w-full max-w-[460px] justify-items-center gap-3 rounded-panel px-6 py-8 text-center">
        <span className="flex items-center gap-2 text-title">
          <LogoMark className="h-6 w-6" />
          notefall
        </span>
        <MonitorIcon className="mt-2 h-10 w-10 text-ink-muted" />
        <h1 className="m-0 text-display">{t('webgl.title')}</h1>
        <p className="m-0 max-w-sm text-ink-muted">{t('webgl.body')}</p>

        <div className="mt-2 grid w-full gap-1.5 rounded-field bg-fill-well px-4 py-3 text-left">
          <p className="m-0 text-heading">{t('webgl.howToTitle')}</p>
          <p className="m-0 text-ink-muted">
            <span className="text-ink">{t('webgl.chromeLabel')}</span> {t('webgl.chromePath')}{' '}
            <span className="text-ink">{t('webgl.chromeSetting')}</span>
            {t('webgl.chromeAfter')}
          </p>
          <p className="m-0 text-ink-muted">
            <span className="text-ink">{t('webgl.firefoxLabel')}</span> {t('webgl.firefoxPath')}{' '}
            <span className="text-ink">{t('webgl.firefoxSetting')}</span>
            {t('webgl.firefoxAfter')}
          </p>
          <p className="m-0 text-ink-muted">
            <span className="text-ink">{t('webgl.safariLabel')}</span> {t('webgl.safariPath')}{' '}
            <span className="text-ink">{t('webgl.safariSetting')}</span>
            {t('webgl.safariAfter')}
          </p>
        </div>

        <Button variant="primary" className="mt-1" onPress={() => window.location.reload()}>
          {t('webgl.reload')}
        </Button>
      </div>
    </div>
  )
}
