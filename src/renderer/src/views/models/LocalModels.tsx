import { Cpu, Eye, FolderOpen, Pencil, Play, Square, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { LocalModelFile } from '@shared/types'
import { Badge, Button, Card, Field, IconButton, Notice, NumberField, Progress, Section, Segmented, Select, Spinner, Switch, TextField } from '@/components/ui'
import { invoke } from '@/lib/api'
import { baseName, errorText, formatBytes } from '@/lib/format'
import { useApp } from '@/store/app'
import { useLibrary } from '@/store/library'
import { HfBrowser } from './HfBrowser'
import { MemoryPlanner, PlannedBadge } from './MemoryPlanner'
import { DownloadsList, Row } from './shared'

function EngineBanner() {
  const status = useLibrary((s) => s.engines.llama)
  const install = useLibrary((s) => s.install.llama)
  const setView = useApp((s) => s.setView)
  const toast = useApp((s) => s.toast)
  const busy = install && install.phase !== 'done' && install.phase !== 'error'

  if (status?.resolvedBinary) return null
  const run = async () => {
    if (!status) return
    try {
      await invoke('engines:install', 'llama', status.recommended)
    } catch (e) {
      toast('error', errorText(e))
    }
  }
  return (
    <Notice
      tone="warn"
      action={
        busy ? undefined : (
          <div className="row">
            <Button size="sm" variant="primary" onClick={() => void run()} disabled={!status}>
              Install {status ? `(${status.recommended.toUpperCase()})` : ''}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setView('models', 'engines')}>
              Choose build
            </Button>
          </div>
        )
      }
    >
      <div>
        <b>The local model engine is not installed yet.</b> Cairn downloads llama.cpp for your GPU the first time. It is a small download.
        {busy && (
          <div style={{ marginTop: 8 }}>
            <div className="xs faint" style={{ marginBottom: 4 }}>
              {install.label}
            </div>
            <Progress value={install.total ? (install.received ?? 0) / install.total : undefined} indeterminate={!install.total} height={4} />
          </div>
        )}
        {install?.phase === 'error' && <div className="dl-err selectable">{install.error}</div>}
      </div>
    </Notice>
  )
}

function ServerCard() {
  const llama = useLibrary((s) => s.llama)
  const gguf = useLibrary((s) => s.gguf)
  const [log, setLog] = useState(false)
  const toast = useApp((s) => s.toast)
  const loadedFile = llama.modelPath ? gguf.find((g) => g.path === llama.modelPath) : undefined
  const name = llama.modelPath ? (loadedFile?.label ?? loadedFile?.name ?? baseName(llama.modelPath)) : ''
  const tone = llama.state === 'running' ? 'ok' : llama.state === 'error' ? 'danger' : llama.state === 'starting' ? 'warn' : 'neutral'
  const label = { stopped: 'Not running', starting: 'Loading…', running: 'Running', error: 'Failed' }[llama.state]
  return (
    <Card>
      <div className="row">
        <span className="provider-icon accent">
          <Cpu size={18} />
        </span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="list-title">{name || 'No model loaded'}</div>
          <div className="list-sub">Models load when you chat with them, or press Load below. Only one runs at a time.</div>
        </div>
        <Badge tone={tone}>{label}</Badge>
        {(llama.state === 'running' || llama.state === 'starting') && (
          <Button size="sm" icon={<Square size={13} />} onClick={() => void invoke('llama:stop').catch((e) => toast('error', errorText(e)))}>
            Unload
          </Button>
        )}
      </div>
      {llama.error && <div className="dl-err selectable" style={{ marginTop: 10 }}>{llama.error}</div>}
      {llama.state === 'error' && /out of memory|failed to allocate|cudamalloc|outofdevicememory|insufficient memory|not enough memory|unable to allocate|std::bad_alloc|alloc.*failed/i.test(`${llama.error ?? ''}\n${llama.log.slice(-30).join('\n')}`) && (
        <div style={{ marginTop: 10 }}>
          <Notice
            tone="warn"
            action={
              <Button size="sm" onClick={() => document.querySelector('.mp')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                Open the memory planner
              </Button>
            }
          >
            The model probably did not fit in memory. The memory planner below shows what fits and can set the model up to use RAM as well.
          </Notice>
        </div>
      )}
      {llama.log.length > 0 && (
        <>
          <button type="button" className="link-btn" style={{ marginTop: 10 }} onClick={() => setLog((l) => !l)}>
            {log ? 'Hide engine log' : 'Show engine log'}
          </button>
          {log && <pre className="tool-out selectable" style={{ marginTop: 8 }}>{llama.log.slice(-40).join('\n')}</pre>}
        </>
      )}
    </Card>
  )
}

/** Inline editor for the name a model is listed under. An empty name goes back to the file name. */
function NameEditor({ file, onSave, onCancel }: { file: LocalModelFile; onSave: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(file.label ?? file.name)
  return (
    <form
      className="row"
      style={{ gap: 6, flexWrap: 'wrap' }}
      onSubmit={(e) => {
        e.preventDefault()
        onSave(value)
      }}
    >
      <div className="field-wrap" style={{ width: 300, maxWidth: '100%' }}>
        <input
          className="field-input"
          autoFocus
          value={value}
          maxLength={120}
          spellCheck={false}
          aria-label="Model name"
          placeholder={file.name}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel()
          }}
        />
      </div>
      <Button size="sm" variant="primary" type="submit">
        Save
      </Button>
      <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  )
}

function Library() {
  const gguf = useLibrary((s) => s.gguf)
  const llama = useLibrary((s) => s.llama)
  const refreshFiles = useLibrary((s) => s.refreshFiles)
  const toast = useApp((s) => s.toast)
  const [doomed, setDoomed] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)

  const rename = async (path: string, name: string) => {
    try {
      await invoke('library:setName', path, name)
      await refreshFiles()
      void useApp.getState().refreshModels(true)
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setRenaming(null)
    }
  }

  const load = async (path: string) => {
    setLoading(path)
    try {
      await invoke('llama:start', path)
      void useApp.getState().refreshModels(true)
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setLoading(null)
    }
  }

  const del = async (path: string) => {
    try {
      await invoke('library:delete', path)
      await refreshFiles()
      void useApp.getState().refreshModels(true)
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setDoomed(null)
    }
  }

  if (!gguf.length) return <div className="faint small">No models on this computer yet. Search below, or drop .gguf files into your models folder.</div>
  return (
    <div className="list">
      {gguf.map((m) => {
        const loaded = llama.modelPath === m.path && (llama.state === 'running' || llama.state === 'starting')
        return (
          <Row
            key={m.path}
            title={
              renaming === m.path ? (
                <NameEditor file={m} onSave={(name) => void rename(m.path, name)} onCancel={() => setRenaming(null)} />
              ) : (
              <span className="row" style={{ gap: 8 }}>
                <span className="ellipsis">{m.label ?? m.name}</span>
                {m.quant && <Badge>{m.quant}</Badge>}
                <PlannedBadge path={m.path} />
                {m.mmprojPath && (
                  <Badge tone="info" title="Has a vision projector next to it">
                    <Eye size={11} /> vision
                  </Badge>
                )}
              </span>
              )
            }
            sub={`${m.label ? `${m.name}.gguf · ` : ''}${formatBytes(m.sizeBytes)} · ${m.root}`}
            right={
              <div className="row" style={{ gap: 4 }}>
                {loaded ? (
                  <Badge tone="ok">Loaded</Badge>
                ) : (
                  <Button size="sm" icon={loading === m.path ? <Spinner size={13} /> : <Play size={13} />} disabled={loading !== null} onClick={() => void load(m.path)}>
                    Load
                  </Button>
                )}
                <IconButton label="Rename" size="sm" onClick={() => setRenaming(m.path)}>
                  <Pencil size={15} />
                </IconButton>
                <IconButton label="Show in folder" size="sm" onClick={() => void invoke('system:showItem', m.path)}>
                  <FolderOpen size={15} />
                </IconButton>
                {doomed === m.path ? (
                  <>
                    <Button size="sm" variant="danger" onClick={() => void del(m.path)}>
                      Delete file
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDoomed(null)}>
                      Keep
                    </Button>
                  </>
                ) : (
                  <IconButton label="Delete" size="sm" danger onClick={() => setDoomed(m.path)}>
                    <Trash2 size={15} />
                  </IconButton>
                )}
              </div>
            }
          />
        )
      })}
    </div>
  )
}

function Runtime() {
  const local = useApp((s) => s.settings!.local)
  const update = useApp((s) => s.update)
  const set = (patch: Partial<typeof local>) => update((s) => ({ local: { ...s.local, ...patch } }))
  return (
    <div className="stack" style={{ gap: 18 }}>
      <Field row label="Context size" hint="How much text the model can hold in mind. Bigger uses more memory. For tools and file editing, 16,384 or more works much better: files the model reads have to fit.">
        <Select
          value={local.contextSize}
          onChange={(v) => set({ contextSize: v })}
          options={[2048, 4096, 8192, 16384, 32768, 65536, 131072].map((n) => ({ value: n, label: `${n.toLocaleString()} tokens` }))}
        />
      </Field>
      <Field row label="GPU layers" hint="-1 puts every layer on the GPU. Lower it if the model does not fit in video memory; 0 uses the CPU only.">
        <NumberField value={local.gpuLayers} min={-1} max={999} onCommit={(v) => set({ gpuLayers: v })} />
      </Field>
      <Field row label="Flash attention" hint="Faster and lighter on memory for most models.">
        <Segmented value={local.flashAttn} onChange={(v) => set({ flashAttn: v })} options={[{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
      </Field>
      <Field row label="Memory precision" hint="How the model's working memory is stored. 8-bit takes about half the video memory of full precision with almost no loss, so a context twice as long fits: on a 16 GB card, 16,384 becomes 32,768. Needs flash attention (not Off).">
        <Select
          value={local.kvCache ?? 'f16'}
          onChange={(v) => set({ kvCache: v })}
          options={[
            { value: 'f16', label: 'Full (16-bit)' },
            { value: 'q8_0', label: '8-bit: half the memory' },
            { value: 'q4_0', label: '4-bit: a quarter, some loss' }
          ]}
        />
      </Field>
      <Field row label="Experts kept in RAM" hint="For mixture-of-experts models (names like 30B-A3B): keep the experts of this many of the first layers in RAM instead of video memory, so a bigger model fits. 0 keeps them on the GPU. The memory planner above sets this per model.">
        <NumberField value={local.nCpuMoe ?? 0} min={0} max={999} onCommit={(v) => set({ nCpuMoe: v })} />
      </Field>
      <Field row label="Working memory in RAM" hint="Keep the model's working memory (the KV cache) in RAM instead of video memory. Lets a much longer context fit, but every word reads it over slower memory.">
        <Switch checked={!!local.kvInRam} onChange={(v) => set({ kvInRam: v })} />
      </Field>
      <Field row label="CPU threads" hint="0 lets the engine decide.">
        <NumberField value={local.threads} min={0} max={256} onCommit={(v) => set({ threads: v })} />
      </Field>
      <Field row label="Unload when idle" hint="Frees video memory after this many idle minutes. 0 keeps it loaded.">
        <NumberField value={local.idleUnloadMinutes} min={0} max={1440} suffix="min" onCommit={(v) => set({ idleUnloadMinutes: v })} />
      </Field>
      <Field row label="Port" hint="0 picks a free one automatically.">
        <NumberField value={local.port} min={0} max={65535} onCommit={(v) => set({ port: v })} />
      </Field>
      <Field label="Extra engine arguments" hint="Passed straight to llama-server, for example --no-mmap or --cache-type-k q8_0.">
        <TextField mono value={local.extraArgs} onCommit={(v) => set({ extraArgs: v })} placeholder="--no-mmap" />
      </Field>
    </div>
  )
}

export function LocalModels() {
  const [showRuntime, setShowRuntime] = useState(false)
  return (
    <>
      <EngineBanner />
      <Section title="Running now">
        <ServerCard />
      </Section>
      <Section title="On this computer" subtitle="GGUF models found in your models folder. Add more by downloading below or copying files in.">
        <Library />
        <DownloadsList subdir="llm" />
      </Section>
      <Section title="Memory planner" subtitle="See what fits in video memory and what has to go to RAM, then set a model up to use both. Bigger models and longer contexts are possible; the cost is speed.">
        <MemoryPlanner />
      </Section>
      <Section title="Get a model" subtitle="Search Hugging Face, or paste a link or an owner/name. Pick a quantisation that fits your video memory: Q4_K_M is a good start.">
        <HfBrowser
          kind="llm"
          subdir="llm"
          accept={(p) => /\.gguf$/i.test(p)}
          placeholder="Search GGUF models, or paste owner/name"
          suggestions={['Qwen3', 'Llama 3.2', 'Gemma 3', 'Mistral', 'DeepSeek R1 distill', 'Phi-4']}
        />
      </Section>
      <Section title="Runtime" subtitle="How the built-in engine runs models." actions={<Button variant="ghost" size="sm" onClick={() => setShowRuntime((s) => !s)}>{showRuntime ? 'Hide' : 'Show'}</Button>}>
        {showRuntime && (
          <Card>
            <Runtime />
          </Card>
        )}
      </Section>
    </>
  )
}

