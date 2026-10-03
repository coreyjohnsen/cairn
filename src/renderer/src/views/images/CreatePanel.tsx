import { AlertTriangle, Dices, ImagePlus, PanelLeftClose, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { LoraPicker, UpscalePicker, loraSectionShown } from '@/components/LoraPicker'
import { Resizer } from '@/components/Resizer'
import { SizeControls, sizeNotes } from '@/components/SizeControls'
import { Button, Disclosure, Field, IconButton, Notice, NumberField, Segmented, Select, Slider, Spinner, TextField } from '@/components/ui'
import { resolveFocus } from '@/lib/focus'
import { cx } from '@/lib/format'
import { SAMPLERS } from '@/lib/imageSize'
import { firstPicture } from '@/lib/pictureFile'
import { useApp } from '@/store/app'
import { type StartMode, targetKeyOf, useImages } from '@/store/images'
import { useLayout, usePanel } from '@/store/layout'
import { PicturePicker } from './PicturePicker'
import { PromptBox } from './PromptBox'
import { StartFrom } from './StartFrom'
import { useHub } from './useHub'

const SCALE_NAME: Record<number, string> = { 0.75: 'small', 1.5: 'large', 2: 'huge' }

export function CreatePanel() {
  const setView = useApp((s) => s.setView)
  const toast = useApp((s) => s.toast)
  const update = useApp((s) => s.update)
  const setForm = useImages((s) => s.setForm)
  const targets = useImages((s) => s.targets)
  const loading = useImages((s) => s.targetsLoading)
  const refreshTargets = useImages((s) => s.refreshTargets)
  const refreshAssets = useImages((s) => s.refreshAssets)
  const importPicture = useImages((s) => s.importPicture)
  const { collapsed } = usePanel('create')
  const toggle = useLayout((s) => s.toggle)
  const hubMode = useLayout((s) => s.hubMode)
  const setHubMode = useLayout((s) => s.setHubMode)
  const [picking, setPicking] = useState(false)

  const h = useHub()
  const { form, target, ready, mode, editing, pic, init, imageOk, like, unsupportedHint, d, size0, negative, saved, stepsDefault, cfgDefault, upscaleValue, upscaleIsDefault, usable, chosenUpscaler, blocked, busyJobs } = h

  useEffect(() => {
    void refreshAssets()
    const onFocus = () => void refreshAssets()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshAssets])

  // Pictures can be dropped on the panel or pasted anywhere in the Images tab to edit them.
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
    if (m === 'text') return setForm({ startMode: 'text' })
    setHubMode('focus')
    if (pic) return setForm({ startMode: 'edit' })
    // Edit the picture that is in front, if there is one; otherwise ask which.
    const s = useImages.getState()
    const item = resolveFocus(s.focus, s.records, s.jobs, s.records[0]?.id)
    setForm({ startMode: 'edit', ...(item?.kind === 'record' ? { initImageId: item.rec.id } : {}) })
  }

  const saveDefaults = () => {
    if (!target) return
    const next = { steps: Math.round(form.steps ?? stepsDefault ?? 25), cfg: form.cfg ?? cfgDefault ?? 7 }
    update((s) => ({ image: { ...s.image, modelDefaults: { ...(s.image.modelDefaults ?? {}), [targetKeyOf(target)]: next } } }))
    setForm({ steps: undefined, cfg: undefined })
    toast('ok', `Saved ${next.steps} steps and guidance ${next.cfg.toFixed(1)} as the default for ${target.label}.`)
  }
  const clearDefaults = () =>
    update((s) => {
      const rest = { ...(s.image.modelDefaults ?? {}) }
      if (target) delete rest[targetKeyOf(target)]
      return { image: { ...s.image, modelDefaults: rest } }
    })

  // One-line summaries so a closed section still says what is set.
  const sizeWarn = sizeNotes(form, target, like).some((n) => n.level === 'warn')
  const shape = form.ratio === 'auto' ? (like ? 'like the picture' : 'auto') : form.ratio === 'custom' ? 'custom' : form.ratio
  const dims = size0.width > 0 ? `${size0.width} × ${size0.height}` : d ? `${d.width} × ${d.height}` : 'model default'
  const sizeSummary = `${dims} · ${shape}${SCALE_NAME[form.scale ?? 1] ? ` · ${SCALE_NAME[form.scale ?? 1]}` : ''}`
  const seedText = form.seed < 0 ? 'random seed' : `seed ${form.seed}`
  const advSummary = `${form.steps ?? stepsDefault ?? 25} steps · guidance ${(form.cfg ?? cfgDefault ?? 7).toFixed(1)} · ${seedText}`

  // While a picture is edited in the big view the prompt is written under it; with the grid showing, it stays here.
  const promptHere = !editing || hubMode === 'grid'

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

        {promptHere && (
          <Field label="Prompt">
            <PromptBox rows={4} placeholder="A lone cabin below a snow-dusted ridge at dawn, mist in the valley…" onSubmit={() => void h.submit()} />
          </Field>
        )}

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
          unsupportedHint={unsupportedHint}
          init={init}
          gridShown={hubMode === 'grid'}
          onShowEditor={() => setHubMode('focus')}
          onClearPicture={() => setForm({ initImageId: undefined })}
          onPick={startFrom}
          onChoose={() => setPicking(true)}
        />
        <PicturePicker open={picking} onClose={() => setPicking(false)} onPick={(rec) => setForm({ initImageId: rec.id, startMode: 'edit' })} />

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
          <Button variant="primary" size="lg" className="create-go grow" icon={<ImagePlus size={18} />} disabled={!!blocked || !ready} onClick={() => void h.submit()}>
            {busyJobs > 0 ? 'Add to queue' : 'Generate'}
          </Button>
        </div>
        <div className="xs faint create-foot-hint">{blocked ?? 'Ctrl+Enter to generate'}</div>
      </div>
      {!collapsed && <Resizer panel="create" side="right" />}
    </aside>
  )
}
