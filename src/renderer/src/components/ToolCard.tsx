import { AlertTriangle, Check, ChevronRight, FilePen, FilePlus, FileText, FolderOpen, Globe, ImageIcon, MoveRight, Puzzle, Search, SearchCode, Terminal, Trash2, X } from 'lucide-react'
import { memo, useState } from 'react'
import type { ChatMessage, ToolCall, ToolProgress } from '@shared/types'
import { cx, formatBytes } from '@/lib/format'
import { type ToolIconKey, parseArgs, presentTense, summarizeTool } from '@/lib/toolSummary'
import { Progress } from './ui'

const ICONS: Record<ToolIconKey, typeof FileText> = {
  read: FileText,
  write: FilePlus,
  edit: FilePen,
  list: FolderOpen,
  search: Search,
  find: SearchCode,
  move: MoveRight,
  delete: Trash2,
  shell: Terminal,
  web: Globe,
  image: ImageIcon,
  custom: Puzzle
}

export function Diff({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <pre className="diff selectable">
      {lines.map((l, i) => (
        <div key={i} className={cx('diff-line', l.startsWith('+') && !l.startsWith('+++') && 'add', l.startsWith('-') && !l.startsWith('---') && 'del', l.startsWith('@@') && 'hunk')}>
          {l || ' '}
        </div>
      ))}
    </pre>
  )
}

const RESULT_LIMIT = 6000

function ResultText({ text }: { text: string }) {
  const shown = text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}\n… ${formatBytes(text.length - RESULT_LIMIT)} more not shown` : text
  return <pre className="tool-out selectable">{shown || '(no output)'}</pre>
}

function Detail({ call, result }: { call: ToolCall; result?: ChatMessage }) {
  const a = parseArgs(call.arguments)
  const hasArgs = Object.keys(a).length > 0
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  return (
    <div className="tool-detail">
      {call.name === 'run_command' && <pre className="tool-cmd selectable">{s('command')}</pre>}
      {call.name === 'edit_file' && (
        <>
          <div className="tool-path mono selectable">{s('path')}</div>
          <Diff text={`${s('old_string').split('\n').map((l) => `- ${l}`).join('\n')}\n${s('new_string').split('\n').map((l) => `+ ${l}`).join('\n')}`} />
        </>
      )}
      {call.name === 'write_file' && (
        <>
          <div className="tool-path mono selectable">{s('path')}</div>
          <pre className="tool-out selectable">{s('content').length > 3000 ? `${s('content').slice(0, 3000)}\n…` : s('content')}</pre>
        </>
      )}
      {!['run_command', 'edit_file', 'write_file'].includes(call.name) && hasArgs && <pre className="tool-args selectable">{JSON.stringify(a, null, 2)}</pre>}
      {result && (
        <>
          <div className="tool-label">{result.denied ? 'Declined' : result.isError ? 'Error' : 'Result'}</div>
          <ResultText text={result.content} />
        </>
      )}
    </div>
  )
}

interface Props {
  call: ToolCall
  result?: ChatMessage
  /** The run that issued this call is still going. */
  live: boolean
  progress?: ToolProgress
  defaultOpen?: boolean
}

export const ToolCard = memo(function ToolCard({ call, result, live, progress, defaultOpen }: Props) {
  const [open, setOpen] = useState(!!defaultOpen)
  const sum = summarizeTool(call.name, call.arguments)
  const Icon = ICONS[sum.icon]
  const pending = !result && live
  const state = result ? (result.denied ? 'denied' : result.isError ? 'error' : 'ok') : pending ? 'running' : 'stopped'

  return (
    <div className={cx('tool-card', `st-${state}`, open && 'open')}>
      <button type="button" className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="tool-icon">
          <Icon size={15} />
        </span>
        <span className="tool-verb">{pending ? presentTense(sum.verb) : sum.verb}</span>
        {sum.target && <span className="tool-target mono ellipsis">{sum.target}</span>}
        <span className="grow" />
        {state === 'running' && <span className="tool-state running">{progress?.label ?? 'Working…'}</span>}
        {state === 'ok' && <Check size={15} className="tool-ok" />}
        {state === 'error' && <AlertTriangle size={15} className="tool-err" />}
        {state === 'denied' && (
          <span className="tool-state denied">
            <X size={13} /> Declined
          </span>
        )}
        {state === 'stopped' && <span className="tool-state faint">Stopped</span>}
        <ChevronRight size={15} className="tool-chev" />
      </button>
      {state === 'running' && typeof progress?.progress === 'number' && (!progress.stage || progress.stage === 'sampling') && <Progress value={progress.progress} height={3} />}
      {open && <Detail call={call} result={result} />}
    </div>
  )
})
