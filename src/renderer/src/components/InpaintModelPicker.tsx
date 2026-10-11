import type { ImageTargetOption } from '@shared/types'
import { type HubForm, targetKeyOf } from '@/store/images'
import { Select } from './ui'

/**
 * Which model draws the painted part: the one chosen for the picture, or one of the inpainting models set up under
 * Models, Image models. Inpainting models are trained to fill a hole so it matches what is around it.
 */
export function InpaintModelPicker({ form, setForm, target, choices }: { form: HubForm; setForm: (p: Partial<HubForm>) => void; target?: ImageTargetOption; choices: ImageTargetOption[] }) {
  const value = choices.some((t) => targetKeyOf(t) === form.inpaintTargetKey) ? (form.inpaintTargetKey as string) : ''
  const same = target && target.inpaint
  return (
    <div>
      <div className="small dim inpaint-model-label">Model for the painted part</div>
      <Select
        value={value}
        onChange={(v) => setForm({ inpaintTargetKey: v || undefined })}
        disabled={choices.length === 0}
        options={[{ value: '', label: target ? `Same as the picture (${target.label})` : 'Same as the picture' }, ...choices.map((t) => ({ value: targetKeyOf(t), label: `${t.label} · inpainting` }))]}
      />
      <div className="faint xs inpaint-model-label">
        {choices.length === 0
          ? 'No inpainting models yet. Add one under Models, Image models, Inpainting models: they blend a repainted part into the rest much better.'
          : value || same
            ? 'An inpainting model sees the rest of the picture and fills the paint to match it.'
            : 'Choose an inpainting model for the best match between new and old.'}
      </div>
    </div>
  )
}
