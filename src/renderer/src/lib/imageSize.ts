import { type SizeArch, guessSizeArch, profileFor } from '@shared/imageSize'
import { sizeLikePicture } from '@shared/img2img'
import type { ImageTargetOption } from '@shared/types'

export type Ratio = 'auto' | '1:1' | '3:4' | '4:3' | '16:9' | '9:16' | 'custom'

export const RATIOS: { id: Ratio; label: string; rw: number; rh: number }[] = [
  { id: 'auto', label: 'Auto', rw: 1, rh: 1 },
  { id: '1:1', label: '1:1', rw: 1, rh: 1 },
  { id: '3:4', label: '3:4', rw: 3, rh: 4 },
  { id: '4:3', label: '4:3', rw: 4, rh: 3 },
  { id: '16:9', label: '16:9', rw: 16, rh: 9 },
  { id: '9:16', label: '9:16', rw: 9, rh: 16 },
  { id: 'custom', label: 'Custom', rw: 1, rh: 1 }
]

/** Sizes relative to what the model is set up for. */
export const SCALES: { value: number; label: string }[] = [
  { value: 0.75, label: 'Small' },
  { value: 1, label: 'Default' },
  { value: 1.5, label: 'Large' },
  { value: 2, label: 'Huge' }
]

export const SAMPLERS = ['euler_a', 'euler', 'heun', 'dpm2', 'dpm++2s_a', 'dpm++2m', 'dpm++2mv2', 'lcm']

const round64 = (n: number) => Math.max(256, Math.min(2048, Math.round(n / 64) * 64))

export interface SizeForm {
  ratio: Ratio
  customW: number
  customH: number
  scale?: number
}

/** What kind of model this is, from what the app knows (built-in engine) or can tell from the name. */
export function archOf(target?: ImageTargetOption): { arch: SizeArch | 'custom' | undefined; guessed: boolean } {
  if (!target) return { arch: undefined, guessed: false }
  if (target.kind === 'builtin' && target.arch && target.arch !== 'custom') return { arch: target.arch, guessed: false }
  const g = guessSizeArch(`${target.label} ${target.model}`)
  return g === 'other' ? { arch: undefined, guessed: false } : { arch: g, guessed: true }
}

/** The side length the model is set up for, as a square would measure it. */
export function nativeSide(target?: ImageTargetOption): number {
  const d = target?.defaults
  if (d) return Math.sqrt(d.width * d.height)
  const { arch } = archOf(target)
  return profileFor(arch, target?.label)?.native ?? 1024
}

/** Pixel size for the chosen shape and size. 0 × 0 means "let the model use its own default". */
export function resolveSize(form: SizeForm, target?: ImageTargetOption, like?: { width: number; height: number }): { width: number; height: number } {
  if (form.ratio === 'custom') return { width: form.customW, height: form.customH }
  const scale = form.scale ?? 1
  // Starting from a picture, "Auto" takes the picture's own shape so it is not stretched.
  if (form.ratio === 'auto' && like && like.width > 0 && like.height > 0) {
    const d = target?.defaults
    const area = (d ? d.width * d.height : nativeSide(target) ** 2) * scale * scale
    return sizeLikePicture(like, area, 16)
  }
  if (form.ratio === 'auto' && scale === 1) return { width: 0, height: 0 }
  const d = target?.defaults
  const r = RATIOS.find((x) => x.id === form.ratio) ?? RATIOS[1]
  const aspect = form.ratio === 'auto' ? (d ? d.width / d.height : 1) : r.rw / r.rh
  const w = nativeSide(target) * scale * Math.sqrt(aspect)
  return { width: round64(w), height: round64(w / aspect) }
}

export function describeSize(form: SizeForm, target?: ImageTargetOption, like?: { width: number; height: number }): string {
  const s = resolveSize(form, target, like)
  if (form.ratio === 'auto' && like && s.width > 0) return `${s.width} × ${s.height} (the shape of your starting picture)`
  if (s.width === 0) return target?.defaults ? `${target.defaults.width} × ${target.defaults.height} (model default)` : 'Model default'
  return `${s.width} × ${s.height}`
}
