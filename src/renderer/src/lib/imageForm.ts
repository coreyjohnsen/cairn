import type { ImageRecord, LoraSelection } from '@shared/types'
import type { Ratio } from './imageSize'

/**
 * What the next picture starts from: only the words, or a picture being edited in the big view. While editing, paint
 * the part to change (nothing painted redoes the whole picture) and describe the change under the picture.
 */
export type StartMode = 'text' | 'edit'

/** The Image Hub's create panel. Lives in the store so "reuse settings" from anywhere can fill it in. */
export interface HubForm {
  prompt: string
  /** undefined = the default negative prompt from settings */
  negative?: string
  /** `${backendId}::${model}`; empty = default target */
  targetKey: string
  ratio: Ratio
  customW: number
  customH: number
  /** Multiplier on the model's own size, used with the shape buttons. */
  scale: number
  steps?: number
  cfg?: number
  sampler?: string
  seed: number
  count: number
  /** `text` ignores the starting picture, which stays chosen in case the person switches back. */
  startMode: StartMode
  initImageId?: string
  strength: number
  /** Part of the starting picture to repaint: white where it changes. Only for the picture it was painted on. */
  mask?: { png: Uint8Array; preview: string; coverage: number }
  /** Send only the masked part (sharper detail) or the whole picture to the engine. */
  inpaintArea: 'masked' | 'whole'
  /** Width of the soft edge where new meets old, in pixels of the starting picture. */
  feather: number
  /** Margin kept around the mask when only the masked part is sent. */
  padding: number
  /** LoRAs to apply (built-in engine only). */
  loras: LoraSelection[]
  /** Make the finished picture bigger with this upscaler. */
  upscale?: { path: string; repeats: number }
  /** The user switched "Upscale when done" off, so the default upscaler is not applied. */
  upscaleOff?: boolean
}

export const DEFAULT_FORM: HubForm = { prompt: '', targetKey: '', ratio: 'auto', customW: 1024, customH: 1024, scale: 1, seed: -1, count: 1, startMode: 'text', strength: 0.6, inpaintArea: 'masked', feather: 12, padding: 64, loras: [] }

/** The form after a change. Picking a different picture to edit means the paint (made for the old one) no longer applies. */
export function formAfterPatch(form: HubForm, patch: Partial<HubForm>): { form: HubForm; newBase: boolean } {
  const newBase = 'initImageId' in patch && patch.initImageId !== form.initImageId
  return { form: { ...form, ...patch, ...(newBase && !('mask' in patch) ? { mask: undefined } : {}) }, newBase }
}

/**
 * Whether "reuse settings" (or "edit") puts a picture in the editor: when asked to edit it, and also when the picture was
 * itself made from another one that is still in the gallery, so reusing it brings that starting picture back.
 */
export function startModeFor(rec: Pick<ImageRecord, 'initImageId'>, records: Pick<ImageRecord, 'id'>[], asInit?: boolean): StartMode {
  return asInit || (rec.initImageId && records.some((r) => r.id === rec.initImageId)) ? 'edit' : 'text'
}
