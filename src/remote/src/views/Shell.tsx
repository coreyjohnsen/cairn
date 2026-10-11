import { MessagesSquare, MountainSnow, RefreshCw, UserRound, WifiOff } from 'lucide-react'
import { Logo } from '@/components/Logo'
import { cx } from '@/lib/format'
import { useChat } from '@/store/chat'
import { useImages } from '@/store/images'
import { useWide } from '../lib/hooks'
import { type Tab, useNav } from '../store/nav'
import { useSession } from '../store/session'
import { ChatScreen } from './ChatScreen'
import { ChatsList } from './ChatsList'
import { CreateSheet } from './CreateSheet'
import { ModelSheet } from './ModelSheet'
import { PicturesScreen } from './PicturesScreen'
import { Viewer } from './Viewer'
import { YouScreen } from './YouScreen'

function useTabs(): { id: Tab; label: string; icon: typeof UserRound; busy: boolean }[] {
  const images = useSession((s) => s.session?.device.scopes.images)
  const chatBusy = useChat((s) => Object.values(s.running).some(Boolean))
  const picBusy = useImages((s) => Object.values(s.jobs).some((j) => j.status === 'running' || j.status === 'queued'))
  return [
    { id: 'chats', label: 'Chats', icon: MessagesSquare, busy: chatBusy },
    ...(images ? [{ id: 'pictures' as const, label: 'Pictures', icon: MountainSnow, busy: picBusy }] : []),
    { id: 'you', label: 'This phone', icon: UserRound, busy: false }
  ]
}

function Connection() {
  const live = useSession((s) => s.live)
  const unreachable = useSession((s) => s.unreachable)
  const retry = useSession((s) => s.retry)
  if (live && !unreachable) return null
  return (
    <div className="offline" role="status">
      <WifiOff size={15} />
      <span>{unreachable ? 'Can’t reach your computer.' : 'Reconnecting to your computer…'}</span>
      <button type="button" onClick={retry}>
        <RefreshCw size={13} /> Retry
      </button>
    </div>
  )
}

export function Shell() {
  const wide = useWide()
  const tab = useNav((s) => s.tab)
  const go = useNav((s) => s.go)
  const layers = useNav((s) => s.layers)
  const tabs = useTabs()
  const current = tabs.some((t) => t.id === tab) ? tab : 'chats'

  return (
    <div className={cx('shell', wide && 'wide')}>
      {wide && (
        <nav className="rail" aria-label="Main">
          <div className="rail-logo">
            <Logo size={30} />
          </div>
          {tabs.map((t) => (
            <button key={t.id} type="button" className={cx('rail-tab', current === t.id && 'on')} aria-current={current === t.id} aria-label={t.label} onClick={() => go(t.id)}>
              <t.icon size={22} strokeWidth={1.7} />
              <span>{t.label}</span>
              {t.busy && <span className="tab-pulse" />}
            </button>
          ))}
        </nav>
      )}
      <main className="shell-main">
        <Connection />
        {current === 'chats' &&
          (wide ? (
            <div className="split">
              <ChatsList wide />
              <ChatScreen wide />
            </div>
          ) : (
            <ChatsList />
          ))}
        {current === 'pictures' && <PicturesScreen />}
        {current === 'you' && <YouScreen />}
      </main>
      {!wide && (
        <nav className="tabbar" aria-label="Main">
          {tabs.map((t) => (
            <button key={t.id} type="button" className={cx('tab', current === t.id && 'on')} aria-current={current === t.id} onClick={() => go(t.id)}>
              <span className="tab-icon">
                <t.icon size={22} strokeWidth={1.8} />
                {t.busy && <span className="tab-pulse" />}
              </span>
              <span className="tab-label">{t.label}</span>
            </button>
          ))}
        </nav>
      )}
      {!wide && layers.includes('chat') && <ChatScreen />}
      <Viewer />
      <CreateSheet />
      <ModelSheet />
    </div>
  )
}
