import { useState } from 'react'
import { Button as AriaButton, MenuTrigger } from 'react-aria-components'
import { useTranslation } from 'react-i18next'
import { REPO_URL, type ReportKind } from '../../feedback/report'
import { isAnalyticsOptedOut, setAnalyticsOptOut } from '../../usage'
import { CONTROL_STATES, LogoMark, Menu, MenuItem, MenuSeparator, Popover } from '../kit'
import { LanguageSubmenu } from '../LanguageSwitcher'
import { useShell } from './uiState'

const openExternal = (url: string) => {
  // `noopener,noreferrer` keeps the new tab from getting `window.opener` back to the app.
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** The wordmark is the app menu: shortcuts, language, feedback, GitHub, analytics, build. */
export function AppMenu({ onFeedback }: { onFeedback: (kind: ReportKind) => void }) {
  const { t } = useTranslation('toolbar')
  // Analytics opt-out is persisted in localStorage; mirror it so the switch reflects the
  // current choice. Framed positively ("Help improve" = on), so `enabled` is the inverse.
  const [analyticsOff, setAnalyticsOff] = useState(isAnalyticsOptedOut)
  const toggleAnalytics = () => {
    setAnalyticsOptOut(!analyticsOff)
    setAnalyticsOff(!analyticsOff)
  }

  return (
    <MenuTrigger>
      <AriaButton
        aria-label={t('app.menuLabel')}
        className={`${CONTROL_STATES} inline-flex h-control cursor-pointer items-center gap-2 rounded-round pl-2 pr-3 text-title text-ink data-[hovered]:bg-fill-hover`}
      >
        <LogoMark className="h-[22px] w-[22px] flex-none" />
        notefall
      </AriaButton>
      <Popover placement="bottom start" className="rounded-[14px]">
        <Menu aria-label={t('app.menuLabel')} className="w-[280px]">
          <MenuItem hint="?" onAction={() => useShell.getState().setShortcutsOpen(true)}>
            {t('app.shortcuts')}
          </MenuItem>
          <LanguageSubmenu />
          <MenuSeparator />
          <MenuItem onAction={() => onFeedback('bug')}>{t('help.reportBug')}</MenuItem>
          <MenuItem onAction={() => onFeedback('feature')}>{t('help.requestFeature')}</MenuItem>
          <MenuItem onAction={() => openExternal(REPO_URL)}>{t('help.viewOnGitHub')}</MenuItem>
          <MenuSeparator />
          {/* Privacy preference: toggling does NOT close the menu. */}
          <MenuItem
            shouldCloseOnSelect={false}
            textValue={t('analytics.label')}
            hint={
              <span
                aria-hidden
                data-on={!analyticsOff || undefined}
                className="relative inline-block h-5 w-[34px] rounded-round bg-fill-track align-middle transition-colors duration-150 data-[on]:bg-ink"
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full transition-transform duration-150 motion-reduce:transition-none ${
                    analyticsOff ? 'translate-x-0 bg-ink' : 'translate-x-[14px] bg-on-ink'
                  }`}
                />
              </span>
            }
            onAction={toggleAnalytics}
          >
            {t('analytics.label')}
          </MenuItem>
        </Menu>
        {/* Caption + build id for bug reports: plain text, selectable so it can be copied. */}
        <div className="select-text border-t border-glass-edge px-4 py-2.5 text-caption text-ink-faint">
          <p>{t('analytics.caption')}</p>
          <p className="mt-0.5">{t('help.build', { commit: __APP_COMMIT__ })}</p>
        </div>
      </Popover>
    </MenuTrigger>
  )
}
