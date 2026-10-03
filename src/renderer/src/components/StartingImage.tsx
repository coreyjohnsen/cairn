import { ImagePlus, Replace, X } from 'lucide-react'
import { useRef } from 'react'
import { stepsRun, strengthLabel } from '@shared/img2img'
import type { ImageRecord } from '@shared/types'
import { mediaUrl } from '@/lib/api'
import { firstPicture } from '@/lib/pictureFile'
import { Field, IconButton, Slider } from './ui'

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
  onClear(): void
  onPick(file: File): void
}

/** The "Starting image" part of the create panel: choose or drop a picture, and how far to move away from it. */
export function StartingImage({ supported, unsupportedHint, init, strength, steps, onStrength, onClear, onPick }: Props) {
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
            Strength {strength.toFixed(2)}
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
      {!supported && <div className="init-warn xs">{unsupportedHint ?? 'This model cannot start from a picture, so the picture will be ignored.'}</div>}
      <div className="faint xs" style={{ marginTop: 6 }}>
        {init.width} × {init.height}
        {init.imported ? ' · from a file' : ''}
      </div>
      {chooser}
    </Field>
  )
}
