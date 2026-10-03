import { BookmarkPlus, FolderOpen, X } from 'lucide-react'
import { useState } from 'react'
import type { ImageTargetOption, LoraFile, LoraSelection } from '@shared/types'
import { newId } from '@shared/defaults'
import { applyLoraPreset } from '@shared/imagePrefs'
import { invoke } from '@/lib/api'
import { errorText } from '@/lib/format'
import { archOf } from '@/lib/imageSize'
import { useApp } from '@/store/app'
import { useImages } from '@/store/images'
import { Button, Field, IconButton, Notice, Select, Slider, TextField } from './ui'
import type { UpscalerFile } from '@shared/types'

const BASE_NAME: Record<NonNullable<LoraFile['base']>, string> = { sd: 'Stable Diffusion 1.x', sdxl: 'SDXL', flux: 'FLUX', sd3: 'Stable Diffusion 3' }
export const DEFAULT_LORA_STRENGTH = 0.8

/** Why a LoRA probably will not work with this model, or null when it looks fine. */
export function loraMismatch(file: LoraFile | undefined, target: ImageTargetOption | undefined): string | null {
  const base = file?.base
  const { arch } = archOf(target)
  if (!file || !base || !arch || arch === 'custom' || !(arch in BASE_NAME)) return null
  if (base === arch) return null
  const how = file.baseGuessed ? 'its file name suggests it is for' : 'it was trained for'
  return `${how} ${BASE_NAME[base]}, but this model is ${BASE_NAME[arch as keyof typeof BASE_NAME]}. It will most likely be ignored or spoil the picture.`
}

/** The LoRA section is shown when the model can use them, or while some are still chosen so they can be removed. */
export const loraSectionShown = (target: ImageTargetOption | undefined, value: LoraSelection[]): boolean => !!target?.supportsLora || value.length > 0

/** The built-in engine can use any listed upscaler; Real-ESRGAN upscalers also work after any other image backend. */
export const usableUpscalers = (target: ImageTargetOption | undefined, upscalers: UpscalerFile[]): UpscalerFile[] => (target?.supportsLora ? upscalers : upscalers.filter((u) => u.engine === 'esrgan'))

function openFolder(kind: 'lora' | 'upscale', toast: (t: 'error', m: string) => void) {
  invoke('images:openFolder', kind).catch((e) => toast('error', errorText(e)))
}

function LoraRow({ sel, file, target, onChange, onRemove }: { sel: LoraSelection; file?: LoraFile; target?: ImageTargetOption; onChange: (p: Partial<LoraSelection>) => void; onRemove: () => void }) {
  const warn = loraMismatch(file, target)
  const suggestions = (file?.triggers ?? []).filter((t) => t !== sel.trigger).slice(0, 4)
  return (
    <div className="lora-row">
      <div className="lora-head">
        <span className="lora-name" title={file?.path ?? sel.id}>
          {file?.name ?? sel.id}
        </span>
        <IconButton label="Remove LoRA" size="sm" onClick={onRemove}>
          <X size={14} />
        </IconButton>
      </div>
      {!file && <div className="xs lora-warn">This file is not in the LoRA folder any more.</div>}
      {warn && <div className="xs lora-warn">{warn}</div>}
      <div className="lora-line">
        <span className="small dim lora-k">Strength</span>
        <Slider value={sel.strength} min={-1} max={2} step={0.05} onChange={(v) => onChange({ strength: v })} format={(v) => v.toFixed(2)} />
      </div>
      <div className="lora-line">
        <span className="small dim lora-k">Trigger</span>
        <TextField className="grow" value={sel.trigger ?? ''} placeholder="Optional" onCommit={(v) => onChange({ trigger: v.trim() || undefined })} ariaLabel="Trigger words" />
      </div>
      {suggestions.length > 0 && (
        <div className="lora-suggest xs faint">
          Suggested from the file:
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

/** Choose LoRAs for the next picture. Only shown for models that can use them. */
export function LoraPicker({ target, value, onChange, bare }: { target?: ImageTargetOption; value: LoraSelection[]; onChange: (next: LoraSelection[]) => void; bare?: boolean }) {
  const files = useImages((s) => s.loraFiles)
  const meta = useApp((s) => s.settings?.image.loraMeta)
  const toast = useApp((s) => s.toast)
  const presets = useApp((s) => s.settings?.image.loraPresets) ?? []
  const update = useApp((s) => s.update)
  const [pick, setPick] = useState('')
  const [applied, setApplied] = useState('')
  const [naming, setNaming] = useState(false)
  const [presetName, setPresetName] = useState('')
  const canUse = !!target?.supportsLora

  if (!canUse && value.length === 0) return null
  const free = files.filter((f) => !value.some((v) => v.id === f.id))

  const add = (id: string) => {
    setPick('')
    const f = files.find((x) => x.id === id)
    if (!f) return
    const saved = meta?.[id]
    onChange([...value, { id, strength: saved?.strength ?? DEFAULT_LORA_STRENGTH, trigger: saved?.trigger }])
  }
  const patch = (id: string, p: Partial<LoraSelection>) => onChange(value.map((v) => (v.id === id ? { ...v, ...p } : v)))

  const applyPreset = (id: string) => {
    const preset = presets.find((p) => p.id === id)
    setApplied(id)
    if (!preset) return
    const { loras, missing } = applyLoraPreset(preset, files.map((f) => f.id))
    onChange(loras)
    if (missing.length) toast('error', `"${preset.name}" uses ${missing.length === 1 ? 'a LoRA' : 'LoRAs'} that ${missing.length === 1 ? 'is' : 'are'} no longer in the LoRA folder: ${missing.join(', ')}.`)
  }
  const savePreset = () => {
    const name = presetName.trim()
    if (!name || value.length === 0) return
    const existing = presets.find((p) => p.name.toLowerCase() === name.toLowerCase())
    const next = { id: existing?.id ?? newId('preset-'), name, loras: value.map((v) => ({ id: v.id, strength: v.strength, ...(v.trigger ? { trigger: v.trigger } : {}) })) }
    update((s) => ({ image: { ...s.image, loraPresets: existing ? (s.image.loraPresets ?? []).map((p) => (p.id === existing.id ? next : p)) : [...(s.image.loraPresets ?? []), next] } }))
    toast('ok', `${existing ? 'Updated' : 'Saved'} the preset "${name}".`)
    setApplied(next.id)
    setNaming(false)
    setPresetName('')
  }

  return (
    <Field label={bare ? undefined : 'LoRAs'} hint={bare ? undefined : value.length ? `${value.length} in use` : undefined}>
      <div className="stack" style={{ gap: 10 }}>
        {!canUse && (
          <Notice tone="warn" action={<Button size="sm" onClick={() => onChange([])}>Remove</Button>}>
            LoRAs only work with the built-in engine, so they will not be used with this model.
          </Notice>
        )}
        {canUse && (presets.length > 0 || value.length > 0) && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="row">
              <Select
                className="grow"
                value={applied && presets.some((p) => p.id === applied) ? applied : ''}
                onChange={applyPreset}
                disabled={presets.length === 0}
                options={[{ value: '', label: presets.length === 0 ? 'No presets saved yet' : 'Apply a preset…' }, ...presets.map((p) => ({ value: p.id, label: `${p.name} (${p.loras.length})` }))]}
              />
              <IconButton label="Save these LoRAs as a preset" size="sm" disabled={value.length === 0} onClick={() => setNaming((n) => !n)}>
                <BookmarkPlus size={15} />
              </IconButton>
            </div>
            {naming && (
              <div className="row">
                <TextField className="grow" value={presetName} onDraft={setPresetName} onCommit={setPresetName} placeholder="Preset name" ariaLabel="Preset name" autoFocus onEnter={savePreset} />
                <Button size="sm" variant="primary" disabled={!presetName.trim()} onClick={savePreset}>
                  Save
                </Button>
              </div>
            )}
            {naming && presets.some((p) => p.name.toLowerCase() === presetName.trim().toLowerCase()) && <div className="xs faint">A preset with this name exists and will be replaced.</div>}
          </div>
        )}
        {canUse &&
          value.map((v) => <LoraRow key={v.id} sel={v} file={files.find((f) => f.id === v.id)} target={target} onChange={(p) => patch(v.id, p)} onRemove={() => onChange(value.filter((x) => x.id !== v.id))} />)}
        {canUse && (
          <div className="row">
            <Select
              className="grow"
              value={pick}
              onChange={add}
              disabled={free.length === 0}
              options={[{ value: '', label: files.length === 0 ? 'No LoRAs yet' : free.length === 0 ? 'All LoRAs added' : 'Add a LoRA…' }, ...free.map((f) => ({ value: f.id, label: f.name }))]}
            />
            <IconButton label="Open the LoRA folder" size="sm" onClick={() => openFolder('lora', toast)}>
              <FolderOpen size={15} />
            </IconButton>
          </div>
        )}
        {canUse && files.length === 0 && <div className="xs faint">Put LoRA files (.safetensors) in the LoRA folder, or download them from Models, Image models, Find more. Then press the folder button to open it.</div>}
      </div>
    </Field>
  )
}

/** "Upscale when done": pick one of the upscaler files, or none. */
export function UpscalePicker({ target, value, onChange, width, height, isDefault, bare }: { target?: ImageTargetOption; value?: { path: string; repeats: number }; onChange: (v?: { path: string; repeats: number }) => void; width?: number; height?: number; isDefault?: boolean; bare?: boolean }) {
  const upscalers = useImages((s) => s.upscalers)
  const toast = useApp((s) => s.toast)
  const usable = usableUpscalers(target, upscalers)
  if (!target || (!target.supportsLora && usable.length === 0)) return null
  const chosen = usable.find((u) => u.path === value?.path)
  const factor = chosen ? chosen.scale ** (value?.repeats ?? 1) : 0
  return (
    <Field label={bare ? undefined : 'Upscale when done'} hint={chosen && width && height ? `About ${Math.round(width * factor)} × ${Math.round(height * factor)}` : undefined}>
      <div className="stack" style={{ gap: 8 }}>
        <div className="row">
          <Select
            className="grow"
            value={value?.path ?? ''}
            onChange={(v) => onChange(v ? { path: v, repeats: value?.repeats ?? 1 } : undefined)}
            options={[{ value: '', label: usable.length ? 'Off' : 'Off (no upscalers yet)' }, ...usable.map((u) => ({ value: u.path, label: `${u.name} · ${u.scale}×${u.style === 'anime' ? ' · anime' : ''}` }))]}
          />
          <IconButton label="Open the upscaler folder" size="sm" onClick={() => openFolder('upscale', toast)}>
            <FolderOpen size={15} />
          </IconButton>
        </div>
        {value && (
          <div className="row">
            <span className="small dim">Passes</span>
            <div className="grow">
              <Slider value={value.repeats} min={1} max={3} onChange={(v) => onChange({ ...value, repeats: v })} format={(v) => `${v}×`} />
            </div>
          </div>
        )}
        {usable.length === 0 && <div className="xs faint">Install the upscaler under Models, Image models, Upscalers (one click), or put upscaler files in the upscaler folder.</div>}
        {isDefault && chosen && <div className="xs faint">On by default. Choose Off to skip it for this picture; Models, Image models, Upscalers turns the default off.</div>}
        {chosen?.style === 'anime' && <div className="xs faint">This model is made for anime and cartoons. For photos and realistic pictures, pick realesrgan-x4plus.</div>}
      </div>
    </Field>
  )
}
