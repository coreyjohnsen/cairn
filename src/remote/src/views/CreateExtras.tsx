import { ArrowLeftRight, Info, X } from 'lucide-react'
import { sizeNotes } from '@/components/SizeControls'
import { DEFAULT_LORA_STRENGTH, loraMismatch } from '@/components/LoraPicker'
import { Segmented, Select, Slider } from '@/components/ui'
import { cx } from '@/lib/format'
import { RATIOS, SCALES, describeSize, resolveSize } from '@/lib/imageSize'
import { applyLoraPreset } from '@shared/imagePrefs'
import { shapeDiffers } from '@shared/img2img'
import type { ImageTargetOption, LoraFile, LoraSelection, UpscalerFile } from '@shared/types'
import { useApp } from '@/store/app'
import { type HubForm, useImages } from '@/store/images'

interface LikePic {
  width: number
  height: number
}

/** Shape, size and exact width and height, with plain-language remarks about them. */
export function SizeSection({ form, setForm, target, like }: { form: HubForm; setForm: (p: Partial<HubForm>) => void; target?: ImageTargetOption; like?: LikePic }) {
  const size = resolveSize(form, target, like)
  const d = target?.defaults
  const custom = form.ratio === 'custom'
  const notes = sizeNotes(form, target, like)
  const pickRatio = (id: HubForm['ratio']) => {
    if (id === 'custom' && !custom) {
      // Start from the size in use instead of an unrelated number.
      const now = size.width > 0 ? size : d ? { width: d.width, height: d.height } : { width: form.customW, height: form.customH }
      setForm({ ratio: 'custom', customW: now.width, customH: now.height })
    } else setForm({ ratio: id })
  }
  const num = (v: string, fallback: number) => (v === '' ? fallback : Math.max(64, Math.min(2048, Math.round(Number(v)) || fallback)))
  return (
    <div className="field-group">
      <div className="fld-label">
        Shape <span className="faint xs">· {describeSize(form, target, like)}</span>
      </div>
      <Segmented fill value={form.ratio} onChange={pickRatio} options={RATIOS.map((r) => ({ value: r.id, label: r.id === 'auto' ? 'Auto' : r.id === 'custom' ? 'Custom' : r.label }))} />
      {custom ? (
        <div className="size-custom">
          <input className="fld" type="number" inputMode="numeric" step={64} min={64} max={2048} aria-label="Width" value={form.customW} onChange={(e) => setForm({ customW: num(e.target.value, form.customW) })} />
          <button type="button" className="icon-x" aria-label="Swap width and height" onClick={() => setForm({ customW: form.customH, customH: form.customW })}>
            <ArrowLeftRight size={17} />
          </button>
          <input className="fld" type="number" inputMode="numeric" step={64} min={64} max={2048} aria-label="Height" value={form.customH} onChange={(e) => setForm({ customH: num(e.target.value, form.customH) })} />
        </div>
      ) : (
        <div className="size-scale">
          <Segmented fill size="sm" value={String(form.scale ?? 1)} onChange={(v) => setForm({ scale: Number(v) })} options={SCALES.map((s) => ({ value: String(s.value), label: s.label }))} />
        </div>
      )}
      {like && size.width > 0 && shapeDiffers(like, size.width, size.height) && (
        <p className="small warn-text size-note">
          This shape differs from the starting picture ({like.width} × {like.height}), so it will be stretched.{' '}
          <button type="button" className="link-btn" onClick={() => setForm({ ratio: 'auto' })}>
            Use the picture’s shape
          </button>
        </p>
      )}
      {notes.map((n) => (
        <p key={n.text} className={cx('small size-note', n.level === 'warn' ? 'warn-text' : 'faint')}>
          {n.level !== 'warn' && <Info size={13} />} {n.text}
        </p>
      ))}
    </div>
  )
}

/** Choose LoRAs for the next picture, with the presets saved on the computer. Only for models that can use them. */
export function LoraSection({ target, value, onChange }: { target?: ImageTargetOption; value: LoraSelection[]; onChange: (next: LoraSelection[]) => void }) {
  const files = useImages((s) => s.loraFiles)
  const meta = useApp((s) => s.settings?.image.loraMeta)
  const presets = useApp((s) => s.settings?.image.loraPresets) ?? []
  const toast = useApp((s) => s.toast)
  const canUse = !!target?.supportsLora
  const free = files.filter((f) => !value.some((v) => v.id === f.id))
  const patch = (id: string, p: Partial<LoraSelection>) => onChange(value.map((v) => (v.id === id ? { ...v, ...p } : v)))
  const add = (id: string) => {
    if (!files.some((f) => f.id === id)) return
    const saved = meta?.[id]
    onChange([...value, { id, strength: saved?.strength ?? DEFAULT_LORA_STRENGTH, trigger: saved?.trigger }])
  }
  const applyPreset = (id: string) => {
    const preset = presets.find((p) => p.id === id)
    if (!preset) return
    const { loras, missing } = applyLoraPreset(preset, files.map((f) => f.id))
    onChange(loras)
    if (missing.length) toast('error', `"${preset.name}" uses ${missing.length === 1 ? 'a LoRA' : 'LoRAs'} that ${missing.length === 1 ? 'is' : 'are'} no longer on your computer: ${missing.join(', ')}.`)
  }
  return (
    <div className="field-group">
      <div className="fld-label">LoRAs</div>
      {!canUse && <p className="small warn-text">LoRAs only work with the built-in engine, so they will not be used with this model.</p>}
      {canUse && presets.length > 0 && (
        <Select value="" onChange={applyPreset} options={[{ value: '', label: 'Apply a preset…' }, ...presets.map((p) => ({ value: p.id, label: `${p.name} (${p.loras.length})` }))]} />
      )}
      {value.map((v) => (
        <LoraRow key={v.id} sel={v} file={files.find((f) => f.id === v.id)} target={target} onChange={(p) => patch(v.id, p)} onRemove={() => onChange(value.filter((x) => x.id !== v.id))} />
      ))}
      {canUse && (
        <Select value="" onChange={add} disabled={free.length === 0} options={[{ value: '', label: files.length === 0 ? 'No LoRAs on your computer yet' : free.length === 0 ? 'All LoRAs added' : 'Add a LoRA…' }, ...free.map((f) => ({ value: f.id, label: f.name }))]} />
      )}
    </div>
  )
}

function LoraRow({ sel, file, target, onChange, onRemove }: { sel: LoraSelection; file?: LoraFile; target?: ImageTargetOption; onChange: (p: Partial<LoraSelection>) => void; onRemove: () => void }) {
  const warn = loraMismatch(file, target)
  const suggestions = (file?.triggers ?? []).filter((t) => t !== sel.trigger).slice(0, 4)
  return (
    <div className="lora-card">
      <div className="row between">
        <span className="lora-name">{file?.name ?? sel.id}</span>
        <button type="button" className="icon-x" aria-label="Remove LoRA" onClick={onRemove}>
          <X size={16} />
        </button>
      </div>
      {!file && <p className="xs warn-text">This file is not on your computer any more.</p>}
      {warn && <p className="xs warn-text">{warn}</p>}
      <div className="row between small">
        <span>Strength</span>
      </div>
      <Slider value={sel.strength} min={-1} max={2} step={0.05} onChange={(v) => onChange({ strength: v })} format={(v) => v.toFixed(2)} />
      <input className="fld" value={sel.trigger ?? ''} placeholder="Trigger words (optional)" aria-label="Trigger words" onChange={(e) => onChange({ trigger: e.target.value || undefined })} />
      {suggestions.length > 0 && (
        <div className="lora-suggest xs faint">
          {suggestions.map((t) => (
            <button key={t} type="button" className="lora-chip" onClick={() => onChange({ trigger: sel.trigger ? `${sel.trigger}, ${t}` : t })}>
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** "Make it bigger when done": pick one of the upscalers on the computer, or none. */
export function UpscaleSection({ usable, value, onChange, width, height }: { usable: UpscalerFile[]; value?: { path: string; repeats: number }; onChange: (v?: { path: string; repeats: number }) => void; width?: number; height?: number }) {
  const chosen = usable.find((u) => u.path === value?.path)
  const factor = chosen ? chosen.scale ** (value?.repeats ?? 1) : 0
  return (
    <div className="field-group">
      <div className="fld-label">
        Make it bigger when done {chosen && width && height ? <span className="faint xs">· about {Math.round(width * factor)} × {Math.round(height * factor)}</span> : null}
      </div>
      <Select
        value={value?.path ?? ''}
        onChange={(v) => onChange(v ? { path: v, repeats: value?.repeats ?? 1 } : undefined)}
        options={[{ value: '', label: 'Off' }, ...usable.map((u) => ({ value: u.path, label: `${u.name} · ${u.scale}×${u.style === 'anime' ? ' · anime' : ''}` }))]}
      />
      {value && (
        <>
          <div className="small dim upscale-passes">Passes</div>
          <Slider value={value.repeats} min={1} max={3} onChange={(v) => onChange({ ...value, repeats: v })} format={(v) => `${v}×`} />
        </>
      )}
      {chosen?.style === 'anime' && <p className="xs faint">Made for anime and cartoons. For photos, pick realesrgan-x4plus.</p>}
    </div>
  )
}
