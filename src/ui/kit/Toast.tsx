import { useEffect, useSyncExternalStore } from 'react'
import { Button as AriaButton } from 'react-aria-components'

/**
 * One toast at a time, centred just above the transport pill. A new toast replaces the
 * current one. Callable from non-React code (`showToast`).
 */
export type ToastSpec = {
  message: string
  /** e.g. Undo after a delete. */
  action?: { label: string; onAction: () => void }
  durationMs?: number
}

type Live = ToastSpec & { id: number }

let current: Live | null = null
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function showToast(spec: ToastSpec): void {
  current = { ...spec, id: nextId++ }
  emit()
}

export function dismissToast(): void {
  if (!current) return
  current = null
  emit()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Mount once in the shell. `bottom` = distance from the bottom edge in px. */
export function ToastHost({ bottom }: { bottom: number }) {
  const toast = useSyncExternalStore(subscribe, () => current)
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => {
      if (current?.id === toast.id) dismissToast()
    }, toast.durationMs ?? (toast.action ? 6000 : 3000))
    return () => clearTimeout(t)
  }, [toast])
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 z-[70] flex justify-center"
      style={{ bottom }}
    >
      {toast && (
        <div
          key={toast.id}
          className="nf-glass-strong pointer-events-auto inline-flex h-11 items-center gap-2.5 rounded-round pl-4 pr-1.5 text-body text-ink"
          style={!toast.action ? { paddingRight: 16 } : undefined}
        >
          <span>{toast.message}</span>
          {toast.action && (
            <AriaButton
              onPress={() => {
                toast.action!.onAction()
                dismissToast()
              }}
              className="nf-focus h-control-sm cursor-pointer rounded-round bg-fill-selected px-2.5 font-medium text-ink outline-none data-[hovered]:brightness-125"
            >
              {toast.action.label}
            </AriaButton>
          )}
        </div>
      )}
    </div>
  )
}
