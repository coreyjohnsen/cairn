import { useEffect } from 'react'
import { Logo } from '@/components/Logo'
import { Toasts } from '@/components/ui'
import { useApp } from '@/store/app'
import { useVisibleHeight } from './lib/hooks'
import { listenForBack } from './store/nav'
import { useSession } from './store/session'
import { PairScreen } from './views/PairScreen'
import { Shell } from './views/Shell'

function applyAppearance(): void {
  const s = useApp.getState().settings
  const root = document.documentElement
  let theme = s?.appearance.theme ?? 'system'
  if (theme === 'system') theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'glacier' : 'alpenglow'
  root.dataset.theme = theme
  root.dataset.motion = s?.appearance.reduceMotion ? 'reduce' : 'full'
  root.style.setProperty('--fs', String(s?.appearance.fontScale ?? 1))
  // Colours the phone's own status bar and browser chrome to match.
  const color = getComputedStyle(root).getPropertyValue('--bg-1').trim()
  if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
}

function Splash() {
  return (
    <div className="splash">
      <Logo size={48} />
    </div>
  )
}

export function App() {
  const phase = useSession((s) => s.phase)
  const settings = useApp((s) => s.settings)
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  useVisibleHeight()

  useEffect(() => listenForBack(), [])

  // Coming back to the page after the phone was locked or the app was in the background: reconnect right away.
  useEffect(() => {
    const onShow = () => document.visibilityState === 'visible' && useSession.getState().retry()
    document.addEventListener('visibilitychange', onShow)
    window.addEventListener('online', onShow)
    return () => {
      document.removeEventListener('visibilitychange', onShow)
      window.removeEventListener('online', onShow)
    }
  }, [])

  const theme = settings?.appearance
  useEffect(() => {
    applyAppearance()
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const on = () => theme?.theme === 'system' && applyAppearance()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [theme?.theme, theme?.fontScale, theme?.reduceMotion])

  return (
    <>
      {phase === 'loading' && <Splash />}
      {phase === 'unpaired' && <PairScreen />}
      {phase === 'ready' && <Shell />}
      <Toasts items={toasts} dismiss={dismiss} />
    </>
  )
}
