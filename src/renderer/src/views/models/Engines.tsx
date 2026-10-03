import { Check, Cpu, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { EngineBackend, EngineId, GpuDevice } from '@shared/types'
import { Badge, Button, Card, Field, Notice, Progress, Section, Select, Spinner, TextField } from '@/components/ui'
import { invoke } from '@/lib/api'
import { errorText, formatBytes } from '@/lib/format'
import { useApp } from '@/store/app'
import { useLibrary } from '@/store/library'
import { PathField, Row } from './shared'

const BACKEND_LABEL: Record<EngineBackend, string> = { cuda: 'CUDA (NVIDIA)', rocm: 'ROCm / HIP (AMD)', vulkan: 'Vulkan (any GPU)', cpu: 'CPU only' }

function vendorLabel(d: GpuDevice): string {
  return { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', apple: 'Apple', unknown: 'GPU' }[d.vendor]
}

function GpuCard() {
  const gpu = useLibrary((s) => s.gpu)
  const refresh = useLibrary((s) => s.refreshGpu)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    await refresh(true)
    setBusy(false)
  }
  return (
    <Card>
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <span className="provider-icon accent">
            <Cpu size={18} />
          </span>
          <div>
            <div className="list-title">Graphics hardware</div>
            {!gpu && (
              <div className="list-sub row">
                <Spinner size={13} /> Looking…
              </div>
            )}
          </div>
        </div>
        <Button size="sm" icon={busy ? <Spinner size={13} /> : <RefreshCw size={14} />} onClick={() => void run()} disabled={busy}>
          Detect again
        </Button>
      </div>
      {gpu && (
        <div className="stack" style={{ marginTop: 14, gap: 10 }}>
          {gpu.devices.length === 0 && <div className="small dim">No dedicated GPU found. Models will run on the CPU.</div>}
          {gpu.devices.map((d, i) => (
            <div key={i} className="gpu-row">
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis">
                  {d.name}
                </div>
                <div className="faint xs">
                  {vendorLabel(d)}
                  {d.vramMB ? ` · ${(d.vramMB / 1024).toFixed(d.vramMB >= 10240 ? 0 : 1)} GB video memory` : ''}
                  {d.driver ? ` · driver ${d.driver}` : ''}
                  {d.cudaVersion ? ` · CUDA ${d.cudaVersion}` : ''}
                </div>
              </div>
            </div>
          ))}
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <Badge tone="accent">Recommended: {BACKEND_LABEL[gpu.recommended]}</Badge>
            <Badge tone={gpu.rocmRuntime ? 'ok' : 'neutral'}>ROCm runtime {gpu.rocmRuntime ? 'found' : 'not found'}</Badge>
            <Badge tone={gpu.vulkanRuntime ? 'ok' : 'neutral'}>Vulkan {gpu.vulkanRuntime ? 'found' : 'not found'}</Badge>
            <Badge>
              {gpu.cpuThreads} threads · {(gpu.totalRamMB / 1024).toFixed(0)} GB RAM
            </Badge>
          </div>
          {gpu.notes.length > 0 && (
            <ul className="notes">
              {gpu.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  )
}

const ENGINE_TEXT: Record<EngineId, { title: string; sub: string; program: string }> = {
  llama: { title: 'llama.cpp', sub: 'Runs chat models (GGUF).', program: 'llama-server' },
  sd: { title: 'stable-diffusion.cpp', sub: 'Draws images from Stable Diffusion, SDXL, FLUX and SD3 weights.', program: 'sd-cli' },
  esrgan: { title: 'Real-ESRGAN upscaler', sub: 'Makes pictures bigger and sharper. Works on any Vulkan graphics card, with models for photos, art and anime.', program: 'realesrgan-ncnn-vulkan' }
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

function EngineCard({ engine }: { engine: EngineId }) {
  const status = useLibrary((s) => s.engines[engine])
  const install = useLibrary((s) => s.install[engine])
  const gpu = useLibrary((s) => s.gpu)
  const cfg = useApp((s) => s.settings!.engines[engine])
  const update = useApp((s) => s.update)
  const toast = useApp((s) => s.toast)
  const [pick, setPick] = useState<EngineBackend | ''>('')
  const refresh = useLibrary((s) => s.refreshEngine)

  const busy = !!install && install.phase !== 'done' && install.phase !== 'error'
  const available = status?.available ?? []
  const chosen: EngineBackend = (pick || status?.recommended || available[0] || 'cpu') as EngineBackend
  const set = (patch: Partial<typeof cfg>) => update((s) => ({ engines: { ...s.engines, [engine]: { ...s.engines[engine], ...patch } } }))

  const act = async (p: Promise<unknown>) => {
    try {
      await p
      await refresh(engine)
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  return (
    <Card>
      <div className="row-between">
        <div>
          <div className="list-title">{ENGINE_TEXT[engine].title}</div>
          <div className="list-sub">{ENGINE_TEXT[engine].sub}</div>
        </div>
        {status?.resolvedBinary ? <Badge tone="ok">Ready</Badge> : <Badge tone="warn">Not installed</Badge>}
      </div>
      {status?.resolvedBinary && <div className="mono xs faint ellipsis selectable" style={{ marginTop: 8 }} title={status.resolvedBinary}>{status.resolvedBinary}</div>}

      <div className="engine-install">
        <Select
          value={chosen}
          onChange={(v) => setPick(v)}
          options={(available.length ? available : (['cpu'] as EngineBackend[])).map((b) => ({ value: b, label: `${BACKEND_LABEL[b]}${status?.recommended === b ? ' (recommended)' : ''}` }))}
          disabled={busy}
        />
        {busy ? (
          <Button onClick={() => void invoke('engines:cancelInstall', engine)}>Cancel</Button>
        ) : (
          <Button variant="primary" onClick={() => void act(invoke('engines:install', engine, chosen))}>
            {status?.builds.length ? 'Install another build' : 'Install'}
          </Button>
        )}
      </div>
      {gpu && chosen === 'rocm' && gpu.platform === 'win32' && <div className="faint xs" style={{ marginTop: 6 }}>If the HIP build will not start on your card, the Vulkan build is a dependable alternative on Windows.</div>}
      {busy && (
        <div style={{ marginTop: 10 }}>
          <div className="xs faint" style={{ marginBottom: 4 }}>
            {install.label}
            {install.total ? ` · ${formatBytes(install.received ?? 0)} of ${formatBytes(install.total)}` : ''}
          </div>
          <Progress value={install.total ? (install.received ?? 0) / install.total : undefined} indeterminate={!install.total} height={4} />
        </div>
      )}
      {install?.phase === 'error' && <div className="dl-err selectable" style={{ marginTop: 10 }}>{install.error}</div>}

      {status && status.builds.length > 0 && (
        <div className="list" style={{ marginTop: 14 }}>
          {status.builds.map((b) => {
            const active = status.activeBuildId === b.id
            return (
              <Row
                key={b.id}
                title={
                  <span className="row" style={{ gap: 8 }}>
                    <span>{b.tag}</span>
                    <Badge>{b.backend.toUpperCase()}</Badge>
                    {active && (
                      <Badge tone="ok">
                        <Check size={11} /> In use
                      </Badge>
                    )}
                  </span>
                }
                sub={`Installed ${new Date(b.installedAt).toLocaleDateString()}`}
                right={
                  <div className="row" style={{ gap: 4 }}>
                    {!active && (
                      <Button size="sm" onClick={() => void act(invoke('engines:activate', engine, b.id))}>
                        Use
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => void act(invoke('engines:uninstall', engine, b.id))}>
                      Remove
                    </Button>
                  </div>
                }
              />
            )
          })}
        </div>
      )}

      <div className="stack" style={{ marginTop: 18, gap: 16 }}>
        <Field row label="Preferred build" hint="Which installed build to run when several are present.">
          <Select
            value={cfg.backendPref}
            onChange={(v) => set({ backendPref: v })}
            options={[{ value: 'auto', label: 'Automatic' }, ...(['cuda', 'rocm', 'vulkan', 'cpu'] as EngineBackend[]).map((b) => ({ value: b, label: BACKEND_LABEL[b] }))]}
          />
        </Field>
        <Field label="Use my own program" hint={`Point to a ${ENGINE_TEXT[engine].program} you built or installed yourself. Leave empty to use the installed build.`}>
          <PathField value={cfg.customPath} onCommit={(v) => set({ customPath: v })} title="Choose the program" />
        </Field>
        <Field label="Environment variables" hint="One KEY=value per line. On Linux with an AMD RDNA2 card such as the RX 6900 XT, ROCm builds often need HSA_OVERRIDE_GFX_VERSION=10.3.0.">
          <TextField
            multiline
            rows={3}
            mono
            value={Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`).join('\n')}
            onCommit={(v) => set({ env: parseEnv(v) })}
            placeholder="HSA_OVERRIDE_GFX_VERSION=10.3.0"
          />
        </Field>
      </div>
    </Card>
  )
}

export function Engines() {
  const gpu = useLibrary((s) => s.gpu)
  return (
    <>
      <Section title="Your hardware" subtitle="Cairn picks the build that suits your graphics card. Engines are downloaded from their official releases the first time you need them.">
        <GpuCard />
        {gpu && gpu.devices.some((d) => d.vendor === 'amd') && (
          <Notice tone="info">
            AMD card detected. On Windows the Vulkan build works with every recent Radeon and is the safest choice; HIP builds can be faster where they run. On Linux, install the ROCm runtime for HIP builds, or use Vulkan.
          </Notice>
        )}
      </Section>
      <Section title="Engines">
        <EngineCard engine="llama" />
        <EngineCard engine="sd" />
        <EngineCard engine="esrgan" />
      </Section>
    </>
  )
}
