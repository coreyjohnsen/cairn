import { describe, expect, it } from 'vitest'
import { checkSize, guessSizeArch, profileFor, snapSize } from '../src/shared/imageSize'
import { archOf, describeSize, nativeSide, resolveSize } from '../src/renderer/src/lib/imageSize'
import type { ImageTargetOption } from '../src/shared/types'

const sdxl: ImageTargetOption = {
  backendId: 'builtin',
  backendName: 'Built-in',
  kind: 'builtin',
  model: 'a',
  label: 'Juggernaut XL',
  supportsImg2Img: true,
  supportsNegative: true,
  defaults: { width: 1024, height: 1024, steps: 25, cfg: 6, sampler: 'euler' },
  arch: 'sdxl',
  vaeTiling: false,
  available: true
}
const sd15: ImageTargetOption = { ...sdxl, label: 'Dreamshaper 8', arch: 'sd', defaults: { width: 512, height: 512, steps: 25, cfg: 7, sampler: 'euler' } }

const levels = (n: ReturnType<typeof checkSize>) => n.map((x) => x.level)

describe('guessSizeArch', () => {
  it.each([
    ['flux1-dev-Q4_K_S.gguf', 'flux'],
    ['z_image_turbo-Q8_0', 'zimage'],
    ['Z-Image Turbo', 'zimage'],
    ['sd3.5_medium', 'sd3'],
    ['juggernautXL_v9', 'sdxl'],
    ['sd_xl_base_1.0', 'sdxl'],
    ['ponyDiffusionV6XL', 'sdxl'],
    ['v1-5-pruned-emaonly', 'sd'],
    ['sd-v1-4', 'sd'],
    ['v2-1_768-ema-pruned', 'sd'],
    ['mystery_model', 'other']
  ])('%s -> %s', (name, arch) => expect(guessSizeArch(name)).toBe(arch))
})

describe('snapSize', () => {
  it('rounds to the multiple and stays in range', () => {
    expect(snapSize(1008, 16)).toBe(1008)
    expect(snapSize(1000, 16)).toBe(1008)
    expect(snapSize(1005, 16)).toBe(1008)
    expect(snapSize(519, 8)).toBe(520)
    expect(snapSize(10, 8)).toBe(64)
    expect(snapSize(5000, 16)).toBe(2048)
    expect(snapSize(2047, 16)).toBe(2048)
  })
})

describe('checkSize', () => {
  const base = { builtin: true, vaeTiling: false }

  it('says nothing about a size the model is happy with', () => {
    expect(checkSize({ ...base, arch: 'sdxl', width: 1024, height: 1024 })).toEqual([])
    expect(checkSize({ ...base, arch: 'sd', width: 512, height: 512 })).toEqual([])
    expect(checkSize({ ...base, arch: 'sdxl', width: 1216, height: 832 })).toEqual([])
    expect(checkSize({ ...base, arch: 'flux', width: 1344, height: 768 })).toEqual([])
    expect(checkSize({ ...base, arch: 'zimage', width: 1024, height: 1536 })).toEqual([])
  })

  it('warns when Stable Diffusion 1.x is pushed far past 512', () => {
    const n = checkSize({ ...base, arch: 'sd', name: 'Dreamshaper 8', width: 1024, height: 1024 })
    expect(levels(n)).toContain('warn')
    expect(n[0].text).toMatch(/repeats subjects|larger than/)
  })

  it('warns when SDXL is used tiny, and mildly when only a bit over', () => {
    expect(levels(checkSize({ ...base, arch: 'sdxl', width: 512, height: 512 }))).toEqual(['warn'])
    expect(levels(checkSize({ ...base, arch: 'sdxl', width: 1280, height: 1280 }))).toEqual(['info'])
  })

  it('warns when the long side is beyond what the model can do', () => {
    const n = checkSize({ ...base, arch: 'sd', width: 1536, height: 512 })
    expect(n[0].level).toBe('warn')
    expect(n[0].text).toMatch(/larger than/)
    expect(n[0].text).toMatch(/upscale/)
  })

  it('treats Turbo variants as small-image models', () => {
    expect(checkSize({ ...base, arch: 'sdxl', name: 'SDXL Turbo', width: 512, height: 512 })).toEqual([])
    expect(levels(checkSize({ ...base, arch: 'sdxl', name: 'SDXL Turbo', width: 1024, height: 1024 }))).toContain('warn')
  })

  it('notes extreme shapes', () => {
    expect(levels(checkSize({ ...base, arch: 'sdxl', width: 1664, height: 384 }))).toContain('warn')
    expect(checkSize({ ...base, arch: 'sdxl', width: 1536, height: 576 }).some((n) => /extreme shape/.test(n.text))).toBe(true)
  })

  it('says when a size will be rounded', () => {
    const n = checkSize({ ...base, arch: 'flux', width: 1000, height: 1000 })
    expect(n.some((x) => /multiples of 16/.test(x.text) && /1008 × 1008/.test(x.text))).toBe(true)
    expect(checkSize({ ...base, arch: 'flux', width: 1008, height: 1008 })).toEqual([])
  })

  it('mentions VAE tiling for big built-in renders, and not when tiling is already on', () => {
    expect(checkSize({ ...base, arch: 'flux', width: 1792, height: 1792 }).some((n) => /Turn on VAE tiling/.test(n.text))).toBe(true)
    expect(checkSize({ ...base, arch: 'flux', width: 1536, height: 1536 }).some((n) => /VAE tiling/.test(n.text))).toBe(true)
    expect(checkSize({ ...base, vaeTiling: true, arch: 'flux', width: 1792, height: 1792 }).some((n) => /Turn on VAE tiling/.test(n.text))).toBe(false)
    expect(checkSize({ ...base, vaeTiling: true, arch: 'flux', width: 1536, height: 1536 }).some((n) => /VAE tiling/.test(n.text))).toBe(false)
    expect(checkSize({ ...base, arch: 'flux', width: 2048, height: 2048 }).some((n) => n.level === 'warn' && /VAE tiling/.test(n.text))).toBe(true)
  })

  it('stays quiet about models it knows nothing about, except for the hard limit', () => {
    expect(checkSize({ arch: undefined, width: 1536, height: 1536 })).toEqual([])
    expect(levels(checkSize({ arch: undefined, width: 3000, height: 1000 }))).toEqual(['warn'])
    expect(checkSize({ arch: 'custom', width: 640, height: 640 })).toEqual([])
  })

  it('says it is going by the name when the type was guessed', () => {
    const n = checkSize({ arch: 'sd', guessed: true, width: 1024, height: 1024 })
    expect(n[0].text).toMatch(/name suggests/)
  })

  it('explains that OpenAI picks the nearest fixed size', () => {
    expect(checkSize({ arch: undefined, kind: 'openai', width: 1000, height: 600 })[0].text).toMatch(/closest in shape/)
  })

  it('ignores unset sizes', () => {
    expect(checkSize({ arch: 'sd', width: 0, height: 0 })).toEqual([])
  })
})

describe('profileFor', () => {
  it('knows 768 variants and the 16-pixel models', () => {
    expect(profileFor('sd', 'v2-1_768')?.native).toBe(768)
    expect(profileFor('sd', 'Dreamshaper')?.native).toBe(512)
    expect(profileFor('flux')?.multiple).toBe(16)
    expect(profileFor('sd3')?.multiple).toBe(16)
    expect(profileFor('zimage')?.multiple).toBe(16)
    expect(profileFor('sdxl')?.multiple).toBe(8)
    expect(profileFor('custom')).toBeNull()
    expect(profileFor(undefined)).toBeNull()
  })
})

describe('shape and size buttons (renderer)', () => {
  const form = { ratio: 'auto' as const, customW: 1024, customH: 1024, scale: 1 }

  it('leaves the size to the model on Auto at the default scale', () => {
    expect(resolveSize(form, sdxl)).toEqual({ width: 0, height: 0 })
    expect(describeSize(form, sdxl)).toBe('1024 × 1024 (model default)')
  })

  it('keeps the model\'s own area for each shape', () => {
    expect(resolveSize({ ...form, ratio: '1:1' }, sdxl)).toEqual({ width: 1024, height: 1024 })
    expect(resolveSize({ ...form, ratio: '16:9' }, sdxl)).toEqual({ width: 1344, height: 768 })
    expect(resolveSize({ ...form, ratio: '9:16' }, sd15)).toEqual({ width: 384, height: 704 })
    expect(resolveSize({ ...form, ratio: '1:1' }, sd15)).toEqual({ width: 512, height: 512 })
  })

  it('scales relative to what the model is set up for', () => {
    expect(resolveSize({ ...form, ratio: '1:1', scale: 0.75 }, sdxl)).toEqual({ width: 768, height: 768 })
    expect(resolveSize({ ...form, ratio: '1:1', scale: 1.5 }, sd15)).toEqual({ width: 768, height: 768 })
    expect(resolveSize({ ...form, ratio: '1:1', scale: 2 }, sdxl)).toEqual({ width: 2048, height: 2048 })
  })

  it('applies the scale to the model\'s own shape on Auto', () => {
    const wide = { ...sdxl, defaults: { ...sdxl.defaults!, width: 1280, height: 720 } }
    const r = resolveSize({ ...form, scale: 1.5 }, wide)
    expect(r.width / r.height).toBeCloseTo(16 / 9, 1)
    expect(r.width).toBeGreaterThan(1280)
  })

  it('passes custom sizes through exactly', () => {
    expect(resolveSize({ ratio: 'custom', customW: 777, customH: 333, scale: 2 }, sdxl)).toEqual({ width: 777, height: 333 })
  })

  it('works out the model type from the built-in engine, or from the name elsewhere', () => {
    expect(archOf(sdxl)).toEqual({ arch: 'sdxl', guessed: false })
    expect(archOf({ ...sdxl, kind: 'comfyui', arch: undefined, label: 'flux1-dev', model: 'flux1-dev.safetensors' })).toEqual({ arch: 'flux', guessed: true })
    expect(archOf({ ...sdxl, kind: 'comfyui', arch: undefined, label: 'mystery', model: 'mystery.safetensors' })).toEqual({ arch: undefined, guessed: false })
    expect(archOf({ ...sdxl, arch: 'custom', label: 'My z-image build' })).toEqual({ arch: 'zimage', guessed: true })
  })

  it('falls back to what it knows about the model type when there are no defaults', () => {
    expect(nativeSide({ ...sd15, defaults: undefined })).toBe(512)
    expect(nativeSide({ ...sdxl, defaults: undefined })).toBe(1024)
    expect(nativeSide(undefined)).toBe(1024)
  })
})
