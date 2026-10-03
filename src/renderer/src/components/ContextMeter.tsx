import { Brain, Eye, RotateCcw, Scissors } from 'lucide-react'
import { useState } from 'react'
import { compactionText } from '@shared/compaction'
import type { Compaction, Conversation } from '@shared/types'
import { cx, formatCount } from '@/lib/format'
import { useApp } from '@/store/app'
import { useChat } from '@/store/chat'
import { Button, Modal, Notice, Popover } from './ui'

/** The summary the model reads in place of the earlier messages, shown the way the model sees it. */
export function SummaryModal({ compaction, open, onClose }: { compaction: Compaction; open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Summary of the earlier conversation" width={680}>
      <div className="stack" style={{ gap: 12 }}>
        <p className="dim small" style={{ margin: 0 }}>
          The model reads this instead of the {compaction.messages} earlier messages ({compaction.toolCalls} tool calls). Your chat still shows all of them, and nothing was deleted.
        </p>
        {compaction.source === 'ledger' && <Notice tone="warn">The model could not write a description this time, so only the list of what was asked and which tools were used was kept.</Notice>}
        <pre className="summary-text selectable">{compactionText(compaction)}</pre>
      </div>
    </Modal>
  )
}

/** The model's memory at a glance: how full it is, and what Cairn does about it. */
export function ContextMeter({ conv, running }: { conv: Conversation; running: boolean }) {
  const compact = useChat((s) => s.compact)
  const uncompact = useChat((s) => s.uncompact)
  const auto = useApp((s) => s.settings?.chat.autoCompact !== false)
  const at = useApp((s) => s.settings?.chat.compactAt ?? 75)
  const setView = useApp((s) => s.setView)
  const [showing, setShowing] = useState(false)
  const u = conv.contextUsage
  const c = conv.compaction
  if (!u || u.window <= 0) return null

  const pct = Math.min(100, Math.round((u.used / u.window) * 100))
  const level = pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low'

  return (
    <>
      <Popover
        align="end"
        width={340}
        trigger={({ toggle, ref }) => (
          <button ref={ref} type="button" className={cx('ctx-pill', `ctx-${level}`)} onClick={toggle} aria-label={`Model memory: ${pct}% full`} data-tip="Model memory">
            <span className="ctx-ring" style={{ ['--pct' as string]: `${pct}%` }} />
            <span className="mono">
              {formatCount(u.used)}
              <span className="faint"> / {formatCount(u.window)}</span>
            </span>
            {c && <Scissors size={12} className="ctx-cut" aria-label="Earlier messages are summarized" />}
          </button>
        )}
      >
        {(close) => (
          <div className="ctx-pop">
            <div className="row-between">
              <strong className="ctx-title">
                <Brain size={14} /> Model memory
              </strong>
              <span className="mono small">{pct}%</span>
            </div>
            <div className={cx('ctx-bar', `ctx-${level}`)}>
              <span style={{ width: `${pct}%` }} />
              <i style={{ left: `${at}%` }} title={`Summaries start at ${at}%`} />
            </div>
            <div className="faint small">
              About {u.used.toLocaleString()} of {u.window.toLocaleString()} tokens used at the last reply.
            </div>
            {c ? (
              <div className="ctx-sum">
                <div className="small">
                  {c.messages} earlier messages ({c.toolCalls} tool calls) are summarized for the model.
                </div>
                <div className="faint xs">
                  That shrank its view of the chat from about {formatCount(c.tokensBefore)} to {formatCount(c.tokensAfter)} tokens
                  {c.source === 'ledger' ? '; the model could not write a description, so only the list of tool calls was kept' : ''}.
                </div>
                <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                  <Button size="sm" icon={<Eye size={14} />} onClick={() => { close(); setShowing(true) }}>
                    View summary
                  </Button>
                  <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onClick={() => { close(); void uncompact() }} disabled={running} title="Send the model the whole chat again; if it is too long for the model it will be summarized again">
                    Use the full chat
                  </Button>
                </div>
              </div>
            ) : (
              <div className="faint xs">{auto ? `When memory is ${at}% full, Cairn summarizes the older steps so a long task can carry on.` : 'Automatic summaries are off, so the oldest messages are trimmed when memory fills up.'}</div>
            )}
            <div className="ctx-actions">
              <Button size="sm" variant="primary" icon={<Scissors size={14} />} disabled={running} onClick={() => { close(); void compact() }} title="Summarize the older messages now to free memory">
                Summarize now
              </Button>
              <button type="button" className="link-btn" onClick={() => { close(); setView('settings', 'chat') }}>
                Settings
              </button>
            </div>
          </div>
        )}
      </Popover>
      {c && <SummaryModal compaction={c} open={showing} onClose={() => setShowing(false)} />}
    </>
  )
}
