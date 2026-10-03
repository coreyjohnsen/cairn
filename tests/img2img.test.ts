import { describe, expect, it } from 'vitest'
import { IMPORT_MAX_BYTES, STRENGTH_DEFAULT, clampStrength, fitWithin, shapeDiffers, sizeLikePicture, stepsRun, strengthLabel } from '../src/shared/img2img'
import { resolveSize, describeSize } from '../src/renderer/src/lib/imageSize'
import type { ImageTargetOption } from '../src/shared/types'

const sdxl: ImageTargetOption = { backendId: 'b', backendName: 'B', kind: 'builtin', model: 'm', label: 'SDXL', supportsImg2Img: true, supportsNegative: true, arch: 'sdxl', defaults: { width: 1024, height: 1024, steps: 25, cfg: 7, sampler: 'euler_a' }, available: true }
const form = { ratio: 'auto' as const, customW: 1024, customH: 1024, scale: 1 }

describe('starting from a picture: strength', () => {
  it('keeps strength in range and falls back to the default for anything that is not a number', () => {
    expect(clampStrength(0.4)).toBe(0.4)
    expect(clampStrength(5)).toBe(1)
    expect(clampStrength(-1)).toBe(0.05)
    expect(clampStrength(undefined)).toBe(STRENGTH_DEFAULT)
    expect(clampStrength(Number.NaN)).toBe(STRENGTH_DEFAULT)
  })
  it('describes the slider in plain words, from subtle to reimagine', () => {
    expect(strengthLabel(0.1)).toMatch(/^Subtle/)
    expect(strengthLabel(0.4)).toMatch(/^Light/)
    expect(strengthLabel(0.6)).toMatch(/^Balanced/)
    expect(strengthLabel(0.8)).toMatch(/^Strong/)
    expect(strengthLabel(1)).toMatch(/^Reimagine/)
  })
  it('says how many steps really run', () => {
    expect(stepsRun(20, 0.5)).toBe(10)
    expect(stepsRun(4, 0.05)).toBe(1)
    expect(stepsRun(30, 2)).toBe(30)
  })
})

describe('starting from a picture: size and shape', () => {
  it('gives the picture’s shape at about the model’s pixel count, in multiples the model can use', () => {
    const s = sizeLikePicture({ width: 3000, height: 2000 }, 1024 * 1024, 16)
    expect(s.width % 16).toBe(0)
    expect(s.height % 16).toBe(0)
    expect(Math.abs(s.width / s.height - 1.5)).toBeLessThan(0.03)
    expect(Math.abs(s.width * s.height - 1024 * 1024) / (1024 * 1024)).toBeLessThan(0.05)
    expect(sizeLikePicture({ width: 800, height: 800 }, 512 * 512, 8)).toEqual({ width: 512, height: 512 })
  })
  it('keeps very wide pictures inside the supported range', () => {
    const s = sizeLikePicture({ width: 8000, height: 400 }, 1024 * 1024, 8)
    expect(s.width).toBeLessThanOrEqual(2048)
    expect(s.height).toBeGreaterThanOrEqual(64)
  })
  it('notices when a size would stretch the picture', () => {
    expect(shapeDiffers({ width: 1000, height: 1000 }, 1024, 1024)).toBe(false)
    expect(shapeDiffers({ width: 1500, height: 1000 }, 1536, 1024)).toBe(false)
    expect(shapeDiffers({ width: 1500, height: 1000 }, 1024, 1024)).toBe(true)
    expect(shapeDiffers({ width: 1000, height: 1000 }, 0, 0)).toBe(false)
  })
  it('scales big pictures down to fit and never scales up', () => {
    expect(fitWithin(4096, 2048, 2048)).toEqual({ width: 2048, height: 1024 })
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 })
    expect(IMPORT_MAX_BYTES).toBeGreaterThan(1_000_000)
  })
})

describe('the Shape buttons with a starting picture', () => {
  const pic = { width: 3000, height: 2000 }
  it('Auto follows the picture’s shape; without a picture it still uses the model default', () => {
    expect(resolveSize(form, sdxl)).toEqual({ width: 0, height: 0 })
    const s = resolveSize(form, sdxl, pic)
    expect(Math.abs(s.width / s.height - 1.5)).toBeLessThan(0.03)
    expect(describeSize(form, sdxl, pic)).toMatch(/starting picture/)
  })
  it('the size buttons scale it, and a chosen shape or custom size is left alone', () => {
    const big = resolveSize({ ...form, scale: 2 }, sdxl, pic)
    const normal = resolveSize(form, sdxl, pic)
    expect(big.width * big.height).toBeGreaterThan(normal.width * normal.height * 3)
    expect(resolveSize({ ...form, ratio: '1:1' }, sdxl, pic)).toEqual({ width: 1024, height: 1024 })
    expect(resolveSize({ ...form, ratio: 'custom', customW: 640, customH: 384 }, sdxl, pic)).toEqual({ width: 640, height: 384 })
  })
})
