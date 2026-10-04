import { ChevronDown, ChevronLeft, MoreHorizontal, Pencil, Pin, PinOff, Scissors, Trash2, Undo2 } from 'lucide-react'
import { useState } from 'react'
import type { ApprovalRequest } from '@shared/types'
import { ApprovalDock } from '@/components/ApprovalDock'
import { Logo } from '@/components/Logo'
import { MessageList } from '@/components/MessageList'
import { Button } from '@/components/ui'
import { cx } from '@/lib/format'
import { useApp } from '@/store/app'
import { useChat } from '@/store/chat'
import { useComposerBus } from '@/store/composer'
import { Sheet, SheetItem } from '../components/Sheet'
import { useNav } from '../store/nav'
import { useSession } from '../store/session'
import { Composer } from './Composer'

const NO_APPROVALS: ApprovalRequest[] = []

const SUGGESTIONS: { title: string; text: string; image?: boolean }[] = [
  { title: 'Paint a mountain scene', text: 'A misty alpine lake at first light, snow-capped peaks, soft pink alpenglow, ultra detailed', image: true },
  { title: 'Explain something simply', text: 'Explain how a transformer language model works, as if to a curious high-school student.' },
  { title: 'Plan my day', text: 'Help me plan a focused day. Ask me what I need to get done first.' },
  { title: 'Write a short story', text: 'Write a very short story about a lighthouse keeper who finds a door in the cliff.' }
]

function EmptyChat() {
  const models = useApp((s) => s.models)
  const loading = useApp((s) => s.modelsLoading)
  const canDraw = useSession((s) => !!s.session?.device.scopes.images)
  const push = useComposerBus((s) => s.push)
  const none = !loading && models.length === 0
  return (
    <div className="start">
      <Logo size={44} />
      <h2>What shall we explore?</h2>
      {none ? (
        <p className="dim">No models are ready on your computer yet. Open Cairn there and add or start one.</p>
      ) : (
        <>
          <p className="dim">Ask anything. The answer is made by the models on your computer.</p>
          <div className="chips">
            {SUGGESTIONS.filter((s) => !s.image || canDraw).map((s) => (
              <button key={s.title} type="button" className="suggest" onClick={() => push({ text: s.text, mode: s.image ? 'image' : 'chat' })}>
                {s.title}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ChatMenu({ onClose }: { onClose: () => void }) {
  const conv = useChat((s) => (s.activeId ? s.cache[s.activeId] : undefined))
  const running = useChat((s) => (s.activeId ? !!s.running[s.activeId] : false))
  const patch = useChat((s) => s.patch)
  const remove = useChat((s) => s.remove)
  const compact = useChat((s) => s.compact)
  const uncompact = useChat((s) => s.uncompact)
  const closeScreen = useNav((s) => s.close)
  const onPhone = useNav((s) => s.layers.includes('chat'))
  const [step, setStep] = useState<'menu' | 'rename' | 'delete'>('menu')
  const [name, setName] = useState('')
  if (!conv) return null

  const done = () => {
    setStep('menu')
    onClose()
  }
  return (
    <Sheet open onClose={done} title={step === 'rename' ? 'Rename chat' : step === 'delete' ? 'Delete this chat?' : conv.title}>
      {step === 'menu' && (
        <>
          <SheetItem
            icon={<Pencil size={20} />}
            label="Rename"
            onClick={() => {
              setName(conv.title)
              setStep('rename')
            }}
          />
          <SheetItem
            icon={conv.pinned ? <PinOff size={20} /> : <Pin size={20} />}
            label={conv.pinned ? 'Unpin' : 'Pin to the top'}
            onClick={() => {
              void patch(conv.id, { pinned: !conv.pinned }).then(() => useChat.getState().refreshList())
              done()
            }}
          />
          {conv.compaction ? (
            <SheetItem
              icon={<Undo2 size={20} />}
              label="Use the whole chat again"
              detail="Stop summarizing the older messages for the model"
              disabled={running}
              onClick={() => {
                void uncompact()
                done()
              }}
            />
          ) : (
            <SheetItem
              icon={<Scissors size={20} />}
              label="Summarize older messages"
              detail="Frees up the model’s memory in a long chat"
              disabled={running || conv.messages.length < 4}
              onClick={() => {
                void compact()
                done()
              }}
            />
          )}
          <SheetItem icon={<Trash2 size={20} />} label="Delete chat" danger onClick={() => setStep('delete')} />
        </>
      )}
      {step === 'rename' && (
        <form
          className="sheet-form"
          onSubmit={(e) => {
            e.preventDefault()
            const t = name.trim()
            if (t && t !== conv.title) void patch(conv.id, { title: t })
            done()
          }}
        >
          <input className="fld" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} aria-label="Chat name" />
          <Button variant="primary" type="submit" disabled={!name.trim()}>
            Save
          </Button>
        </form>
      )}
      {step === 'delete' && (
        <div className="sheet-form">
          <p className="dim" style={{ margin: 0 }}>
            This removes the chat from your computer too. Pictures it made stay in Pictures.
          </p>
          <div className="row">
            <Button variant="ghost" onClick={() => setStep('menu')}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                void remove(conv.id)
                // On a phone the chat itself closes too; closing it also closes this sheet above it.
                closeScreen(onPhone ? 'chat' : 'chatMenu')
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  )
}

/** One chat: its messages, the message box, and a menu. A full screen on phones, the right-hand pane on tablets. */
export function ChatScreen({ wide }: { wide?: boolean }) {
  const activeId = useChat((s) => s.activeId)
  const conv = useChat((s) => (s.activeId ? s.cache[s.activeId] : undefined))
  const running = useChat((s) => (s.activeId ? !!s.running[s.activeId] : false))
  const status = useChat((s) => (s.activeId ? (s.status[s.activeId] ?? '') : ''))
  const runError = useChat((s) => (s.activeId ? (s.runError[s.activeId] ?? '') : ''))
  const approvals = useChat((s) => (s.activeId ? (s.approvals[s.activeId] ?? NO_APPROVALS) : NO_APPROVALS))
  const progress = useChat((s) => s.progress)
  const draftModel = useChat((s) => s.draft.modelRef)
  const models = useApp((s) => s.models)
  const defaultModel = useApp((s) => s.settings?.defaultModel)
  const close = useNav((s) => s.close)
  const openLayer = useNav((s) => s.open)
  const layers = useNav((s) => s.layers)
  const menuOpen = layers.includes('chatMenu')

  const ref = conv?.modelRef || draftModel || defaultModel
  const model = models.find((m) => m.ref === ref)
  const hasMessages = !!conv && conv.messages.length > 0

  return (
    <section className={cx('chatx', wide ? 'pane' : 'screen')} aria-label="Chat">
      <header className="top chat-top">
        {!wide && (
          <button type="button" className="top-btn icon" aria-label="Back to chats" onClick={() => close('chat')}>
            <ChevronLeft size={24} />
          </button>
        )}
        <div className="chat-titles">
          <h1 className="ellipsis">{conv?.title ?? 'New chat'}</h1>
          <button type="button" className="model-chip" onClick={() => openLayer('models')}>
            <span className="ellipsis">{model?.name ?? (models.length ? 'Choose a model' : 'No model')}</span>
            <ChevronDown size={13} />
          </button>
        </div>
        {conv && (
          <button type="button" className="top-btn icon" aria-label="Chat options" onClick={() => openLayer('chatMenu')}>
            <MoreHorizontal size={22} />
          </button>
        )}
      </header>
      {hasMessages && conv ? <MessageList conv={conv} running={running} status={status} runError={runError} progress={progress} /> : <EmptyChat />}
      <div className="dock">
        <ApprovalDock approvals={approvals} />
        <Composer key={activeId ?? 'new'} storageKey={activeId ?? 'new'} />
      </div>
      {menuOpen && <ChatMenu onClose={() => close('chatMenu')} />}
    </section>
  )
}
