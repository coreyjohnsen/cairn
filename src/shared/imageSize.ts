/**
 * What each kind of image model handles well, so the app can round sizes properly and warn before a
 * size that tends to give poor results. Pure functions; used by both the interface and the engine code.
 */

export type SizeArch = 'sd' | 'sdxl' | 'flux' | 'sd3' | 'zimage' | 'other'

export interface SizeProfile {
  arch: SizeArch
  /** Plain-language name used in warnings. */
  label: string
  /** The side length (px) the model was mostly trained at. */
  native: number
  /** Comfortable range of total pixels, in millions. */
  mpMin: number
  mpMax: number
  /** Past this on either side the model is not expected to cope at all. */
  maxSide: number
  /** Width and height must be a multiple of this. */
  multiple: number
}

export interface SizeNote {
  level: 'info' | 'warn'
  text: string
}

export const MIN_SIDE = 64
export const MAX_SIDE = 2048

const mp = (w: number, h: number) => (w * h) / 1_000_000

/** Work out the kind of model from its name. `other` when nothing recognisable is in it. */
export function guessSizeArch(name: string): SizeArch {
  const n = name.toLowerCase()
  if (/flux/.test(n)) return 'flux'
  if (/z[-_ ]?image/.test(n)) return 'zimage'
  if (/sd[-_ ]?3/.test(n)) return 'sd3'
  if (/xl(?![a-z])|pony|illustrious/.test(n)) return 'sdxl'
  if (/sd[-_ ]?v?[12]([-_ .]|$)|sd[-_ ]?(1[45]|2[01])(?![0-9])|v1[-_.][0-5]|v2[-_.][01]|stable[-_ ]diffusion[-_ ]?[12]/.test(n)) return 'sd'
  return 'other'
}

/** The sizes this kind of model is happy with, or null when we know nothing specific. */
export function profileFor(arch: SizeArch | 'custom' | undefined, name = ''): SizeProfile | null {
  const turbo = /turbo|lcm|lightning|hyper/i.test(name)
  switch (arch) {
    case 'sd': {
      const big = /768|sd[-_ ]?2|v2[-_]1/i.test(name) && !turbo
      if (turbo) return { arch: 'sd', label: 'This Turbo model', native: 512, mpMin: 0.15, mpMax: 0.45, maxSide: 768, multiple: 8 }
      return big
        ? { arch: 'sd', label: 'Stable Diffusion 2.x', native: 768, mpMin: 0.3, mpMax: 0.95, maxSide: 1152, multiple: 8 }
        : { arch: 'sd', label: 'Stable Diffusion 1.x', native: 512, mpMin: 0.15, mpMax: 0.62, maxSide: 1024, multiple: 8 }
    }
    case 'sdxl':
      if (/turbo/i.test(name)) return { arch: 'sdxl', label: 'SDXL Turbo', native: 512, mpMin: 0.15, mpMax: 0.45, maxSide: 768, multiple: 8 }
      return { arch: 'sdxl', label: 'SDXL', native: 1024, mpMin: 0.6, mpMax: 1.6, maxSide: 2048, multiple: 8 }
    case 'sd3':
      return { arch: 'sd3', label: 'Stable Diffusion 3', native: 1024, mpMin: 0.5, mpMax: 1.6, maxSide: 2048, multiple: 16 }
    case 'flux':
      return { arch: 'flux', label: 'FLUX', native: 1024, mpMin: 0.25, mpMax: 2.1, maxSide: 2048, multiple: 16 }
    case 'zimage':
      return { arch: 'zimage', label: 'Z-Image', native: 1024, mpMin: 0.25, mpMax: 2.4, maxSide: 2048, multiple: 16 }
    default:
      return null
  }
}

/** Round to a multiple and keep within the supported range. */
export function snapSize(n: number, multiple = 8, min = MIN_SIDE, max = MAX_SIDE): number {
  const m = Math.max(1, multiple)
  const v = Math.round(n / m) * m
  return Math.min(Math.floor(max / m) * m, Math.max(Math.ceil(min / m) * m, v))
}

export interface SizeCheck {
  arch: SizeArch | 'custom' | undefined
  /** Model name, used to spot Turbo and 768 variants. */
  name?: string
  width: number
  height: number
  /** The built-in engine, where the app also controls memory use. */
  builtin?: boolean
  vaeTiling?: boolean
  /** The arch was guessed from a file name rather than known. */
  guessed?: boolean
  /** Where the model runs. OpenAI's own service only offers a few fixed sizes. */
  kind?: 'builtin' | 'comfyui' | 'a1111' | 'openai'
}

/**
 * Plain-language notes about a size for a model. An empty list means nothing to worry about.
 * `width` and `height` are the sizes about to be asked for (not 0).
 */
export function checkSize(c: SizeCheck): SizeNote[] {
  const { width: w, height: h } = c
  if (!(w > 0 && h > 0)) return []
  const notes: SizeNote[] = []
  if (c.kind === 'openai') {
    notes.push({ level: 'info', text: 'OpenAI offers only a few fixed sizes, so it uses the one closest in shape (square, wide or tall). Other OpenAI-compatible servers use the exact size you pick.' })
  }
  const profile = profileFor(c.arch, c.name)
  const area = mp(w, h)
  const long = Math.max(w, h)
  const short = Math.min(w, h)
  const ratio = long / short

  if (profile) {
    const typical = `${profile.native} × ${profile.native}`
    const tuned = c.guessed ? `The name suggests ${profile.label}, which is tuned for` : `${profile.label} is tuned for`
    if (long > profile.maxSide) {
      notes.push({
        level: 'warn',
        text: `${w} × ${h} is larger than ${profile.label} can handle. Expect broken or repeated images, or a failure. Stay under ${profile.maxSide} pixels on the long side${profile.native <= 768 ? ' and upscale afterwards' : ''}.`
      })
    } else if (area > profile.mpMax * 1.4) {
      notes.push({
        level: 'warn',
        text: `${tuned} about ${typical}. At ${w} × ${h} it often repeats subjects, stretches faces and bodies, or loses the composition. Try a smaller size and upscale afterwards.`
      })
    } else if (area > profile.mpMax) {
      notes.push({ level: 'info', text: `This is a little larger than ${profile.label} is tuned for (about ${typical}). It usually works, but small flaws and repeated details become more likely.` })
    } else if (area < profile.mpMin * 0.6) {
      notes.push({
        level: 'warn',
        text: `${tuned} about ${typical}. At ${w} × ${h} pictures tend to look soft and lose detail. Try ${profile.native} for the best result.`
      })
    } else if (area < profile.mpMin) {
      notes.push({ level: 'info', text: `A bit small for ${profile.label} (tuned for about ${typical}). Expect less detail than at full size.` })
    }

    if (ratio > 4) {
      notes.push({ level: 'warn', text: 'Very long, thin shapes like this are where models struggle most. Subjects may be cut off or repeated.' })
    } else if (ratio > 2.5 && profile.arch !== 'flux' && profile.arch !== 'zimage') {
      notes.push({ level: 'info', text: 'This is an extreme shape for this model. A shape closer to 16:9 or 3:4 tends to look better.' })
    }

    const m = profile.multiple
    if (w % m !== 0 || h % m !== 0) {
      notes.push({ level: 'info', text: `${profile.label} needs sizes in multiples of ${m}, so this will be rounded to ${snapSize(w, m)} × ${snapSize(h, m)}.` })
    }
  } else if (long > MAX_SIDE) {
    notes.push({ level: 'warn', text: `${w} × ${h} is beyond the ${MAX_SIDE} pixel limit; it will be reduced.` })
  }

  if (c.builtin) {
    if (area > 3) {
      const fix = c.vaeTiling ? 'VAE tiling is already on, so if it runs out of memory, choose a smaller size.' : 'Turn on VAE tiling for this model (Models, Image models, pencil) or choose a smaller size.'
      notes.push({ level: 'warn', text: `${area.toFixed(1)} megapixels needs a great deal of video memory, and the last decoding step may fail. ${fix}` })
    } else if (area > 2 && !c.vaeTiling) {
      notes.push({ level: 'info', text: `At ${area.toFixed(1)} megapixels the last decoding step needs a lot of video memory. If it runs out, turn on VAE tiling for this model (Models, Image models, pencil).` })
    }
  }

  return notes
}
