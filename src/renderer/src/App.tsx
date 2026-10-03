import { Layers, MessagesSquare, MountainSnow, SlidersHorizontal, Wrench } from 'lucide-react'
import { useEffect } from 'react'
import { Logo } from '@/components/Logo'
import { Toasts } from '@/components/ui'
import { Lightbox } from '@/components/Lightbox'
import { Onboarding } from '@/components/Onboarding'
import { ChatView } from '@/views/ChatView'
import { ImagesView } from '@/views/ImagesView'
import { ModelsView } from '@/views/ModelsView'
import { SettingsView } from '@/views/SettingsView'
import { ToolsView } from '@/views/ToolsView'
import { invoke, platform } from '@/lib/api'
import { cx } from '@/lib/format'
import { type ViewId, useApp } from '@/store/app'
import { useChat } from '@/store/chat'
import { useImages } from '@/store/images'
import { useLibrary } from '@/store/library'

const NAV: { id: ViewId; label: string; icon: typeof Layers }[] = [
  { id: 'chat', label: 'Chat', icon: MessagesSquare },
  { id: 'images', label: 'Images', icon: MountainSnow },
  { id: 'models', label: 'Models', icon: Layers },
  { id: 'tools', label: 'Tools', icon: Wrench }
]

function applyAppearance(): void {
  const s = useApp.getState().settings
  if (!s) return
  const root = document.documentElement
  let theme = s.appearance.theme
  if (theme === 'system') theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'glacier' : 'alpenglow'
  root.dataset.theme = theme
  root.dataset.motion = s.appearance.reduceMotion ? 'reduce' : 'full'
  root.dataset.platform = platform()
  root.style.setProperty('--fs', String(s.appearance.fontScale))
  const css = getComputedStyle(root)
  void invoke('system:setTitleBar', { color: css.getPropertyValue('--bg-1').trim() || '#12171c', symbolColor: css.getPropertyValue('--fg-dim').trim() || '#a1afb8' }).catch(() => {})
}

export function App() {
  const ready = useApp((s) => s.ready)
  const view = useApp((s) => s.view)
  const setView = useApp((s) => s.setView)
  const settings = useApp((s) => s.settings)
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  const llama = useLibrary((s) => s.llama)
  const running = useChat((s) => Object.values(s.running).some(Boolean))
  const jobs = useImages((s) => Object.values(s.jobs).filter((j) => j.status === 'running' || j.status === 'queued').length)

  useEffect(() => {
    document.documentElement.dataset.platform = platform()
    void useApp
      .getState()
      .init()
      .then(() => Promise.all([useChat.getState().init(), useImages.getState().init(), useLibrary.getState().init()]))
      .catch((e) => console.error('Startup failed', e))
  }, [])

  const theme = settings?.appearance
  useEffect(() => {
    if (ready) applyAppearance()
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const on = () => theme?.theme === 'system' && applyAppearance()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [ready, theme?.theme, theme?.fontScale, theme?.reduceMotion])

  if (!ready || !settings) {
    return (
      <div className="splash">
        <Logo size={44} />
      </div>
    )
  }

  const llamaTip = llama.state === 'running' ? 'Local model running' : llama.state === 'starting' ? 'Loading local model…' : llama.state === 'error' ? 'Local model error' : ''

  return (
    <div className="app">
      <nav className="rail" aria-label="Main">
        <div className="rail-drag drag" />
        <div className="rail-logo" title="Cairn">
          <Logo size={30} />
        </div>
        <div className="rail-items">
          {NAV.map((n) => (
            <button key={n.id} className={cx('rail-btn', 'tip-right', view === n.id && 'on')} data-tip={n.label} aria-label={n.label} aria-current={view === n.id} onClick={() => setView(n.id)}>
              <n.icon size={21} strokeWidth={1.7} />
              {n.id === 'chat' && running && <span className="rail-pulse" />}
              {n.id === 'images' && jobs > 0 && <span className="rail-pulse" />}
            </button>
          ))}
        </div>
        <div className="rail-foot">
          {llamaTip && <span className={cx('rail-dot', `st-${llama.state}`)} title={llamaTip} />}
          <button className={cx('rail-btn', 'tip-right', view === 'settings' && 'on')} data-tip="Settings" aria-label="Settings" onClick={() => setView('settings')}>
            <SlidersHorizontal size={20} strokeWidth={1.7} />
          </button>
        </div>
      </nav>
      <main className="main">
        <div className="topbar drag" />
        <div className="view">
          {view === 'chat' && <ChatView />}
          {view === 'images' && <ImagesView />}
          {view === 'models' && <ModelsView />}
          {view === 'tools' && <ToolsView />}
          {view === 'settings' && <SettingsView />}
        </div>
      </main>
      <Lightbox />
      <Onboarding />
      <Toasts items={toasts} dismiss={dismiss} />
    </div>
  )
}
