import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { baseFromMetadata, loraId, readLoraInfo, resolveLora, scanLoras, scanUpscalers, triggersFromMetadata, upscaleFactor, upscalerStyle } from '../src/main/images/assets'

/** A .safetensors file with the given header and no real weights. */
function safetensors(meta: Record<string, string>, tensors: string[] = ['lora_unet_x.lora_down.weight']): Buffer {
  const header: Record<string, unknown> = { __metadata__: meta }
  for (const t of tensors) header[t] = { dtype: 'F16', shape: [1], data_offsets: [0, 0] }
  const json = Buffer.from(JSON.stringify(header))
  const len = Buffer.alloc(8)
  len.writeBigUInt64LE(BigInt(json.length))
  return Buffer.concat([len, json])
}

describe('LoRA files', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cairn-lora-'))
  })
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })
  const put = async (rel: string, data: Buffer | string = 'x') => {
    const f = path.join(dir, rel)
    await fsp.mkdir(path.dirname(f), { recursive: true })
    await fsp.writeFile(f, data)
    return f
  }

  it('works out the base model from the trainer notes', () => {
    expect(baseFromMetadata({ ss_base_model_version: 'sdxl_base_v1-0' })).toBe('sdxl')
    expect(baseFromMetadata({ ss_base_model_version: 'sd_v1-5' })).toBe('sd')
    expect(baseFromMetadata({ 'modelspec.architecture': 'flux-1-dev/lora' })).toBe('flux')
    expect(baseFromMetadata({ 'modelspec.architecture': 'stable-diffusion-3-medium' })).toBe('sd3')
    expect(baseFromMetadata({}, ['lora_te2_text_model'])).toBe('sdxl')
    expect(baseFromMetadata({}, ['transformer.single_transformer_blocks.0.attn'])).toBe('flux')
    expect(baseFromMetadata({})).toBeUndefined()
  })

  it('suggests trigger words from the training tags, most used first', () => {
    const tags = JSON.stringify({ a: { pixelart: 50, fox: 10, '1girl': 90 }, b: { pixelart: 20 } })
    expect(triggersFromMetadata({ ss_tag_frequency: tags }, 2)).toEqual(['1girl', 'pixelart'])
    expect(triggersFromMetadata({ 'modelspec.trigger_phrase': 'in pixel style', ss_tag_frequency: tags }, 2)).toEqual(['in pixel style', '1girl'])
    expect(triggersFromMetadata({ ss_tag_frequency: 'not json' })).toEqual([])
  })

  it('reads the header and ignores files that are not safetensors', async () => {
    const f = await put('a.safetensors', safetensors({ ss_base_model_version: 'sdxl_base', ss_output_name: 'Pixel Fox' }))
    expect(await readLoraInfo(f)).toMatchObject({ base: 'sdxl', title: 'Pixel Fox' })
    expect(await readLoraInfo(await put('b.safetensors', 'garbage not a header'))).toEqual({ triggers: [] })
    expect(await readLoraInfo(await put('c.pt'))).toEqual({ triggers: [] })
    expect(await readLoraInfo(path.join(dir, 'missing.safetensors'))).toEqual({ triggers: [] })
  })

  it('lists LoRAs in subfolders with ids that go into the prompt tag', async () => {
    await put('pixel.safetensors', safetensors({ ss_base_model_version: 'sdxl_base', ss_tag_frequency: JSON.stringify({ x: { pixelart: 5 } }) }))
    await put('styles/ink_v1.5.safetensors', safetensors({}, ['single_blocks.0.x']))
    await put('sd15-detail.safetensors', safetensors({}))
    await put('readme.txt')
    const list = await scanLoras(dir)
    expect(list.map((l) => l.id)).toEqual(['pixel', 'sd15-detail', 'styles/ink_v1.5'])
    expect(list[0]).toMatchObject({ base: 'sdxl', triggers: ['pixelart'] })
    expect(list[0].baseGuessed).toBe(false)
    expect(list[1]).toMatchObject({ base: 'sd', baseGuessed: true })
    expect(list[2]).toMatchObject({ base: 'flux' })
    expect(loraId(dir, path.join(dir, 'styles', 'ink_v1.5.safetensors'))).toBe('styles/ink_v1.5')
  })

  it('returns an empty list when the folder does not exist', async () => {
    expect(await scanLoras(path.join(dir, 'nope'))).toEqual([])
    expect(await scanUpscalers(path.join(dir, 'nope'))).toEqual([])
  })

  it('resolves ids to files only inside the folder', async () => {
    const f = await put('styles/ink.safetensors')
    await put('../outside.safetensors')
    expect(await resolveLora(dir, 'styles/ink')).toBe(f)
    for (const bad of ['', '../outside', 'styles/../../outside', '/etc/passwd', 'a//b', 'ink<x>', 'ghost']) expect(await resolveLora(dir, bad)).toBeNull()
  })

  it('finds upscalers and reads their scale from the name', async () => {
    await put('4x-UltraSharp.pth')
    await put('RealESRGAN_x2plus.pth')
    await put('sub/4xNomos8k_x.safetensors')
    await put('notes.md')
    const list = await scanUpscalers(dir)
    expect(list.map((u) => [u.name, u.scale])).toEqual([['4x-UltraSharp', 4], ['4xNomos8k_x', 4], ['RealESRGAN_x2plus', 2]])
    expect(upscaleFactor('RealESRGAN_x4plus')).toBe(4)
    expect(upscaleFactor('x8_sharp')).toBe(8)
    expect(upscaleFactor('mystery')).toBe(4)
  })
  it('lists Real-ESRGAN (ncnn) models once, by their .param file, and puts them first', async () => {
    await put('4x-UltraSharp.pth')
    await put('ncnn/realesrgan-x4plus.param', 'p')
    await put('ncnn/realesrgan-x4plus.bin', 'bbbb')
    await put('ncnn/realesrgan-x4plus-anime.param', 'p')
    await put('ncnn/realesrgan-x4plus-anime.bin', 'b')
    await put('ncnn/lonely.param', 'p') // no weights beside it
    const list = await scanUpscalers(dir)
    expect(list.map((u) => [u.name, u.engine, u.style])).toEqual([
      ['realesrgan-x4plus', 'esrgan', 'general'],
      ['realesrgan-x4plus-anime', 'esrgan', 'anime'],
      ['4x-UltraSharp', 'sd', 'general']
    ])
    expect(list[0]).toMatchObject({ scale: 4, sizeBytes: 5, path: path.join(dir, 'ncnn', 'realesrgan-x4plus.param') })
  })

  it('adds the models that came with the upscaler, without listing them twice or listing stray files', async () => {
    const bundled = `${dir}-engine-models`
    await fsp.mkdir(bundled, { recursive: true })
    for (const n of ['realesrgan-x4plus', 'realesr-animevideov3-x2', 'realesr-animevideov3-x3']) {
      await fsp.writeFile(path.join(bundled, `${n}.param`), 'p')
      await fsp.writeFile(path.join(bundled, `${n}.bin`), 'b')
    }
    await fsp.writeFile(path.join(bundled, 'other.pth'), 'x')
    await put('realesrgan-x4plus.param', 'p') // the user's own copy wins
    await put('realesrgan-x4plus.bin', 'b')
    const list = await scanUpscalers(dir, bundled)
    expect(list.map((u) => [u.name, u.bundled ?? false, u.scale])).toEqual([
      ['realesrgan-x4plus', false, 4],
      ['realesr-animevideov3-x2', true, 2],
      ['realesr-animevideov3-x3', true, 3]
    ])
    expect(await scanUpscalers(path.join(dir, 'missing'), bundled)).toHaveLength(3)
    await fsp.rm(bundled, { recursive: true, force: true })
  })

  it('reads 3x from names and tells anime models from general ones', () => {
    expect(upscaleFactor('realesr-animevideov3-x3')).toBe(3)
    expect(upscaleFactor('realesrgan-x4plus-anime')).toBe(4)
    expect(upscalerStyle('RealESRGAN_x4plus_anime_6B')).toBe('anime')
    expect(upscalerStyle('realesr-animevideov3-x2')).toBe('anime')
    expect(upscalerStyle('realesrgan-x4plus')).toBe('general')
    expect(upscalerStyle('4x-UltraSharp')).toBe('general')
  })
})
