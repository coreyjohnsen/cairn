import { FilePen, FilePlus, Globe, MoveRight, ShieldQuestion, Terminal, Trash2 } from 'lucide-react'
import type { ApprovalKind, ApprovalRequest } from '@shared/types'
import { useChat } from '@/store/chat'
import { Button } from './ui'
import { Diff } from './ToolCard'

const KIND_ICON: Record<ApprovalKind, typeof Terminal> = {
  write: FilePlus,
  edit: FilePen,
  delete: Trash2,
  move: MoveRight,
  command: Terminal,
  network: Globe,
  generic: ShieldQuestion
}

/** Shows the oldest pending permission request for the open chat. Nothing runs until the person decides. */
export function ApprovalDock({ approvals }: { approvals: ApprovalRequest[] }) {
  const approve = useChat((s) => s.approve)
  const a = approvals[0]
  if (!a) return null
  const Icon = KIND_ICON[a.kind] ?? ShieldQuestion
  const destructive = a.kind === 'delete' || a.kind === 'command'
  return (
    <div className="approval" role="alertdialog" aria-label="Permission needed">
      <div className="approval-head">
        <span className={`approval-icon k-${a.kind}`}>
          <Icon size={17} />
        </span>
        <div className="grow">
          <div className="approval-title">{a.title}</div>
          {a.reason && <div className="approval-reason">{a.reason}</div>}
        </div>
        {approvals.length > 1 && <span className="approval-count">+{approvals.length - 1} more waiting</span>}
      </div>
      {a.path && <div className="approval-path mono selectable">{a.path}</div>}
      {a.command && (
        <pre className="approval-cmd selectable">
          {a.cwd && <span className="faint">{`${a.cwd}\n`}</span>}
          {a.command}
        </pre>
      )}
      {a.diff && <Diff text={a.diff} />}
      <div className="approval-actions">
        <Button variant="primary" size="sm" onClick={() => approve(a, 'allow')} autoFocus={false}>
          Allow once
        </Button>
        <Button variant="soft" size="sm" onClick={() => approve(a, 'allow-chat')}>
          Allow for this chat
        </Button>
        {!destructive && (
          <Button variant="ghost" size="sm" onClick={() => approve(a, 'always')}>
            Always allow
          </Button>
        )}
        <span className="grow" />
        <Button variant="danger" size="sm" onClick={() => approve(a, 'deny')}>
          Decline
        </Button>
      </div>
    </div>
  )
}
