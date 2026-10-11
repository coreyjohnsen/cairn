import { AlertCircle, Camera, Check, Laptop, Loader2, Pencil, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Logo } from '@/components/Logo'
import { Ridgeline } from '@/components/Ridgeline'
import { cx } from '@/lib/format'
import { PAIR_CODE_LENGTH, normalizePairCode, pairCodeFromText } from '@shared/remotePrefs'
import { useSession } from '../store/session'

/** What the person has typed so far, tidied: capitals only, no stray characters, a dash in the middle. */
function tidy(input: string): string {
  const fromLink = /[#?&]pair=/.test(input) ? pairCodeFromText(input) : null
  const raw = (fromLink ?? input).toUpperCase().replace(/[^A-Z0-9]/g, '')
  const s = raw.slice(0, PAIR_CODE_LENGTH)
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s
}

export function PairScreen() {
  const pair = useSession((s) => s.pair)
  const pairing = useSession((s) => s.pairing)
  const error = useSession((s) => s.pairError)
  const unreachable = useSession((s) => s.unreachable)
  const retry = useSession((s) => s.retry)
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [naming, setNaming] = useState(false)
  const [shake, setShake] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const code = normalizePairCode(text)
  const complete = text.replace('-', '').length === PAIR_CODE_LENGTH

  // A full code is sent as soon as it is typed: there is no button to find.
  useEffect(() => {
    if (code && !pairing) {
      void pair(code, name.trim() || undefined).then((ok) => {
        if (!ok) setShake((n) => n + 1)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  const badCode = complete && !code
  const message = badCode ? 'Codes never contain 0, 1, I, L or O. Check the letters on your computer.' : error

  return (
    <div className="pair">
      <div className="pair-hero" aria-hidden>
        <Ridgeline seed={21} layers={4} animate />
      </div>
      <div className="pair-card">
        <div className="pair-brand">
          <Logo size={40} />
          <span>Cairn</span>
        </div>
        <h1>Connect to your computer</h1>
        <p className="dim pair-lead">Chat and make pictures with the models on your computer, from anywhere.</p>

        {unreachable && (
          <div className="pair-note warn" role="alert">
            <AlertCircle size={16} />
            <div>
              <div>{unreachable}</div>
              <button type="button" className="link-btn" onClick={retry}>
                <RefreshCw size={13} /> Try again
              </button>
            </div>
          </div>
        )}

        <ol className="pair-steps">
          <li>
            <span className="pair-n">1</span>
            <span>
              On your computer, open Cairn and press <b>Connect your phone</b>.
            </span>
          </li>
          <li>
            <span className="pair-n">2</span>
            <span>
              <Camera size={14} className="inline-icon" /> Point this phone’s camera at the square code. It opens this page and connects by itself.
            </span>
          </li>
        </ol>

        <div className="pair-or">
          <span>or type the code</span>
        </div>

        <label className={cx('pair-code', (message || badCode) && 'bad', pairing && 'busy')} key={shake}>
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(tidy(e.target.value))}
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="XXXX-XXXX"
            aria-label="Pairing code"
            disabled={pairing}
            maxLength={40}
          />
          {pairing && <Loader2 size={20} className="spin pair-spin" />}
          {!pairing && code && <Check size={20} className="pair-ok" />}
        </label>
        <div className="pair-msg" aria-live="polite">
          {pairing ? <span className="dim">Connecting…</span> : message ? <span className="pair-err">{message}</span> : <span className="faint">The code is on your computer’s screen and works for 5 minutes.</span>}
        </div>

        <div className="pair-device">
          {naming ? (
            <input className="pair-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this phone, e.g. Corey’s phone" maxLength={40} onBlur={() => setNaming(false)} />
          ) : (
            <button type="button" className="link-btn" onClick={() => setNaming(true)}>
              <Pencil size={13} /> {name.trim() ? `Shown as “${name.trim()}”` : 'Name this phone'}
            </button>
          )}
        </div>
      </div>
      <p className="pair-foot faint">
        <Laptop size={13} /> Your chats and pictures stay on your computer. This phone only borrows them while you are connected.
      </p>
    </div>
  )
}

