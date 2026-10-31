/** Modifier key label for tooltips and hints: "⌘" on Apple platforms, "Ctrl+" elsewhere. */
const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
export const MOD = isApple ? '⌘' : 'Ctrl+'
