import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Icon } from './kit'
import { ScreenFrame } from './shell/ScreenFrame'

/**
 * Shown on screens narrower than the supported breakpoint. The full UI
 * (3D viewport + inspector + transport bar) needs at least ~1024px to be
 * usable, so smaller devices see this page instead of a broken layout.
 * Most people land here from a phone: give them the link to open on a computer.
 */
export function UnsupportedScreen() {
  const { t } = useTranslation('screens')
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard blocked: the address bar still has the link */
    }
  }
  return (
    <ScreenFrame title={t('unsupported.title')}>
      <p className="-mt-2 mb-0 text-ink-muted">{t('unsupported.body')}</p>
      <Button variant="primary" icon={copied ? <Icon.CheckIcon /> : undefined} onPress={copy} className="w-fit">
        {copied ? t('unsupported.copied') : t('unsupported.copyLink')}
      </Button>
    </ScreenFrame>
  )
}
