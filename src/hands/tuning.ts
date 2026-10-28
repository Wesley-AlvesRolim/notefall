// Dev-only hand pipeline overrides (pure, no React / DOM). The dev panel (src/dev/handsPanel.ts) writes here; build.ts
// merges the current overrides over the defaults. Never persisted into settings / .nfz. With nothing set (always the
// case in production) `getTuning` returns undefined and the pipeline uses its defaults untouched.

export type TuningGroup = 'motion' | 'split' | 'reach' | 'fingering'
type Values = Record<string, number | boolean>

const overrides: Record<TuningGroup, Values> = { motion: {}, split: {}, reach: {}, fingering: {} }
const subs = new Set<() => void>()
let version = 0

const bump = () => {
  version++
  subs.forEach((f) => f())
}

/** Current overrides for a group, or undefined when it has none. The returned object is stable until the next change. */
export function getTuning<T extends Values>(group: TuningGroup): Partial<T> | undefined {
  const o = overrides[group]
  return Object.keys(o).length ? (o as Partial<T>) : undefined
}

export function setTuning(group: TuningGroup, key: string, value: number | boolean | undefined): void {
  const next = { ...overrides[group] }
  if (value === undefined) delete next[key]
  else next[key] = value
  overrides[group] = next
  bump()
}

export function resetTuning(group?: TuningGroup): void {
  for (const g of Object.keys(overrides) as TuningGroup[]) if (!group || g === group) overrides[g] = {}
  bump()
}

export function getAllTuning(): Record<TuningGroup, Values> {
  return overrides
}

/** Bumps on every change; use as a React dependency (via useSyncExternalStore) to rebuild the motion. */
export function tuningVersion(): number {
  return version
}

export function subscribeTuning(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}
