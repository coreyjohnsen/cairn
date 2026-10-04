import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/tokens.css'
import '@/styles/base.css'
import '@/styles/components.css'
import '@/styles/chat.css'
import '@/styles/imgprog.css'
import './styles/remote.css'
import { App } from './App'
import { bridge, useSession } from './store/session'

async function start() {
  const demo = import.meta.env.DEV ? new URLSearchParams(location.search).get('demo') : null
  if (demo) {
    // Design work in a plain browser: no computer to talk to, so use the in-memory demo (never part of the real build).
    const { startDemo } = await import('./lib/demo')
    await startDemo(demo)
  } else {
    window.cairn = bridge.api
    // Pictures come from the computer through the signed-in connection.
    ;(window as unknown as { __cairnMedia: (kind: string, file: string) => string }).__cairnMedia = (kind, file) => `remote/media/${kind}/${encodeURIComponent(file)}`
    void useSession.getState().start()
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}
void start()
