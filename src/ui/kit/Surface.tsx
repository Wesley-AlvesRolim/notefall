import { forwardRef, type HTMLAttributes } from 'react'
import clsx from 'clsx'

/**
 * Screen geometry shared by every floating surface (px). Islands sit `EDGE` from the
 * screen edges; the pill sits `PILL_BOTTOM` from the bottom.
 */
export const GEOMETRY = {
  EDGE: 16,
  BAR: 52,
  PILL: 68,
  PILL_BOTTOM: 20,
  PANEL: 344,
  /** Gap between stacked surfaces (island → panel, panel → pill). */
  GAP: 12,
} as const

type DivProps = HTMLAttributes<HTMLDivElement> & { strong?: boolean }

/** Bar island (top-left / top-right): 52px tall, fully round. */
export const Island = forwardRef<HTMLDivElement, DivProps>(function Island({ className, strong, ...rest }, ref) {
  return (
    <div
      ref={ref}
      {...rest}
      className={clsx(
        strong ? 'nf-glass-strong' : 'nf-glass',
        'box-border inline-flex h-bar items-center gap-1 rounded-round p-1.5 text-body text-ink',
        className,
      )}
    />
  )
})

/** Panel (Look, Timeline, selection card): `radius-panel`, content clipped. */
export const Panel = forwardRef<HTMLDivElement, DivProps>(function Panel({ className, strong, ...rest }, ref) {
  return (
    <div
      ref={ref}
      {...rest}
      className={clsx(
        strong ? 'nf-glass-strong' : 'nf-glass',
        'box-border flex flex-col overflow-hidden rounded-panel text-body text-ink',
        className,
      )}
    />
  )
})
