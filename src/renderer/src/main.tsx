import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/layout.css'
import './styles/chat.css'
import './styles/hub.css'
import './styles/pages.css'
import './styles/connect.css'
import { App } from './App'

async function start() {
  // Running in a plain browser (design work, screenshots): fall back to an in-memory demo backend.
  if (!window.cairn && import.meta.env.DEV) {
    const { installMock } = await import('./lib/mock')
    installMock()
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}
void start()
