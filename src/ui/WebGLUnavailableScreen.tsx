import { useTranslation } from 'react-i18next'
import { Button } from './kit'
import { ScreenFrame } from './shell/ScreenFrame'

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
  const steps = [
    ['chromeLabel', 'chromePath', 'chromeSetting', 'chromeAfter'],
    ['firefoxLabel', 'firefoxPath', 'firefoxSetting', 'firefoxAfter'],
    ['safariLabel', 'safariPath', 'safariSetting', 'safariAfter'],
  ] as const
  return (
    <ScreenFrame title={t('webgl.title')}>
      <p className="-mt-2 mb-0 text-ink-muted">{t('webgl.body')}</p>
      <div className="grid gap-2">
        <p className="m-0 text-heading">{t('webgl.howToTitle')}</p>
        {steps.map(([label, path, setting, after]) => (
          <p key={label} className="m-0 text-ink-muted">
            <span className="text-ink">{t(`webgl.${label}`)}</span> {t(`webgl.${path}`)}{' '}
            <span className="text-ink">{t(`webgl.${setting}`)}</span>
            {t(`webgl.${after}`)}
          </p>
        ))}
      </div>
      <Button variant="primary" className="w-fit" onPress={() => window.location.reload()}>
        {t('webgl.reload')}
      </Button>
    </ScreenFrame>
  )
}
