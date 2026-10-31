import type { ReactNode } from 'react'
import { LogoMark } from '../kit'
import backdropUrl from '../assets/backdrop.jpg'

/**
 * Full-page screens shown instead of the app (unsupported device, no WebGL): a still of the
 * visualizer as the backdrop, the card on glass over it — the same picture-first look as the app,
 * without needing WebGL to draw it.
 */
export function ScreenFrame({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="relative h-full w-full overflow-auto bg-canvas text-ink">
      <img
        src={backdropUrl}
        alt=""
        aria-hidden
        className="pointer-events-none fixed inset-0 h-full w-full object-cover object-[56%_50%]"
      />
      {/* darken toward the card so text reads over bright notes */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{ background: 'linear-gradient(rgba(5,6,10,0.25), rgba(5,6,10,0.45) 55%, rgba(5,6,10,0.7))' }}
      />
      <div className="relative flex min-h-full items-center justify-center p-4">
        <section className="nf-glass nf-enter-fade box-border grid w-[520px] max-w-full gap-4 rounded-panel px-7 py-[26px] text-body">
          <span className="flex items-center gap-2 text-title">
            <LogoMark className="h-[22px] w-[22px]" />
            notefall
          </span>
          <h1 className="m-0 text-display">{title}</h1>
          {children}
        </section>
      </div>
    </div>
  )
}
