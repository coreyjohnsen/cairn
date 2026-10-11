import { AlertTriangle, Check, ChevronDown, CircleDot, Circle, ListChecks, Play, X } from 'lucide-react'
import { useState } from 'react'
import { planProgress } from '@shared/plan'
import type { Conversation, PlanStatus } from '@shared/types'
import { cx } from '@/lib/format'
import { useChat } from '@/store/chat'
import { Markdown } from './Markdown'
import { Button, IconButton } from './ui'

const ICON: Record<PlanStatus, typeof Circle> = { todo: Circle, doing: CircleDot, done: Check, blocked: AlertTriangle }
const LABEL: Record<PlanStatus, string> = { todo: 'To do', doing: 'Doing now', done: 'Done', blocked: 'Blocked' }

/** The plan the assistant is following: its goal, the steps with their progress, and the design behind them. */
export function PlanCard({ conv, running, canClear = true, canBuild = true }: { conv: Conversation; running: boolean; canClear?: boolean; canBuild?: boolean }) {
  const plan = conv.plan
  const send = useChat((s) => s.send)
  const patch = useChat((s) => s.patch)
  const [open, setOpen] = useState(true)
  const [design, setDesign] = useState(false)
  if (!plan || (!plan.goal && plan.steps.length === 0)) return null
  const { done, total } = planProgress(plan)
  const finished = total > 0 && done === total
  return (
    <div className={cx('plan-card', open && 'open')}>
      <div className="plan-head">
        <button type="button" className="plan-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <ListChecks size={15} />
          <span className="plan-goal">{plan.goal || 'Plan'}</span>
          {total > 0 && (
            <span className="plan-count mono xs">
              {done}/{total}
            </span>
          )}
          <ChevronDown size={15} className="plan-chev" />
        </button>
        {canBuild && !running && !finished && total > 0 && (
          <Button size="sm" variant="primary" icon={<Play size={13} />} onClick={() => void send('/build')} title="Carry out the plan, step by step">
            Build it
          </Button>
        )}
        {canClear && !running && (
          <IconButton label="Clear the plan" size="sm" onClick={() => void patch(conv.id, { plan: null })}>
            <X size={14} />
          </IconButton>
        )}
      </div>
      {open && (
        <div className="plan-body">
          {total > 0 && <div className="plan-bar" aria-hidden><span style={{ width: `${(done / total) * 100}%` }} /></div>}
          <ol className="plan-steps">
            {plan.steps.map((s) => {
              const Icon = ICON[s.status]
              return (
                <li key={s.id} className={cx('plan-step', s.status)} title={LABEL[s.status]}>
                  <Icon size={14} aria-label={LABEL[s.status]} />
                  <span>{s.text}</span>
                </li>
              )
            })}
          </ol>
          {plan.design && (
            <div className="plan-design">
              <button type="button" className="link-btn" onClick={() => setDesign((d) => !d)}>
                {design ? 'Hide the design' : 'Show the design'}
              </button>
              {design && (
                <div className="plan-design-body selectable">
                  <Markdown text={plan.design} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
