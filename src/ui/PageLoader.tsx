/**
 * Full-screen splash shown over the app while the Layout settles. Without
 * this, absolutely-positioned overlays flash briefly in the wrong spot before
 * the Viewport's ResizeObserver fires and the 16:9 letterbox is computed.
 *
 * The Layout mounts underneath at the same time, so the ResizeObserver and
 * the Three.js Canvas warm up while the splash is still visible. When the
 * splash fades out, everything is in its final position.
 *
 * Indeterminate animation only: there's no quantifiable signal to show real
 * progress against (the heavy sampler load is deferred to first interaction
 * and has its own progress island).
 */
import { useTranslation } from 'react-i18next'
import { LogoMark } from './kit'

export function PageLoader({ visible }: { visible: boolean }) {
  const { t } = useTranslation('common')
  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-canvas transition-opacity duration-500 ${
        visible ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
      aria-hidden={!visible}
    >
      <div className="flex flex-col items-center gap-5">
        <LogoMark className="h-14 w-14" />
        <span className="text-body text-ink-muted">{t('pageLoader.loading')}</span>
        {/* A short bar slides across the track; the eased curve pauses at the edges. */}
        <div className="relative h-1 w-36 overflow-hidden rounded-[2px] bg-fill-track">
          <div className="page-loader-bar absolute inset-y-0 w-1/3 rounded-[2px] bg-ink" />
        </div>
      </div>
      <style>{`
        @keyframes page-loader-slide {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(330%); }
        }
        .page-loader-bar {
          animation: page-loader-slide 1.3s cubic-bezier(0.65, 0.05, 0.36, 1) infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .page-loader-bar { animation: none; width: 100%; opacity: 0.4; }
        }
      `}</style>
    </div>
  )
}
