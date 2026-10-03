import { Download, MoreHorizontal, Pencil, Pin, PinOff, Search, SquarePen, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ConversationSummary } from '@shared/types'
import { invoke } from '@/lib/api'
import { cx, dayBucket, errorText } from '@/lib/format'
import { useApp } from '@/store/app'
import { useChat } from '@/store/chat'
import { Button, IconButton, MenuItem, MenuSeparator, Modal, Popover } from './ui'

function Row({ c, active, running, onAskDelete }: { c: ConversationSummary; active: boolean; running: boolean; onAskDelete: (c: ConversationSummary) => void }) {
  const select = useChat((s) => s.select)
  const patch = useChat((s) => s.patch)
  const toast = useApp((s) => s.toast)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(c.title)

  const commit = () => {
    setRenaming(false)
    const t = name.trim()
    if (t && t !== c.title) void patch(c.id, { title: t })
    else setName(c.title)
  }

  return (
    <div className={cx('conv-row', active && 'on')}>
      {renaming ? (
        <input
          className="conv-rename"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setName(c.title)
              setRenaming(false)
            }
          }}
        />
      ) : (
        <button type="button" className="conv-main" onClick={() => void select(c.id)} onDoubleClick={() => setRenaming(true)}>
          {c.pinned && <Pin size={12} className="conv-pin" />}
          <span className="conv-title ellipsis">{c.title}</span>
          {running && <span className="dot-pulse small" aria-label="Working" />}
        </button>
      )}
      {!renaming && (
        <Popover
          align="end"
          width={200}
          trigger={({ toggle, ref }) => (
            <button ref={ref} type="button" className="conv-more" aria-label="Chat options" onClick={toggle}>
              <MoreHorizontal size={16} />
            </button>
          )}
        >
          {(close) => (
            <div>
              <MenuItem
                icon={<Pencil size={14} />}
                onClick={() => {
                  close()
                  setRenaming(true)
                }}
              >
                Rename
              </MenuItem>
              <MenuItem
                icon={c.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                onClick={() => {
                  close()
                  void patch(c.id, { pinned: !c.pinned }).then(() => useChat.getState().refreshList())
                }}
              >
                {c.pinned ? 'Unpin' : 'Pin to top'}
              </MenuItem>
              <MenuItem
                icon={<Download size={14} />}
                onClick={() => {
                  close()
                  invoke('conversations:export', c.id)
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
                  onAskDelete(c)
                }}
              >
                Delete
              </MenuItem>
            </div>
          )}
        </Popover>
      )}
    </div>
  )
}

export function ConversationPanel() {
  const list = useChat((s) => s.list)
  const results = useChat((s) => s.results)
  const query = useChat((s) => s.query)
  const setQuery = useChat((s) => s.setQuery)
  const activeId = useChat((s) => s.activeId)
  const running = useChat((s) => s.running)
  const newChat = useChat((s) => s.newChat)
  const remove = useChat((s) => s.remove)
  const [doomed, setDoomed] = useState<ConversationSummary | null>(null)

  const shown = results ?? list
  const groups = useMemo(() => {
    const out: { label: string; items: ConversationSummary[] }[] = []
    const add = (label: string, c: ConversationSummary) => {
      const g = out.find((x) => x.label === label)
      if (g) g.items.push(c)
      else out.push({ label, items: [c] })
    }
    for (const c of shown) add(c.pinned ? 'Pinned' : dayBucket(c.updatedAt), c)
    return out
  }, [shown])

  return (
    <aside className="conv-panel">
      <div className="conv-top">
        <h2>Chats</h2>
        <IconButton label="New chat" onClick={() => newChat()}>
          <SquarePen size={17} />
        </IconButton>
      </div>
      <div className="conv-search">
        <Search size={14} />
        <input placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>
            <X size={14} />
          </button>
        )}
      </div>
      <div className="conv-scroll">
        {shown.length === 0 && <div className="conv-empty">{query ? 'No chats match.' : 'Your conversations will appear here.'}</div>}
        {groups.map((g) => (
          <div key={g.label} className="conv-group">
            <div className="menu-heading">{g.label}</div>
            {g.items.map((c) => (
              <Row key={c.id} c={c} active={c.id === activeId} running={!!running[c.id]} onAskDelete={setDoomed} />
            ))}
          </div>
        ))}
      </div>
      <Modal
        open={!!doomed}
        onClose={() => setDoomed(null)}
        title="Delete this chat?"
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDoomed(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (doomed) void remove(doomed.id)
                setDoomed(null)
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="dim" style={{ margin: 0 }}>
          “{doomed?.title}” and its messages will be removed from this computer. Images it made stay in the Image Hub.
        </p>
      </Modal>
    </aside>
  )
}
