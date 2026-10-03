import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CustomToolConfig, McpServerConfig, ToolInfo } from '@shared/types'
import { CustomToolEditor, McpEditor, PERMISSION_OPTIONS, blankMcp, blankTool } from '@/components/ToolEditors'
import { Ridgeline } from '@/components/Ridgeline'
import { Badge, Button, Card, IconButton, Section, Select, Spinner, Switch } from '@/components/ui'
import { invoke } from '@/lib/api'
import { errorText } from '@/lib/format'
import { useApp } from '@/store/app'
import { useLibrary } from '@/store/library'
import { Row } from './models/shared'

const GROUP_ORDER = ['Files', 'Shell', 'Web', 'Images']

function BuiltinTools() {
  const allTools = useLibrary((s) => s.tools)
  const tools = useMemo(() => allTools.filter((t) => t.source === 'builtin'), [allTools])
  const perms = useApp((s) => s.settings!.agent.toolPermissions)
  const update = useApp((s) => s.update)
  const setPerm = (t: ToolInfo, v: ToolInfo['permission']) => {
    const next = { ...perms }
    if (v === t.defaultPermission) delete next[t.name]
    else next[t.name] = v
    update((s) => ({ agent: { ...s.agent, toolPermissions: next } }))
    setTimeout(() => void useLibrary.getState().refreshTools(), 300)
  }
  const groups = [...new Set(tools.map((t) => t.group))].sort((a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99))
  if (tools.length === 0) return <div className="faint small">Loading tools…</div>
  return (
    <>
      {groups.map((g) => (
        <div key={g} className="stack" style={{ gap: 6 }}>
          <div className="menu-heading" style={{ padding: 0 }}>
            {g}
          </div>
          <div className="list">
            {tools
              .filter((t) => t.group === g)
              .map((t) => (
                <Row
                  key={t.name}
                  title={
                    <span className="row" style={{ gap: 8 }}>
                      <span className="mono">{t.name}</span>
                      {!t.available && <Badge tone="warn" title={t.unavailableReason}>Unavailable</Badge>}
                    </span>
                  }
                  sub={t.available ? t.description : (t.unavailableReason ?? t.description)}
                  right={<Select value={t.permission} onChange={(v) => setPerm(t, v)} options={PERMISSION_OPTIONS.map((o) => ({ ...o, label: o.value === t.defaultPermission ? `${o.label} (default)` : o.label }))} />}
                />
              ))}
          </div>
        </div>
      ))}
    </>
  )
}

function CustomTools() {
  const tools = useApp((s) => s.settings!.customTools)
  const update = useApp((s) => s.update)
  const [editing, setEditing] = useState<CustomToolConfig | null>(null)
  const [doomed, setDoomed] = useState<string | null>(null)
  const save = (t: CustomToolConfig) => {
    update((s) => ({ customTools: s.customTools.some((x) => x.id === t.id) ? s.customTools.map((x) => (x.id === t.id ? t : x)) : [...s.customTools, t] }))
    setEditing(null)
    setTimeout(() => void useLibrary.getState().refreshTools(), 300)
  }
  return (
    <Section
      title="Custom tools"
      subtitle="Teach the model new abilities: run a script, call an API, or write a few lines of JavaScript."
      actions={
        <Button icon={<Plus size={16} />} onClick={() => setEditing(blankTool())}>
          New tool
        </Button>
      }
    >
      {tools.length === 0 && <div className="faint small">No custom tools yet.</div>}
      <div className="list">
        {tools.map((t) => (
          <Row
            key={t.id}
            title={
              <span className="row" style={{ gap: 8 }}>
                <span className="mono">{t.name}</span>
                <Badge>{t.impl.type === 'command' ? 'program' : t.impl.type === 'http' ? 'web' : 'javascript'}</Badge>
              </span>
            }
            sub={t.description}
            right={
              <div className="row" style={{ gap: 6 }}>
                <Switch checked={t.enabled} onChange={(v) => save({ ...t, enabled: v })} label={`Enable ${t.name}`} />
                <IconButton label="Edit" size="sm" onClick={() => setEditing(t)}>
                  <Pencil size={15} />
                </IconButton>
                {doomed === t.id ? (
                  <>
                    <Button size="sm" variant="danger" onClick={() => { update((s) => ({ customTools: s.customTools.filter((x) => x.id !== t.id) })); setDoomed(null); setTimeout(() => void useLibrary.getState().refreshTools(), 300) }}>
                      Delete
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDoomed(null)}>
                      Keep
                    </Button>
                  </>
                ) : (
                  <IconButton label="Delete" size="sm" danger onClick={() => setDoomed(t.id)}>
                    <Trash2 size={15} />
                  </IconButton>
                )}
              </div>
            }
          />
        ))}
      </div>
      {editing && <CustomToolEditor initial={editing} existing={tools.filter((x) => x.id !== editing.id).map((x) => x.name)} onSave={save} onClose={() => setEditing(null)} />}
    </Section>
  )
}

function McpServers() {
  const servers = useApp((s) => s.settings!.mcpServers)
  const status = useLibrary((s) => s.mcp)
  const update = useApp((s) => s.update)
  const toast = useApp((s) => s.toast)
  const [editing, setEditing] = useState<McpServerConfig | null>(null)
  const [doomed, setDoomed] = useState<string | null>(null)
  const save = (m: McpServerConfig) => {
    update((s) => ({ mcpServers: s.mcpServers.some((x) => x.id === m.id) ? s.mcpServers.map((x) => (x.id === m.id ? m : x)) : [...s.mcpServers, m] }))
    setEditing(null)
  }
  return (
    <Section
      title="MCP servers"
      subtitle="Connect Model Context Protocol servers to give the model tools made by others."
      actions={
        <Button icon={<Plus size={16} />} onClick={() => setEditing(blankMcp())}>
          Add server
        </Button>
      }
    >
      {servers.length === 0 && <div className="faint small">No servers connected.</div>}
      <div className="stack">
        {servers.map((m) => {
          const st = status.find((x) => x.id === m.id)
          const state = !m.enabled ? 'disabled' : (st?.state ?? 'connecting')
          return (
            <Card key={m.id}>
              <div className="row">
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="list-title">{m.name}</div>
                  <div className="list-sub mono ellipsis">{m.transport === 'stdio' ? `${m.command} ${m.args.join(' ')}` : m.url}</div>
                </div>
                {state === 'connecting' && (
                  <Badge tone="warn">
                    <Spinner size={11} /> Connecting
                  </Badge>
                )}
                {state === 'connected' && <Badge tone="ok">{st?.tools.length ?? 0} tools</Badge>}
                {state === 'error' && <Badge tone="danger">Failed</Badge>}
                {state === 'disabled' && <Badge>Off</Badge>}
                <Select value={m.permission} onChange={(v) => save({ ...m, permission: v })} options={PERMISSION_OPTIONS} />
                <Switch checked={m.enabled} onChange={(v) => save({ ...m, enabled: v })} label={`Enable ${m.name}`} />
                <IconButton label="Reconnect" size="sm" onClick={() => void invoke('mcp:reconnect', m.id).catch((e) => toast('error', errorText(e)))}>
                  <RefreshCw size={15} />
                </IconButton>
                <IconButton label="Edit" size="sm" onClick={() => setEditing(m)}>
                  <Pencil size={15} />
                </IconButton>
                {doomed === m.id ? (
                  <>
                    <Button size="sm" variant="danger" onClick={() => { update((s) => ({ mcpServers: s.mcpServers.filter((x) => x.id !== m.id) })); setDoomed(null) }}>
                      Remove
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDoomed(null)}>
                      Keep
                    </Button>
                  </>
                ) : (
                  <IconButton label="Remove" size="sm" danger onClick={() => setDoomed(m.id)}>
                    <Trash2 size={15} />
                  </IconButton>
                )}
              </div>
              {st?.error && <div className="dl-err selectable" style={{ marginTop: 10 }}>{st.error}</div>}
              {st && st.tools.length > 0 && (
                <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
                  {st.tools.map((t) => (
                    <span key={t.name} className="chip-pill" title={t.description}>
                      {t.name}
                    </span>
                  ))}
                </div>
              )}
            </Card>
          )
        })}
      </div>
      {editing && <McpEditor initial={editing} onSave={save} onClose={() => setEditing(null)} />}
    </Section>
  )
}

export function ToolsView() {
  const ridges = useApp((s) => s.settings?.appearance.ridgelines)
  return (
    <div className="page">
      {ridges && (
        <div className="hero-ridge">
          <Ridgeline seed={9} layers={4} />
        </div>
      )}
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1>Tools</h1>
            <p>What the assistant is allowed to do on your computer. Anything that changes files or runs commands asks first unless you say otherwise.</p>
          </div>
        </div>
        <Section title="Built-in tools" subtitle="Reading, writing and searching files, running commands, browsing the web and making images.">
          <BuiltinTools />
        </Section>
        <CustomTools />
        <McpServers />
      </div>
    </div>
  )
}
