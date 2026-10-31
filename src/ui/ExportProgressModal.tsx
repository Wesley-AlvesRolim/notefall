import { useTranslation } from 'react-i18next'
import { Button, Dialog, Progress } from './kit'
import type { TFunction } from 'i18next'

export type ExportProgressState = {
  /** Modal title — e.g. "Exporting audio", "Exporting video". */
  title: string
  /** Phase label shown above the progress bar — e.g. "Rendering audio". */
  phaseLabel: string
  /** 0..1, current progress within the active phase. */
  progress: number
  /**
   * Estimated remaining time in seconds. `null` until enough progress
   * has accumulated to compute a stable estimate (the very first
   * progress sample produces wildly noisy ETAs).
   */
  etaSeconds: number | null
} | null

/** Format an ETA in seconds as either `"12 sec"` or `"2 min 14 sec"`. */
function formatEta(seconds: number, t: TFunction<'dialogs'>): string {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return t('progress.etaSeconds', { count: total })
  const min = Math.floor(total / 60)
  const sec = total % 60
  return t('progress.etaMinutes', { min, sec })
}

/**
 * Shared progress modal used by every offline-export operation in the
 * app (audio WAV today, silent MP4 next, A/V MP4 once muxing lands).
 *
 * Non-dismissable — no Escape, no backdrop close. The user must press
 * Cancel. `onCancel` aborts the caller's `AbortController`; the
 * actual render usually can't be stopped mid-flight, but the
 * resulting Blob is discarded so nothing lands on disk.
 *
 * Built on the kit Dialog like every other dialog.
 */
export function ExportProgressModal({
  state,
  onCancel,
}: {
  state: ExportProgressState
  onCancel: () => void
}) {
  const { t } = useTranslation('dialogs')
  // Display percent floored, not rounded — a 99% display followed by
  // the modal vanishing reads better than "100% then disappear".
  const pct = state ? Math.max(0, Math.min(100, Math.floor(state.progress * 100))) : 0

  return (
    <Dialog
      isOpen={state !== null}
      dismissable={false}
      role="alertdialog"
      width={420}
      title={state?.title ?? ''}
      actions={
        <Button autoFocus onPress={onCancel}>
          {t('progress.cancel')}
        </Button>
      }
    >
      <div className="grid gap-2">
        <div className="flex items-baseline justify-between">
          <span>{state?.phaseLabel ?? ''}</span>
          <span className="tabular-nums text-ink-muted">{pct}%</span>
        </div>
        <Progress value={pct / 100} label={state?.phaseLabel ?? ''} />
        <div className="min-h-[18px] text-right tabular-nums text-ink-muted">
          {state?.etaSeconds != null && pct >= 5
            ? t('progress.eta', { eta: formatEta(state.etaSeconds, t) })
            : ' '}
        </div>
      </div>
      <p className="m-0 text-ink-muted">{t('progress.note')}</p>
    </Dialog>
  )
}
