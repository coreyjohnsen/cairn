import { AlertTriangle, Copy, RefreshCw, Server } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ServerLogEntry, ServerModelInfo, ServerSettings, ServerStatus } from '@shared/types'
import { defaultServerSettings } from '@shared/defaults'
import { normalizeOrigin, originProblem, serveExamples } from '@shared/serverPrefs'
import { Badge, Button, Card, EmptyState, IconButton, Notice, NumberField, Section, Segmented, Spinner, Switch, TextField } from '@/components/ui'
import { invoke, on, platform } from '@/lib/api'
import { cx, errorText } from '@/lib/format'
import { useApp } from '@/store/app'
import { useLibrary } from '@/store/library'
import { Row } from './shared'

const EMPTY_STATUS: ServerStatus = { state: 'stopped', urls: [], active: 0, total: 0, recent: [] }

function copy(text: string, what: string): void {
  void navigator.clipboard.writeText(text).then(
    () => useApp.getState().toast('info', `${what} copied`),
    () => useApp.getState().toast('error', 'Could not copy. Select the text and copy it by hand.')
  )
}

/** The server's state, kept current while this tab is open. */
function useServerStatus(): ServerStatus {
  const [status, setStatus] = useState<ServerStatus>(EMPTY_STATUS)
  useEffect(() => {
    let alive = true
    void invoke('server:status').then((s) => alive && setStatus(s), () => {})
    const off = on('server:status', (s) => setStatus(s))
    return () => {
      alive = false
      off()
    }
  }, [])
  return status
}

/** Every model that could be shared, with its name and whether it is shared; reloaded when the choice or the files change. */
function useServerModels(sv: ServerSettings): ServerModelInfo[] | null {
  const [models, setModels] = useState<ServerModelInfo[] | null>(null)
  const files = useLibrary((s) => s.gguf.length)
  const imageModels = useApp((s) => s.settings?.image.localModels.length ?? 0)
  const key = JSON.stringify([sv.exposeAll, sv.chatModels, sv.imageModels, files, imageModels])
  useEffect(() => {
    let alive = true
    void invoke('server:models').then((m) => alive && setModels(m), () => alive && setModels([]))
    return () => {
      alive = false
    }
  }, [key])
  return models
}

function StatusLine({ status }: { status: ServerStatus }) {
  if (status.state === 'starting') {
    return (
      <span className="row" style={{ gap: 6 }}>
        <Spinner size={13} /> Starting…
      </span>
    )
  }
  if (status.state === 'running') {
    return (
      <span className="ok-text">
        Running
        {status.active > 0 ? ` · ${status.active} answering now` : ''}
        {status.total > 0 ? ` · ${status.total} request${status.total === 1 ? '' : 's'} so far` : ''}
      </span>
    )
  }
  if (status.state === 'error') return <span className="lora-warn">Could not start</span>
  return <span className="faint">Off</span>
}

function Addresses({ status }: { status: ServerStatus }) {
  if (status.state !== 'running' || status.urls.length === 0) return null
  return (
    <div className="stack" style={{ gap: 6, marginTop: 14 }}>
      <div className="small dim">Give other programs this address (an OpenAI-compatible base URL):</div>
      {status.urls.map((u) => (
        <div key={u} className="serve-url">
          <span className="mono selectable grow ellipsis">{u}</span>
          <IconButton label="Copy address" size="sm" onClick={() => copy(u, 'Address')}>
            <Copy size={14} />
          </IconButton>
        </div>
      ))}
    </div>
  )
}

function AccessCard({ sv, save, status }: { sv: ServerSettings; save: (patch: Partial<ServerSettings>) => void; status: ServerStatus }) {
  const toast = useApp((s) => s.toast)
  const newKey = async () => {
    try {
      await invoke('server:newKey')
      toast('info', 'New key made. Programs using the old key will be refused.')
    } catch (e) {
      toast('error', errorText(e))
    }
  }
  const open = sv.access === 'network'
  return (
    <Card>
      <div className="stack" style={{ gap: 16 }}>
        <div className="stack" style={{ gap: 8 }}>
          <div className="list-title">Who can connect</div>
          <Segmented
            value={sv.access}
            onChange={(access) => save({ access })}
            options={[
              { value: 'local', label: 'This computer only', title: 'Only programs running on this computer' },
              { value: 'network', label: 'Other devices on my network', title: 'Phones, other computers and servers on the same network' }
            ]}
          />
          {open ? (
            <Notice tone="warn">
              <div>
                <b>Anyone on your network who has the key can use your models and your graphics card.</b> The connection is not encrypted, so only turn this on for a network you trust, and allow the port in your firewall if it asks.
              </div>
            </Notice>
          ) : (
            <div className="small dim">Only programs on this computer can connect. Docker containers and virtual machines count as other devices.</div>
          )}
        </div>

        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          <div className="grow">
            <div className="list-title">Port</div>
            <div className="list-sub">The server restarts when this changes.</div>
          </div>
          <NumberField value={sv.port} min={1} max={65535} onCommit={(port) => save({ port })} />
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 12, alignItems: 'center' }}>
            <div className="grow">
              <div className="list-title">Require an API key</div>
              <div className="list-sub">{open ? 'Always on when other devices can connect.' : 'Programs send the key as "Authorization: Bearer …". Turn off only if you trust everything on this computer.'}</div>
            </div>
            <Switch checked={sv.requireKey || open} disabled={open} onChange={(requireKey) => save({ requireKey })} label="Require an API key" />
          </div>
          {(sv.requireKey || open) && (
            <div className="row" style={{ gap: 8 }}>
              <TextField className="grow" mono secret value={sv.apiKey} onCommit={(apiKey) => save({ apiKey })} placeholder="No key yet. It is made when the server is turned on." ariaLabel="API key" />
              <IconButton label="Copy key" disabled={!sv.apiKey} onClick={() => copy(sv.apiKey, 'Key')}>
                <Copy size={15} />
              </IconButton>
              <Button size="sm" icon={<RefreshCw size={14} />} onClick={() => void newKey()}>
                New key
              </Button>
            </div>
          )}
          {status.state === 'running' && !sv.requireKey && !open && <div className="small lora-warn">Anything running on this computer can use your models without a key.</div>}
        </div>
      </div>
    </Card>
  )
}

function OriginsCard({ sv, save }: { sv: ServerSettings; save: (patch: Partial<ServerSettings>) => void }) {
  const [error, setError] = useState<string | null>(null)
  const commit = (text: string) => {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const bad = lines.map((l) => originProblem(l)).find(Boolean)
    setError(bad ?? null)
    if (bad) return
    const unique = [...new Set(lines.map((l) => normalizeOrigin(l)!))]
    save({ allowedOrigins: unique })
  }
  return (
    <Card>
      <div className="stack" style={{ gap: 8 }}>
        <div>
          <div className="list-title">Web pages</div>
          <div className="list-sub">Programs on your computer and servers are never affected. A web page in a browser can only use the server if its address is listed here, one per line. Use * to allow every page.</div>
        </div>
        <TextField multiline rows={3} mono value={sv.allowedOrigins.join('\n')} onCommit={commit} placeholder="https://my-app.example" ariaLabel="Allowed web pages" />
        {error && <div className="xs lora-warn">{error}</div>}
        {sv.allowedOrigins.includes('*') && <div className="xs lora-warn">Every web page you visit can send requests to this server while it is running{sv.requireKey ? ', but they still need the key' : ' and they do not even need a key'}.</div>}
      </div>
    </Card>
  )
}

function ModelsCard({ sv, save, models }: { sv: ServerSettings; save: (patch: Partial<ServerSettings>) => void; models: ServerModelInfo[] | null }) {
  const setView = useApp((s) => s.setView)
  const toggle = (m: ServerModelInfo, value: boolean) => {
    const list = m.type === 'chat' ? sv.chatModels : sv.imageModels
    const next = value ? [...new Set([...list, m.key])] : list.filter((k) => k !== m.key)
    save(m.type === 'chat' ? { chatModels: next } : { imageModels: next })
  }
  const shareAll = (all: boolean) => {
    if (all) return save({ exposeAll: true })
    // Turning it off keeps everything shared until the user unticks something.
    save({ exposeAll: false, chatModels: (models ?? []).filter((m) => m.type === 'chat').map((m) => m.key), imageModels: (models ?? []).filter((m) => m.type === 'image').map((m) => m.key) })
  }
  return (
    <Card pad={false}>
      <div className="row" style={{ gap: 12, padding: '14px 16px', alignItems: 'center' }}>
        <div className="grow">
          <div className="list-title">Models to share</div>
          <div className="list-sub">Chat models run on the llama.cpp engine and image models on the image engine. Only one chat model is loaded at a time; a request for another one waits until the current answers are finished.</div>
        </div>
        <label className="row small" style={{ gap: 8 }}>
          Share all
          <Switch checked={sv.exposeAll} onChange={shareAll} label="Share all models" />
        </label>
      </div>
      {models === null && (
        <div className="list-row dim">
          <Spinner size={14} /> Looking for models…
        </div>
      )}
      {models?.length === 0 && (
        <div style={{ padding: 16 }}>
          <EmptyState title="No models yet">
            <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
              <Button size="sm" onClick={() => setView('models', 'local')}>
                Get a chat model
              </Button>
              <Button size="sm" onClick={() => setView('models', 'image')}>
                Get an image model
              </Button>
            </div>
          </EmptyState>
        </div>
      )}
      {models?.map((m) => (
        <Row
          key={`${m.type}:${m.key}`}
          title={
            <span className="row" style={{ gap: 8 }}>
              <span className="ellipsis">{m.name}</span>
              <Badge tone={m.type === 'chat' ? 'accent' : 'info'}>{m.type === 'chat' ? 'Chat' : 'Images'}</Badge>
              {m.detail && m.available && <span className="faint xs">{m.detail}</span>}
              {!m.available && <Badge tone="warn">Not ready</Badge>}
            </span>
          }
          sub={
            <span className="row" style={{ gap: 6 }}>
              <span className="faint">Name to use:</span>
              <button type="button" className="serve-id mono" title="Copy name" onClick={() => copy(m.id, 'Name')}>
                {m.id}
              </button>
              {!m.available && m.detail && <span className="lora-warn"> {m.detail}</span>}
            </span>
          }
          right={sv.exposeAll ? <span className="faint xs">Shared</span> : <Switch checked={m.exposed} onChange={(value) => toggle(m, value)} label={`Share ${m.name}`} />}
        />
      ))}
    </Card>
  )
}

function ConnectCard({ sv, status, models }: { sv: ServerSettings; status: ServerStatus; models: ServerModelInfo[] | null }) {
  const [tab, setTab] = useState<'curl' | 'powershell' | 'python' | 'images'>(platform() === 'win32' ? 'powershell' : 'curl')
  const shared = (models ?? []).filter((m) => m.exposed)
  const chat = shared.find((m) => m.type === 'chat')?.id ?? 'your-model'
  const image = shared.find((m) => m.type === 'image' && m.available)?.id
  const base = status.urls[0] ?? `http://127.0.0.1:${sv.port}/v1`
  const needsKey = sv.requireKey || sv.access === 'network'
  const text = useCallback(
    (key: string | null) => {
      const ex = serveExamples({ base, key, chat, image })
      return tab === 'curl' ? ex.curl : tab === 'powershell' ? ex.powershell : tab === 'python' ? ex.python : ex.images
    },
    [base, chat, image, tab]
  )
  const shown = useMemo(() => text(needsKey ? 'YOUR_API_KEY' : null), [text, needsKey])
  return (
    <Card>
      <div className="stack" style={{ gap: 10 }}>
        <div className="row-between" style={{ gap: 12 }}>
          <div className="list-title">Try it</div>
          <Segmented
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'curl', label: 'curl', title: 'macOS, Linux and Git Bash. In Windows PowerShell use the PowerShell tab (curl there is a different command).' },
              { value: 'powershell', label: 'PowerShell' },
              { value: 'python', label: 'Python' },
              { value: 'images', label: 'Pictures' }
            ]}
          />
        </div>
        {tab === 'images' && !image && <div className="small dim">Share an image model above to try this one.</div>}
        <pre className="serve-code selectable">{shown}</pre>
        <div className="row" style={{ gap: 8 }}>
          <Button size="sm" icon={<Copy size={14} />} onClick={() => copy(text(needsKey ? sv.apiKey || 'YOUR_API_KEY' : null), 'Example')}>
            Copy example
          </Button>
          {needsKey && <span className="xs faint">The copy has your real key in it.</span>}
        </div>
        <div className="xs faint">
          Works with the OpenAI libraries and any tool that lets you set a base URL and a key: chat completions, completions, image generations and the model list. Pictures made this way also appear in the Image Hub.
        </div>
      </div>
    </Card>
  )
}

function statusTone(code: number): 'ok' | 'warn' | 'danger' {
  return code < 300 ? 'ok' : code < 500 ? 'warn' : 'danger'
}

function LogRow({ e }: { e: ServerLogEntry }) {
  return (
    <div className="serve-log-row">
      <span className="faint xs mono">{new Date(e.at).toLocaleTimeString()}</span>
      <span className="mono ellipsis" title={`${e.method} ${e.path}`}>
        {e.path.replace(/^\/v1/, '')}
      </span>
      <span className="ellipsis dim" title={e.model}>
        {e.model ?? ''}
      </span>
      <span className="faint xs mono">
        {e.ms < 1000 ? `${e.ms} ms` : `${(e.ms / 1000).toFixed(1)} s`}
        {e.tokens !== undefined ? ` · ${e.tokens} tok` : ''}
      </span>
      <Badge tone={statusTone(e.status)}>{e.status}</Badge>
      {e.error && (
        <div className="serve-log-err xs lora-warn selectable">
          <AlertTriangle size={12} /> {e.error}
        </div>
      )}
    </div>
  )
}

function RecentCard({ status }: { status: ServerStatus }) {
  return (
    <Card pad={false}>
      <div className="list-row">
        <div className="grow">
          <div className="list-title">Recent requests</div>
          <div className="list-sub">What was asked for, not the text itself. The prompts are never kept.</div>
        </div>
      </div>
      {status.recent.length === 0 ? (
        <div className="list-row faint small">{status.state === 'running' ? 'Nothing yet. Requests show up here.' : 'Turn the server on to see requests.'}</div>
      ) : (
        <div className="serve-log">
          {status.recent.map((e) => (
            <LogRow key={e.id} e={e} />
          ))}
        </div>
      )}
    </Card>
  )
}

export function Serve() {
  const stored = useApp((s) => s.settings?.server)
  const update = useApp((s) => s.update)
  const sv = stored ?? defaultServerSettings()
  const status = useServerStatus()
  const models = useServerModels(sv)
  const save = (patch: Partial<ServerSettings>) => update((s) => ({ server: { ...s.server, ...patch } }))

  return (
    <div className="stack" style={{ gap: 18 }}>
      <Card>
        <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
          <span className={cx('provider-icon', status.state === 'running' && 'accent')}>
            <Server size={18} />
          </span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="list-title">Share my models with other programs</div>
            <div className="list-sub">
              Turn your chat and image models into an OpenAI-compatible service, so editors, scripts, other apps and other devices can use them. It starts with Cairn and stops when you quit.
            </div>
            <div className="small" style={{ marginTop: 8 }}>
              <StatusLine status={status} />
            </div>
          </div>
          <Switch checked={sv.enabled} onChange={(enabled) => save({ enabled })} label="Share my models" />
        </div>
        {status.state === 'error' && status.error && (
          <div style={{ marginTop: 12 }}>
            <Notice tone="danger">{status.error}</Notice>
          </div>
        )}
        <Addresses status={status} />
      </Card>

      <Section title="Access" subtitle="Choose who may connect and how they prove it.">
        <div className="stack" style={{ gap: 12 }}>
          <AccessCard sv={sv} save={save} status={status} />
          <OriginsCard sv={sv} save={save} />
        </div>
      </Section>

      <Section title="Models">
        <ModelsCard sv={sv} save={save} models={models} />
      </Section>

      <Section title="Connect">
        <ConnectCard sv={sv} status={status} models={models} />
      </Section>

      <Section title="Activity">
        <RecentCard status={status} />
      </Section>
    </div>
  )
}
