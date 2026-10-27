import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Checkbox, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import {
  ISSUES_URL,
  REPORT_LIMITS,
  buildEnvironmentBlock,
  githubIssueUrl,
  submitReport,
  type ReportKind,
  type SubmitResult,
} from '../feedback/report'

// In-app bug report / feature request form (Help menu). Posts to
// /api/report, which files a public GitHub issue; on success it links
// to that issue so the sender can follow it. Where the endpoint isn't
// available (dev server, unconfigured deploy) it offers GitHub's own form.

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  reset: (id: string) => void
  remove: (id: string) => void
}
declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let turnstileScript: Promise<TurnstileApi> | null = null
function loadTurnstile(): Promise<TurnstileApi> {
  turnstileScript ??= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    s.async = true
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile')))
    s.onerror = () => {
      turnstileScript = null
      reject(new Error('turnstile'))
    }
    document.head.appendChild(s)
  })
  return turnstileScript
}

/** The Turnstile widget; reports its token (null when expired / failed). */
function Turnstile({ onToken, resetKey }: { onToken: (t: string | null) => void; resetKey: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const idRef = useRef<string | null>(null)
  const apiRef = useRef<TurnstileApi | null>(null)
  useEffect(() => {
    let cancelled = false
    void loadTurnstile()
      .then((api) => {
        if (cancelled || !ref.current) return
        apiRef.current = api
        idRef.current = api.render(ref.current, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: 'dark',
          size: 'flexible',
          callback: (token: string) => onToken(token),
          'expired-callback': () => onToken(null),
          'error-callback': () => onToken(null),
        })
      })
      .catch(() => onToken(null))
    return () => {
      cancelled = true
      if (idRef.current && apiRef.current) apiRef.current.remove(idRef.current)
      idRef.current = null
    }
    // onToken is a state setter wrapper, stable enough for one widget
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (resetKey > 0 && idRef.current && apiRef.current) {
      onToken(null)
      apiRef.current.reset(idRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])
  return <div ref={ref} className="min-h-[65px]" />
}

const fieldClass =
  'w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-sky-500'

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-neutral-400">
        {label}
        {hint && <span className="ml-1 text-neutral-600">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

const buttonClass =
  'rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 outline-none hover:border-neutral-600 focus-visible:border-sky-500'
const primaryClass =
  'rounded border border-sky-500/60 bg-sky-500/15 px-3 py-1.5 text-xs text-sky-200 outline-none hover:bg-sky-500/25 focus-visible:border-sky-300 disabled:cursor-default disabled:opacity-40'
const linkClass = 'text-sky-300 underline-offset-2 hover:underline'

export function FeedbackDialog({
  kind: initialKind,
  isOpen,
  onClose,
}: {
  kind: ReportKind
  isOpen: boolean
  onClose: () => void
}) {
  const { t } = useTranslation('dialogs')
  const [kind, setKind] = useState<ReportKind>(initialKind)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [details, setDetails] = useState('')
  const [expected, setExpected] = useState('')
  const [website, setWebsite] = useState('') // honeypot
  const [includeEnv, setIncludeEnv] = useState(true)
  const [environment, setEnvironment] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [resetKey, setResetKey] = useState(0)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<SubmitResult | null>(null)

  // A fresh form each time the dialog opens (the kind follows the menu item).
  useEffect(() => {
    if (!isOpen) return
    setKind(initialKind)
    setTitle('')
    setDescription('')
    setDetails('')
    setExpected('')
    setWebsite('')
    setIncludeEnv(true)
    setEnvironment(buildEnvironmentBlock())
    setToken(null)
    setSending(false)
    setResult(null)
  }, [isOpen, initialKind])

  const needsToken = !!TURNSTILE_SITE_KEY
  const canSend = !sending && title.trim() !== '' && description.trim() !== '' && (!needsToken || token !== null)

  const send = async () => {
    setSending(true)
    const r = await submitReport(
      {
        kind,
        title,
        description,
        details,
        expected: kind === 'bug' ? expected : '',
        environment: includeEnv ? environment : '',
        website,
      },
      token,
    )
    setSending(false)
    setResult(r)
    // a Turnstile token is single-use: get a new one for a retry
    if (r.kind !== 'ok' && needsToken) setResetKey((k) => k + 1)
  }

  const fallbackUrl = githubIssueUrl(kind, includeEnv ? environment : '')

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && !sending) onClose()
      }}
      isDismissable={!sending}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm data-[entering]:animate-in data-[entering]:fade-in data-[entering]:duration-150 data-[exiting]:animate-out data-[exiting]:fade-out data-[exiting]:duration-100"
    >
      <Modal className="outline-none data-[entering]:animate-in data-[entering]:zoom-in-95 data-[entering]:duration-150">
        <Dialog
          aria-label={t('feedback.ariaLabel')}
          className="flex max-h-[90vh] w-[28rem] flex-col gap-4 overflow-y-auto rounded-md bg-black/70 p-5 shadow-lg ring-1 ring-white/10 backdrop-blur-md outline-none"
        >
          {result?.kind === 'ok' ? (
            <>
              <Heading slot="title" className="text-sm font-medium text-neutral-100">
                {t('feedback.sentTitle')}
              </Heading>
              <p className="text-[11px] leading-relaxed text-neutral-300">
                {t('feedback.sentBody', { number: result.number })}{' '}
                <a href={result.url} target="_blank" rel="noopener noreferrer" className={linkClass}>
                  {t('feedback.sentLink', { number: result.number })}
                </a>
              </p>
              <div className="flex justify-end">
                <Button autoFocus onPress={onClose} className={primaryClass}>
                  {t('feedback.close')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Heading slot="title" className="text-sm font-medium text-neutral-100">
                  {t('feedback.title')}
                </Heading>
                <p className="text-[11px] leading-relaxed text-neutral-400">
                  {t('feedback.publicNotice')}{' '}
                  <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
                    {t('feedback.statusLink')}
                  </a>
                </p>
              </div>

              <div className="flex gap-1 rounded border border-neutral-800 p-0.5" role="radiogroup" aria-label={t('feedback.kind')}>
                {(['bug', 'feature'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={kind === k}
                    onClick={() => setKind(k)}
                    className={`flex-1 rounded px-2 py-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-sky-500 ${
                      kind === k ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    {t(`feedback.kinds.${k}`)}
                  </button>
                ))}
              </div>

              <Field label={t('feedback.summary')}>
                <input
                  className={fieldClass}
                  value={title}
                  maxLength={REPORT_LIMITS.title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t(`feedback.placeholders.${kind}.summary`)}
                />
              </Field>
              <Field label={t(`feedback.fields.${kind}.description`)}>
                <textarea
                  className={`${fieldClass} min-h-20 resize-y`}
                  value={description}
                  maxLength={REPORT_LIMITS.text}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t(`feedback.placeholders.${kind}.description`)}
                />
              </Field>
              <Field label={t(`feedback.fields.${kind}.details`)} hint={t('feedback.optional')}>
                <textarea
                  className={`${fieldClass} min-h-16 resize-y`}
                  value={details}
                  maxLength={REPORT_LIMITS.text}
                  onChange={(e) => setDetails(e.target.value)}
                  placeholder={t(`feedback.placeholders.${kind}.details`)}
                />
              </Field>
              {kind === 'bug' && (
                <Field label={t('feedback.fields.bug.expected')} hint={t('feedback.optional')}>
                  <textarea
                    className={`${fieldClass} min-h-12 resize-y`}
                    value={expected}
                    maxLength={REPORT_LIMITS.text}
                    onChange={(e) => setExpected(e.target.value)}
                  />
                </Field>
              )}
              {/* honeypot: hidden from people, tempting to form-filling bots */}
              <input
                tabIndex={-1}
                aria-hidden
                autoComplete="off"
                className="hidden"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                name="website"
              />

              <div className="flex flex-col gap-1.5">
                <Checkbox
                  isSelected={includeEnv}
                  onChange={setIncludeEnv}
                  className="group flex cursor-pointer items-center gap-2 text-[11px] text-neutral-300 outline-none"
                >
                  {({ isSelected }) => (
                    <>
                      <span
                        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                          isSelected ? 'border-sky-400 bg-sky-500/20' : 'border-neutral-600 bg-neutral-900'
                        } group-data-[focus-visible]:ring-1 group-data-[focus-visible]:ring-sky-500/40`}
                      >
                        {isSelected && (
                          <svg viewBox="0 0 14 14" className="h-2.5 w-2.5 stroke-sky-300" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2.5 7.5 L6 11 L11.5 3.5" />
                          </svg>
                        )}
                      </span>
                      <span>{t('feedback.includeEnv')}</span>
                    </>
                  )}
                </Checkbox>
                {includeEnv && (
                  <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-[10px] leading-snug text-neutral-500">
                    {environment}
                  </pre>
                )}
              </div>

              {needsToken && <Turnstile onToken={setToken} resetKey={resetKey} />}

              {result?.kind === 'unavailable' && (
                <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-200">
                  {t('feedback.unavailable')}{' '}
                  <a href={fallbackUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
                    {t('feedback.openGitHub')}
                  </a>
                </p>
              )}
              {result?.kind === 'error' && (
                <p className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-rose-200">
                  {t(`feedback.errors.${result.reason}`)}{' '}
                  <a href={fallbackUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
                    {t('feedback.openGitHub')}
                  </a>
                </p>
              )}

              <div className="flex items-center justify-between gap-2">
                <a href={fallbackUrl} target="_blank" rel="noopener noreferrer" className={`text-[11px] ${linkClass}`}>
                  {t('feedback.useGitHub')}
                </a>
                <div className="flex gap-2">
                  <Button onPress={onClose} isDisabled={sending} className={buttonClass}>
                    {t('feedback.cancel')}
                  </Button>
                  <Button onPress={() => void send()} isDisabled={!canSend} className={primaryClass}>
                    {sending ? t('feedback.sending') : t('feedback.send')}
                  </Button>
                </div>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
