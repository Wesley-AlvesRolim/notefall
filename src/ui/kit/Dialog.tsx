import type { ReactNode } from 'react'
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import clsx from 'clsx'

/**
 * Centred modal over `scrim`. Controlled: pass `isOpen` + `onOpenChange`.
 * `dismissable` = Esc / outside click close it (off for progress and destructive confirms).
 */
export function Dialog({
  isOpen,
  onOpenChange,
  title,
  children,
  actions,
  dismissable = true,
  width = 520,
  className,
  role,
}: {
  isOpen: boolean
  onOpenChange?: (open: boolean) => void
  title?: ReactNode
  children?: ReactNode
  /** Right-aligned buttons; the primary goes last. */
  actions?: ReactNode
  dismissable?: boolean
  width?: number
  className?: string
  role?: 'dialog' | 'alertdialog'
}) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={dismissable}
      isKeyboardDismissDisabled={!dismissable}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-scrim p-4"
    >
      <Modal className="max-h-full w-full outline-none" style={{ maxWidth: width }}>
        <AriaDialog
          role={role}
          className={clsx(
            'nf-glass-strong box-border grid max-h-[calc(100vh-32px)] gap-4 overflow-auto rounded-panel px-6 py-[22px] text-body text-ink outline-none',
            className,
          )}
        >
          {title && (
            <Heading slot="title" className="m-0 text-display text-ink">
              {title}
            </Heading>
          )}
          {children}
          {actions && <div className="flex justify-end gap-2">{actions}</div>}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  )
}

/** Secondary text right under a dialog title. */
export function DialogText({ children }: { children: ReactNode }) {
  return <p className="-mt-2 mb-0 text-ink-muted">{children}</p>
}
