import { Check, Copy, Globe, Laptop, Loader2, MountainSnow, Pencil, Power, RefreshCw, ShieldCheck, Smartphone, Tablet, Trash2, Wifi, Wrench } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { RemoteAddress, RemoteDevice, RemotePairing, RemoteStatus } from '@shared/types'
import { publicUrlProblem } from '@shared/remotePrefs'
import { invoke } from '@/lib/api'
import { cx, timeAgo } from '@/lib/format'
import { useApp } from '@/store/app'
import { useRemote } from '@/store/remote'
import { QrCode } from './QrCode'
import { Button, IconButton, Modal, Switch } from './ui'

/** Seconds until `at`, counting down once a second. */
function useSecondsLeft(at: number | undefined): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!at) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [at])
  return at ? Math.max(0, Math.ceil((at - now) / 1000)) : 0
}

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
const bare = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/#pair=.*$/, '').replace(/\/$/, '')

function CopyChip({ text, label, children }: { text: string; label: string; children: React.ReactNode }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={cx('cp-copy', done && 'done')}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1400)
        })
      }}
    >
      {children}
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

function Intro({ onStart, busy }: { onStart: () => void; busy: boolean }) {
  return (
    <div className="cp-intro">
      <div className="cp-intro-art" aria-hidden>
        <Smartphone size={34} strokeWidth={1.5} />
        <span className="cp-intro-link" />
        <Laptop size={40} strokeWidth={1.5} />
      </div>
      <h4>Use Cairn from your phone or tablet</h4>
      <p className="dim">Chat with the models on this computer, and make and look at pictures, from the couch or from across town. Your chats and pictures stay here; the phone only borrows them.</p>
      <ul className="cp-points">
        <li>
          <ShieldCheck size={16} /> <span>Pair with a code on this screen. Only devices you pair can get in.</span>
        </li>
        <li>
          <MountainSnow size={16} /> <span>Chats and pictures are the same on both. Start on the computer, carry on from the phone.</span>
        </li>
        <li>
          <Wrench size={16} /> <span>You decide what each phone may do. Tools that touch your files stay off unless you turn them on.</span>
        </li>
      </ul>
      <Button variant="primary" size="lg" busy={busy} onClick={onStart}>
        Turn on and connect a phone
      </Button>
      <p className="faint xs">
        Works on your home Wi-Fi. For use anywhere, add Tailscale (free) later. If Windows asks whether Cairn may use the network, allow it on <b>private networks</b>.
      </p>
    </div>
  )
}

function PairPanel({ status, offer, onNew, busy }: { status: RemoteStatus; offer: RemotePairing; onNew: () => void; busy: boolean }) {
  const [pick, setPick] = useState(0)
  const left = useSecondsLeft(offer.expiresAt)
  const link = offer.links[Math.min(pick, offer.links.length - 1)]
  const page = bare(link.url)
  const awake = useApp((s) => s.settings?.remote.keepAwake)
  const update = useApp((s) => s.update)
  const settings = useApp((s) => s.settings)
  const hasTailscale = status.addresses.some((a) => a.kind === 'tailscale')

  // A code that has run out is replaced by a new one, so the picture on screen always works.
  useEffect(() => {
    if (left === 0 && !busy) onNew()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left === 0])

  return (
    <div className="cp-pair">
      <div className="cp-qr-col">
        <div className="cp-qr">
          <QrCode text={link.url} size={236} label={`QR code that opens ${page} and connects this phone`} />
        </div>
        <div className="cp-timer">
          <span className={cx('cp-count', left < 30 && 'low')}>Works for {clock(left)}</span>
          <button type="button" className="link-btn" onClick={onNew} disabled={busy}>
            <RefreshCw size={12} className={cx(busy && 'spin')} /> New code
          </button>
        </div>
      </div>
      <div className="cp-steps-col">
        <ol className="cp-steps">
          <li>
            <span className="cp-n">1</span>
            <span>
              Open the <b>camera</b> on your phone or tablet and point it at the square.
            </span>
          </li>
          <li>
            <span className="cp-n">2</span>
            <span>
              Tap the link that pops up. Cairn opens and <b>connects by itself</b>.
            </span>
          </li>
        </ol>

        {offer.links.length > 1 && (
          <div className="cp-addrs" role="radiogroup" aria-label="Which address the code uses">
            {offer.links.map((l, i) => (
              <button key={l.url} type="button" role="radio" aria-checked={i === pick} className={cx('cp-addr', i === pick && 'on')} onClick={() => setPick(i)}>
                {l.kind === 'tailscale' ? <Globe size={14} /> : <Wifi size={14} />}
                <span>{l.label}</span>
                <span className="mono faint xs">{bare(l.url)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="cp-manual">
          <div className="cp-manual-title">Camera will not open the link?</div>
          <p className="small dim">
            In your phone’s browser go to <CopyChip text={page} label="Copy the address"><span className="mono">{page}</span></CopyChip> and type this code:
          </p>
          <CopyChip text={offer.code} label="Copy the code">
            <span className="cp-code">{offer.code}</span>
          </CopyChip>
        </div>

        <div className="cp-awake">
          <div className="grow">
            <div className="cp-awake-title">Keep this computer awake</div>
            <div className="faint xs">The phone can only reach Cairn while this computer is on. The screen can still turn off.</div>
          </div>
          <Switch checked={!!awake} label="Keep this computer awake" onChange={(v) => settings && update({ remote: { ...settings.remote, keepAwake: v } })} />
        </div>
        {!hasTailscale && (
          <p className="faint xs cp-away">
            Away from home? Install <button type="button" className="link-btn" onClick={() => void invoke('system:openExternal', 'https://tailscale.com/download')}>Tailscale</button> on this computer and your phone (both free), then open this window again. A second address appears here.
          </p>
        )}
      </div>
    </div>
  )
}

function Paired({ device, onMore, onDone }: { device: RemoteDevice; onMore: () => void; onDone: () => void }) {
  return (
    <div className="cp-paired" role="status">
      <span className="cp-paired-check">
        <Check size={30} strokeWidth={2.4} />
      </span>
      <h4>{device.name} is connected</h4>
      <p className="dim">It can chat with your models and use pictures. You can change what it may do below, or disconnect it at any time.</p>
      <div className="row" style={{ justifyContent: 'center' }}>
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
        <Button variant="ghost" onClick={onMore}>
          Connect another
        </Button>
      </div>
    </div>
  )
}

function DeviceRow({ d }: { d: RemoteDevice }) {
  const update = useRemote((s) => s.updateDevice)
  const remove = useRemote((s) => s.removeDevice)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(d.name)
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3500)
    return () => clearTimeout(t)
  }, [armed])
  const Icon = /ipad|tablet/i.test(d.name) ? Tablet : Smartphone
  const commit = () => {
    setRenaming(false)
    const t = name.trim()
    if (t && t !== d.name) void update(d.id, { name: t })
    else setName(d.name)
  }
  return (
    <li className="dev">
      <span className={cx('dev-icon', d.online && 'on')}>
        <Icon size={20} />
      </span>
      <div className="dev-main">
        <div className="dev-top">
          {renaming ? (
            <input className="dev-rename" autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => (e.key === 'Enter' ? commit() : e.key === 'Escape' && (setName(d.name), setRenaming(false)))} />
          ) : (
            <span className="dev-name ellipsis">{d.name}</span>
          )}
          {d.online ? <span className="dev-badge on">Online</span> : <span className="faint xs">Last seen {timeAgo(d.lastSeenAt)}</span>}
        </div>
        <div className="dev-scopes">
          <label className="dev-scope">
            <Switch checked={d.scopes.images} label={`Pictures on ${d.name}`} onChange={(v) => void update(d.id, { scopes: { images: v } })} />
            <span>Pictures</span>
          </label>
          <label className="dev-scope">
            <Switch checked={d.scopes.tools} label={`Tools on ${d.name}`} onChange={(v) => void update(d.id, { scopes: { tools: v } })} />
            <span>Tools</span>
          </label>
        </div>
        {d.scopes.tools && <div className="dev-warn xs">Chats started here can use your tools (files, commands), following your tool permissions.</div>}
      </div>
      <div className="dev-actions">
        <IconButton label="Rename" size="sm" onClick={() => setRenaming(true)}>
          <Pencil size={14} />
        </IconButton>
        <button type="button" className={cx('dev-remove', armed && 'armed')} aria-label={armed ? `Click again to disconnect ${d.name}` : `Disconnect ${d.name}`} onClick={() => (armed ? void remove(d.id) : setArmed(true))}>
          <Trash2 size={14} />
          {armed && <span>Disconnect?</span>}
        </button>
      </div>
    </li>
  )
}

function Advanced({ status }: { status: RemoteStatus }) {
  const settings = useApp((s) => s.settings)!
  const update = useApp((s) => s.update)
  const turnOff = useRemote((s) => s.turnOff)
  const [port, setPort] = useState(String(settings.remote.port))
  const [url, setUrl] = useState(settings.remote.publicUrl)
  const urlProblem = useMemo(() => publicUrlProblem(url), [url])
  const r = settings.remote
  return (
    <div className="cp-adv">
      <div className="cp-adv-grid">
        <label className="cp-field">
          <span>Port</span>
          <input
            className="field-input"
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            onBlur={() => {
              const n = Number(port)
              if (Number.isInteger(n) && n >= 1 && n <= 65535) {
                if (n !== r.port) update({ remote: { ...r, port: n } })
              } else setPort(String(r.port))
            }}
          />
          <span className="faint xs">Use another one if something else on this computer already uses {r.port}.</span>
        </label>
        <label className="cp-field">
          <span>Your own address (optional)</span>
          <input className="field-input" value={url} placeholder="https://cairn.example.com" onChange={(e) => setUrl(e.target.value)} onBlur={() => !urlProblem && url !== r.publicUrl && update({ remote: { ...r, publicUrl: url.trim() } })} spellCheck={false} />
          <span className={cx('xs', urlProblem ? 'cp-bad' : 'faint')}>{urlProblem ?? 'For a tunnel or domain you set up. The QR code then uses it first.'}</span>
        </label>
      </div>
      <div className="cp-adv-foot">
        <span className="faint xs">
          {status.state === 'running' && status.port ? `Serving on port ${status.port}.` : ''} Pairing uses plain web addresses on your network; use Tailscale or your own HTTPS address when you are away from home.
        </span>
        <Button variant="ghost" size="sm" icon={<Power size={14} />} onClick={turnOff}>
          Turn off
        </Button>
      </div>
    </div>
  )
}

export function ConnectPhone() {
  const open = useRemote((s) => s.open)
  const hide = useRemote((s) => s.hide)
  const status = useRemote((s) => s.status)
  const offer = useRemote((s) => s.offer)
  const paired = useRemote((s) => s.paired)
  const busy = useRemote((s) => s.busy)
  const newCode = useRemote((s) => s.newCode)
  const turnOn = useRemote((s) => s.turnOn)
  const dismiss = useRemote((s) => s.dismissPaired)
  const enabled = useApp((s) => s.settings?.remote.enabled)
  const [showAdv, setShowAdv] = useState(false)
  const state = status?.state ?? 'stopped'
  const running = state === 'running'

  // As soon as the computer is serving and nobody has been shown a code, show one.
  useEffect(() => {
    if (open && running && !offer && !paired && !busy) void newCode()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, running, !offer, !!paired])

  if (!open) return null
  const devices = status?.devices ?? []

  return (
    <Modal open onClose={hide} title="Connect your phone or tablet" width={820}>
      <div className="cp">
        {!enabled && !running && state !== 'error' && <Intro busy={false} onStart={turnOn} />}
        {enabled && (state === 'starting' || (state === 'stopped' && !status?.error)) && (
          <div className="cp-wait">
            <Loader2 size={22} className="spin" />
            <span className="dim">Starting…</span>
          </div>
        )}
        {state === 'error' && (
          <div className="cp-error" role="alert">
            <h4>Could not start</h4>
            <p>{status?.error}</p>
            <Button onClick={() => setShowAdv(true)}>Change the port</Button>
            {showAdv && status && <Advanced status={status} />}
          </div>
        )}
        {running && status && paired && <Paired device={paired} onMore={() => void newCode()} onDone={dismiss} />}
        {running && status && !paired && offer && <PairPanel status={status} offer={offer} busy={busy} onNew={() => void newCode()} />}
        {running && status && !paired && !offer && (
          <div className="cp-wait">
            <Loader2 size={22} className="spin" />
            <span className="dim">Making a code…</span>
          </div>
        )}
        {status?.missingClient && running && (
          <p className="cp-bad small">The phone app is not built in this copy of Cairn, so phones would see an empty page. Run “npm run build” and restart.</p>
        )}

        {(running || devices.length > 0) && (
          <section className="cp-devices">
            <h5>Connected devices</h5>
            {devices.length === 0 ? <p className="faint small">Nothing connected yet. Scan the code above with your phone.</p> : <ul>{devices.map((d) => <DeviceRow key={d.id} d={d} />)}</ul>}
          </section>
        )}

        {running && status && (
          <div className="cp-advtoggle">
            <button type="button" className="link-btn" onClick={() => setShowAdv((v) => !v)} aria-expanded={showAdv}>
              {showAdv ? 'Hide settings' : 'Settings'}
            </button>
            {showAdv && <Advanced status={status} />}
          </div>
        )}
      </div>
    </Modal>
  )
}
