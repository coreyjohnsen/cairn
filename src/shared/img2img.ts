/**
 * Image-to-image helpers shared by the interface and the engine code: how far to move away from the
 * starting picture, and what size the result should have so the picture is not stretched.
 */
import { MAX_SIDE, MIN_SIDE, snapSize } from './imageSize'

export const STRENGTH_DEFAULT = 0.6
export const STRENGTH_MIN = 0.05
export const STRENGTH_MAX = 1

/** The most a picture can weigh when it is brought in, and its largest side. */
export const IMPORT_MAX_BYTES = 40 * 1024 * 1024
export const IMPORT_MAX_SIDE = 8192

export function clampStrength(v: number | undefined): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : STRENGTH_DEFAULT
  return Math.min(STRENGTH_MAX, Math.max(STRENGTH_MIN, n))
}

/** A short plain-language reading of the strength slider. */
export function strengthLabel(v: number): string {
  if (v < 0.3) return 'Subtle: small touch-ups, the picture stays almost the same'
  if (v < 0.5) return 'Light: same layout and colors, new details'
  if (v < 0.7) return 'Balanced: keeps the composition, changes a lot of the detail'
  if (v < 0.9) return 'Strong: only the rough layout is kept'
  return 'Reimagine: the picture is barely used'
}

/** Roughly how many of the sampling steps run when starting from a picture. */
export function stepsRun(steps: number, strength: number): number {
  return Math.max(1, Math.round(steps * clampStrength(strength)))
}

/**
 * A size with the same shape as a picture and about the pixel count the model is set up for,
 * rounded to a multiple the model can use. Keeps the picture from being stretched.
 */
export function sizeLikePicture(pic: { width: number; height: number }, nativeArea: number, multiple = 8): { width: number; height: number } {
  const area = nativeArea > 0 ? nativeArea : 1024 * 1024
  const aspect = pic.width > 0 && pic.height > 0 ? pic.width / pic.height : 1
  const w = Math.sqrt(area * aspect)
  const h = w / aspect
  return { width: snapSize(w, multiple, MIN_SIDE, MAX_SIDE), height: snapSize(h, multiple, MIN_SIDE, MAX_SIDE) }
}

/** The shape asked for is noticeably different from the picture's, so the picture would be stretched or squeezed. */
export function shapeDiffers(pic: { width: number; height: number }, width: number, height: number, tolerance = 0.03): boolean {
  if (!(pic.width > 0 && pic.height > 0 && width > 0 && height > 0)) return false
  const a = pic.width / pic.height
  const b = width / height
  return Math.abs(a - b) / a > tolerance
}

/** Scale down to fit within `max` on the longest side, never up. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= max) return { width, height }
  const k = max / longest
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}
