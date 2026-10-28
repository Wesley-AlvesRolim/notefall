import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import { App } from './App'

// Dev tools (Ctrl+Alt+D / ?dev=1): DEV-guarded dynamic import, so production bundles never contain src/dev/boot.
if (import.meta.env.DEV) void import('./dev/boot').then((m) => m.bootDev())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
