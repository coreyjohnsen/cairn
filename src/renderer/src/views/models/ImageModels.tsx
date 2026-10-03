import { ChevronDown, Download, FolderOpen, ImagePlus, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { guessImageFolder } from '@shared/naming'
import type { ImageBackendConfig, LoraFile, SdArch, SdModelConfig } from '@shared/types'
import { IMAGE_BACKEND_PRESETS, SD_SAMPLERS, STARTER_PACKS, type StarterPack, blankSdModel, newId } from '@shared/defaults'
import { Badge, Button, Card, Field, IconButton, MenuItem, Modal, Notice, NumberField, Popover, Progress, Section, Segmented, Select, Switch, TextField } from '@/components/ui'
import { invoke } from '@/lib/api'
import { baseName, errorText, formatBytes } from '@/lib/format'
import { useApp } from '@/store/app'
import { targetKeyOf, useImages } from '@/store/images'
import { useLibrary } from '@/store/library'
import { CivitaiBrowser, HfBrowser } from './HfBrowser'
import { DownloadsList, PathField, Row, archGuess, fileLabel, startDownload } from './shared'

const ARCH_LABEL: Record<SdArch, string> = { sd: 'Stable Diffusion 1.x / 2.x', sdxl: 'SDXL', flux: 'FLUX', sd3: 'Stable Diffusion 3', zimage: 'Z-Image', custom: 'Custom' }
type PathKey = 'model' | 'diffusionModel' | 'vae' | 'clipL' | 'clipG' | 't5xxl' | 'llm'
const PATH_FIELDS: Record<SdArch, PathKey[]> = {
  sd: ['model', 'vae'],
  sdxl: ['model', 'vae'],
  flux: ['diffusionModel', 'vae', 'clipL', 't5xxl', 'model'],
  sd3: ['model', 'diffusionModel', 'clipL', 'clipG', 't5xxl', 'vae'],
  zimage: ['diffusionModel', 'llm', 'vae'],
  custom: ['model', 'diffusionModel', 'vae', 'clipL', 'clipG', 't5xxl', 'llm']
}
const PATH_LABEL: Record<PathKey, { label: string; hint?: string }> = {
  model: { label: 'Checkpoint', hint: 'A single .safetensors, .ckpt or .gguf file.' },
  diffusionModel: { label: 'Diffusion model', hint: 'The main weights when they come as a separate file (FLUX, SD3, Z-Image).' },
  vae: { label: 'VAE', hint: 'Optional for most checkpoints, required for FLUX and Z-Image.' },
  clipL: { label: 'CLIP-L text encoder' },
  clipG: { label: 'CLIP-G text encoder' },
  t5xxl: { label: 'T5-XXL text encoder' },
  llm: { label: 'Language-model text encoder', hint: 'Z-Image uses Qwen3-4B here (a .gguf or .safetensors file).' }
}

/** Where each file dialog opens, under the models folder. */
const START_IN: Record<PathKey, string> = {
  model: 'image',
  diffusionModel: 'image',
  vae: 'image/vae',
  clipL: 'image/text-encoders',
  clipG: 'image/text-encoders',
  t5xxl: 'image/text-encoders',
  llm: 'image/text-encoders'
}

function saveModel(m: SdModelConfig): void {
  useApp.getState().update((s) => {
    const exists = s.image.localModels.some((x) => x.id === m.id)
    return { image: { ...s.image, localModels: exists ? s.image.localModels.map((x) => (x.id === m.id ? m : x)) : [...s.image.localModels, m] } }
  })
  setTimeout(() => void useImages.getState().refreshTargets(true), 400)
}

function SdModelEditor({ initial, onClose }: { initial: SdModelConfig; onClose: () => void }) {
  const [m, setM] = useState(initial)
  const set = (patch: Partial<SdModelConfig>) => setM((cur) => ({ ...cur, ...patch }))
  const fields = PATH_FIELDS[m.arch]
  const hasWeights = !!(m.model || m.diffusionModel)
  const changeArch = (arch: SdArch) => {
    const b = blankSdModel(arch)
    set({ arch, steps: b.steps, cfg: b.cfg, sampler: b.sampler, width: b.width, height: b.height, vaeTiling: b.vaeTiling, clipOnCpu: b.clipOnCpu })
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Image model"
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!m.name.trim() || !hasWeights}
            onClick={() => {
              saveModel({ ...m, name: m.name.trim() })
              onClose()
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 18, paddingTop: 6 }}>
        <Field label="Name">
          <TextField value={m.name} onCommit={(v) => set({ name: v })} onDraft={(v) => set({ name: v })} autoFocus />
        </Field>
        <Field label="Type" hint="Decides which files are needed and sensible starting settings.">
          <Select className="grow" value={m.arch} onChange={changeArch} options={(Object.keys(ARCH_LABEL) as SdArch[]).map((a) => ({ value: a, label: ARCH_LABEL[a] }))} />
        </Field>
        {fields.map((k) => (
          <Field key={k} label={PATH_LABEL[k].label} hint={PATH_LABEL[k].hint}>
            <PathField value={m[k] ?? ''} onCommit={(v) => set({ [k]: v })} title={`Choose ${PATH_LABEL[k].label}`} extensions={['safetensors', 'gguf', 'ckpt', 'pt', 'bin']} startIn={START_IN[k]} />
          </Field>
        ))}
        {!hasWeights && <Notice tone="warn">Choose at least the {m.arch === 'flux' || m.arch === 'zimage' ? 'diffusion model' : 'checkpoint'} file.</Notice>}
        <div className="divider" style={{ margin: '2px 0' }} />
        <div className="grid-2">
          <Field label="Steps">
            <NumberField value={m.steps} min={1} max={150} onCommit={(v) => set({ steps: v })} />
          </Field>
          <Field label="Guidance">
            <NumberField value={m.cfg} min={0} max={30} step={0.5} float onCommit={(v) => set({ cfg: v })} />
          </Field>
          <Field label="Width">
            <NumberField value={m.width} min={64} max={2048} step={64} onCommit={(v) => set({ width: v })} />
          </Field>
          <Field label="Height">
            <NumberField value={m.height} min={64} max={2048} step={64} onCommit={(v) => set({ height: v })} />
          </Field>
        </div>
        <Field label="Sampler">
          <Select value={m.sampler} onChange={(v) => set({ sampler: v })} options={SD_SAMPLERS.map((s) => ({ value: s, label: s }))} />
        </Field>
        <Field row label="Tile the VAE" hint="Saves video memory when decoding large images.">
          <Switch checked={m.vaeTiling} onChange={(v) => set({ vaeTiling: v })} />
        </Field>
        <Field row label="Keep weights in system memory" hint="Slower, but fits bigger models in less video memory.">
          <Switch checked={m.offloadToCpu} onChange={(v) => set({ offloadToCpu: v })} />
        </Field>
        <Field row label="Run text encoders on the CPU" hint="Frees video memory for FLUX, SD3 and Z-Image.">
          <Switch checked={m.clipOnCpu} onChange={(v) => set({ clipOnCpu: v })} />
        </Field>
        <Field row label="Flash attention">
          <Switch checked={m.flashAttn} onChange={(v) => set({ flashAttn: v })} />
        </Field>
        <Field label="Extra arguments" hint="Passed to sd-cli as written.">
          <TextField mono value={m.extraArgs} onCommit={(v) => set({ extraArgs: v })} placeholder="--diffusion-fa" />
        </Field>
      </div>
    </Modal>
  )
}

function EngineBanner() {
  const status = useLibrary((s) => s.engines.sd)
  const install = useLibrary((s) => s.install.sd)
  const setView = useApp((s) => s.setView)
  const toast = useApp((s) => s.toast)
  const busy = install && install.phase !== 'done' && install.phase !== 'error'
  if (status?.resolvedBinary) return null
  return (
    <Notice
      tone="warn"
      action={
        busy ? undefined : (
          <div className="row">
            <Button
              size="sm"
              variant="primary"
              disabled={!status}
              onClick={() => status && void invoke('engines:install', 'sd', status.recommended).catch((e) => toast('error', errorText(e)))}
            >
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
        <b>The built-in image engine is not installed yet.</b> Cairn downloads stable-diffusion.cpp for your GPU. Skip this if you use ComfyUI, AUTOMATIC1111 or an API instead.
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

function StarterCard({ pack }: { pack: StarterPack }) {
  const models = useApp((s) => s.settings!.image.localModels)
  const downloads = useLibrary((s) => s.downloads)
  const update = useApp((s) => s.update)
  const [busy, setBusy] = useState(false)
  const added = models.some((m) => m.name === pack.title)
  const active = downloads.some((d) => pack.files.some((f) => f.filename === d.spec.filename) && (d.status === 'downloading' || d.status === 'queued'))

  const add = async () => {
    setBusy(true)
    try {
      const ids: (string | null)[] = []
      for (const f of pack.files) ids.push(await startDownload({ url: f.url, subdir: f.subdir, filename: f.filename, source: 'hf', label: `${pack.title} · ${f.filename}` }))
      if (ids.some((i) => !i)) return
      const list = await invoke('downloads:list')
      const m: SdModelConfig = { ...blankSdModel(pack.arch), ...pack.defaults, name: pack.title }
      pack.files.forEach((f, i) => {
        const dest = list.find((d) => d.id === ids[i])?.dest
        if (dest) Object.assign(m, { [f.role]: dest })
      })
      update((s) => ({ image: { ...s.image, localModels: [...s.image.localModels.filter((x) => x.name !== pack.title), m] } }))
      setTimeout(() => void useImages.getState().refreshTargets(true), 600)
    } catch (e) {
      useApp.getState().toast('error', errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="starter">
      <div className="row-between">
        <div className="list-title">{pack.title}</div>
        <Badge>{pack.vramHint}</Badge>
      </div>
      <p className="small dim" style={{ margin: '6px 0 10px' }}>
        {pack.blurb}
      </p>
      <div className="faint xs" style={{ marginBottom: 12 }}>
        {pack.files.map((f) => `${f.filename} (${f.sizeHint})`).join(' · ')}
      </div>
      <Button size="sm" variant={added ? 'secondary' : 'primary'} icon={<ImagePlus size={14} />} busy={busy || active} onClick={() => void add()}>
        {added ? 'Download again' : 'Download and add'}
      </Button>
    </Card>
  )
}

function BackendCard({ b }: { b: ImageBackendConfig }) {
  const [open, setOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [res, setRes] = useState<{ ok: boolean; message: string } | null>(null)
  const [confirm, setConfirm] = useState(false)
  const patch = (p: Partial<ImageBackendConfig>) => {
    useApp.getState().update((s) => ({ image: { ...s.image, backends: s.image.backends.map((x) => (x.id === b.id ? { ...x, ...p } : x)) } }))
    setTimeout(() => void useImages.getState().refreshTargets(true), 500)
  }
  const test = async () => {
    setTesting(true)
    try {
      setRes(await invoke('images:testBackend', b.id))
    } catch (e) {
      setRes({ ok: false, message: errorText(e) })
    } finally {
      setTesting(false)
    }
  }
  return (
    <Card>
      <div className="row">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="list-title">{b.name}</div>
          <div className="list-sub mono ellipsis">{b.baseUrl}</div>
        </div>
        {res && <Badge tone={res.ok ? 'ok' : 'danger'}>{res.ok ? 'Connected' : 'Failed'}</Badge>}
        <Switch checked={b.enabled} onChange={(v) => patch({ enabled: v })} label={`Enable ${b.name}`} />
        <IconButton label={open ? 'Hide details' : 'Show details'} size="sm" onClick={() => setOpen((o) => !o)}>
          <ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 120ms' }} />
        </IconButton>
      </div>
      {res && <div className={res.ok ? 'small dim selectable' : 'dl-err selectable'} style={{ marginTop: 8 }}>{res.message}</div>}
      {open && (
        <div className="stack" style={{ marginTop: 16, gap: 16 }}>
          <Field label="Name">
            <TextField value={b.name} onCommit={(v) => patch({ name: v || b.name })} />
          </Field>
          <Field label="Address">
            <TextField mono value={b.baseUrl} onCommit={(v) => patch({ baseUrl: v.trim() })} />
          </Field>
          {(b.kind === 'openai' || b.apiKey) && (
            <Field label="API key">
              <TextField secret mono value={b.apiKey} onCommit={(v) => patch({ apiKey: v.trim() })} />
            </Field>
          )}
          <Field label={b.kind === 'openai' ? 'Model' : 'Default checkpoint'} hint={b.kind === 'openai' ? 'For example gpt-image-1 or dall-e-3.' : 'The checkpoint used when the server has several. Leave empty to pick from the list.'}>
            <TextField mono value={b.defaultModel} onCommit={(v) => patch({ defaultModel: v.trim() })} />
          </Field>
          {b.kind === 'comfyui' && (
            <Field label="Custom workflow" hint="Paste a workflow exported with “Save (API Format)”. Use {{prompt}}, {{negative}}, {{seed}}, {{steps}}, {{cfg}}, {{sampler}}, {{width}}, {{height}}, {{count}} and {{model}} where values belong. Empty uses a standard text-to-image workflow.">
              <TextField multiline rows={7} mono value={b.comfyWorkflow} onCommit={(v) => patch({ comfyWorkflow: v })} placeholder='{ "3": { "class_type": "KSampler", … } }' />
            </Field>
          )}
          <div className="row-between">
            <Button size="sm" busy={testing} onClick={() => void test()}>
              Test connection
            </Button>
            {confirm ? (
              <div className="row">
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    useApp.getState().update((s) => ({ image: { ...s.image, backends: s.image.backends.filter((x) => x.id !== b.id) } }))
                    setTimeout(() => void useImages.getState().refreshTargets(true), 500)
                  }}
                >
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


/** The upscaler stable-diffusion.cpp documents support for. */
const SD_CPP_UPSCALER = /x4plus[_-]?anime[_-]?6b/i
const ESRGAN_URL = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth'

const BASE_LABEL: Record<NonNullable<LoraFile['base']>, string> = { sd: 'SD 1.x', sdxl: 'SDXL', flux: 'FLUX', sd3: 'SD 3' }

function LoraItem({ file }: { file: LoraFile }) {
  const meta = useApp((s) => s.settings?.image.loraMeta?.[file.id])
  const update = useApp((s) => s.update)
  const settings = useApp((s) => s.settings)!
  const save = (patch: { strength?: number; trigger?: string }) => {
    const next = { ...(settings.image.loraMeta ?? {}) }
    const merged = { ...(next[file.id] ?? {}), ...patch }
    if (merged.strength === undefined && !merged.trigger) delete next[file.id]
    else next[file.id] = merged
    update({ image: { ...settings.image, loraMeta: next } })
  }
  return (
    <Row
      title={file.name}
      sub={`${formatBytes(file.sizeBytes)} · ${file.id}`}
      right={file.base ? <Badge tone={file.baseGuessed ? 'neutral' : 'accent'} title={file.baseGuessed ? 'Guessed from the file name' : 'Read from the file'}>{BASE_LABEL[file.base]}{file.baseGuessed ? '?' : ''}</Badge> : <Badge title="The file does not say what it was trained for">Unknown base</Badge>}
    >
      <div className="lora-defaults">
        <div className="row">
          <span className="small dim lora-k">Usual strength</span>
          <NumberField float value={meta?.strength ?? 0.8} min={-1} max={2} step={0.05} onCommit={(v) => save({ strength: v })} />
        </div>
        <div className="row">
          <span className="small dim lora-k">Trigger words</span>
          <TextField className="grow" value={meta?.trigger ?? ''} placeholder={file.triggers.length ? `Suggested: ${file.triggers.slice(0, 3).join(', ')}` : 'Words this LoRA needs (optional)'} onCommit={(v) => save({ trigger: v.trim() || undefined })} />
        </div>
      </div>
    </Row>
  )
}

/** Real-ESRGAN: the upscaler that works on photos and realistic art. One click installs it with its models. */
function UpscalerEngine() {
  const status = useLibrary((s) => s.engines.esrgan)
  const install = useLibrary((s) => s.install.esrgan)
  const toast = useApp((s) => s.toast)
  const busy = !!install && install.phase !== 'done' && install.phase !== 'error'
  if (status?.resolvedBinary) return null
  if (status && status.available.length === 0) {
    return <div className="xs faint" style={{ marginBottom: 8 }}>The Real-ESRGAN upscaler has no build for this computer. The built-in engine can run RealESRGAN_x4plus_anime_6B, which is made for anime.</div>
  }
  return (
    <Notice tone="info">
      <div className="stack" style={{ gap: 8 }}>
        <div>
          The built-in engine can only run an anime-trained upscaler, which makes photos and realistic pictures look smooth and waxy. Install Real-ESRGAN for much better results on those: it works on any graphics card with Vulkan (NVIDIA, AMD and Intel), comes with models for photos, art and anime, and is about 45 MB.
        </div>
        <div className="row" style={{ gap: 8 }}>
          {busy ? (
            <Button size="sm" onClick={() => void invoke('engines:cancelInstall', 'esrgan')}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon={<Download size={14} />} onClick={() => void invoke('engines:install', 'esrgan', 'vulkan').catch((e) => toast('error', errorText(e)))}>
              Install the upscaler
            </Button>
          )}
        </div>
        {busy && (
          <div>
            <div className="xs faint" style={{ marginBottom: 4 }}>
              {install.label}
              {install.total ? ` · ${formatBytes(install.received ?? 0)} of ${formatBytes(install.total)}` : ''}
            </div>
            <Progress value={install.total ? (install.received ?? 0) / install.total : undefined} indeterminate={!install.total} height={4} />
          </div>
        )}
        {install?.phase === 'error' && <div className="dl-err selectable">{install.error}</div>}
      </div>
    </Notice>
  )
}

function LorasAndUpscalers() {
  const loras = useImages((s) => s.loraFiles)
  const upscalers = useImages((s) => s.upscalers)
  const esrganReady = useLibrary((s) => !!s.engines.esrgan?.resolvedBinary)
  const settings = useApp((s) => s.settings)!
  const update = useApp((s) => s.update)
  const presets = settings.image.loraPresets ?? []
  const hasX4plus = upscalers.some((u) => u.engine === 'esrgan' && /^realesrgan-x4plus$/i.test(u.name))
  const refresh = useImages((s) => s.refreshAssets)
  const toast = useApp((s) => s.toast)
  useEffect(() => {
    void refresh()
    const f = () => void refresh()
    window.addEventListener('focus', f)
    return () => window.removeEventListener('focus', f)
  }, [refresh])
  const open = (kind: 'lora' | 'upscale') => invoke('images:openFolder', kind).catch((e) => toast('error', errorText(e)))
  return (
    <Section
      title="LoRAs and upscalers"
      subtitle="LoRAs add a style, character or subject to a model (built-in engine). Upscalers make a finished picture bigger, from the Image Hub or by opening a picture."
      actions={
        <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={() => void refresh()}>
          Rescan
        </Button>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <div>
          <div className="row row-between" style={{ marginBottom: 8 }}>
            <strong className="small">LoRAs ({loras.length})</strong>
            <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => void open('lora')}>
              Open LoRA folder
            </Button>
          </div>
          {loras.length === 0 ? (
            <div className="small faint">None yet. Download one below with "Find more" (pick LORA on Civitai) or put .safetensors files in the LoRA folder. A LoRA only works with the kind of model it was made for: SD 1.x, SDXL, FLUX and SD 3 LoRAs are not interchangeable.</div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {loras.map((l) => (
                <LoraItem key={l.id} file={l} />
              ))}
            </div>
          )}
        </div>
        {presets.length > 0 && (
          <div>
            <strong className="small">LoRA presets ({presets.length})</strong>
            <div className="xs faint" style={{ margin: '4px 0 8px' }}>Save one from the LoRA box in the Image Hub (the bookmark button). Rename or delete them here.</div>
            <div className="stack" style={{ gap: 8 }}>
              {presets.map((p) => (
                <Row
                  key={p.id}
                  title={
                    <TextField
                      value={p.name}
                      ariaLabel="Preset name"
                      onCommit={(v) => {
                        const name = v.trim()
                        if (name && !presets.some((x) => x.id !== p.id && x.name.toLowerCase() === name.toLowerCase())) update({ image: { ...settings.image, loraPresets: presets.map((x) => (x.id === p.id ? { ...x, name } : x)) } })
                      }}
                    />
                  }
                  sub={p.loras.map((l) => `${l.id} ${l.strength.toFixed(2)}`).join(' · ')}
                  right={
                    <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => update({ image: { ...settings.image, loraPresets: presets.filter((x) => x.id !== p.id) } })}>
                      Delete
                    </Button>
                  }
                />
              ))}
            </div>
          </div>
        )}
        <div>
          <div className="row row-between" style={{ marginBottom: 8 }}>
            <strong className="small">Upscalers ({upscalers.length})</strong>
            <div className="row" style={{ gap: 8 }}>
              {!esrganReady && !upscalers.some((u) => SD_CPP_UPSCALER.test(u.name)) && (
                <Button size="sm" icon={<Download size={14} />} onClick={() => void startDownload({ url: ESRGAN_URL, subdir: 'image/upscale', filename: 'RealESRGAN_x4plus_anime_6B.pth', source: 'url', label: 'RealESRGAN x4plus anime 6B (upscaler)' })}>
                  Anime-only model for the built-in engine (17 MB)
                </Button>
              )}
              <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => void open('upscale')}>
                Open upscaler folder
              </Button>
            </div>
          </div>
          <UpscalerEngine />
          {hasX4plus && (
            <div className="row row-between" style={{ marginBottom: 10, gap: 12 }}>
              <div className="small dim">
                Turn "Upscale when done" on by default, using realesrgan-x4plus (Image Hub). You can still switch it off for a single picture.
              </div>
              <Switch checked={settings.image.upscaleByDefault !== false} onChange={(v) => update({ image: { ...settings.image, upscaleByDefault: v } })} label="Upscale by default" />
            </div>
          )}
          {upscalers.length === 0 ? (
            <div className="small faint">None yet. Install the upscaler above, or put upscaler files in the upscaler folder.</div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {upscalers.map((u) => (
                <Row
                  key={u.path}
                  title={u.name}
                  sub={`${formatBytes(u.sizeBytes)} · makes pictures ${u.scale}× bigger${u.bundled ? ' · came with the upscaler' : ''}`}
                  right={
                    <div className="row" style={{ gap: 6 }}>
                      {u.engine === 'esrgan' ? (
                        u.style === 'anime' ? (
                          <Badge title="Trained on anime and cartoons. On photos it flattens detail into smooth colour.">Anime</Badge>
                        ) : (
                          <Badge tone="ok" title="General purpose: photographs, realistic and painted art.">Photos and art</Badge>
                        )
                      ) : SD_CPP_UPSCALER.test(u.name) ? (
                        <Badge title="The built-in engine can run this one, but it is trained on anime, so photos look waxy.">Built-in engine, anime</Badge>
                      ) : (
                        <Badge title="The built-in engine (stable-diffusion.cpp) may ignore this model. If a picture comes back unchanged, use a Real-ESRGAN model.">Untested</Badge>
                      )}
                      <Badge>{u.scale}×</Badge>
                    </div>
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </Section>
  )
}

export function ImageModels() {
  const settings = useApp((s) => s.settings)!
  const update = useApp((s) => s.update)
  const weights = useLibrary((s) => s.weights)
  const targets = useImages((s) => s.targets)
  const [editing, setEditing] = useState<SdModelConfig | null>(null)
  const [find, setFind] = useState<'hf' | 'civitai'>('hf')
  const [doomed, setDoomed] = useState<string | null>(null)
  const models = settings.image.localModels
  const used = new Set(models.flatMap((m) => [m.model, m.diffusionModel, m.vae, m.clipL, m.clipG, m.t5xxl, m.llm].filter(Boolean)))
  // Only checkpoints belong in this list; LoRAs, upscalers, VAEs and text encoders have their own places.
  const loose = weights.filter((w) => !used.has(w.path) && guessImageFolder(w.name, '', w.sizeBytes) === 'image' && !/[\\/]image[\\/](lora|upscale|vae|text-encoders|embeddings)[\\/]/i.test(w.path))
  const defTarget = settings.image.defaultTarget
  const availableTargets = targets.filter((t) => t.available)

  return (
    <>
      <EngineBanner />
      <Section
        title="Models for the built-in engine"
        subtitle="Each entry points at weight files on this computer and remembers sensible settings for them."
        actions={
          <Popover
            align="end"
            width={250}
            trigger={({ toggle, ref }) => (
              <Button ref={ref} icon={<Plus size={16} />} onClick={toggle}>
                Add model
              </Button>
            )}
          >
            {(close) => (
              <div>
                {(['sdxl', 'sd', 'flux', 'zimage', 'sd3', 'custom'] as SdArch[]).map((a) => (
                  <MenuItem key={a} onClick={() => { close(); setEditing(blankSdModel(a)) }}>
                    {ARCH_LABEL[a]}
                  </MenuItem>
                ))}
              </div>
            )}
          </Popover>
        }
      >
        {models.length === 0 && <div className="faint small">No models yet. Start with a starter model below, or add files you already have.</div>}
        <div className="list">
          {models.map((m) => (
            <Row
              key={m.id}
              title={
                <span className="row" style={{ gap: 8 }}>
                  <span className="ellipsis">{m.name}</span>
                  <Badge>{m.arch.toUpperCase()}</Badge>
                </span>
              }
              sub={baseName(m.model || m.diffusionModel) || 'No file chosen'}
              right={
                <div className="row" style={{ gap: 4 }}>
                  <IconButton label="Edit" size="sm" onClick={() => setEditing(m)}>
                    <Pencil size={15} />
                  </IconButton>
                  {doomed === m.id ? (
                    <>
                      <Button size="sm" variant="danger" onClick={() => { update((s) => ({ image: { ...s.image, localModels: s.image.localModels.filter((x) => x.id !== m.id) } })); setDoomed(null); setTimeout(() => void useImages.getState().refreshTargets(true), 400) }}>
                        Remove
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDoomed(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <IconButton label="Remove from list (files stay on disk)" size="sm" danger onClick={() => setDoomed(m.id)}>
                      <Trash2 size={15} />
                    </IconButton>
                  )}
                </div>
              }
            />
          ))}
        </div>
        {loose.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="menu-heading" style={{ padding: 0 }}>
              Weight files found on disk
            </div>
            <div className="list">
              {loose.slice(0, 12).map((w) => (
                <Row
                  key={w.path}
                  title={<span className="ellipsis">{fileLabel(w.path)}</span>}
                  sub={`${formatBytes(w.sizeBytes)} · ${w.root}`}
                  right={
                    <div className="row" style={{ gap: 4 }}>
                      <Button
                        size="sm"
                        onClick={() => {
                          const arch = archGuess(w.name)
                          const b = blankSdModel(arch)
                          setEditing({ ...b, name: fileLabel(w.path), ...(arch === 'zimage' || (/\.gguf$/i.test(w.name) && arch === 'flux') ? { diffusionModel: w.path } : { model: w.path }) })
                        }}
                      >
                        Make a model
                      </Button>
                      <IconButton label="Show in folder" size="sm" onClick={() => void invoke('system:showItem', w.path)}>
                        <FolderOpen size={15} />
                      </IconButton>
                    </div>
                  }
                />
              ))}
            </div>
          </div>
        )}
        <DownloadsList subdir="image" />
      </Section>

      <Section title="Starter models" subtitle="One click downloads the files and sets the model up. Sizes are large, so check your disk space and video memory first.">
        <div className="grid-2">
          {STARTER_PACKS.map((p) => (
            <StarterCard key={p.id} pack={p} />
          ))}
        </div>
      </Section>

      <Section title="Find more" subtitle="Search for checkpoints, LoRAs, VAEs or upscalers, or paste a Hugging Face link. Files are sorted into the right folder inside your models folder.">
        <Segmented value={find} onChange={setFind} options={[{ value: 'hf', label: 'Hugging Face' }, { value: 'civitai', label: 'Civitai' }]} />
        {find === 'hf' ? (
          <HfBrowser kind="image" subdir="image" accept={(p) => /\.(safetensors|gguf|ckpt)$/i.test(p)} placeholder="Search image models, or paste owner/name" suggestions={['SDXL', 'FLUX.1', 'Z-Image', 'Stable Diffusion 3.5', 'Juggernaut', 'RealVisXL']} />
        ) : (
          <CivitaiBrowser hasToken={!!settings.paths.civitaiToken} />
        )}
      </Section>

      <LorasAndUpscalers />

      <Section
        title="Other image engines"
        subtitle="Use a ComfyUI or AUTOMATIC1111 / Forge server you already run, or an image API. They show up next to your built-in models in the Image Hub."
        actions={
          <Popover
            align="end"
            width={250}
            trigger={({ toggle, ref }) => (
              <Button ref={ref} icon={<Plus size={16} />} onClick={toggle}>
                Add engine
              </Button>
            )}
          >
            {(close) => (
              <div>
                {IMAGE_BACKEND_PRESETS.map((p) => (
                  <MenuItem
                    key={p.name}
                    onClick={() => {
                      close()
                      update((s) => ({ image: { ...s.image, backends: [...s.image.backends, { ...p, id: newId('img_') }] } }))
                      setTimeout(() => void useImages.getState().refreshTargets(true), 500)
                    }}
                  >
                    {p.name}
                  </MenuItem>
                ))}
              </div>
            )}
          </Popover>
        }
      >
        {settings.image.backends.filter((b) => b.kind !== 'builtin').map((b) => (
          <BackendCard key={b.id} b={b} />
        ))}
        {settings.image.backends.every((b) => b.kind === 'builtin') && <div className="faint small">None added. Start ComfyUI or AUTOMATIC1111 with its API enabled, then add it here.</div>}
      </Section>

      <Section title="Preferences">
        <Card>
          <div className="stack" style={{ gap: 18 }}>
            <Field row label="Default image model" hint="Used for “make me a picture” in chat.">
              <Select
                value={defTarget ? targetKeyOf(defTarget) : ''}
                onChange={(v) => {
                  const t = availableTargets.find((x) => targetKeyOf(x) === v)
                  update((s) => ({ image: { ...s.image, defaultTarget: t ? { backendId: t.backendId, model: t.model } : undefined } }))
                }}
                options={[{ value: '', label: 'First available' }, ...availableTargets.map((t) => ({ value: targetKeyOf(t), label: t.label }))]}
              />
            </Field>
            <Field row label="Free video memory for pictures" hint="Unload the local chat model while the built-in engine draws, then reload it when you chat again.">
              <Switch checked={settings.image.unloadLlmForImages} onChange={(v) => update((s) => ({ image: { ...s.image, unloadLlmForImages: v } }))} />
            </Field>
            <Field label="Default words to avoid" hint="Used when a model supports negative prompts.">
              <TextField multiline rows={2} value={settings.image.negativePrompt} onCommit={(v) => update((s) => ({ image: { ...s.image, negativePrompt: v } }))} />
            </Field>
          </div>
        </Card>
      </Section>

      {editing && <SdModelEditor initial={editing} onClose={() => setEditing(null)} />}
    </>
  )
}
