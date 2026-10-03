import { Dices, ImagePlus, MountainSnow, RotateCcw, Search, Sparkles, Star, Tags, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ImageProgress } from '@/components/ImageProgress'
import { AliasManager } from '@/components/AliasManager'
import { LoraPicker, UpscalePicker } from '@/components/LoraPicker'
import { type GridItem, JustifiedGrid } from '@/components/JustifiedGrid'
import { Ridgeline } from '@/components/Ridgeline'
import { SizeControls } from '@/components/SizeControls'
import { MaskEditor } from '@/components/MaskEditor'
import { StartingImage } from '@/components/StartingImage'
import { Button, EmptyState, Field, IconButton, Notice, NumberField, Segmented, Select, Slider, Spinner, TextField } from '@/components/ui'
import { invoke, mediaUrl } from '@/lib/api'
import { firstPicture } from '@/lib/pictureFile'
import { SAMPLERS, resolveSize } from '@/lib/imageSize'
import { cx, errorText } from '@/lib/format'
import { useApp } from '@/store/app'
import { targetKeyOf, useImages } from '@/store/images'
import { defaultUpscaler, expandAliases } from '@shared/imagePrefs'
import type { ImageGenRequest, ImageJob, ImageRecord } from '@shared/types'

/* ───────────── create panel ───────────── */

function CreatePanel() {
  const settings = useApp((s) => s.settings)!
  const setView = useApp((s) => s.setView)
  const toast = useApp((s) => s.toast)
  const update = useApp((s) => s.update)
  const form = useImages((s) => s.form)
  const setForm = useImages((s) => s.setForm)
  const targets = useImages((s) => s.targets)
  const loading = useImages((s) => s.targetsLoading)
  const refreshTargets = useImages((s) => s.refreshTargets)
  const refreshAssets = useImages((s) => s.refreshAssets)
  const generate = useImages((s) => s.generate)
  const importPicture = useImages((s) => s.importPicture)
  const maskEditorOpen = useImages((s) => s.maskEditorOpen)
  const openMaskEditor = useImages((s) => s.openMaskEditor)
  const upscalers = useImages((s) => s.upscalers)
  const records = useImages((s) => s.records)
  const busyJobs = useImages((s) => Object.values(s.jobs).filter((j) => j.status === 'queued' || j.status === 'running').length)
  const [enhancing, setEnhancing] = useState(false)
  const [before, setBefore] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [aliasesOpen, setAliasesOpen] = useState(false)

  useEffect(() => {
    void refreshAssets()
    const onFocus = () => void refreshAssets()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshAssets])

  const def = settings.image.defaultTarget
  const target =
    targets.find((t) => targetKeyOf(t) === form.targetKey) ??
    (def ? targets.find((t) => t.backendId === def.backendId && t.model === def.model && t.available) : undefined) ??
    targets.find((t) => t.available) ??
    targets[0]
  const ready = !!target?.available
  const init = form.initImageId ? records.find((r) => r.id === form.initImageId) : undefined
  const img2img = !!init && !!target?.supportsImg2Img

  // Pictures can be dropped on the panel or pasted anywhere in the Images tab to start from them.
  const canStart = !!target?.supportsImg2Img
  const [dropping, setDropping] = useState(false)
  const startFrom = (file: File) => {
    if (!canStart) {
      toast('error', target ? `${target.backendName} cannot start from a picture. Choose a built-in or AUTOMATIC1111 model.` : 'Choose an image model that can start from a picture first.')
      return
    }
    void importPicture(file)
  }
  const startFromRef = useRef(startFrom)
  startFromRef.current = startFrom
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = firstPicture(e.clipboardData?.files)
      if (!f) return
      e.preventDefault()
      startFromRef.current(f)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [])
  const negative = form.negative ?? settings.image.negativePrompt
  const d = target?.defaults
  const like = init ? { width: init.width, height: init.height } : undefined
  const size0 = resolveSize(form, target, like)

  // Steps and guidance the user saved for this model come first, then the model's own.
  const modelKey = target ? targetKeyOf(target) : ''
  const saved = settings.image.modelDefaults?.[modelKey]
  const stepsDefault = saved?.steps ?? d?.steps
  const cfgDefault = saved?.cfg ?? d?.cfg
  const saveDefaults = () => {
    if (!target) return
    const next = { steps: Math.round(form.steps ?? stepsDefault ?? 25), cfg: form.cfg ?? cfgDefault ?? 7 }
    update((s) => ({ image: { ...s.image, modelDefaults: { ...(s.image.modelDefaults ?? {}), [modelKey]: next } } }))
    setForm({ steps: undefined, cfg: undefined })
    toast('ok', `Saved ${next.steps} steps and guidance ${next.cfg.toFixed(1)} as the default for ${target.label}.`)
  }
  const clearDefaults = () =>
    update((s) => {
      const rest = { ...(s.image.modelDefaults ?? {}) }
      delete rest[modelKey]
      return { image: { ...s.image, modelDefaults: rest } }
    })

  // "Upscale when done" is on with realesrgan-x4plus once it is installed, unless the user switched it off.
  const defUp = settings.image.upscaleByDefault !== false ? defaultUpscaler(upscalers) : undefined
  const upscaleValue = form.upscale ?? (form.upscaleOff || !defUp ? undefined : { path: defUp.path, repeats: 1 })
  const upscaleIsDefault = !form.upscale && !!upscaleValue

  // Aliases the user typed, shown as they will be sent.
  const expanded = useMemo(() => expandAliases(form.prompt, settings.image.aliases), [form.prompt, settings.image.aliases])

  const submit = async () => {
    if (!target || !ready) return
    const prompt = form.prompt.trim()
    if (!prompt) return
    const size = resolveSize(form, target, img2img ? like : undefined)
    // A mask is sent first and the request then points at it, so the picture-sized data does not travel with the job.
    let inpaint: ImageGenRequest['inpaint']
    if (img2img && form.mask) {
      if (!target.supportsMask) {
        toast('error', `${target.backendName} cannot use a mask. Choose a built-in or AUTOMATIC1111 model, or remove the mask.`)
        return
      }
      try {
        const { maskId } = await invoke('images:setMask', form.mask.png)
        inpaint = { maskId, area: form.inpaintArea, feather: form.feather, padding: form.padding }
      } catch (e) {
        toast('error', errorText(e))
        return
      }
    }
    await generate({
      prompt,
      negativePrompt: target.supportsNegative && negative.trim() ? negative.trim() : undefined,
      target: { backendId: target.backendId, model: target.model },
      width: size.width,
      height: size.height,
      steps: form.steps,
      cfgScale: form.cfg,
      sampler: form.sampler,
      seed: form.seed,
      count: form.count,
      initImageId: img2img ? form.initImageId : undefined,
      strength: img2img ? form.strength : undefined,
      inpaint,
      loras: target.supportsLora && form.loras.length ? form.loras : undefined,
      upscale: upscaleValue && (target.supportsLora || upscalers.find((u) => u.path === upscaleValue.path)?.engine === 'esrgan') ? upscaleValue : undefined
    })
  }

  const enhance = async () => {
    const p = form.prompt.trim()
    if (!p) return
    setEnhancing(true)
    try {
      const out = await invoke('chat:enhance', p)
      if (out && out.trim()) {
        setBefore(form.prompt)
        setForm({ prompt: out.trim() })
      }
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setEnhancing(false)
    }
  }

  return (
    <aside
      className={cx('create-panel', dropping && 'drop-hot')}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault()
          setDropping(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => {
        setDropping(false)
        const f = firstPicture(e.dataTransfer.files)
        if (!f) return
        e.preventDefault()
        startFrom(f)
      }}
    >
      <div className="create-scroll">
        <div className="create-title">
          <h2>Create</h2>
          {busyJobs > 0 && (
            <span className="badge badge-accent">
              <Spinner size={11} /> {busyJobs} in progress
            </span>
          )}
        </div>

        <Field
          label="Prompt"
          hint={
            before !== null ? (
              <button type="button" className="link-btn" onClick={() => { setForm({ prompt: before }); setBefore(null) }}>
                Undo enhancement
              </button>
            ) : undefined
          }
        >
          <div className="prompt-box">
            <textarea
              className="prompt-input"
              rows={5}
              value={form.prompt}
              placeholder="A lone cabin below a snow-dusted ridge at dawn, mist in the valley…"
              onChange={(e) => setForm({ prompt: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  void submit()
                }
              }}
              spellCheck
            />
            <div className="prompt-tools">
              <Button variant="ghost" size="sm" icon={<Tags size={14} />} onClick={() => setAliasesOpen(true)} title="Words you type here that are replaced by longer text when the picture is made">
                Aliases{(settings.image.aliases?.length ?? 0) > 0 ? ` (${settings.image.aliases!.length})` : ''}
              </Button>
              <Button variant="ghost" size="sm" icon={<Sparkles size={14} />} busy={enhancing} disabled={!form.prompt.trim()} onClick={() => void enhance()} title="Let your chat model rewrite the prompt with more visual detail">
                Enhance
              </Button>
            </div>
          </div>
          {expanded.used.length > 0 && (
            <div className="alias-preview xs" title="This is the text the picture is made from">
              <span className="faint">Sent as ({expanded.used.join(', ')}): </span>
              {expanded.text}
            </div>
          )}
        </Field>
        <AliasManager open={aliasesOpen} onClose={() => setAliasesOpen(false)} />

        <Field label="Model" hint={loading ? 'Looking…' : undefined}>
          <div className="row">
            <Select
              className="grow"
              value={target ? targetKeyOf(target) : ''}
              onChange={(v) => setForm({ targetKey: v })}
              options={targets.length ? targets.map((t) => ({ value: targetKeyOf(t), label: `${t.label}${t.available ? '' : ' (not ready)'}` })) : [{ value: '', label: 'No image models yet' }]}
              disabled={targets.length === 0}
            />
            <IconButton label="Refresh" size="sm" onClick={() => void refreshTargets(true)}>
              <RotateCcw size={15} />
            </IconButton>
          </div>
        </Field>

        {targets.length === 0 && (
          <Notice tone="info" action={<Button size="sm" onClick={() => setView('models', 'image')}>Set up</Button>}>
            Add an image model to start. The built-in engine runs on your GPU, or connect ComfyUI, AUTOMATIC1111 or an API.
          </Notice>
        )}
        {target && !target.available && (
          <Notice tone="warn" action={<Button size="sm" onClick={() => setView('models', 'image')}>Fix</Button>}>
            {target.unavailableReason ?? 'This model is not ready.'}
          </Notice>
        )}

        {target?.supportsNegative && (
          <Field label="Avoid">
            <TextField multiline rows={2} value={negative} placeholder="blurry, low quality, watermark" onCommit={(v) => setForm({ negative: v })} spellCheck />
          </Field>
        )}

        <SizeControls form={form} setForm={setForm} target={target} like={like} />

        <LoraPicker target={target} value={form.loras} onChange={(loras) => setForm({ loras })} />
        <UpscalePicker target={target} value={upscaleValue} isDefault={upscaleIsDefault} onChange={(upscale) => setForm({ upscale, upscaleOff: upscale ? undefined : true })} width={size0.width || d?.width} height={size0.height || d?.height} />

        <Field label="How many">
          <Segmented size="sm" value={String(form.count)} onChange={(v) => setForm({ count: Number(v) })} options={['1', '2', '4', '8'].map((n) => ({ value: n, label: n }))} />
        </Field>

        <StartingImage
          supported={!!target?.supportsImg2Img}
          unsupportedHint={target && !target.supportsImg2Img ? `${target.backendName} cannot start from a picture. Choose a built-in or AUTOMATIC1111 model to use one.` : undefined}
          init={init}
          strength={form.strength}
          steps={form.steps ?? stepsDefault}
          onStrength={(v) => setForm({ strength: v })}
          maskSupported={!!target?.supportsMask}
          mask={form.mask}
          inpaintArea={form.inpaintArea}
          feather={form.feather}
          padding={form.padding}
          onEditMask={() => openMaskEditor(true)}
          onClearMask={() => setForm({ mask: undefined })}
          onInpaint={(patch) => setForm(patch)}
          onClear={() => setForm({ initImageId: undefined })}
          onPick={startFrom}
        />

        <button type="button" className="adv-toggle" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
          <span>Advanced</span>
          <span className="faint xs">{advanced ? 'Hide' : 'Steps, guidance, sampler, seed'}</span>
        </button>
        {advanced && (
          <div className="stack" style={{ gap: 16 }}>
            <Field label="Steps" hint={form.steps === undefined ? (saved?.steps !== undefined ? `Your default (${saved.steps})` : `Model default${d ? ` (${d.steps})` : ''}`) : undefined}>
              <div className="row">
                <Slider value={form.steps ?? stepsDefault ?? 25} min={1} max={100} onChange={(v) => setForm({ steps: v })} />
                {form.steps !== undefined && <button type="button" className="link-btn" onClick={() => setForm({ steps: undefined })}>Reset</button>}
              </div>
            </Field>
            <Field label="Guidance" hint={form.cfg === undefined ? (saved?.cfg !== undefined ? `Your default (${saved.cfg})` : `Model default${d ? ` (${d.cfg})` : ''}`) : undefined}>
              <div className="row">
                <Slider value={form.cfg ?? cfgDefault ?? 7} min={0} max={20} step={0.5} onChange={(v) => setForm({ cfg: v })} format={(v) => v.toFixed(1)} />
                {form.cfg !== undefined && <button type="button" className="link-btn" onClick={() => setForm({ cfg: undefined })}>Reset</button>}
              </div>
            </Field>
            {target && (
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <Button size="sm" onClick={saveDefaults} title="Use these steps and guidance whenever this model is chosen, in the Image Hub and in chat">
                  Save as default for this model
                </Button>
                {saved && (
                  <button type="button" className="link-btn" onClick={clearDefaults}>
                    Clear saved default
                  </button>
                )}
              </div>
            )}
            <Field label="Sampler">
              <Select
                value={form.sampler ?? ''}
                onChange={(v) => setForm({ sampler: v || undefined })}
                options={[{ value: '', label: d ? `Model default (${d.sampler})` : 'Model default' }, ...SAMPLERS.map((s) => ({ value: s, label: s }))]}
              />
            </Field>
            <Field label="Seed" hint="-1 picks a new one every time.">
              <div className="row">
                <NumberField value={form.seed} min={-1} max={4294967295} onCommit={(v) => setForm({ seed: v })} className="seed-field" />
                <IconButton label="Random seed" size="sm" onClick={() => setForm({ seed: -1 })}>
                  <Dices size={16} />
                </IconButton>
              </div>
            </Field>
          </div>
        )}
      </div>
      <div className="create-foot">
        <Button variant="primary" size="lg" className="create-go" icon={<ImagePlus size={18} />} disabled={!ready || !form.prompt.trim()} onClick={() => void submit()}>
          {busyJobs > 0 ? 'Add to queue' : 'Generate'}
        </Button>
        <div className="faint xs" style={{ textAlign: 'center', marginTop: 8 }}>
          Ctrl+Enter to generate
        </div>
      </div>
      {maskEditorOpen && init && (
        <MaskEditor
          picture={init}
          initial={form.mask?.png}
          onCancel={() => openMaskEditor(false)}
          onDone={(m) => {
            setForm({ mask: m })
            openMaskEditor(false)
          }}
        />
      )}
    </aside>
  )
}

/* ───────────── gallery ───────────── */

type Filter = 'all' | 'favorites' | 'chat'

function JobTile({ job }: { job: ImageJob }) {
  const cancel = useImages((s) => s.cancel)
  const dismiss = useImages((s) => s.dismissJob)
  const generate = useImages((s) => s.generate)
  const failed = job.status === 'error'
  return (
    <div className={cx('tile job', failed && 'failed')}>
      {!failed && <div className="gen-shimmer" />}
      <div className="job-body">
        {failed ? (
          <>
            <div className="small selectable job-err">{job.error ?? 'Generation failed.'}</div>
            <div className="row">
              <Button size="sm" onClick={() => { const { source: _s, ...rest } = job.request; void generate(rest); dismiss(job.id) }}>Retry</Button>
              <Button size="sm" variant="ghost" onClick={() => dismiss(job.id)}>Dismiss</Button>
            </div>
          </>
        ) : (
          <>
            <div className="job-prompt small dim">{job.request.prompt}</div>
            <div className="job-foot">
              <ImageProgress queued={job.status === 'queued'} upscale={!!job.request.upscale} upscaleOnly={!!job.request.upscaleOf} stage={job.stage} label={job.label ?? 'Generating…'} progress={job.progress} />
            </div>
            <IconButton label="Cancel" size="sm" className="job-x" onClick={() => cancel(job.id)}>
              <X size={14} />
            </IconButton>
          </>
        )}
      </div>
    </div>
  )
}

function Tile({ rec, ids }: { rec: ImageRecord; ids: string[] }) {
  const view = useImages((s) => s.view)
  const favorite = useImages((s) => s.favorite)
  const remove = useImages((s) => s.remove)
  // Deleting is permanent, so the trash button asks for a second click.
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <div className="tile" onMouseLeave={() => setArmed(false)}>
      <button type="button" className="tile-img" onClick={() => view(rec.id, ids)} aria-label={`Open: ${rec.prompt}`}>
        <img src={mediaUrl('thumb', rec.thumb)} alt={rec.prompt} loading="lazy" draggable={false} />
      </button>
      <div className="tile-over">
        <span className="tile-prompt">{rec.prompt}</span>
      </div>
      <button
        type="button"
        className={cx('tile-del', armed && 'armed')}
        aria-label={armed ? 'Click again to delete this image' : 'Delete this image'}
        title={armed ? 'Click again to delete' : 'Delete'}
        onClick={() => (armed ? void remove([rec.id]) : setArmed(true))}
      >
        <Trash2 size={14} />
        {armed && <span>Delete?</span>}
      </button>
      <button type="button" className={cx('tile-fav', rec.favorite && 'on')} aria-label={rec.favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={() => favorite(rec.id, !rec.favorite)}>
        <Star size={15} fill={rec.favorite ? 'currentColor' : 'none'} />
      </button>
    </div>
  )
}

function Gallery() {
  const records = useImages((s) => s.records)
  const jobs = useImages((s) => s.jobs)
  const dismissed = useImages((s) => s.dismissed)
  const hasTargets = useImages((s) => s.targets.some((t) => t.available))
  const setView = useApp((s) => s.setView)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return records.filter((r) => (filter === 'favorites' ? r.favorite : filter === 'chat' ? r.source === 'chat' : true) && (!q || r.prompt.toLowerCase().includes(q) || r.model.toLowerCase().includes(q)))
  }, [records, filter, query])
  const ids = useMemo(() => shown.map((r) => r.id), [shown])
  const live = Object.values(jobs)
    .filter((j) => (j.status === 'queued' || j.status === 'running' || j.status === 'error') && !dismissed[j.id] && j.request.source === 'hub')
    .sort((a, b) => b.createdAt - a.createdAt)

  // Newest first, left to right, then down.
  const items: GridItem[] = [
    ...live.map((j) => ({ key: `job:${j.id}`, aspect: j.request.width && j.request.height ? j.request.width / j.request.height : 1, render: () => <JobTile job={j} /> })),
    ...shown.map((r) => ({ key: r.id, aspect: r.width / r.height, render: () => <Tile rec={r} ids={ids} /> }))
  ]

  return (
    <section className="gallery-wrap">
      <div className="gallery-head">
        <div>
          <h1>Image Hub</h1>
          <p className="faint small">{records.length === 0 ? 'Everything you make lands here.' : `${records.length} image${records.length === 1 ? '' : 's'}`}</p>
        </div>
        <div className="row">
          <div className="conv-search gallery-search">
            <Search size={14} />
            <input placeholder="Search prompts" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
          </div>
          <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'favorites', label: 'Favorites' }, { value: 'chat', label: 'From chats' }]} />
        </div>
      </div>
      <div className="gallery-scroll">
        {records.length === 0 && live.length === 0 ? (
          <div className="gallery-empty">
            <div className="chat-empty-ridge">
              <Ridgeline seed={23} layers={4} />
            </div>
            <EmptyState
              icon={<MountainSnow size={26} />}
              title="No pictures yet"
              action={!hasTargets ? <Button variant="primary" onClick={() => setView('models', 'image')}>Set up an image model</Button> : undefined}
            >
              {hasTargets ? 'Describe a scene on the left and press Generate. You can also ask for images in any chat.' : 'Add an image model first, then describe a scene and watch it appear here.'}
            </EmptyState>
          </div>
        ) : shown.length === 0 && live.length === 0 ? (
          <EmptyState icon={<Search size={24} />} title="Nothing matches">
            Try another word, or switch the filter.
          </EmptyState>
        ) : (
          <JustifiedGrid items={items} />
        )}
      </div>
    </section>
  )
}

export function ImagesView() {
  return (
    <div className="hub-layout">
      <CreatePanel />
      <Gallery />
    </div>
  )
}

