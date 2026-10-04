import { Pin, Search, SquarePen, X } from 'lucide-react'
import { useMemo } from 'react'
import type { ConversationSummary } from '@shared/types'
import { Logo } from '@/components/Logo'
import { cx, dayBucket } from '@/lib/format'
import { useChat } from '@/store/chat'
import { useNav } from '../store/nav'

function shortTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const days = (now.getTime() - ts) / 86400000
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function Row({ c, active, running, onOpen }: { c: ConversationSummary; active: boolean; running: boolean; onOpen: () => void }) {
  return (
    <button type="button" className={cx('chat-row', active && 'on')} onClick={onOpen}>
      <span className="chat-row-main">
        <span className="chat-row-title">
          {c.pinned && <Pin size={12} className="chat-row-pin" />}
          <span className="ellipsis">{c.title}</span>
        </span>
        <span className="chat-row-preview ellipsis">{c.preview || 'No messages yet'}</span>
      </span>
      <span className="chat-row-side">
        {running ? <span className="dot-pulse small" aria-label="Working" /> : <span className="faint xs">{shortTime(c.updatedAt)}</span>}
      </span>
    </button>
  )
}

export function ChatsList({ wide }: { wide?: boolean }) {
  const list = useChat((s) => s.list)
  const results = useChat((s) => s.results)
  const query = useChat((s) => s.query)
  const setQuery = useChat((s) => s.setQuery)
  const activeId = useChat((s) => s.activeId)
  const running = useChat((s) => s.running)
  const select = useChat((s) => s.select)
  const newChat = useChat((s) => s.newChat)
  const open = useNav((s) => s.open)

  const shown = results ?? list
  const groups = useMemo(() => {
    const pinned = shown.filter((c) => c.pinned)
    const rest = shown.filter((c) => !c.pinned)
    const out: { label: string; items: ConversationSummary[] }[] = []
    if (pinned.length) out.push({ label: 'Pinned', items: pinned })
    for (const c of rest) {
      const label = results ? 'Results' : dayBucket(c.updatedAt)
      const g = out.find((x) => x.label === label)
      if (g) g.items.push(c)
      else out.push({ label, items: [c] })
    }
    return out
  }, [shown, results])

  const openChat = (id: string) => {
    void select(id)
    if (!wide) open('chat')
  }
  const startNew = () => {
    newChat()
    if (!wide) open('chat')
  }

  return (
    <section className="chats" aria-label="Chats">
      <header className="top">
        <h1>Chats</h1>
        <button type="button" className="top-btn accent" onClick={startNew} aria-label="New chat">
          <SquarePen size={18} />
          <span>New</span>
        </button>
      </header>
      <div className="search">
        <Search size={16} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" aria-label="Search chats" inputMode="search" enterKeyHint="search" />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>
            <X size={15} />
          </button>
        )}
      </div>
      <div className="scroll">
        {groups.map((g) => (
          <div key={g.label} className="group">
            <div className="group-label">{g.label}</div>
            {g.items.map((c) => (
              <Row key={c.id} c={c} active={wide === true && c.id === activeId} running={!!running[c.id]} onOpen={() => openChat(c.id)} />
            ))}
          </div>
        ))}
        {!shown.length && (
          <div className="blank">
            <Logo size={40} />
            <h2>{query ? 'No chats match that' : 'No chats yet'}</h2>
            <p className="dim">{query ? 'Try other words.' : 'Start one and the answer comes from the models on your computer.'}</p>
            {!query && (
              <button type="button" className="btn btn-primary" onClick={startNew}>
                Start a chat
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
