import { Check, ChevronDown, Cloud, Cpu, Plus, Radar, Server, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { DetectedServer, ProviderConfig, ProviderModel } from '@shared/types'
import { PROVIDER_PRESETS, type ProviderPreset, makeProvider } from '@shared/defaults'
import { Badge, Button, Card, Field, IconButton, MenuItem, MenuLabel, Notice, Popover, Section, Spinner, Switch, TextField } from '@/components/ui'
import { invoke } from '@/lib/api'
import { cx, errorText } from '@/lib/format'
import { useApp } from '@/store/app'

function patchProvider(id: string, patch: Partial<ProviderConfig>, refresh = true): void {
  useApp.getState().update((s) => ({ providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
  if (refresh) setTimeout(() => void useApp.getState().refreshModels(true), 500)
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

function ProviderCard({ p, defaultOpen }: { p: ProviderConfig; defaultOpen?: boolean }) {
  const allModels = useApp((s) => s.models)
  const models = useMemo(() => allModels.filter((m) => m.providerId === p.id), [allModels, p.id])
  const [open, setOpen] = useState(!!defaultOpen)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; count: number; error?: string } | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [manual, setManual] = useState('')
  const preset = PROVIDER_PRESETS.find((x) => x.id === p.preset)

  const test = async () => {
    setTesting(true)
    setResult(null)
    try {
      setResult(await invoke('models:test', p.id))
      void useApp.getState().refreshModels(true)
    } catch (e) {
      setResult({ ok: false, count: 0, error: errorText(e) })
    } finally {
      setTesting(false)
    }
  }

  const setCap = (modelId: string, key: 'vision' | 'tools' | 'reasoning', current: boolean) => {
    const prev = p.capOverrides[modelId] ?? {}
    patchProvider(p.id, { capOverrides: { ...p.capOverrides, [modelId]: { ...prev, [key]: !current } } })
  }

  const addManual = () => {
    const id = manual.trim()
    if (!id || p.manualModels.some((m) => m.id === id)) return
    patchProvider(p.id, { manualModels: [...p.manualModels, { id } satisfies ProviderModel] })
    setManual('')
  }

  return (
    <Card className={cx('provider', !p.enabled && 'disabled')}>
      <div className="row">
        <span className="provider-icon">{preset?.local ? <Server size={18} /> : <Cloud size={18} />}</span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="list-title">{p.name}</div>
          <div className="list-sub ellipsis mono">{p.baseUrl}</div>
        </div>
        {result && (
          <Badge tone={result.ok ? 'ok' : 'danger'} title={result.error}>
            {result.ok ? `${result.count} model${result.count === 1 ? '' : 's'}` : 'Failed'}
          </Badge>
        )}
        {!result && models.length > 0 && <Badge>{models.length} model{models.length === 1 ? '' : 's'}</Badge>}
        <Switch checked={p.enabled} onChange={(v) => patchProvider(p.id, { enabled: v })} label={`Enable ${p.name}`} />
        <IconButton label={open ? 'Hide details' : 'Show details'} size="sm" onClick={() => setOpen((o) => !o)}>
          <ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 120ms' }} />
        </IconButton>
      </div>
      {result && !result.ok && <div className="dl-err selectable" style={{ marginTop: 10 }}>{result.error}</div>}
      {open && (
        <div className="stack" style={{ marginTop: 16, gap: 16 }}>
          <Field label="Name">
            <TextField value={p.name} onCommit={(v) => patchProvider(p.id, { name: v || p.name }, false)} />
          </Field>
          <Field label="Address" hint={p.kind === 'anthropic' ? 'Anthropic Messages API' : 'Any server that speaks the OpenAI chat API'}>
            <TextField mono value={p.baseUrl} onCommit={(v) => patchProvider(p.id, { baseUrl: v.trim() })} placeholder="http://127.0.0.1:8080/v1" />
          </Field>
          <Field label="API key" hint={preset && !preset.needsKey ? 'Usually not needed for local servers.' : 'Stored encrypted on this computer.'}>
            <TextField secret mono value={p.apiKey} onCommit={(v) => patchProvider(p.id, { apiKey: v.trim() })} placeholder={preset?.needsKey ? 'sk-…' : 'optional'} />
          </Field>
          <Field label="Extra headers" hint="One per line, like “HTTP-Referer: https://example.com”.">
            <TextField
              multiline
              rows={2}
              mono
              value={Object.entries(p.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}
              onCommit={(v) => patchProvider(p.id, { headers: parseHeaders(v) })}
            />
          </Field>

          <Field label="Models you add by hand" hint="For servers that cannot list their models.">
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {p.manualModels.map((m) => (
                <span key={m.id} className="chip-pill on">
                  {m.id}
                  <button type="button" aria-label={`Remove ${m.id}`} onClick={() => patchProvider(p.id, { manualModels: p.manualModels.filter((x) => x.id !== m.id) })}>
                    ×
                  </button>
                </span>
              ))}
              <div className="row" style={{ gap: 6 }}>
                <TextField className="manual-input" mono value={manual} onCommit={() => undefined} onDraft={setManual} onEnter={addManual} placeholder="model-id" />
                <Button size="sm" icon={<Plus size={14} />} onClick={addManual} disabled={!manual.trim()}>
                  Add
                </Button>
              </div>
            </div>
          </Field>

          {models.length > 0 && (
            <Field label="Model abilities" hint="Cairn guesses what each model can do. Correct it here if it is wrong.">
              <div className="cap-table">
                {models.slice(0, 40).map((m) => (
                  <div key={m.ref} className="cap-row">
                    <span className="grow ellipsis mono small" title={m.id}>
                      {m.name}
                    </span>
                    {(['vision', 'tools', 'reasoning'] as const).map((k) => {
                      const on = k === 'tools' ? m.caps.tools !== false : !!m.caps[k]
                      return (
                        <button key={k} type="button" className={cx('chip-pill', on && 'on')} onClick={() => setCap(m.id, k, on)}>
                          {on && <Check size={11} />} {k}
                        </button>
                      )
                    })}
                  </div>
                ))}
                {models.length > 40 && <div className="faint xs">Showing the first 40 of {models.length}.</div>}
              </div>
            </Field>
          )}

          <div className="row-between">
            <Button size="sm" busy={testing} onClick={() => void test()}>
              Test connection
            </Button>
            {confirm ? (
              <div className="row">
                <span className="small dim">Remove this connection?</span>
                <Button size="sm" variant="danger" onClick={() => useApp.getState().update((s) => ({ providers: s.providers.filter((x) => x.id !== p.id) }))}>
                  Remove
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                  Keep
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setConfirm(true)}>
                Remove
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}

function AddMenu({ onAdd }: { onAdd: (p: ProviderPreset) => void }) {
  const locals = PROVIDER_PRESETS.filter((p) => p.local)
  const cloud = PROVIDER_PRESETS.filter((p) => !p.local)
  return (
    <Popover
      align="end"
      width={290}
      trigger={({ toggle, ref }) => (
        <Button ref={ref} variant="primary" icon={<Plus size={16} />} onClick={toggle}>
          Add connection
        </Button>
      )}
    >
      {(close) => (
        <div>
          <MenuLabel>On this computer or network</MenuLabel>
          {locals.map((p) => (
            <MenuItem key={p.id} icon={<Server size={14} />} onClick={() => { close(); onAdd(p) }}>
              {p.name}
            </MenuItem>
          ))}
          <MenuLabel>Cloud APIs</MenuLabel>
          {cloud.map((p) => (
            <MenuItem key={p.id} icon={<Cloud size={14} />} onClick={() => { close(); onAdd(p) }}>
              {p.name}
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  )
}

export function Connections() {
  const settings = useApp((s) => s.settings)!
  const setView = useApp((s) => s.setView)
  const update = useApp((s) => s.update)
  const [detected, setDetected] = useState<DetectedServer[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [fresh, setFresh] = useState<string | null>(null)

  const add = (preset: ProviderPreset) => {
    const p = makeProvider(preset)
    update((s) => ({ providers: [...s.providers, p] }))
    setFresh(p.id)
  }

  const scan = async () => {
    setScanning(true)
    try {
      setDetected(await invoke('providers:detect'))
    } catch (e) {
      useApp.getState().toast('error', errorText(e))
    } finally {
      setScanning(false)
    }
  }

  const known = new Set(settings.providers.map((p) => p.baseUrl.replace(/\/+$/, '')))
  const found = (detected ?? []).filter((d) => !known.has(d.baseUrl.replace(/\/+$/, '')))
  const local = settings.providers.find((p) => p.kind === 'local')
  const others = settings.providers.filter((p) => p.kind !== 'local')

  return (
    <>
      <Section title="Connections" subtitle="Chat with models from any server or API. Add as many as you like and pick between them in the chat box." actions={<AddMenu onAdd={add} />}>
        <div className="row">
          <Button size="sm" icon={scanning ? <Spinner size={14} /> : <Radar size={14} />} onClick={() => void scan()} disabled={scanning}>
            Look for running servers
          </Button>
          <span className="faint small">Checks Ollama, LM Studio, llama.cpp, KoboldCpp and vLLM on this computer.</span>
        </div>
        {detected && found.length === 0 && <Notice tone="info">No new servers found. Start one, or add it by hand.</Notice>}
        {found.map((d) => {
          const preset = PROVIDER_PRESETS.find((p) => p.id === d.presetId)
          return (
            <Notice
              key={d.baseUrl}
              tone="ok"
              action={
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    const p = { ...makeProvider(preset ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]), name: d.name, baseUrl: d.baseUrl }
                    update((s) => ({ providers: [...s.providers, p] }))
                    setDetected((cur) => (cur ?? []).filter((x) => x.baseUrl !== d.baseUrl))
                    setTimeout(() => void useApp.getState().refreshModels(true), 400)
                  }}
                >
                  Add
                </Button>
              }
            >
              Found <b>{d.name}</b> at <span className="mono">{d.baseUrl}</span> with {d.modelCount} model{d.modelCount === 1 ? '' : 's'}.
            </Notice>
          )
        })}

        {local && (
          <Card className="provider">
            <div className="row">
              <span className="provider-icon accent">
                <Cpu size={18} />
              </span>
              <div className="grow">
                <div className="list-title">{local.name}</div>
                <div className="list-sub">Runs GGUF models on your own GPU or CPU. Nothing leaves this computer.</div>
              </div>
              <Button size="sm" onClick={() => setView('models', 'local')}>
                Manage local models
              </Button>
              <Switch checked={local.enabled} onChange={(v) => patchProvider(local.id, { enabled: v })} label="Enable local models" />
            </div>
          </Card>
        )}
        {others.map((p) => (
          <ProviderCard key={p.id} p={p} defaultOpen={p.id === fresh} />
        ))}
        {others.length === 0 && <div className="faint small">No other connections yet. Add Ollama, LM Studio, OpenAI, Anthropic, OpenRouter or any OpenAI-compatible address.</div>}
      </Section>
    </>
  )
}
