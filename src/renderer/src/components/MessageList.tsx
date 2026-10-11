import { AlertCircle, Brain, ChevronRight, Copy, FileText, Info, Pencil, RotateCcw, Scissors } from 'lucide-react'
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, ChatMessage, Compaction, Conversation, ImageRef, ToolProgress } from '@shared/types'
import { mediaUrl } from '@/lib/api'
import { cx, formatBytes, formatDuration } from '@/lib/format'
import { useChat } from '@/store/chat'
import { useComposerBus } from '@/store/composer'
import { useImages } from '@/store/images'
import { SummaryModal } from './ContextMeter'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'
import { ImageProgress } from './ImageProgress'
import { Button, IconButton, Modal } from './ui'

/* ───────────── pieces ───────────── */

function ImageGrid({ images }: { images: ImageRef[] }) {
  const view = useImages((s) => s.view)
  return (
    <div className={cx('msg-images', `n-${Math.min(images.length, 4)}`)}>
      {images.map((im) => (
        <button key={im.id} type="button" className="msg-image" style={{ aspectRatio: `${im.width} / ${im.height}` }} onClick={() => view(im.id, images.map((x) => x.id))} title={im.prompt}>
          <img src={mediaUrl('thumb', im.thumb)} alt={im.prompt} loading="lazy" draggable={false} />
        </button>
      ))}
    </div>
  )
}

/** A text or code file sent with a message. Tapping it shows what the model read, with a copy button and a way to save it. */
function FileChip({ a }: { a: Attachment }) {
  const [open, setOpen] = useState(false)
  const text = a.text
  const save = () => {
    const url = URL.createObjectURL(new Blob([text ?? ''], { type: a.mime || 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = a.name
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }
  const body = (
    <>
      <FileText size={14} />
      <span className="ellipsis">{a.name}</span>
      <span className="faint xs">{formatBytes(a.size)}</span>
    </>
  )
  if (text === undefined) {
    return (
      <span className="att-file" title={a.name}>
        {body}
      </span>
    )
  }
  return (
    <>
      <button type="button" className="att-file openable" title={`Show ${a.name}`} onClick={() => setOpen(true)}>
        {body}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={a.name}
        width={760}
        footer={
          <>
            <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(text)}>
              Copy
            </Button>
            <Button onClick={save}>Save a copy</Button>
          </>
        }
      >
        <pre className="att-text selectable">{text}</pre>
      </Modal>
    </>
  )
}

function AttachmentChips({ items }: { items: Attachment[] }) {
  return (
    <div className="msg-attachments">
      {items.map((a) =>
        a.kind === 'image' ? <img key={a.id} className="att-thumb" src={mediaUrl('attachment', a.file)} alt={a.name} title={a.name} draggable={false} /> : <FileChip key={a.id} a={a} />
      )}
    </div>
  )
}

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  const shown = open || (streaming && !!text)
  return (
    <div className={cx('reasoning', shown && 'open')}>
      <button type="button" className="reasoning-head" onClick={() => setOpen((o) => !o)} aria-expanded={shown}>
        <Brain size={14} />
        <span>{streaming ? 'Thinking…' : 'Reasoning'}</span>
        <ChevronRight size={14} className="chev" />
      </button>
      {shown && <div className="reasoning-body selectable">{text}</div>}
    </div>
  )
}

function Typing() {
  return (
    <span className="typing" aria-label="Thinking">
      <i />
      <i />
      <i />
    </span>
  )
}

function copy(text: string) {
  void navigator.clipboard.writeText(text)
}

/* ───────────── messages ───────────── */

const UserMessage = memo(function UserMessage({ m, canEdit }: { m: ChatMessage; canEdit: boolean }) {
  const truncateFrom = useChat((s) => s.truncateFrom)
  const push = useComposerBus((s) => s.push)
  return (
    <div className="msg msg-user">
      <div className="bubble selectable">
        {m.attachments && m.attachments.length > 0 && <AttachmentChips items={m.attachments} />}
        {m.content && <div className="bubble-text">{m.content}</div>}
      </div>
      <div className="msg-actions">
        <IconButton label="Copy" size="sm" onClick={() => copy(m.content)}>
          <Copy size={14} />
        </IconButton>
        {canEdit && (
          <IconButton
            label="Edit and resend"
            size="sm"
            onClick={() => {
              void truncateFrom(m.id).then(() => push({ text: m.content }))
            }}
          >
            <Pencil size={14} />
          </IconButton>
        )}
      </div>
    </div>
  )
})

interface AssistantProps {
  m: ChatMessage
  results: Map<string, ChatMessage>
  live: boolean
  showModel: boolean
  footer: boolean
  progress: Record<string, ToolProgress>
  canRegenerate: boolean
}

const AssistantMessage = memo(function AssistantMessage({ m, results, live, showModel, footer, progress, canRegenerate }: AssistantProps) {
  const regenerate = useChat((s) => s.regenerate)
  const streaming = m.status === 'streaming'
  const hasBody = !!m.content || !!m.reasoning || !!m.toolCalls?.length || !!m.notice || !!m.error
  const u = m.usage
  return (
    <div className="msg msg-assistant">
      {showModel && m.model && <div className="msg-model">{m.model}</div>}
      {m.reasoning && <Reasoning text={m.reasoning} streaming={streaming && !m.content} />}
      {m.content && <Markdown text={m.content} />}
      {streaming && !m.content && !m.reasoning && !m.toolCalls?.length && <Typing />}
      {m.toolCalls?.map((tc) => {
        const r = results.get(tc.id)
        const imgs = r?.images
        const generating = tc.name === 'generate_image' && !r && live
        return (
          <div key={tc.id} className="tool-block">
            <ToolCard call={tc} result={r} live={live} progress={progress[tc.id]} />
            {generating && (
              <div className="gen-placeholder">
                <div className="gen-shimmer" />
                <div className="gen-meta">
                  <ImageProgress compact stage={progress[tc.id]?.stage} label={progress[tc.id]?.label ?? 'Generating image…'} progress={progress[tc.id]?.progress} />
                </div>
              </div>
            )}
            {imgs && imgs.length > 0 && <ImageGrid images={imgs} />}
          </div>
        )
      })}
      {m.status === 'error' && m.error && (
        <div className="msg-note error">
          <AlertCircle size={14} />
          <span className="selectable">{m.error}</span>
        </div>
      )}
      {m.status === 'aborted' && <div className="msg-note faint">Stopped</div>}
      {m.notice && (
        <div className="msg-note">
          <Info size={14} />
          <span className="selectable">{m.notice}</span>
        </div>
      )}
      {footer && hasBody && !streaming && (
        <div className="msg-foot">
          {(u?.completionTokens || m.durationMs) && (
            <span className="msg-usage faint xs">
              {u?.completionTokens ? `${u.completionTokens} tokens` : ''}
              {u?.tokensPerSecond ? ` · ${u.tokensPerSecond.toFixed(1)} tok/s` : ''}
              {m.durationMs ? `${u?.completionTokens ? ' · ' : ''}${formatDuration(m.durationMs)}` : ''}
            </span>
          )}
          <div className="msg-actions">
            {m.content && (
              <IconButton label="Copy" size="sm" onClick={() => copy(m.content)}>
                <Copy size={14} />
              </IconButton>
            )}
            {canRegenerate && (
              <IconButton label="Regenerate" size="sm" onClick={() => void regenerate()}>
                <RotateCcw size={14} />
              </IconButton>
            )}
          </div>
        </div>
      )}
    </div>
  )
})

/** Where the model's view of the chat starts: everything above this line is summarized for it. */
function CompactionNote({ c }: { c: Compaction }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="compaction-note">
      <span className="compaction-line" />
      <button type="button" className="compaction-chip" onClick={() => setOpen(true)} title="See what the model reads in place of the messages above">
        <Scissors size={12} />
        <span>
          Summarized for the model: {c.messages} messages, {c.toolCalls} tool calls
        </span>
        <span className="link-btn">View</span>
      </button>
      <span className="compaction-line" />
      <SummaryModal compaction={c} open={open} onClose={() => setOpen(false)} />
    </div>
  )
}

/* ───────────── list ───────────── */

interface ListProps {
  conv: Conversation
  running: boolean
  status: string
  runError: string
  progress: Record<string, ToolProgress>
}

export function MessageList({ conv, running, status, runError, progress }: ListProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const regenerate = useChat((s) => s.regenerate)

  const { items, results } = useMemo(() => {
    const results = new Map<string, ChatMessage>()
    for (const m of conv.messages) if (m.role === 'tool' && m.toolCallId) results.set(m.toolCallId, m)
    const items: { m: ChatMessage; showModel: boolean; footer: boolean }[] = []
    const visible = conv.messages.filter((m) => m.role !== 'tool')
    visible.forEach((m, i) => {
      const prev = visible[i - 1]
      const next = visible[i + 1]
      items.push({ m, showModel: m.role === 'assistant' && (!prev || prev.role !== 'assistant'), footer: m.role === 'assistant' && (!next || next.role !== 'assistant') })
    })
    return { items, results }
  }, [conv.messages])

  // The line goes after the last visible message the summary covers (that message itself may be a hidden tool result).
  const noteAfter = useMemo(() => {
    if (!conv.compaction) return null
    const at = conv.messages.findIndex((m) => m.id === conv.compaction!.upToMessageId)
    for (let i = at; i >= 0; i--) if (conv.messages[i].role !== 'tool') return conv.messages[i].id
    return null
  }, [conv.messages, conv.compaction])

  const lastUserIndex = useMemo(() => {
    for (let i = conv.messages.length - 1; i >= 0; i--) if (conv.messages[i].role === 'user') return i
    return -1
  }, [conv.messages])
  const lastAssistantId = useMemo(() => {
    for (let i = conv.messages.length - 1; i >= 0; i--) if (conv.messages[i].role === 'assistant') return conv.messages[i].id
    return null
  }, [conv.messages])

  const onScroll = () => {
    const el = scroller.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
  }

  // Follow the stream unless the person scrolled up to read.
  const last = conv.messages[conv.messages.length - 1]
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [conv.messages.length, last?.content.length, last?.reasoning?.length, status, runError, running])

  useEffect(() => {
    stick.current = true
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [conv.id])

  return (
    <div className="messages" ref={scroller} onScroll={onScroll}>
      <div className="messages-inner">
        {items.map(({ m, showModel, footer }) => (
          <Fragment key={m.id}>
            {m.role === 'user' ? (
              <UserMessage m={m} canEdit={!running && conv.messages.indexOf(m) === lastUserIndex} />
            ) : (
              <AssistantMessage
                m={m}
                results={results}
                live={running}
                showModel={showModel}
                footer={footer}
                progress={progress}
                canRegenerate={!running && m.id === lastAssistantId && lastUserIndex >= 0}
              />
            )}
            {conv.compaction && m.id === noteAfter && <CompactionNote c={conv.compaction} />}
          </Fragment>
        ))}
        {running && status && (
          <div className="run-status">
            <span className="dot-pulse" />
            <span>{status}</span>
          </div>
        )}
        {runError && !running && (
          <div className="run-error" role="alert">
            <AlertCircle size={16} />
            <div className="grow selectable">{runError}</div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void regenerate()}>
              <RotateCcw size={14} /> <span>Try again</span>
            </button>
          </div>
        )}
        <div className="messages-end" />
      </div>
    </div>
  )
}
