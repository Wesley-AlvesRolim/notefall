import { useTranslation } from 'react-i18next'

import { LogoMark } from './kit'
import { MonitorIcon } from './icons'

/**
 * Shown on screens narrower than the supported breakpoint. The full UI
 * (3D viewport + inspector + transport bar) needs at least ~1024px to be
 * usable, so smaller devices see this page instead of a broken layout.
 */
export function UnsupportedScreen() {
  const { t } = useTranslation('screens')
  return (
    <div className="flex h-full w-full items-center justify-center bg-canvas px-6 text-ink">
      <div className="nf-glass-strong grid w-full max-w-[420px] justify-items-center gap-3 rounded-panel px-6 py-8 text-center">
        <span className="flex items-center gap-2 text-title">
          <LogoMark className="h-6 w-6" />
          notefall
        </span>
        <MonitorIcon className="mt-2 h-10 w-10 text-ink-muted" />
        <h1 className="m-0 text-display">{t('unsupported.title')}</h1>
        <p className="m-0 max-w-xs text-ink-muted">{t('unsupported.body')}</p>
      </div>
    </div>
  )
}
