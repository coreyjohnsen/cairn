import { ArrowUp, Camera, FileText, Image as ImageIcon, MountainSnow, Paperclip, Square, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AttachmentInput } from '@shared/types'
import { Spinner } from '@/components/ui'
import { cx, formatBytes } from '@/lib/format'
import { readFiles } from '@/lib/files'
import { useApp } from '@/store/app'
import { useChat } from '@/store/chat'
import { useComposerBus } from '@/store/composer'
import { Sheet, SheetItem } from '../components/Sheet'
import { useTouch } from '../lib/hooks'
import { shrinkPhoto } from '../lib/photo'
import { useSession } from '../store/session'

const DRAFT = 'cairn-remote-draft:'

function loadDraft(key: string): string {
  try {
    return localStorage.getItem(DRAFT + key) ?? ''
  } catch {
    return ''
  }
}
function saveDraft(key: string, text: string): void {
  try {
    if (text) localStorage.setItem(DRAFT + key, text)
    else localStorage.removeItem(DRAFT + key)
  } catch {
    /* no storage: the draft only lives while the page is open */
  }
}

interface Pending {
  id: number
  file: AttachmentInput
  url?: string
}
let nextId = 1

/** The message box: grows with the text, takes photos and files, and can ask for a picture instead of an answer. */
export function Composer({ storageKey }: { storageKey: string }) {
  const send = useChat((s) => s.send)
  const stop = useChat((s) => s.stop)
  const running = useChat((s) => (s.activeId ? !!s.running[s.activeId] : false))
  const toast = useApp((s) => s.toast)
  const sendOnEnter = useApp((s) => s.settings?.chat.sendOnEnter ?? true)
  const canDraw = useSession((s) => !!s.session?.device.scopes.images)
  const bus = useComposerBus()
  const touch = useTouch()
  const [text, setText] = useState(() => loadDraft(storageKey))
  const [pending, setPending] = useState<Pending[]>([])
  const [mode, setMode] = useState<'chat' | 'image'>('chat')
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const photos = useRef<HTMLInputElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const lastNonce = useRef(bus.nonce)

  useEffect(() => saveDraft(storageKey, text), [storageKey, text])

  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [text])

  // Edit-and-resend, suggestion chips and the like hand their text to the message box through the bus.
  useEffect(() => {
    if (bus.nonce === lastNonce.current) return
    lastNonce.current = bus.nonce
    if (bus.text !== null) setText(bus.text)
    if (bus.mode && (bus.mode !== 'image' || canDraw)) setMode(bus.mode)
    if (bus.files.length) void add(bus.files)
    area.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus.nonce])

  const add = async (inputs: AttachmentInput[]) => {
    const next = inputs.map((file) => ({ id: nextId++, file, url: file.mime.startsWith('image/') ? URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type: file.mime })) : undefined }))
    setPending((p) => [...p, ...next])
  }

  const pick = async (list: FileList | null) => {
    if (!list?.length) return
    setBusy(true)
    try {
      const shrunk = await Promise.all([...list].map(shrinkPhoto))
      const { files: read, skipped } = await readFiles(shrunk)
      skipped.forEach((s) => toast('error', s))
      await add(read)
    } finally {
      setBusy(false)
    }
  }

  const remove = (id: number) =>
    setPending((p) => {
      const gone = p.find((x) => x.id === id)
      if (gone?.url) URL.revokeObjectURL(gone.url)
      return p.filter((x) => x.id !== id)
    })

  const canSend = (text.trim().length > 0 || pending.length > 0) && !busy
  const submit = async () => {
    if (!canSend || running) return
    const t = text
    const att = pending.map((p) => p.file)
    setText('')
    setPending([])
    pending.forEach((p) => p.url && URL.revokeObjectURL(p.url))
    const ok = await send(t, att.length ? att : undefined, mode === 'image' ? 'image' : undefined)
    if (!ok) {
      // Nothing was sent: give the words back so they are not lost.
      setText(t)
    } else setMode('chat')
  }

  const placeholder = useMemo(() => (mode === 'image' ? 'Describe the picture…' : 'Message'), [mode])

  return (
    <div className="mbar">
      {pending.length > 0 && (
        <div className="tray">
          {pending.map((p) => (
            <div key={p.id} className="tray-item">
              {p.url ? (
                <img src={p.url} alt={p.file.name} />
              ) : (
                <span className="tray-file">
                  <FileText size={18} />
                  <span className="ellipsis">{p.file.name}</span>
                  <span className="faint xs">{formatBytes(p.file.data.byteLength)}</span>
                </span>
              )}
              <button type="button" className="tray-x" aria-label={`Remove ${p.file.name}`} onClick={() => remove(p.id)}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className={cx('composer-box', mode === 'image' && 'draw')}>
        <button type="button" className="r-round" aria-label="Add a photo or file" onClick={() => setAdding(true)} disabled={busy}>
          {busy ? <Spinner size={18} /> : <Paperclip size={20} />}
        </button>
        <textarea
          ref={area}
          value={text}
          rows={1}
          placeholder={placeholder}
          aria-label="Message"
          enterKeyHint={touch ? 'enter' : 'send'}
          autoCapitalize="sentences"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // On a phone Enter starts a new line; the arrow button sends. With a keyboard attached it follows the computer's choice.
            if (e.key === 'Enter' && !e.shiftKey && !touch && sendOnEnter && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        {canDraw && (
          <button type="button" className={cx('r-round', mode === 'image' && 'on')} aria-label="Make a picture instead" aria-pressed={mode === 'image'} onClick={() => setMode(mode === 'image' ? 'chat' : 'image')}>
            <MountainSnow size={20} />
          </button>
        )}
        {running ? (
          <button type="button" className="r-round r-send r-stop" aria-label="Stop" onClick={stop}>
            <Square size={15} fill="currentColor" />
          </button>
        ) : (
          <button type="button" className="r-round r-send" aria-label="Send" disabled={!canSend} onClick={() => void submit()}>
            <ArrowUp size={20} strokeWidth={2.4} />
          </button>
        )}
      </div>

      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (void pick(e.target.files), (e.target.value = ''))} />
      <input ref={photos} type="file" accept="image/*" multiple hidden onChange={(e) => (void pick(e.target.files), (e.target.value = ''))} />
      <input ref={files} type="file" multiple hidden onChange={(e) => (void pick(e.target.files), (e.target.value = ''))} />
      <Sheet open={adding} onClose={() => setAdding(false)} title="Add to your message">
        <SheetItem
          icon={<Camera size={20} />}
          label="Take a photo"
          onClick={() => {
            setAdding(false)
            camera.current?.click()
          }}
        />
        <SheetItem
          icon={<ImageIcon size={20} />}
          label="Choose photos"
          onClick={() => {
            setAdding(false)
            photos.current?.click()
          }}
        />
        <SheetItem
          icon={<FileText size={20} />}
          label="Choose files"
          detail="Text and code files are read by the model"
          onClick={() => {
            setAdding(false)
            files.current?.click()
          }}
        />
      </Sheet>
    </div>
  )
}
