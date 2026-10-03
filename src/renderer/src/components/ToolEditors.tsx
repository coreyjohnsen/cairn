import { Play } from 'lucide-react'
import { useState } from 'react'
import type { CustomToolConfig, CustomToolImpl, McpServerConfig, ToolPermission, ToolTestResult } from '@shared/types'
import { newId } from '@shared/defaults'
import { invoke } from '@/lib/api'
import { errorText, formatDuration } from '@/lib/format'
import { Button, Field, Modal, Notice, NumberField, Segmented, Select, Switch, TextField } from './ui'

export const PERMISSION_OPTIONS: { value: ToolPermission; label: string }[] = [
  { value: 'auto', label: 'Run automatically' },
  { value: 'ask', label: 'Ask me first' },
  { value: 'deny', label: 'Never allow' }
]

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/

export function blankTool(): CustomToolConfig {
  return {
    id: newId('tool_'),
    name: '',
    description: '',
    enabled: true,
    parameters: JSON.stringify({ type: 'object', properties: { text: { type: 'string', description: 'Input text' } }, required: ['text'] }, null, 2),
    permission: 'ask',
    impl: { type: 'command', file: '', args: ['{{text}}'], timeoutSec: 30 }
  }
}

export function blankMcp(): McpServerConfig {
  return { id: newId('mcp_'), name: '', enabled: true, transport: 'stdio', command: '', args: [], env: {}, url: '', headers: {}, permission: 'ask' }
}

const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean)
const kv = (s: string, sep: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const l of s.split('\n')) {
    const i = l.indexOf(sep)
    if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim()
  }
  return out
}

/* ───────────── custom tool ───────────── */

export function CustomToolEditor({ initial, existing, onSave, onClose }: { initial: CustomToolConfig; existing: string[]; onSave: (t: CustomToolConfig) => void; onClose: () => void }) {
  const [t, setT] = useState(initial)
  const [testArgs, setTestArgs] = useState('{}')
  const [result, setResult] = useState<ToolTestResult | { error: string } | null>(null)
  const [running, setRunning] = useState(false)
  const set = (p: Partial<CustomToolConfig>) => setT((c) => ({ ...c, ...p }))
  const setImpl = (p: Partial<CustomToolImpl>) => setT((c) => ({ ...c, impl: { ...c.impl, ...p } as CustomToolImpl }))

  let schemaError = ''
  try {
    const v = JSON.parse(t.parameters || '{}')
    if (!v || typeof v !== 'object' || Array.isArray(v)) schemaError = 'The schema must be a JSON object.'
  } catch (e) {
    schemaError = `Not valid JSON: ${(e as Error).message}`
  }
  const nameError = !t.name ? '' : !NAME_RE.test(t.name) ? 'Use letters, digits, underscore or dash, starting with a letter.' : existing.includes(t.name) ? 'Another tool already uses this name.' : ''
  const ok = !!t.name && !nameError && !schemaError && !!t.description.trim()

  const switchType = (type: CustomToolImpl['type']) => {
    if (type === t.impl.type) return
    if (type === 'command') setT((c) => ({ ...c, impl: { type: 'command', file: '', args: [], timeoutSec: 30 } }))
    if (type === 'http') setT((c) => ({ ...c, impl: { type: 'http', method: 'GET', url: '', headers: {}, timeoutSec: 30 } }))
    if (type === 'javascript') setT((c) => ({ ...c, impl: { type: 'javascript', code: "// `args` holds the parameters. Return a string or any JSON value.\nreturn 'Hello, ' + (args.text ?? 'world')", timeoutSec: 15 } }))
  }

  const test = async () => {
    setRunning(true)
    setResult(null)
    try {
      const parsed = JSON.parse(testArgs || '{}')
      setResult(await invoke('tools:test', t, parsed))
    } catch (e) {
      setResult({ error: errorText(e) })
    } finally {
      setRunning(false)
    }
  }

  const impl = t.impl
  return (
    <Modal
      open
      onClose={onClose}
      title={initial.name ? `Edit ${initial.name}` : 'New custom tool'}
      width={680}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ok} onClick={() => onSave({ ...t, description: t.description.trim() })}>
            Save tool
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 18, paddingTop: 6 }}>
        <Notice tone="info">Custom tools are things the model can call: run a program, call a web API, or run a small piece of JavaScript. Write {'{{name}}'} where a parameter value belongs.</Notice>
        <div className="grid-2">
          <Field label="Name" hint={nameError || 'How the model refers to it, like get_weather.'}>
            <TextField mono value={t.name} onCommit={(v) => set({ name: v.trim() })} onDraft={(v) => set({ name: v.trim() })} autoFocus />
          </Field>
          <Field label="When to ask me">
            <Select value={t.permission} onChange={(v) => set({ permission: v })} options={PERMISSION_OPTIONS} className="grow" />
          </Field>
        </div>
        <Field label="Description" hint="Tell the model what it does and when to use it. This is what it reads.">
          <TextField multiline rows={2} value={t.description} onCommit={(v) => set({ description: v })} onDraft={(v) => set({ description: v })} />
        </Field>
        <Field label="Parameters" hint={schemaError || 'A JSON Schema describing the arguments.'}>
          <TextField multiline rows={7} mono value={t.parameters} onCommit={(v) => set({ parameters: v })} onDraft={(v) => set({ parameters: v })} />
        </Field>
        <Field label="What it does">
          <Segmented
            value={impl.type}
            onChange={switchType}
            options={[
              { value: 'command', label: 'Run a program' },
              { value: 'http', label: 'Call a web address' },
              { value: 'javascript', label: 'JavaScript' }
            ]}
          />
        </Field>

        {impl.type === 'command' && (
          <>
            <Field label="Program" hint="Full path or a command on your PATH.">
              <TextField mono value={impl.file} onCommit={(v) => setImpl({ file: v.trim() })} placeholder="python" />
            </Field>
            <Field label="Arguments" hint="One per line. The full argument JSON is also sent to the program on standard input.">
              <TextField multiline rows={3} mono value={impl.args.join('\n')} onCommit={(v) => setImpl({ args: lines(v) })} placeholder={'script.py\n{{text}}'} />
            </Field>
            <div className="grid-2">
              <Field label="Working folder" hint="Defaults to the chat's folder.">
                <TextField mono value={impl.cwd ?? ''} onCommit={(v) => setImpl({ cwd: v.trim() || undefined })} />
              </Field>
              <Field label="Time limit">
                <NumberField value={impl.timeoutSec} min={1} max={3600} suffix="s" onCommit={(v) => setImpl({ timeoutSec: v })} />
              </Field>
            </div>
          </>
        )}
        {impl.type === 'http' && (
          <>
            <div className="row">
              <Select value={impl.method} onChange={(v) => setImpl({ method: v })} options={(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((m) => ({ value: m, label: m }))} />
              <TextField className="grow" mono value={impl.url} onCommit={(v) => setImpl({ url: v.trim() })} placeholder="https://api.example.com/items/{{id}}" />
            </div>
            <Field label="Headers" hint="One per line, like “Authorization: Bearer …”.">
              <TextField multiline rows={2} mono value={Object.entries(impl.headers).map(([k, v]) => `${k}: ${v}`).join('\n')} onCommit={(v) => setImpl({ headers: kv(v, ':') })} />
            </Field>
            {impl.method !== 'GET' && (
              <Field label="Body">
                <TextField multiline rows={4} mono value={impl.body ?? ''} onCommit={(v) => setImpl({ body: v })} placeholder='{"query": "{{text}}"}' />
              </Field>
            )}
            <Field label="Time limit">
              <NumberField value={impl.timeoutSec} min={1} max={600} suffix="s" onCommit={(v) => setImpl({ timeoutSec: v })} />
            </Field>
          </>
        )}
        {impl.type === 'javascript' && (
          <>
            <Field label="Code" hint="Runs in an isolated worker. Use args for the parameters and return the result. It may use require() for Node modules.">
              <TextField multiline rows={9} mono value={impl.code} onCommit={(v) => setImpl({ code: v })} />
            </Field>
            <Field label="Time limit">
              <NumberField value={impl.timeoutSec} min={1} max={600} suffix="s" onCommit={(v) => setImpl({ timeoutSec: v })} />
            </Field>
          </>
        )}

        <div className="divider" style={{ margin: '2px 0' }} />
        <Field label="Try it" hint="Runs the tool right now with these arguments. Nothing asks for approval here, so be sure of what it does.">
          <TextField multiline rows={2} mono value={testArgs} onCommit={setTestArgs} onDraft={setTestArgs} />
        </Field>
        <div>
          <Button icon={<Play size={14} />} busy={running} onClick={() => void test()} disabled={!!schemaError}>
            Run test
          </Button>
        </div>
        {result && ('error' in result ? <div className="dl-err selectable">{result.error}</div> : (
          <div className="stack" style={{ gap: 6 }}>
            <div className="faint xs">{result.ok ? 'Succeeded' : 'Failed'} in {formatDuration(result.durationMs)}</div>
            <pre className="tool-out selectable">{result.output || '(no output)'}</pre>
          </div>
        ))}
      </div>
    </Modal>
  )
}

/* ───────────── MCP server ───────────── */

export function McpEditor({ initial, onSave, onClose }: { initial: McpServerConfig; onSave: (m: McpServerConfig) => void; onClose: () => void }) {
  const [m, setM] = useState(initial)
  const set = (p: Partial<McpServerConfig>) => setM((c) => ({ ...c, ...p }))
  const ok = !!m.name.trim() && (m.transport === 'stdio' ? !!m.command.trim() : !!m.url.trim())
  return (
    <Modal
      open
      onClose={onClose}
      title={initial.name ? `Edit ${initial.name}` : 'Add an MCP server'}
      width={620}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ok} onClick={() => onSave({ ...m, name: m.name.trim() })}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 18, paddingTop: 6 }}>
        <Notice tone="info">MCP servers add ready-made tools such as databases, browsers or ticket trackers. Only add servers you trust: they run with your permissions.</Notice>
        <Field label="Name">
          <TextField value={m.name} onCommit={(v) => set({ name: v })} onDraft={(v) => set({ name: v })} autoFocus placeholder="filesystem" />
        </Field>
        <Field label="How it connects">
          <Segmented value={m.transport} onChange={(v) => set({ transport: v })} options={[{ value: 'stdio', label: 'Program on this computer' }, { value: 'http', label: 'Web address' }]} />
        </Field>
        {m.transport === 'stdio' ? (
          <>
            <Field label="Command">
              <TextField mono value={m.command} onCommit={(v) => set({ command: v.trim() })} onDraft={(v) => set({ command: v.trim() })} placeholder="npx" />
            </Field>
            <Field label="Arguments" hint="One per line.">
              <TextField multiline rows={3} mono value={m.args.join('\n')} onCommit={(v) => set({ args: lines(v) })} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/folder'} />
            </Field>
            <Field label="Environment variables" hint="One KEY=value per line.">
              <TextField multiline rows={2} mono value={Object.entries(m.env).map(([k, v]) => `${k}=${v}`).join('\n')} onCommit={(v) => set({ env: kv(v, '=') })} />
            </Field>
            <Field label="Working folder">
              <TextField mono value={m.cwd ?? ''} onCommit={(v) => set({ cwd: v.trim() || undefined })} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Address">
              <TextField mono value={m.url} onCommit={(v) => set({ url: v.trim() })} onDraft={(v) => set({ url: v.trim() })} placeholder="https://example.com/mcp" />
            </Field>
            <Field label="Headers" hint="One per line, like “Authorization: Bearer …”.">
              <TextField multiline rows={2} mono value={Object.entries(m.headers).map(([k, v]) => `${k}: ${v}`).join('\n')} onCommit={(v) => set({ headers: kv(v, ':') })} />
            </Field>
          </>
        )}
        <Field label="When to ask me" hint="Applies to every tool from this server.">
          <Select value={m.permission} onChange={(v) => set({ permission: v })} options={PERMISSION_OPTIONS} className="grow" />
        </Field>
        <Field row label="Enabled">
          <Switch checked={m.enabled} onChange={(v) => set({ enabled: v })} />
        </Field>
      </div>
    </Modal>
  )
}
