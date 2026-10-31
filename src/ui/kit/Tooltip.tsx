import type { ReactElement, ReactNode } from 'react'
import { Tooltip as AriaTooltip, TooltipTrigger, type TooltipProps } from 'react-aria-components'
import clsx from 'clsx'

/** A keyboard key cap, e.g. <Kbd>Space</Kbd>. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={clsx(
        'inline-grid h-6 min-w-6 place-items-center rounded-[6px] bg-fill-field px-1.5 font-sans text-caption text-ink shadow-[inset_0_-1px_0_var(--glass-highlight)]',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

/** Hover / focus label for a control. Shows the shortcut as key caps when given. */
export function Tooltip({
  label,
  shortcut,
  placement = 'top',
  children,
}: {
  label: ReactNode
  shortcut?: string
  placement?: TooltipProps['placement']
  children: ReactElement
}) {
  return (
    <TooltipTrigger delay={500} closeDelay={0}>
      {children}
      <AriaTooltip
        offset={8}
        placement={placement}
        className="nf-glass-strong z-[100] inline-flex items-center gap-2 whitespace-nowrap rounded-field px-2.5 py-1.5 text-body text-ink outline-none"
      >
        {label}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </AriaTooltip>
    </TooltipTrigger>
  )
}
