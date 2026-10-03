import { AlertTriangle, Dices, ImagePlus, PanelLeftClose, RotateCcw, Sparkles, Tags } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AliasManager } from '@/components/AliasManager'
import { LoraPicker, UpscalePicker, loraSectionShown, usableUpscalers } from '@/components/LoraPicker'
import { Resizer } from '@/components/Resizer'
import { SizeControls, sizeNotes } from '@/components/SizeControls'
import { Button, Disclosure, Field, IconButton, Notice, NumberField, Segmented, Select, Slider, Spinner, TextField } from '@/components/ui'
import { invoke } from '@/lib/api'
import { cx, errorText } from '@/lib/format'
import { SAMPLERS, resolveSize } from '@/lib/imageSize'
import { firstPicture } from '@/lib/pictureFile'
import { useApp } from '@/store/app'
import { type StartMode, targetKeyOf, useImages } from '@/store/images'
import { useLayout, usePanel } from '@/store/layout'
import { defaultUpscaler, expandAliases } from '@shared/imagePrefs'
import type { ImageGenRequest } from '@shared/types'
import { PicturePicker } from './PicturePicker'
import { StartFrom } from './StartFrom'

const SCALE_NAME: Record<number, string> = { 0.75: 'small', 1.5: 'large', 2: 'huge' }

export function CreatePanel() {
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
  const openMaskEditor = useImages((s) => s.openMaskEditor)
  const upscalers = useImages((s) => s.upscalers)
  const records = useImages((s) => s.records)
  const busyJobs = useImages((s) => Object.values(s.jobs).filter((j) => j.status === 'queued' || j.status === 'running').length)
  const { collapsed } = usePanel('create')
  const toggle = useLayout((s) => s.toggle)
  const [enhancing, setEnhancing] = useState(false)
  const [before, setBefore] = useState<string | null>(null)
  const [aliasesOpen, setAliasesOpen] = useState(false)
  const [picking, setPicking] = useState(false)

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

  const mode = form.startMode
  const pic = form.initImageId ? records.find((r) => r.id === form.initImageId) : undefined
  const imageOk = !!target?.supportsImg2Img
  const maskOk = imageOk && !!target?.supportsMask
  const wantsPicture = mode !== 'text'
  const init = wantsPicture ? pic : undefined
  const img2img = !!init && imageOk
  const maskUsed = img2img && mode === 'mask' && !!form.mask && maskOk
  const unsupportedHint = target && !imageOk ? `${target.backendName} cannot start from a picture. Choose a built-in or AUTOMATIC1111 model.` : undefined

  // Pictures can be dropped on the panel or pasted anywhere in the Images tab to start from them.
  const [dropping, setDropping] = useState(false)
  const startFrom = (file: File) => {
    if (!imageOk) {
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

  const switchMode = (m: StartMode) => {
    setForm({ startMode: m })
    // Choosing Mask with a picture ready goes straight to painting.
    if (m === 'mask' && pic && !form.mask) openMaskEditor(true)
  }

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
  const usable = usableUpscalers(target, upscalers)
  const chosenUpscaler = usable.find((u) => u.path === upscaleValue?.path)

  // Aliases the user typed, shown as they will be sent.
  const expanded = useMemo(() => expandAliases(form.prompt, settings.image.aliases), [form.prompt, settings.image.aliases])

  // Why Generate cannot be pressed yet, in words.
  const blocked = !form.prompt.trim()
    ? 'Describe the picture to make it.'
    : !ready
      ? 'Choose an image model that is ready.'
      : wantsPicture && !imageOk
        ? (unsupportedHint ?? 'This model cannot start from a picture.')
        : wantsPicture && !pic
          ? 'Choose a starting picture, or switch to Text.'
          : mode === 'mask' && !maskOk
            ? 'This model cannot use a mask. Choose a built-in or AUTOMATIC1111 model.'
            : mode === 'mask' && !form.mask
              ? 'Paint the part to change first, or switch to Picture.'
              : null

  const submit = async () => {
    if (!target || blocked) return
    const prompt = form.prompt.trim()
    const size = resolveSize(form, target, img2img ? like : undefined)
    // A mask is sent first and the request then points at it, so the picture-sized data does not travel with the job.
    let inpaint: ImageGenRequest['inpaint']
    if (maskUsed && form.mask) {
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

  // One-line summaries so a closed section still says what is set.
  const sizeWarn = sizeNotes(form, target, like).some((n) => n.level === 'warn')
  const shape = form.ratio === 'auto' ? (like ? 'like the picture' : 'auto') : form.ratio === 'custom' ? 'custom' : form.ratio
  const dims = size0.width > 0 ? `${size0.width} × ${size0.height}` : d ? `${d.width} × ${d.height}` : 'model default'
  const sizeSummary = `${dims} · ${shape}${SCALE_NAME[form.scale ?? 1] ? ` · ${SCALE_NAME[form.scale ?? 1]}` : ''}`
  const seedText = form.seed < 0 ? 'random seed' : `seed ${form.seed}`
  const advSummary = `${form.steps ?? stepsDefault ?? 25} steps · guidance ${(form.cfg ?? cfgDefault ?? 7).toFixed(1)} · ${seedText}`

  return (
    <aside
      className={cx('create-panel', dropping && 'drop-hot', collapsed && 'is-folded')}
      aria-hidden={collapsed}
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
          <div className="row" style={{ gap: 6 }}>
            {busyJobs > 0 && (
              <span className="badge badge-accent">
                <Spinner size={11} /> {busyJobs} in progress
              </span>
            )}
            <IconButton label="Hide this panel (Ctrl+B)" size="sm" onClick={() => toggle('create')}>
              <PanelLeftClose size={16} />
            </IconButton>
          </div>
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
              rows={4}
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

        <StartFrom
          mode={mode}
          onMode={switchMode}
          imageOk={imageOk}
          maskOk={maskOk}
          unsupportedHint={unsupportedHint}
          init={init}
          strength={form.strength}
          steps={form.steps ?? stepsDefault}
          onStrength={(v) => setForm({ strength: v })}
          mask={form.mask}
          inpaintArea={form.inpaintArea}
          feather={form.feather}
          padding={form.padding}
          onEditMask={() => openMaskEditor(true)}
          onClearMask={() => setForm({ mask: undefined })}
          onInpaint={(patch) => setForm(patch)}
          onClearPicture={() => setForm({ initImageId: undefined })}
          onPick={startFrom}
          onChoose={() => setPicking(true)}
        />
        <PicturePicker
          open={picking}
          onClose={() => setPicking(false)}
          onPick={(rec) => setForm({ initImageId: rec.id, startMode: mode === 'mask' ? 'mask' : 'image' })}
        />

        <div className="disc-list">
          <Disclosure id="size" title="Size" summary={sizeSummary} badge={sizeWarn ? <AlertTriangle size={13} className="disc-warn" aria-label="Warning" /> : undefined}>
            <SizeControls form={form} setForm={setForm} target={target} like={like} bare />
          </Disclosure>

          {target?.supportsNegative && (
            <Disclosure id="avoid" title="Avoid" summary={negative.trim() || 'nothing'}>
              <TextField multiline rows={3} value={negative} placeholder="blurry, low quality, watermark" onCommit={(v) => setForm({ negative: v })} spellCheck />
            </Disclosure>
          )}

          {loraSectionShown(target, form.loras) && (
            <Disclosure id="loras" title="LoRAs" summary={form.loras.length ? `${form.loras.length} in use` : 'none'}>
              <LoraPicker target={target} value={form.loras} onChange={(loras) => setForm({ loras })} bare />
            </Disclosure>
          )}

          {!!target && (target.supportsLora || usable.length > 0) && (
            <Disclosure id="upscale" title="Upscale" summary={chosenUpscaler ? `${chosenUpscaler.name} · ${chosenUpscaler.scale}×` : 'off'}>
              <UpscalePicker
                target={target}
                value={upscaleValue}
                isDefault={upscaleIsDefault}
                onChange={(upscale) => setForm({ upscale, upscaleOff: upscale ? undefined : true })}
                width={size0.width || d?.width}
                height={size0.height || d?.height}
                bare
              />
            </Disclosure>
          )}

          <Disclosure id="advanced" title="Advanced" summary={advSummary}>
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
          </Disclosure>
        </div>
      </div>

      <div className="create-foot">
        <div className="create-foot-row">
          <div title="How many pictures to make at once">
            <Segmented size="sm" value={String(form.count)} onChange={(v) => setForm({ count: Number(v) })} options={['1', '2', '4', '8'].map((n) => ({ value: n, label: n }))} />
          </div>
          <Button variant="primary" size="lg" className="create-go grow" icon={<ImagePlus size={18} />} disabled={!!blocked} onClick={() => void submit()}>
            {busyJobs > 0 ? 'Add to queue' : 'Generate'}
          </Button>
        </div>
        <div className="xs faint create-foot-hint">{blocked ?? 'Ctrl+Enter to generate'}</div>
      </div>
      {!collapsed && <Resizer panel="create" side="right" />}
    </aside>
  )
}
