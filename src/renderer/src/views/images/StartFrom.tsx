import { Brush, FolderOpen, ImagePlus, Images, Pencil, Replace, X } from 'lucide-react'
import { useRef } from 'react'
import { stepsRun, strengthLabel } from '@shared/img2img'
import type { ImageRecord } from '@shared/types'
import { Button, Disclosure, Field, IconButton, Segmented, Slider } from '@/components/ui'
import { mediaUrl } from '@/lib/api'
import { firstPicture } from '@/lib/pictureFile'
import type { StartMode } from '@/store/images'

interface Props {
  mode: StartMode
  onMode(m: StartMode): void
  /** The model chosen can start from a picture, and can repaint just part of it. */
  imageOk: boolean
  maskOk: boolean
  /** Why not, when it cannot. */
  unsupportedHint?: string
  init?: ImageRecord
  strength: number
  /** Steps the picture will be made with, for the "about N steps" line. */
  steps?: number
  onStrength(v: number): void
  mask?: { preview: string; coverage: number }
  inpaintArea: 'masked' | 'whole'
  feather: number
  padding: number
  onEditMask(): void
  onClearMask(): void
  onInpaint(patch: { inpaintArea?: 'masked' | 'whole'; feather?: number; padding?: number }): void
  onClearPicture(): void
  /** A file from disk (browse, drop or paste). */
  onPick(file: File): void
  /** Open the list of pictures already made. */
  onChoose(): void
}

const HINTS: Record<StartMode, string> = {
  text: 'Draws a new picture from your words alone.',
  image: 'Starts from a picture, and moves away from it as far as you say.',
  mask: 'Paint the part to change. The rest of the picture stays exactly as it is.'
}

/**
 * The "Start from" part of the create panel. Three clear modes: words only, a starting picture, or a picture with
 * just the painted part repainted. Everything for the chosen mode is right under the switch.
 */
export function StartFrom(p: Props) {
  const input = useRef<HTMLInputElement>(null)
  const { mode, init } = p

  const options: { value: StartMode; label: string; title?: string; disabled?: boolean }[] = [
    { value: 'text', label: 'Text', title: 'Make a new picture from your words alone' },
    { value: 'image', label: 'Picture', title: p.imageOk ? 'Start from a picture and change it as far as you like (image to image)' : p.unsupportedHint, disabled: !p.imageOk },
    { value: 'mask', label: 'Mask', title: p.maskOk ? 'Change only the part you paint; the rest stays exactly as it is (inpainting)' : (p.unsupportedHint ?? 'This model cannot use a mask. Built-in and AUTOMATIC1111 models can.'), disabled: !p.maskOk }
  ]

  return (
    <Field label="Start from" hint={mode === 'text' ? undefined : init ? `${init.width} × ${init.height}${init.imported ? ' · from a file' : ''}` : undefined}>
      <Segmented size="sm" fill value={mode} onChange={p.onMode} options={options} />
      <div className="faint xs start-hint">{p.unsupportedHint && mode === 'text' && !p.imageOk ? p.unsupportedHint : HINTS[mode]}</div>

      {mode !== 'text' && !init && (
        <div className="start-drop">
          <ImagePlus size={20} />
          <strong>Choose a starting picture</strong>
          <span className="faint xs">Drop one here, paste it, or pick one.</span>
          <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
            <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => input.current?.click()}>
              Browse files…
            </Button>
            <Button size="sm" icon={<Images size={14} />} onClick={p.onChoose}>
              From your pictures
            </Button>
          </div>
        </div>
      )}

      {mode !== 'text' && init && (
        <div className="start-pic">
          <div className="start-stage">
            <div className="start-frame">
              <img src={mediaUrl('thumb', init.thumb)} alt="The starting picture" draggable={false} />
              {mode === 'mask' && p.mask && <span className="start-mask" style={{ ['--mask' as string]: `url(${p.mask.preview})` }} aria-hidden />}
              {mode === 'mask' && (
                <button type="button" className="start-paint" onClick={p.onEditMask} aria-label={p.mask ? 'Edit the mask' : 'Paint the part to change'}>
                  {!p.mask && (
                    <span>
                      <Brush size={15} /> Paint the part to change
                    </span>
                  )}
                </button>
              )}
            </div>
          </div>
          <div className="start-tools">
            <Button size="sm" variant="ghost" icon={<Replace size={14} />} onClick={() => input.current?.click()} title="Choose another file">
              Replace
            </Button>
            <Button size="sm" variant="ghost" icon={<Images size={14} />} onClick={p.onChoose} title="Choose from the pictures you have made">
              Gallery
            </Button>
            <span className="grow" />
            <IconButton label="Remove the starting picture" size="sm" onClick={p.onClearPicture}>
              <X size={15} />
            </IconButton>
          </div>

          {mode === 'mask' && p.mask && (
            <div className="start-maskbar">
              <span className="grow small" title="Only the painted part is repainted">
                Painted: {Math.max(1, Math.round(p.mask.coverage * 100))}% of it
              </span>
              <Button size="sm" icon={<Pencil size={13} />} onClick={p.onEditMask}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={p.onClearMask}>
                Clear
              </Button>
            </div>
          )}

          <div className="start-strength">
            <div className="small dim">
              {mode === 'mask' ? 'How much to repaint' : 'How far to move away from it'}
              {p.steps ? (
                <span className="faint">
                  {' '}
                  · about {stepsRun(p.steps, p.strength)} of {p.steps} steps
                </span>
              ) : null}
            </div>
            <Slider value={p.strength} min={0.05} max={1} step={0.05} onChange={p.onStrength} format={(v) => v.toFixed(2)} />
            <div className="faint xs">{strengthLabel(p.strength)}</div>
          </div>

          {mode === 'mask' && p.mask && (
            <Disclosure id="mask-settings" title="Mask settings" summary={`${p.inpaintArea === 'masked' ? 'Just that area' : 'Whole picture'} · soft edge ${p.feather === 0 ? 'off' : `${p.feather}px`}`}>
              <div className="stack" style={{ gap: 10 }}>
                <div>
                  <div className="small dim" style={{ marginBottom: 6 }}>
                    Repaint
                  </div>
                  <Segmented
                    size="sm"
                    fill
                    value={p.inpaintArea}
                    onChange={(v) => p.onInpaint({ inpaintArea: v })}
                    options={[
                      { value: 'masked', label: 'Just that area', title: 'The engine sees only the area and a margin, enlarged, so small areas get full detail' },
                      { value: 'whole', label: 'Whole picture', title: 'The engine sees the whole picture and only the painted part of its result is used' }
                    ]}
                  />
                  <div className="faint xs" style={{ marginTop: 6 }}>
                    {p.inpaintArea === 'masked' ? 'Best for small areas such as a face or an object: they get as much detail as a whole picture. The Size buttons set how detailed.' : 'Best for large areas, or when the change must fit the whole scene.'}
                  </div>
                </div>
                <div>
                  <div className="small dim">Soft edge</div>
                  <Slider value={p.feather} min={0} max={64} step={1} onChange={(v) => p.onInpaint({ feather: v })} format={(v) => (v === 0 ? 'off' : `${v}px`)} />
                </div>
                {p.inpaintArea === 'masked' && (
                  <div>
                    <div className="small dim">Margin around it</div>
                    <Slider value={p.padding} min={0} max={256} step={8} onChange={(v) => p.onInpaint({ padding: v })} format={(v) => `${v}px`} />
                    <div className="faint xs">How much of the surroundings the engine can see. More helps it match the scene.</div>
                  </div>
                )}
              </div>
            </Disclosure>
          )}
        </div>
      )}

      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = firstPicture(e.target.files)
          e.target.value = ''
          if (f) p.onPick(f)
        }}
      />
    </Field>
  )
}
