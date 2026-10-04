import { Check, Laptop, LogOut, Minus, Share, Smartphone, Wifi, WifiOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Segmented } from '@/components/ui'
import { cx } from '@/lib/format'
import { useApp } from '@/store/app'
import type { ThemeId } from '@shared/types'
import { Sheet } from '../components/Sheet'
import { useSession } from '../store/session'

const THEMES: { value: ThemeId; label: string }[] = [
  { value: 'system', label: 'Auto' },
  { value: 'alpenglow', label: 'Dusk' },
  { value: 'glacier', label: 'Light' },
  { value: 'granite', label: 'Stone' },
  { value: 'timberline', label: 'Forest' }
]

interface InstallPrompt extends Event {
  prompt(): Promise<void>
}

function Permission({ on, label, detail }: { on: boolean; label: string; detail: string }) {
  return (
    <div className={cx('perm', on && 'on')}>
      <span className="perm-icon">{on ? <Check size={15} /> : <Minus size={15} />}</span>
      <span className="perm-text">
        <span>{label}</span>
        <span className="faint xs">{detail}</span>
      </span>
    </div>
  )
}

/** Installing the page as an app: Safari and Chrome do it differently, so say which. */
function HomeScreenHint() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null)
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault()
      setPrompt(e as InstallPrompt)
    }
    window.addEventListener('beforeinstallprompt', on)
    return () => window.removeEventListener('beforeinstallprompt', on)
  }, [])
  if (standalone) return null
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  return (
    <section className="panel">
      <h2>
        <Smartphone size={16} /> Keep it on your home screen
      </h2>
      {prompt ? (
        <>
          <p className="dim small">Open Cairn like any other app, full screen.</p>
          <Button onClick={() => void prompt.prompt()}>Add to home screen</Button>
        </>
      ) : ios ? (
        <p className="dim small">
          Tap <Share size={13} className="inline-icon" /> <b>Share</b> in Safari, then <b>Add to Home Screen</b>. It opens full screen, like an app. You may need to enter the pairing code once more inside it.
        </p>
      ) : (
        <p className="dim small">
          Open your browser’s menu and choose <b>Install app</b> or <b>Add to Home screen</b>.
        </p>
      )}
    </section>
  )
}

export function YouScreen() {
  const session = useSession((s) => s.session)
  const live = useSession((s) => s.live)
  const unreachable = useSession((s) => s.unreachable)
  const retry = useSession((s) => s.retry)
  const signOut = useSession((s) => s.signOut)
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.update)
  const [confirm, setConfirm] = useState(false)
  if (!session || !settings) return null
  const { device, host } = session
  const connected = live && !unreachable

  return (
    <section className="you" aria-label="This phone">
      <header className="top">
        <h1>This phone</h1>
      </header>
      <div className="scroll pad">
        <section className="panel">
          <h2>
            <Laptop size={16} /> Your computer
          </h2>
          <div className="kv">
            <span className="faint">Name</span>
            <span>{host.name}</span>
          </div>
          <div className="kv">
            <span className="faint">Connection</span>
            <span className={cx('conn', connected ? 'ok' : 'bad')}>
              {connected ? <Wifi size={14} /> : <WifiOff size={14} />} {connected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          {host.version && (
            <div className="kv">
              <span className="faint">Cairn version</span>
              <span className="mono small">{host.version}</span>
            </div>
          )}
          {!connected && (
            <Button size="sm" onClick={retry}>
              Try again
            </Button>
          )}
        </section>

        <section className="panel">
          <h2>
            <Smartphone size={16} /> {device.name}
          </h2>
          <Permission on label="Chat" detail="Talk to the models on your computer" />
          <Permission on={device.scopes.images} label="Pictures" detail={device.scopes.images ? 'See and make pictures' : 'Off for this phone'} />
          <Permission on={device.scopes.tools} label="Tools" detail={device.scopes.tools ? 'The assistant may work with files and commands on your computer, after asking you' : 'The assistant only chats; it cannot touch files'} />
          <p className="faint xs">Change these in Cairn on your computer: Connect your phone, then Devices.</p>
        </section>

        <section className="panel">
          <h2>Look and feel</h2>
          <div className="fld-label">Colours</div>
          <Segmented size="sm" fill value={settings.appearance.theme} onChange={(theme) => update({ appearance: { ...settings.appearance, theme } })} options={THEMES} />
          <div className="fld-label" style={{ marginTop: 14 }}>
            Text size
          </div>
          <input type="range" min={0.9} max={1.3} step={0.05} value={settings.appearance.fontScale} onChange={(e) => update({ appearance: { ...settings.appearance, fontScale: Number(e.target.value) } })} aria-label="Text size" />
          <p className="faint xs">These are kept on this phone only.</p>
        </section>

        <HomeScreenHint />

        <Button variant="danger" icon={<LogOut size={16} />} onClick={() => setConfirm(true)} className="signout">
          Disconnect this phone
        </Button>
      </div>
      <Sheet open={confirm} onClose={() => setConfirm(false)} title="Disconnect this phone?">
        <div className="sheet-form">
          <p className="dim" style={{ margin: 0 }}>
            Your chats and pictures stay on your computer. To use them from this phone again, scan a new code.
          </p>
          <div className="row">
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void signOut()}>
              Disconnect
            </Button>
          </div>
        </div>
      </Sheet>
    </section>
  )
}
