import { Download, FileText, MoreHorizontal, Pencil, PanelLeftOpen, Pin, PinOff, SlidersHorizontal, Trash2, Upload } from 'lucide-react'
import { type CSSProperties, useRef, useState } from 'react'
import type { ApprovalRequest } from '@shared/types'
import { ApprovalDock } from '@/components/ApprovalDock'
import { ChatSettingsModal } from '@/components/ChatSettingsModal'
import { Composer } from '@/components/Composer'
import { ConversationPanel } from '@/components/ConversationPanel'
import { MessageList } from '@/components/MessageList'
import { Ridgeline } from '@/components/Ridgeline'
import { Button, IconButton, MenuItem, MenuSeparator, Modal, Popover } from '@/components/ui'
import { invoke } from '@/lib/api'
import { cx, errorText } from '@/lib/format'
import { readFiles } from '@/lib/files'
import { useApp } from '@/store/app'
import { useChat } from '@/store/chat'
import { useComposerBus } from '@/store/composer'
import { useLayout, usePanel } from '@/store/layout'

const NO_APPROVALS: ApprovalRequest[] = []

const SUGGESTIONS: { title: string; text: string; image?: boolean }[] = [
  { title: 'Paint a mountain scene', text: 'A misty alpine lake at first light, snow-capped peaks, soft pink alpenglow, ultra detailed', image: true },
  { title: 'Tidy up a project folder', text: 'Look through my working folder and suggest a cleaner structure. Do not move anything until I agree.' },
  { title: 'Explain something simply', text: 'Explain how a transformer language model works, as if to a curious high-school student.' },
  { title: 'Write a script', text: 'Write a Python script that renames the photos in a folder by the date they were taken.' }
]

function EmptyChat() {
  const models = useApp((s) => s.models)
  const loading = useApp((s) => s.modelsLoading)
  const setView = useApp((s) => s.setView)
  const push = useComposerBus((s) => s.push)
  const noModels = !loading && models.length === 0
  return (
    <div className="chat-empty">
      <div className="chat-empty-ridge">
        <Ridgeline seed={11} layers={4} animate />
      </div>
      <div className="chat-empty-body">
        <h1>What shall we explore?</h1>
        {noModels ? (
          <>
            <p>Add a model to begin. Run one on this computer, or connect a server or API you already use.</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <Button variant="primary" onClick={() => setView('models', 'local')}>
                Download a local model
              </Button>
              <Button onClick={() => setView('models', 'connections')}>Connect a provider</Button>
            </div>
          </>
        ) : (
          <>
            <p>Chat, give it tools to work on your files, or ask for a picture.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s.title} type="button" className="suggestion" onClick={() => push({ text: s.text, mode: s.image ? 'image' : 'chat' })}>
                  <span className="suggestion-title">{s.title}</span>
                  <span className="suggestion-text">{s.text}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ChatHeader({ onSettings }: { onSettings: () => void }) {
  const conv = useChat((s) => (s.activeId ? s.cache[s.activeId] : undefined))
  const patch = useChat((s) => s.patch)
  const remove = useChat((s) => s.remove)
  const toast = useApp((s) => s.toast)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [confirm, setConfirm] = useState(false)
  const { collapsed } = usePanel('conversations')
  const toggleList = useLayout((s) => s.toggle)

  const commit = () => {
    setEditing(false)
    const t = name.trim()
    if (conv && t && t !== conv.title) void patch(conv.id, { title: t })
  }

  return (
    <header className={cx('chat-head', collapsed && 'list-folded')}>
      {collapsed && (
        <IconButton label="Show the chat list (Ctrl+B)" onClick={() => toggleList('conversations')}>
          <PanelLeftOpen size={17} />
        </IconButton>
      )}
      {editing && conv ? (
        <input
          className="chat-title-edit"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <h2
          className="chat-title ellipsis"
          title={conv ? 'Double-click to rename' : undefined}
          onDoubleClick={() => {
            if (!conv) return
            setName(conv.title)
            setEditing(true)
          }}
        >
          {conv?.title ?? 'New chat'}
        </h2>
      )}
      <span className="grow" />
      <IconButton label="Chat settings" onClick={onSettings}>
        <SlidersHorizontal size={17} />
      </IconButton>
      {conv && (
        <Popover
          align="end"
          width={210}
          trigger={({ toggle, ref }) => (
            <IconButton ref={ref} label="More" onClick={toggle}>
              <MoreHorizontal size={18} />
            </IconButton>
          )}
        >
          {(close) => (
            <div>
              <MenuItem
                icon={<Pencil size={14} />}
                onClick={() => {
                  close()
                  setName(conv.title)
                  setEditing(true)
                }}
              >
                Rename
              </MenuItem>
              <MenuItem
                icon={conv.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                onClick={() => {
                  close()
                  void patch(conv.id, { pinned: !conv.pinned }).then(() => useChat.getState().refreshList())
                }}
              >
                {conv.pinned ? 'Unpin' : 'Pin to top'}
              </MenuItem>
              <MenuItem
                icon={<Download size={14} />}
                onClick={() => {
                  close()
                  invoke('conversations:export', conv.id)
                    .then((p) => p && toast('ok', `Saved to ${p}`))
                    .catch((e) => toast('error', errorText(e)))
                }}
              >
                Export as Markdown
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                danger
                icon={<Trash2 size={14} />}
                onClick={() => {
                  close()
                  setConfirm(true)
                }}
              >
                Delete chat
              </MenuItem>
            </div>
          )}
        </Popover>
      )}
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete this chat?"
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(false)
                if (conv) void remove(conv.id)
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="dim" style={{ margin: 0 }}>
          This removes the conversation from this computer. Images it made stay in the Image Hub.
        </p>
      </Modal>
    </header>
  )
}

export function ChatView() {
  const activeId = useChat((s) => s.activeId)
  const conv = useChat((s) => (s.activeId ? s.cache[s.activeId] : undefined))
  const running = useChat((s) => (s.activeId ? !!s.running[s.activeId] : false))
  const status = useChat((s) => (s.activeId ? (s.status[s.activeId] ?? '') : ''))
  const runError = useChat((s) => (s.activeId ? (s.runError[s.activeId] ?? '') : ''))
  const approvals = useChat((s) => (s.activeId ? (s.approvals[s.activeId] ?? NO_APPROVALS) : NO_APPROVALS))
  const progress = useChat((s) => s.progress)
  const push = useComposerBus((s) => s.push)
  const toast = useApp((s) => s.toast)
  const [dragging, setDragging] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const depth = useRef(0)
  const { width: listWidth, collapsed: listFolded } = usePanel('conversations')

  const hasMessages = !!conv && conv.messages.length > 0
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files')

  return (
    <div className="chat-layout" style={{ '--conv-w': `${listFolded ? 0 : listWidth}px` } as CSSProperties}>
      <ConversationPanel />
      <section
        className="chat-main"
        onDragEnter={(e) => {
          if (!hasFiles(e)) return
          depth.current++
          setDragging(true)
        }}
        onDragLeave={(e) => {
          if (!hasFiles(e)) return
          depth.current = Math.max(0, depth.current - 1)
          if (depth.current === 0) setDragging(false)
        }}
        onDragOver={(e) => hasFiles(e) && e.preventDefault()}
        onDrop={(e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          depth.current = 0
          setDragging(false)
          void readFiles([...e.dataTransfer.files]).then(({ files, skipped }) => {
            skipped.forEach((s) => toast('error', s))
            if (files.length) push({ files })
          })
        }}
      >
        <ChatHeader onSettings={() => setSettingsOpen(true)} />
        {hasMessages && conv ? <MessageList conv={conv} running={running} status={status} runError={runError} progress={progress} /> : <EmptyChat />}
        <div className="chat-bottom">
          <ApprovalDock approvals={approvals} />
          <Composer key={activeId ?? 'new'} storageKey={activeId ?? 'new'} />
        </div>
        {dragging && (
          <div className="drop-overlay">
            <div className="drop-card">
              <Upload size={22} />
              <span>Drop files to attach</span>
              <span className="faint xs">
                <FileText size={12} /> Images and text or code files
              </span>
            </div>
          </div>
        )}
      </section>
      <ChatSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
