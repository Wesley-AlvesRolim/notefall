import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, DialogText } from './kit'
import {
  dismissPending,
  getPending,
  resolveAlert,
  resolveConfirm,
  subscribePending,
} from './confirm'

/**
 * Single mounted instance (in `Layout.tsx`) that listens for pending
 * `showConfirm` / `showAlert` calls and renders them in the kit Dialog.
 *
 * Two layouts on the same chrome:
 *   - **confirm**: quiet cancel + primary confirm. Cancel is `autoFocus`
 *     so pressing Enter on a destructive prompt preserves work. The
 *     primary stays the confirm even when `destructive` (the label names
 *     the consequence).
 *   - **alert**: a single primary button. `tone: 'error'` gets no special
 *     chrome: a clear title and message are enough.
 *
 * a11y: the kit Dialog (react-aria Modal) handles focus trap, Escape, and
 * backdrop-click dismiss. `role="alertdialog"` tells screen readers this
 * requires a response.
 */
export function ConfirmModal() {
  const { t } = useTranslation('dialogs')
  const pending = useSyncExternalStore(subscribePending, getPending, getPending)

  return (
    <Dialog
      isOpen={pending !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) dismissPending()
      }}
      role="alertdialog"
      width={420}
      title={pending?.options.title}
      actions={
        pending?.kind === 'confirm' ? (
          <>
            <Button autoFocus onPress={() => resolveConfirm(false)}>
              {pending.options.cancelLabel ?? t('confirm.defaultCancel')}
            </Button>
            <Button variant="primary" onPress={() => resolveConfirm(true)}>
              {pending.options.confirmLabel ?? t('confirm.defaultConfirm')}
            </Button>
          </>
        ) : pending?.kind === 'alert' ? (
          <Button autoFocus variant="primary" onPress={() => resolveAlert()}>
            {pending.options.okLabel ?? t('alert.acknowledge')}
          </Button>
        ) : undefined
      }
    >
      {pending && (
        <div className="whitespace-pre-line">
          <DialogText>{pending.options.message}</DialogText>
        </div>
      )}
    </Dialog>
  )
}
