import { AlertTriangle, Check, FolderOpen, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { DownloadItem, DownloadSpec } from '@shared/types'
import { Button, IconButton, Progress, TextField } from '@/components/ui'
import { invoke } from '@/lib/api'
import { baseName, cx, errorText, formatBytes } from '@/lib/format'
import { useApp } from '@/store/app'
import { useLibrary } from '@/store/library'

export async function startDownload(spec: DownloadSpec): Promise<string | null> {
  try {
    const { id } = await invoke('downloads:start', spec)
    useApp.getState().toast('info', `Downloading ${spec.label ?? spec.filename}`)
    return id
  } catch (e) {
    useApp.getState().toast('error', errorText(e))
    return null
  }
}

export function DownloadsList({ subdir }: { subdir?: string }) {
  const all = useLibrary((s) => s.downloads)
  const items = all.filter((d) => !subdir || d.spec.subdir.startsWith(subdir))
  if (!items.length) return null
  const finished = items.some((d) => d.status === 'done' || d.status === 'error' || d.status === 'cancelled')
  const clear = async () => {
    try {
      await invoke('downloads:clear')
      useLibrary.setState({ downloads: await invoke('downloads:list') })
    } catch (e) {
      useApp.getState().toast('error', errorText(e))
    }
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row-between">
        <span className="menu-heading" style={{ padding: 0 }}>
          Downloads
        </span>
        {finished && (
          <Button variant="ghost" size="sm" onClick={() => void clear()}>
            Clear finished
          </Button>
        )}
      </div>
      {items.map((d) => (
        <DownloadRow key={d.id} d={d} />
      ))}
    </div>
  )
}

function DownloadRow({ d }: { d: DownloadItem }) {
  const active = d.status === 'queued' || d.status === 'downloading'
  const pct = d.total > 0 ? d.received / d.total : undefined
  return (
    <div className="dl-row">
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row-between">
          <span className="ellipsis" title={d.dest}>
            {d.spec.label ?? d.spec.filename}
          </span>
          <span className="faint xs mono">
            {d.status === 'done' && (
              <span className="ok-text">
                <Check size={12} /> {formatBytes(d.total || d.received)}
              </span>
            )}
            {d.status === 'queued' && 'Waiting'}
            {d.status === 'cancelled' && 'Cancelled'}
            {d.status === 'downloading' && `${formatBytes(d.received)}${d.total ? ` / ${formatBytes(d.total)}` : ''}${d.speedBps ? ` · ${formatBytes(d.speedBps)}/s` : ''}`}
          </span>
        </div>
        {d.status === 'downloading' && <Progress value={pct} indeterminate={pct === undefined} height={4} />}
        {d.status === 'error' && (
          <div className="dl-err selectable">
            <AlertTriangle size={13} /> {d.error}
          </div>
        )}
      </div>
      {active && (
        <IconButton label="Cancel" size="sm" onClick={() => void invoke('downloads:cancel', d.id)}>
          <X size={15} />
        </IconButton>
      )}
    </div>
  )
}

/** Path text box with a Browse button. */
export function PathField({ value, onCommit, kind = 'file', title, extensions, placeholder, startIn }: { value: string; onCommit: (v: string) => void; kind?: 'file' | 'folder'; title?: string; extensions?: string[]; placeholder?: string; startIn?: string }) {
  const browse = async () => {
    try {
      const p = kind === 'folder' ? await invoke('system:selectFolder', title) : await invoke('system:selectFile', title, extensions, startIn)
      if (p) onCommit(p)
    } catch (e) {
      useApp.getState().toast('error', errorText(e))
    }
  }
  return (
    <div className="row">
      <TextField className="grow" mono value={value} onCommit={onCommit} placeholder={placeholder} />
      <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => void browse()}>
        Browse
      </Button>
    </div>
  )
}

export function Row({ title, children, sub, right, className }: { title: ReactNode; sub?: ReactNode; children?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cx('list-row', className)}>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="list-title">{title}</div>
        {sub && <div className="list-sub">{sub}</div>}
        {children}
      </div>
      {right && <div className="list-right">{right}</div>}
    </div>
  )
}

export function archGuess(name: string): 'sd' | 'sdxl' | 'flux' | 'sd3' | 'zimage' {
  const n = name.toLowerCase()
  if (n.includes('flux')) return 'flux'
  if (/z[-_ ]?image/.test(n)) return 'zimage'
  if (n.includes('sd3') || n.includes('sd_3')) return 'sd3'
  if (n.includes('xl') || n.includes('pony') || n.includes('illustrious')) return 'sdxl'
  return 'sd'
}

export const fileLabel = (p: string): string => baseName(p).replace(/\.(gguf|safetensors|ckpt|pt|bin)$/i, '')
