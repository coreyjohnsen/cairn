import { AlertTriangle, ArrowUp, Brain, ChevronDown, FileText, FolderOpen, FolderX, ImageIcon, Paperclip, Square, Wrench, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { LOCAL_PROVIDER_ID } from '@shared/defaults'
import type { AttachmentInput, ThinkingMode } from '@shared/types'
import { invoke } from '@/lib/api'
import { baseName, cx, errorText, formatBytes, truncate } from '@/lib/format'
import { previewUrl, readFiles } from '@/lib/files'
import { useApp } from '@/store/app'
import { useChat } from '@/store/chat'
import { useComposerBus } from '@/store/composer'
import { useImages } from '@/store/images'
import { ModelPicker } from './ModelPicker'
import { IconButton, MenuItem, MenuLabel, MenuSeparator, Popover } from './ui'

const drafts = new Map<string, string>()

interface Pending {
  id: number
  input: AttachmentInput
  preview?: string
}
let pid = 1

function TargetPicker() {
  const targets = useImages((s) => s.targets)
  const refresh = useImages((s) => s.refreshTargets)
  const setView = useApp((s) => s.setView)
  const conv = useChat((s) => (s.activeId ? s.cache[s.activeId] : undefined))
  const draft = useChat((s) => s.draft)
  const patchActive = useChat((s) => s.patchActive)
  const defaultTarget = useApp((s) => s.settings?.image.defaultTarget)
  const current = conv?.imageTarget ?? draft.imageTarget ?? defaultTarget
  const selected = targets.find((t) => t.backendId === current?.backendId && t.model === current?.model) ?? targets.find((t) => t.available)
  return (
    <Popover
      placement="top"
      width={340}
      trigger={({ open, toggle, ref }) => (
        <button ref={ref} type="button" className={cx('chip-btn', open && 'open', !selected && 'empty')} onClick={() => { toggle(); if (!open) void refresh() }}>
          <ImageIcon size={14} />
          <span className="chip-main">{selected ? truncate(selected.label, 30) : 'No image model'}</span>
          <ChevronDown size={14} />
        </button>
      )}
    >
      {(close) => (
        <div>
          <MenuLabel>Image model</MenuLabel>
          {targets.length === 0 && <div className="model-empty">No image models set up yet.</div>}
          {targets.map((t) => (
            <MenuItem
              key={`${t.backendId}::${t.model}`}
              active={selected?.backendId === t.backendId && selected.model === t.model}
              disabled={!t.available}
              hint={!t.available ? t.unavailableReason : t.backendName}
              onClick={() => {
                patchActive({ imageTarget: { backendId: t.backendId, model: t.model } })
                close()
              }}
            >
              {t.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem
            icon={<Wrench size={14} />}
            onClick={() => {
              close()
              setView('models', 'image')
            }}
          >
            Manage image models
          </MenuItem>
        </div>
      )}
    </Popover>
  )
}

const THINKING_LABEL: Record<ThinkingMode, string> = { auto: 'Think: auto', on: 'Thinking', off: 'No thinking' }

/** Lets the person decide whether a reasoning model thinks before it answers. */
function ThinkingChip({ mode }: { mode: ThinkingMode }) {
  const patchActive = useChat((s) => s.patchActive)
  const conv = useChat((s) => (s.activeId ? s.cache[s.activeId] : undefined))
  const draft = useChat((s) => s.draft)
  const params = conv?.params ?? draft.params ?? {}
  const choose = (m: ThinkingMode, close: () => void) => {
    patchActive({ params: { ...params, thinking: m } })
    close()
  }
  const options: { id: ThinkingMode; label: string; hint: string }[] = [
    { id: 'auto', label: 'Auto', hint: "the model's own default" },
    { id: 'on', label: 'On', hint: 'reason first' },
    { id: 'off', label: 'Off', hint: 'answer straight away' }
  ]
  return (
    <Popover
      placement="top"
      width={280}
      trigger={({ open, toggle, ref }) => (
        <button ref={ref} type="button" className={cx('chip-btn', 'subtle', open && 'open', mode === 'on' && 'on')} onClick={toggle} title="Thinking mode">
          <Brain size={14} />
          <span className="chip-main">{THINKING_LABEL[mode]}</span>
        </button>
      )}
    >
      {(close) => (
        <div>
          <MenuLabel>Thinking mode</MenuLabel>
          {options.map((o) => (
            <MenuItem key={o.id} active={mode === o.id} hint={o.hint} onClick={() => choose(o.id, close)}>
              {o.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <div className="model-empty">Works with models running in Cairn, Ollama and other servers on this network, and OpenRouter. Other connections ignore it.</div>
        </div>
      )}
    </Popover>
  )
}

function WorkspaceChip({ workspace, defaultWorkspace }: { workspace: string; defaultWorkspace: string }) {
  const patchActive = useChat((s) => s.patchActive)
  const toast = useApp((s) => s.toast)
  const choose = async (close: () => void) => {
    close()
    try {
      const p = await invoke('system:selectFolder', 'Choose a working folder for this chat')
      if (p) patchActive({ workspace: p })
    } catch (e) {
      toast('error', errorText(e))
    }
  }
  return (
    <Popover
      placement="top"
      width={300}
      trigger={({ open, toggle, ref }) => (
        <button ref={ref} type="button" className={cx('chip-btn', 'subtle', open && 'open')} onClick={toggle} title={workspace || 'No working folder'}>
          {workspace ? <FolderOpen size={14} /> : <FolderX size={14} />}
          <span className="chip-main">{workspace ? truncate(baseName(workspace), 22) : 'No folder'}</span>
        </button>
      )}
    >
      {(close) => (
        <div>
          <MenuLabel>Working folder</MenuLabel>
          <div className="menu-path mono selectable">{workspace || 'Files are not accessible until you choose a folder.'}</div>
          <MenuSeparator />
          <MenuItem icon={<FolderOpen size={14} />} onClick={() => void choose(close)}>
            Choose folder…
          </MenuItem>
          {workspace && (
            <MenuItem
              onClick={() => {
                close()
                void invoke('system:openPath', workspace)
              }}
            >
              Open in file manager
            </MenuItem>
          )}
          {defaultWorkspace && workspace !== defaultWorkspace && (
            <MenuItem
              onClick={() => {
                close()
                patchActive({ workspace: '' })
              }}
            >
              Use default ({baseName(defaultWorkspace)})
            </MenuItem>
          )}
        </div>
      )}
    </Popover>
  )
}

export function Composer({ storageKey }: { storageKey: string }) {
  const settings = useApp((s) => s.settings)!
  const models = useApp((s) => s.models)
  const toast = useApp((s) => s.toast)
  const activeId = useChat((s) => s.activeId)
  const conv = useChat((s) => (s.activeId ? s.cache[s.activeId] : undefined))
  const draft = useChat((s) => s.draft)
  const running = useChat((s) => (s.activeId ? !!s.running[s.activeId] : false))
  const { send, stop, patchActive } = useChat.getState()
  const hasTargets = useImages((s) => s.targets.some((t) => t.available))

  const [text, setText] = useState(() => drafts.get(storageKey) ?? '')
  const [pending, setPending] = useState<Pending[]>([])
  const [mode, setMode] = useState<'chat' | 'image'>('chat')
  const area = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const pendingRef = useRef(pending)
  pendingRef.current = pending

  const modelRef = conv?.modelRef ?? draft.modelRef ?? settings.defaultModel
  const option = models.find((m) => m.ref === modelRef)
  const toolsOn = conv?.toolsEnabled ?? draft.toolsEnabled ?? settings.chat.toolsDefault
  const toolsSupported = option ? option.caps.tools !== false : true
  const thinkingMode: ThinkingMode = conv?.params?.thinking ?? draft.params?.thinking ?? settings.chat.thinking ?? 'auto'
  const thinkingShown = option ? option.caps.reasoning === true || option.providerId === LOCAL_PROVIDER_ID : false
  const workspace = (conv?.workspace ?? draft.workspace ?? '') || settings.agent.workspace

  useEffect(() => {
    drafts.set(storageKey, text)
  }, [storageKey, text])

  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  useEffect(() => () => pendingRef.current.forEach((p) => p.preview && URL.revokeObjectURL(p.preview)), [])

  const addInputs = (files: AttachmentInput[]) => {
    if (!files.length) return
    setPending((cur) => [...cur, ...files.map((input) => ({ id: pid++, input, preview: previewUrl(input) }))])
  }

  const addFiles = async (list: File[]) => {
    const { files, skipped } = await readFiles(list)
    skipped.forEach((s) => toast('error', s))
    addInputs(files)
  }

  // Other screens hand over text, files or a mode through the bus.
  const nonce = useComposerBus((s) => s.nonce)
  const seen = useRef(nonce)
  useEffect(() => {
    if (nonce === seen.current) return
    seen.current = nonce
    const b = useComposerBus.getState()
    if (b.text != null) setText(b.text)
    if (b.mode) setMode(b.mode)
    addInputs(b.files)
    area.current?.focus()
  }, [nonce])

  useEffect(() => {
    if (!running) area.current?.focus()
  }, [running, activeId])

  const removePending = (id: number) =>
    setPending((cur) => {
      const gone = cur.find((p) => p.id === id)
      if (gone?.preview) URL.revokeObjectURL(gone.preview)
      return cur.filter((p) => p.id !== id)
    })

  const canSend = (text.trim().length > 0 || pending.length > 0) && !running
  const sawImages = pending.some((p) => p.input.mime.startsWith('image/'))
  const visionWarning = mode === 'chat' && sawImages && option && !option.caps.vision

  const submit = async () => {
    const t = text.trim()
    if (!canSend) return
    if (mode === 'chat' && !option && !t.startsWith('/imagine')) {
      toast('info', 'Choose a model first. Use the model button at the bottom right.')
      return
    }
    const files = pending.map((p) => p.input)
    const ok = await send(t, files.length ? files : undefined, mode)
    if (ok) {
      setText('')
      drafts.delete(storageKey)
      pending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview))
      setPending([])
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    const wantsSend = settings.chat.sendOnEnter ? !e.shiftKey : e.ctrlKey || e.metaKey
    if (wantsSend) {
      e.preventDefault()
      void submit()
    }
  }

  const placeholder = useMemo(() => (mode === 'image' ? 'Describe the image you want to make…' : models.length === 0 ? 'Add a model to start chatting…' : 'Message, or type /imagine to make a picture'), [mode, models.length])

  return (
    <div className="composer-wrap">
      <div className={cx('composer', mode === 'image' && 'image-mode')}>
        {pending.length > 0 && (
          <div className="composer-files">
            {pending.map((p) => (
              <div key={p.id} className="pending">
                {p.preview ? <img src={p.preview} alt={p.input.name} draggable={false} /> : <FileText size={16} />}
                {!p.preview && (
                  <span className="pending-name ellipsis" title={p.input.name}>
                    {p.input.name}
                    <span className="faint xs"> {formatBytes(p.input.data.byteLength)}</span>
                  </span>
                )}
                <button type="button" className="pending-x" aria-label={`Remove ${p.input.name}`} onClick={() => removePending(p.id)}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {visionWarning && (
          <div className="composer-warn">
            <AlertTriangle size={14} /> {option?.name} can't see images. Pick a vision model or the picture will be ignored.
          </div>
        )}
        <textarea
          ref={area}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={placeholder}
          spellCheck
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = [...e.clipboardData.files]
            if (files.length) {
              e.preventDefault()
              void addFiles(files)
            }
          }}
        />
        <div className="composer-bar">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          <IconButton label="Attach files" size="sm" disabled={mode === 'image'} onClick={() => fileInput.current?.click()}>
            <Paperclip size={16} />
          </IconButton>
          <IconButton
            label={mode === 'image' ? 'Image mode: on' : 'Make an image'}
            size="sm"
            active={mode === 'image'}
            onClick={() => {
              if (mode === 'chat' && !hasTargets) {
                toast('info', 'No image model is set up yet. Open Models, then Image models.')
                useApp.getState().setView('models', 'image')
                return
              }
              setMode((m) => (m === 'chat' ? 'image' : 'chat'))
            }}
          >
            <ImageIcon size={16} />
          </IconButton>
          {mode === 'chat' && (
            <>
              <IconButton
                label={!toolsSupported ? "This model can't use tools" : toolsOn ? 'Tools on (click to turn off)' : 'Tools off (click to turn on)'}
                size="sm"
                active={toolsOn && toolsSupported}
                disabled={!toolsSupported}
                onClick={() => patchActive({ toolsEnabled: !toolsOn })}
              >
                <Wrench size={16} />
              </IconButton>
              {thinkingShown && <ThinkingChip mode={thinkingMode} />}
              {toolsOn && toolsSupported && <WorkspaceChip workspace={workspace} defaultWorkspace={settings.agent.workspace} />}
            </>
          )}
          <span className="grow" />
          {mode === 'image' ? <TargetPicker /> : <ModelPicker value={modelRef} onChange={(ref) => { patchActive({ modelRef: ref }); useApp.getState().update({ defaultModel: ref }) }} />}
          {running ? (
            <button type="button" className="send-btn stop" onClick={() => stop()} aria-label="Stop generating" data-tip="Stop">
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="send-btn" disabled={!canSend} onClick={() => void submit()} aria-label="Send" data-tip={mode === 'image' ? 'Generate' : 'Send'}>
              <ArrowUp size={18} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint">{settings.chat.sendOnEnter ? 'Enter to send · Shift+Enter for a new line' : 'Ctrl+Enter to send'}</div>
    </div>
  )
}
