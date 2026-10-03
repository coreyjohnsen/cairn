import { ImagePlus, PaintBucket, Pencil, Replace, X } from 'lucide-react'
import { useRef } from 'react'
import { stepsRun, strengthLabel } from '@shared/img2img'
import type { ImageRecord } from '@shared/types'
import { mediaUrl } from '@/lib/api'
import { firstPicture } from '@/lib/pictureFile'
import { Button, Field, IconButton, Segmented, Slider } from './ui'

interface Props {
  /** The model chosen can start from a picture. */
  supported: boolean
  /** Why not, when it cannot. */
  unsupportedHint?: string
  init?: ImageRecord
  strength: number
  /** Steps the picture will be made with, for the "about N steps" line. */
  steps?: number
  onStrength(v: number): void
  /** The model chosen can repaint just the part a mask marks. */
  maskSupported: boolean
  mask?: { preview: string; coverage: number }
  inpaintArea: 'masked' | 'whole'
  feather: number
  padding: number
  onEditMask(): void
  onClearMask(): void
  onInpaint(patch: { inpaintArea?: 'masked' | 'whole'; feather?: number; padding?: number }): void
  onClear(): void
  onPick(file: File): void
}

/** The "Starting image" part of the create panel: choose or drop a picture, and how far to move away from it. */
export function StartingImage({ supported, unsupportedHint, init, strength, steps, onStrength, maskSupported, mask, inpaintArea, feather, padding, onEditMask, onClearMask, onInpaint, onClear, onPick }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const choose = () => input.current?.click()

  const chooser = (
    <input
      ref={input}
      type="file"
      accept="image/*"
      hidden
      onChange={(e) => {
        const f = firstPicture(e.target.files)
        e.target.value = ''
        if (f) onPick(f)
      }}
    />
  )

  if (!init) {
    if (!supported) {
      return unsupportedHint ? (
        <Field label="Starting image" hint={unsupportedHint}>
          <span />
        </Field>
      ) : null
    }
    return (
      <Field label="Starting image" hint="Optional">
        <button type="button" className="init-drop" onClick={choose}>
          <ImagePlus size={18} />
          <span>
            <strong>Start from a picture</strong>
            <span className="faint xs">Drop one here, paste it, or browse. Or open any picture in the gallery and press "Start from this".</span>
          </span>
        </button>
        {chooser}
      </Field>
    )
  }

  return (
    <Field label="Starting image">
      <div className="init-card">
        <img src={mediaUrl('thumb', init.thumb)} alt="" draggable={false} />
        <div className="grow">
          <div className="small dim">
            Strength
            {steps ? <span className="faint"> · about {stepsRun(steps, strength)} of {steps} steps</span> : null}
          </div>
          <Slider value={strength} min={0.05} max={1} step={0.05} onChange={onStrength} format={(v) => v.toFixed(2)} />
          <div className="faint xs">{strengthLabel(strength)}</div>
        </div>
        <div className="init-actions">
          <IconButton label="Choose another picture" size="sm" onClick={choose}>
            <Replace size={15} />
          </IconButton>
          <IconButton label="Remove" size="sm" onClick={onClear}>
            <X size={15} />
          </IconButton>
        </div>
      </div>
      {supported && !mask && (
        <div className="mask-row">
          <Button size="sm" icon={<PaintBucket size={14} />} disabled={!maskSupported} onClick={onEditMask} title="Choose which part of the picture to change; the rest stays exactly as it is">
            Change only part of it…
          </Button>
          {!maskSupported && <span className="faint xs">This model cannot use a mask. Built-in and AUTOMATIC1111 models can.</span>}
        </div>
      )}
      {supported && mask && (
        <div className="mask-card">
          <div className="mask-card-head">
            <img className="mask-thumb" src={mask.preview} alt="Mask: the white part will be repainted" />
            <div className="grow">
              <div className="small">Only the painted part changes</div>
              <div className="faint xs">{Math.max(1, Math.round(mask.coverage * 100))}% of the picture</div>
            </div>
            <IconButton label="Edit the mask" size="sm" onClick={onEditMask}>
              <Pencil size={15} />
            </IconButton>
            <IconButton label="Remove the mask" size="sm" onClick={onClearMask}>
              <X size={15} />
            </IconButton>
          </div>
          {!maskSupported && <div className="init-warn xs">This model cannot use a mask. Choose a built-in or AUTOMATIC1111 model, or remove the mask.</div>}
          <div className="small dim" style={{ marginTop: 10 }}>
            Repaint
          </div>
          <Segmented
            size="sm"
            value={inpaintArea}
            onChange={(v) => onInpaint({ inpaintArea: v })}
            options={[
              { value: 'masked', label: 'Just that area', title: 'The engine sees only the area and a margin, enlarged, so small areas get full detail' },
              { value: 'whole', label: 'Whole picture', title: 'The engine sees the whole picture and only the painted part of its result is used' }
            ]}
          />
          <div className="faint xs" style={{ marginTop: 6 }}>
            {inpaintArea === 'masked' ? 'Best for small areas such as a face or an object: they get as much detail as a whole picture. The Size buttons set how detailed.' : 'Best for large areas, or when the change must fit the whole scene.'}
          </div>
          <div className="small dim" style={{ marginTop: 10 }}>
            Soft edge
          </div>
          <Slider value={feather} min={0} max={64} step={1} onChange={(v) => onInpaint({ feather: v })} format={(v) => (v === 0 ? 'off' : `${v}px`)} />
          {inpaintArea === 'masked' && (
            <>
              <div className="small dim" style={{ marginTop: 6 }}>
                Margin around it
              </div>
              <Slider value={padding} min={0} max={256} step={8} onChange={(v) => onInpaint({ padding: v })} format={(v) => `${v}px`} />
              <div className="faint xs">How much of the surroundings the engine can see. More helps it match the scene.</div>
            </>
          )}
        </div>
      )}
      {!supported && <div className="init-warn xs">{unsupportedHint ?? 'This model cannot start from a picture, so the picture will be ignored.'}</div>}
      <div className="faint xs" style={{ marginTop: 6 }}>
        {init.width} × {init.height}
        {init.imported ? ' · from a file' : ''}
      </div>
      {chooser}
    </Field>
  )
}
