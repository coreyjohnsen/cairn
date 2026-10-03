import { useMemo } from 'react'
import { invoke } from '@/lib/api'
import { errorText } from '@/lib/format'
import { resolveSize } from '@/lib/imageSize'
import { useApp } from '@/store/app'
import { targetKeyOf, useImages } from '@/store/images'
import { defaultUpscaler } from '@shared/imagePrefs'
import type { ImageGenRequest } from '@shared/types'
import { usableUpscalers } from '@/components/LoraPicker'

/**
 * What the Image Hub's controls add up to: the model chosen, whether a picture is being edited, what the next
 * picture will be made with, why Generate cannot be pressed yet, and `submit`. Shared by the create panel and
 * the editor under the big picture, so both always do the same thing.
 */
export function useHub() {
  const settings = useApp((s) => s.settings)!
  const toast = useApp((s) => s.toast)
  const form = useImages((s) => s.form)
  const targets = useImages((s) => s.targets)
  const records = useImages((s) => s.records)
  const upscalers = useImages((s) => s.upscalers)
  const generate = useImages((s) => s.generate)
  const busyJobs = useImages((s) => Object.values(s.jobs).filter((j) => j.status === 'queued' || j.status === 'running').length)

  const def = settings.image.defaultTarget
  const target =
    targets.find((t) => targetKeyOf(t) === form.targetKey) ??
    (def ? targets.find((t) => t.backendId === def.backendId && t.model === def.model && t.available) : undefined) ??
    targets.find((t) => t.available) ??
    targets[0]
  const ready = !!target?.available

  const mode = form.startMode
  const editing = mode === 'edit'
  const pic = form.initImageId ? records.find((r) => r.id === form.initImageId) : undefined
  const imageOk = !!target?.supportsImg2Img
  const maskOk = imageOk && !!target?.supportsMask
  const init = editing ? pic : undefined
  const img2img = !!init && imageOk
  const like = init ? { width: init.width, height: init.height } : undefined
  const unsupportedHint = target && !imageOk ? `${target.backendName} cannot start from a picture. Choose a built-in or AUTOMATIC1111 model.` : undefined

  const d = target?.defaults
  const size0 = resolveSize(form, target, like)
  const negative = form.negative ?? settings.image.negativePrompt

  // Steps and guidance the user saved for this model come first, then the model's own.
  const modelKey = target ? targetKeyOf(target) : ''
  const saved = settings.image.modelDefaults?.[modelKey]
  const stepsDefault = saved?.steps ?? d?.steps
  const cfgDefault = saved?.cfg ?? d?.cfg

  // "Upscale when done" is on with realesrgan-x4plus once it is installed, unless the user switched it off.
  const defUp = settings.image.upscaleByDefault !== false ? defaultUpscaler(upscalers) : undefined
  const upscaleValue = form.upscale ?? (form.upscaleOff || !defUp ? undefined : { path: defUp.path, repeats: 1 })
  const upscaleIsDefault = !form.upscale && !!upscaleValue
  const usable = usableUpscalers(target, upscalers)
  const chosenUpscaler = usable.find((u) => u.path === upscaleValue?.path)

  // Why Generate cannot be pressed yet, in words.
  const blocked = useMemo(
    () =>
      !form.prompt.trim()
        ? editing
          ? 'Describe what the picture should become.'
          : 'Describe the picture to make it.'
        : !ready
          ? 'Choose an image model that is ready.'
          : editing && !imageOk
            ? (unsupportedHint ?? 'This model cannot start from a picture.')
            : editing && !pic
              ? 'Choose a picture to edit, or switch to Text.'
              : editing && !!form.mask && !maskOk
                ? 'This model cannot repaint just part of a picture. Choose a built-in or AUTOMATIC1111 model, or clear the paint.'
                : null,
    [form.prompt, form.mask, editing, ready, imageOk, maskOk, pic, unsupportedHint]
  )

  const submit = async (): Promise<string | null> => {
    if (!target || blocked) return null
    // The painting canvas saves its mask a moment after the last stroke; make sure that has happened.
    await useImages.getState().maskFlush?.()
    const f = useImages.getState().form
    const prompt = f.prompt.trim()
    const size = resolveSize(f, target, img2img ? like : undefined)
    // A mask is sent first and the request then points at it, so the picture-sized data does not travel with the job.
    let inpaint: ImageGenRequest['inpaint']
    if (img2img && f.mask) {
      if (!maskOk) {
        toast('error', `${target.backendName} cannot use a mask. Choose a built-in or AUTOMATIC1111 model, or clear the paint.`)
        return null
      }
      try {
        const { maskId } = await invoke('images:setMask', f.mask.png)
        inpaint = { maskId, area: f.inpaintArea, feather: f.feather, padding: f.padding }
      } catch (e) {
        toast('error', errorText(e))
        return null
      }
    }
    const id = await generate({
      prompt,
      negativePrompt: target.supportsNegative && negative.trim() ? negative.trim() : undefined,
      target: { backendId: target.backendId, model: target.model },
      width: size.width,
      height: size.height,
      steps: f.steps,
      cfgScale: f.cfg,
      sampler: f.sampler,
      seed: f.seed,
      count: f.count,
      initImageId: img2img ? f.initImageId : undefined,
      strength: img2img ? f.strength : undefined,
      inpaint,
      loras: target.supportsLora && f.loras.length ? f.loras : undefined,
      upscale: upscaleValue && (target.supportsLora || upscalers.find((u) => u.path === upscaleValue.path)?.engine === 'esrgan') ? upscaleValue : undefined
    })
    // A picture made from the editor shows up in the editor, next to the one it started from.
    if (id && img2img) useImages.getState().setEditJob(id)
    return id
  }

  return {
    settings, form, target, ready, mode, editing, pic, init, imageOk, maskOk, img2img, like, unsupportedHint, d, size0, negative,
    saved, stepsDefault, cfgDefault, upscaleValue, upscaleIsDefault, usable, chosenUpscaler, blocked, busyJobs, submit
  }
}
