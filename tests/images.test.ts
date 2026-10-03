import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { STARTER_PACKS, blankSdModel, defaultSettings } from '../src/shared/defaults'
import { checkSize, guessSizeArch, profileFor, snapSize } from '../src/shared/imageSize'
import type { ImageBackendConfig, ImageGenRequest, ImageJob, ImageRecord, ImageStage, Settings } from '../src/shared/types'
import { AttachmentStore, looksLikeText } from '../src/main/attachments'
import { setEventSink } from '../src/main/events'
import { A1111Backend, a1111Sampler } from '../src/main/images/a1111'
import { ComfyBackend, DEFAULT_COMFY_WORKFLOW, comfySampler, fillWorkflow } from '../src/main/images/comfyui'
import { OpenAIImagesBackend, openAiSize } from '../src/main/images/openai-images'
import { SdCppBackend, SdProgress, VAE_FAILED_MESSAGE, buildSdArgs, explainSdFailure, probeFlags, clearFlagCache, promptWithLoras } from '../src/main/images/sdcpp'
import { ImageService } from '../src/main/images/service'
import { imageSize } from '../src/main/images/size'
import { ImageStore } from '../src/main/images/store'
import { BackendError, type BackendHooks, type GenParams, type ImageBackend, sniffImageExt } from '../src/main/images/types'
import { fakeJpeg, fakePng, fakeWebpVp8x } from './helpers/png'

const params = (over: Partial<GenParams> = {}): GenParams => ({
  prompt: 'a snowy peak at dawn',
  negative: '',
  width: 512,
  height: 512,
  steps: 4,
  cfg: 1,
  seed: 42,
  sampler: 'euler_a',
  count: 1,
  model: 'm1',
  ...over
})

const hooks = (signal = new AbortController().signal): BackendHooks & { log: [number, string | undefined, ImageStage | undefined][] } => {
  const log: [number, string | undefined, ImageStage | undefined][] = []
  return { signal, log, onProgress: (f, l, st) => log.push([f, l, st]) }
}

describe('image header sniffing', () => {
  it('reads PNG, JPEG and WebP sizes and detects the container', () => {
    expect(imageSize(fakePng(640, 480))).toEqual({ width: 640, height: 480 })
    expect(imageSize(fakeJpeg(1024, 768))).toEqual({ width: 1024, height: 768 })
    expect(imageSize(fakeWebpVp8x(800, 600))).toEqual({ width: 800, height: 600 })
    expect(imageSize(new Uint8Array(10))).toBeNull()
    expect(imageSize(new Uint8Array(64))).toBeNull()
    expect(sniffImageExt(fakePng(1, 1))).toBe('png')
    expect(sniffImageExt(fakeJpeg(1, 1))).toBe('jpg')
    expect(sniffImageExt(fakeWebpVp8x(1, 1))).toBe('webp')
    expect(sniffImageExt(new Uint8Array(30))).toBe('png')
  })
})

describe('ImageStore', () => {
  let dir: string
  const mk = (makeThumb?: (d: Uint8Array, n: number) => Uint8Array | null) =>
    new ImageStore({ imagesDir: path.join(dir, 'images'), thumbsDir: path.join(dir, 'thumbs'), indexFile: path.join(dir, 'images', 'index.json'), makeThumb })
  const meta = (over: Record<string, unknown> = {}) => ({
    prompt: 'p', negativePrompt: '', backendId: 'b', backendName: 'B', model: 'm', width: 8, height: 8, seed: 1, durationMs: 5, source: 'hub' as const, ...over
  })

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cairn-img-'))
    await fsp.mkdir(path.join(dir, 'images'), { recursive: true })
    await fsp.mkdir(path.join(dir, 'thumbs'), { recursive: true })
  })
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('stores images with thumbnails, lists newest first and emits events', async () => {
    const events: string[] = []
    setEventSink((ch) => void events.push(ch))
    const store = mk(() => new Uint8Array([1, 2, 3]))
    const a = await store.add(fakePng(8, 8, 1), meta({ prompt: 'first' }))
    await new Promise((r) => setTimeout(r, 5))
    const b = await store.add(fakePng(8, 8, 2), meta({ prompt: 'second' }))
    expect(store.list().map((x) => x.prompt)).toEqual(['second', 'first'])
    expect(a.file).toMatch(/\.png$/)
    expect(a.thumb).toMatch(/\.jpg$/)
    expect(fs.existsSync(store.filePath(a))).toBe(true)
    expect(fs.readFileSync(store.thumbPath(a))).toEqual(Buffer.from([1, 2, 3]))
    expect(events.filter((e) => e === 'images:added')).toHaveLength(2)

    store.setFavorite(b.id, true)
    expect(store.get(b.id)?.favorite).toBe(true)
    expect(events).toContain('images:updated')
    setEventSink(() => {})
  })

  it('falls back to the original as thumbnail when none can be made', async () => {
    const store = mk(() => null)
    const r = await store.add(fakePng(8, 8), meta())
    expect(r.thumb).toBe(r.file)
  })

  it('persists across restarts and forgets files deleted outside the app', async () => {
    const s1 = mk()
    const keep = await s1.add(fakePng(8, 8, 1), meta({ prompt: 'keep' }))
    const gone = await s1.add(fakePng(8, 8, 2), meta({ prompt: 'gone' }))
    await s1.flush()
    await fsp.rm(s1.filePath(gone))

    const s2 = mk()
    await s2.load()
    expect(s2.list().map((r) => r.id)).toEqual([keep.id])
    expect(Buffer.from((await s2.readBytes(keep.id))!)).toEqual(await fsp.readFile(s2.filePath(keep)))
    expect(await s2.readBytes('nope')).toBeNull()
  })

  it('removes records and their files', async () => {
    const events: [string, unknown][] = []
    setEventSink((ch, p) => void events.push([ch, p]))
    const store = mk(() => new Uint8Array([9]))
    const r = await store.add(fakePng(8, 8), meta())
    await store.remove([r.id, 'missing'])
    expect(store.list()).toHaveLength(0)
    expect(fs.existsSync(path.join(dir, 'images', r.file))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'thumbs', r.thumb))).toBe(false)
    expect(events.find(([c]) => c === 'images:removed')?.[1]).toEqual([r.id])
    setEventSink(() => {})
  })
})

describe('pure backend helpers', () => {
  it('fills workflow placeholders, keeping numeric types for exact matches', () => {
    const out = fillWorkflow({ a: '{{steps}}', b: 'size {{width}}x{{height}}', c: [['4', 0], '{{seed}}'], d: { e: '{{prompt}}' }, f: '{{unknown}}' }, { steps: 20, width: 512, height: 768, seed: 7, prompt: 'x "quoted"' }) as any
    expect(out.a).toBe(20)
    expect(out.b).toBe('size 512x768')
    expect(out.c[1]).toBe(7)
    expect(out.c[0]).toEqual(['4', 0])
    expect(out.d.e).toBe('x "quoted"')
    expect(out.f).toBe('{{unknown}}')
  })

  it('maps sampler names per backend', () => {
    expect(comfySampler('euler_a')).toBe('euler_ancestral')
    expect(comfySampler('dpm++2m')).toBe('dpmpp_2m')
    expect(comfySampler('custom_one')).toBe('custom_one')
    expect(a1111Sampler('euler_a')).toBe('Euler a')
    expect(a1111Sampler('dpm++2m')).toBe('DPM++ 2M')
  })

  it('snaps OpenAI sizes only for the official API', () => {
    expect(openAiSize('gpt-image-1', 1024, 768, true)).toBe('1536x1024')
    expect(openAiSize('gpt-image-1', 768, 1024, true)).toBe('1024x1536')
    expect(openAiSize('gpt-image-1', 512, 512, true)).toBe('1024x1024')
    expect(openAiSize('dall-e-3', 1024, 512, true)).toBe('1792x1024')
    expect(openAiSize('dall-e-2', 300, 300, true)).toBe('256x256')
    expect(openAiSize('flux', 832, 1216, false)).toBe('832x1216')
  })
})

describe('sd.cpp command line', () => {
  const model = { ...blankSdModel('sdxl'), id: 'x', name: 'X', model: '/m/sdxl.safetensors', vae: '/m/vae.safetensors', vaeTiling: true, offloadToCpu: true, flashAttn: true, extraArgs: '--rng cuda' }

  it('builds a txt2img command', () => {
    const a = buildSdArgs(model, params({ negative: 'blurry', count: 3 }), '/tmp/o/out.png', null)
    expect(a.slice(0, 4)).toEqual(['-m', '/m/sdxl.safetensors', '--vae', '/m/vae.safetensors'])
    expect(a).toEqual(expect.arrayContaining(['-p', 'a snowy peak at dawn', '-n', 'blurry', '-W', '512', '-H', '512', '--steps', '4', '--cfg-scale', '1', '--sampling-method', 'euler_a', '-s', '42', '-b', '3', '-o', '/tmp/o/out.png']))
    expect(a).toEqual(expect.arrayContaining(['--vae-tiling', '--offload-to-cpu', '--diffusion-fa']))
    expect(a.slice(-2)).toEqual(['--rng', 'cuda'])
    expect(a).not.toContain('-i')
  })

  it('adds LoRA tags to the prompt and points the engine at the LoRA folder', () => {
    const a = buildSdArgs(model, params({ prompt: 'a cat', loras: [{ id: 'style/pixel', strength: 0.8 }, { id: 'detail', strength: 1 }], loraDir: '/m/lora' }), '/o/out.png', null)
    expect(a[a.indexOf('-p') + 1]).toBe('a cat <lora:style/pixel:0.8> <lora:detail:1>')
    expect(a[a.indexOf('--lora-model-dir') + 1]).toBe('/m/lora')
    expect(promptWithLoras({ prompt: 'x', loras: [{ id: 'a', strength: 0.123456 }] })).toBe('x <lora:a:0.12>')
    expect(promptWithLoras({ prompt: 'x' })).toBe('x')
    expect(buildSdArgs(model, params({ loras: [] }), '/o/out.png', null)).not.toContain('--lora-model-dir')
  })

  it('asks for upscaling only with flags the engine knows', () => {
    const up = { path: '/m/up/4x.pth', repeats: 2 }
    expect(buildSdArgs(model, params({ upscale: up }), '/o/out.png', null)).toEqual(expect.arrayContaining(['--upscale-model', '/m/up/4x.pth', '--upscale-repeats', '2']))
    const old = buildSdArgs(model, params({ upscale: up }), '/o/out.png', new Set(['--upscale-model']))
    expect(old).toContain('--upscale-model')
    expect(old).not.toContain('--upscale-repeats')
    expect(buildSdArgs(model, params({ upscale: { ...up, repeats: 1 } }), '/o/out.png', null)).not.toContain('--upscale-repeats')
  })

  it('uses --diffusion-model for split models and omits empty options', () => {
    const flux = { ...blankSdModel('flux'), id: 'f', name: 'F', model: '', diffusionModel: '/m/flux.gguf', t5xxl: '/m/t5.safetensors', clipL: '/m/clip_l.safetensors', vae: '/m/ae.safetensors' }
    const a = buildSdArgs(flux, params({ count: 1 }), '/o/out.png', null)
    expect(a).not.toContain('-m')
    expect(a).toEqual(expect.arrayContaining(['--diffusion-model', '/m/flux.gguf', '--t5xxl', '/m/t5.safetensors', '--clip_l', '/m/clip_l.safetensors']))
    expect(a).not.toContain('-n')
    expect(a).not.toContain('-b')
  })

  it('builds the Z-Image Turbo command line the sd.cpp docs describe', () => {
    const z = { ...blankSdModel('zimage'), id: 'z', name: 'Z', model: '', diffusionModel: '/m/z_image_turbo-Q8_0.gguf', llm: '/m/Qwen3-4B-Instruct-2507-Q4_K_M.gguf', vae: '/m/ae.safetensors' }
    expect(z.steps).toBe(8)
    expect(z.cfg).toBe(1)
    const a = buildSdArgs(z, params({ steps: z.steps, cfg: z.cfg, sampler: 'euler', count: 1 }), '/o/out.png', null)
    // Z-Image must be loaded with --diffusion-model (using -m fails to load it) plus the LLM text encoder.
    expect(a).not.toContain('-m')
    expect(a).toEqual(expect.arrayContaining(['--diffusion-model', '/m/z_image_turbo-Q8_0.gguf', '--llm', '/m/Qwen3-4B-Instruct-2507-Q4_K_M.gguf', '--vae', '/m/ae.safetensors', '--steps', '8', '--cfg-scale', '1']))
    expect(a).not.toContain('--t5xxl')
    expect(a).not.toContain('--clip_l')
  })

  it('tolerates saved models from before the llm field existed', () => {
    const old = { ...blankSdModel('flux'), model: '', diffusionModel: '/m/flux.gguf' } as Record<string, unknown>
    delete old.llm
    const a = buildSdArgs(old as unknown as ReturnType<typeof blankSdModel>, params(), '/o/out.png', null)
    expect(a).not.toContain('--llm')
  })

  it('ships well-formed Z-Image starter packs', () => {
    const packs = STARTER_PACKS.filter((p) => p.arch === 'zimage')
    expect(packs.map((p) => p.id)).toEqual(['z-image-turbo-q8', 'z-image-turbo-q4'])
    for (const p of packs) {
      expect(p.files.map((f) => f.role).sort()).toEqual(['diffusionModel', 'llm', 'vae'])
      for (const f of p.files) {
        expect(f.url).toMatch(/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/main\//)
        if (f.role !== 'vae') expect(f.url.split('/').pop()).toBe(f.filename)
        expect(f.subdir.startsWith('image')).toBe(true)
      }
      expect(p.defaults).toMatchObject({ steps: 8, cfg: 1 })
    }
    // Unique ids and filenames per role across all packs (a pack must not overwrite another's files with different data).
    expect(new Set(STARTER_PACKS.map((p) => p.id)).size).toBe(STARTER_PACKS.length)
  })

  it('adds image-to-image arguments', () => {
    const a = buildSdArgs(model, params({ strength: 0.4 }), '/o/out.png', null, '/o/init.png')
    expect(a.slice(a.indexOf('-i'), a.indexOf('-i') + 4)).toEqual(['-i', '/o/init.png', '--strength', '0.4'])
  })

  it('drops optional flags the binary does not understand', () => {
    const a = buildSdArgs(model, params(), '/o/out.png', new Set(['--vae-tiling', '--steps', '--cfg-scale', '--a', '--b', '--c']))
    expect(a).toContain('--vae-tiling')
    expect(a).not.toContain('--offload-to-cpu')
    expect(a).not.toContain('--diffusion-fa')
  })

  it('turns failures into actionable advice', () => {
    expect(explainSdFailure(1, ['ggml_vulkan: ErrorOutOfDeviceMemory'])).toMatch(/VAE tiling/)
    expect(explainSdFailure(1, ['error: unknown argument: --foo'])).toMatch(/Extra arguments/)
    expect(explainSdFailure(1, ['get sd version from file failed'])).toMatch(/model type/)
    expect(explainSdFailure(3, ['something else'])).toMatch(/exited with code 3/)
  })
})

/* ───────────────────────────── sd.cpp backend driving a fake binary ───────────────────────────── */

describe('SdProgress (reading the engine log)', () => {
  const run = (count: number, lines: string[]) => {
    const t = new SdProgress(count)
    const out: { label: string; stage: ImageStage; fraction: number }[] = []
    for (const l of lines) {
      const u = t.feed(l)
      if (u) out.push(u)
    }
    return { t, out }
  }

  // Modelled on a real stable-diffusion.cpp run (the VAE is mentioned long before decoding starts).
  const single = [
    "[INFO ] stable-diffusion.cpp:200 - loading diffusion model from 'flux.gguf'",
    "[INFO ] stable-diffusion.cpp:230 - loading vae from 'ae.safetensors'",
    '[INFO ] stable-diffusion.cpp:260 - VAE weight type: f16',
    '[INFO ] stable-diffusion.cpp:300 - total params memory size = 6563.34MB (VRAM 6563.34MB, RAM 0.00MB): vae 94.57MB(VRAM)',
    '[INFO ] stable-diffusion.cpp:320 - running in Flow mode',
    '[INFO ] stable-diffusion.cpp:3200 - generate_image 1024x1024',
    '[INFO ] stable-diffusion.cpp:3250 - get_learned_condition completed, taking 3379 ms',
    '[INFO ] stable-diffusion.cpp:3361 - generating image: 1/1 - seed 4700',
    '  |==================================================| 1/4 - 4.00s/it',
    '  |==================================================| 2/4 - 4.00s/it',
    '  |==================================================| 4/4 - 4.00s/it',
    '[INFO ] stable-diffusion.cpp:3403 - sampling completed, taking 10.03s',
    '[INFO ] stable-diffusion.cpp:3414 - generating 1 latent images completed, taking 10.04s',
    '[INFO ] stable-diffusion.cpp:3417 - decoding 1 latents',
    '[INFO ] stable-diffusion.cpp:3427 - latent 1 decoded, taking 0.93s',
    '[INFO ] stable-diffusion.cpp:3431 - decode_first_stage completed, taking 0.94s',
    '[INFO ] stable-diffusion.cpp:3741 - generate_image completed in 15.37s',
    "[INFO ] main.cpp:421  - save result image 0 to 'output.png' (success)"
  ]

  it('does not call it decoding just because the VAE is loading', () => {
    const { out } = run(1, single.slice(0, 5))
    expect(out.map((u) => u.stage)).toEqual(['encoding'])
    expect(out.every((u) => u.stage !== 'decoding')).toBe(true)
  })

  it('walks through the stages in order, once each', () => {
    const { out } = run(1, single)
    const stages = out.map((u) => u.stage)
    expect(stages.filter((s, i) => s !== stages[i - 1])).toEqual(['encoding', 'sampling', 'decoding', 'saving'])
    expect(out.find((u) => u.stage === 'decoding')?.label).toBe('Decoding the finished image')
    expect(out.find((u) => u.stage === 'encoding')?.label).toMatch(/prompt/)
    const fr = out.map((u) => u.fraction)
    expect(Math.max(...fr)).toBeLessThan(1)
  })

  it('reports steps with a time estimate, and the decode stage is not reported as sampling', () => {
    const { out } = run(1, single)
    const steps = out.filter((u) => /step/.test(u.label))
    expect(steps[0].label).toBe('Sampling · step 1 of 4 · about 12s left')
    expect(steps.at(-1)?.label).toBe('Sampling · step 4 of 4')
    expect(out.filter((u) => u.stage === 'sampling').every((u) => u.fraction <= 0.9)).toBe(true)
    expect(out.find((u) => u.stage === 'decoding')!.fraction).toBe(0.9)
  })

  it('keeps counting images across a batch and only decodes after the last', () => {
    const lines = [
      '[INFO ] generating image: 1/2 - seed 1',
      '  |=====| 1/2 - 1.00s/it',
      '  |=====| 2/2 - 1.00s/it',
      '[INFO ] sampling completed, taking 2.00s',
      '[INFO ] generating image: 2/2 - seed 2',
      '  |=====| 1/2 - 1.00s/it',
      '  |=====| 2/2 - 1.00s/it',
      '[INFO ] sampling completed, taking 2.00s',
      '[INFO ] generating 2 latent images completed, taking 4.00s',
      '[INFO ] decoding 2 latents',
      '[INFO ] latent 1 decoded, taking 1.00s',
      '[INFO ] latent 2 decoded, taking 1.00s',
      '[INFO ] decode_first_stage completed, taking 2.00s'
    ]
    const { out } = run(2, lines)
    const labels = out.map((u) => u.label)
    expect(labels).toContain('Sampling · step 2 of 2 · image 1 of 2')
    expect(labels).toContain('Sampling · step 1 of 2 · image 2 of 2')
    const firstDecode = out.findIndex((u) => u.stage === 'decoding')
    expect(out.slice(0, firstDecode).every((u) => u.stage === 'sampling')).toBe(true)
    expect(labels).toContain('Decoding the finished images (1 of 2)')
    expect(labels).toContain('Decoding the finished images (2 of 2)')
    expect(out.at(-1)?.stage).toBe('saving')
    const fr = out.map((u) => u.fraction)
    expect(fr.filter((f, i) => i > 0 && f < fr[i - 1] - 1e-9).length).toBe(0)
  })

  it('follows batches even when the engine never prints which image it is on', () => {
    const { out } = run(2, ['  |=====| 1/2 - 1.00s/it', '  |=====| 2/2 - 1.00s/it', '  |=====| 1/2 - 1.00s/it', '  |=====| 2/2 - 1.00s/it'])
    expect(out.map((u) => u.label)).toEqual([
      'Sampling · step 1 of 2 · image 1 of 2',
      'Sampling · step 2 of 2 · image 1 of 2',
      'Sampling · step 1 of 2 · image 2 of 2',
      'Sampling · step 2 of 2 · image 2 of 2'
    ])
  })

  it('understands speeds given as iterations per second', () => {
    const { out } = run(1, ['  |=====| 3/20 - 0.50it/s'])
    expect(out[0].label).toBe('Sampling · step 3 of 20 · about 34s left')
  })

  it('notices running out of memory while decoding, which the engine can still call a success', () => {
    const { t } = run(1, [
      '[INFO ] decoding 1 latents',
      'ggml_vulkan: Device memory allocation of size 4831838208 failed.',
      '[ERROR] ggml_extend.hpp:1724 - vae: failed to allocate compute buffer'
    ])
    expect(t.vaeFailed).toBe(true)
    // Memory trouble earlier on is left to the exit code.
    expect(run(1, ['ggml_vulkan: Device memory allocation of size 4831838208 failed.']).t.vaeFailed).toBe(false)
    expect(VAE_FAILED_MESSAGE).toMatch(/VAE tiling/)
  })
})

describe('SdProgress with upscaling', () => {
  const feed = (t: SdProgress, lines: string[]) => lines.map((l) => t.feed(l)).filter(Boolean) as { label: string; stage: ImageStage; fraction: number }[]
  const lines = [
    '[INFO ] stable-diffusion.cpp:3417 - decoding 1 latents',
    '[INFO ] stable-diffusion.cpp:3431 - decode_first_stage completed, taking 0.1s',
    '[INFO ] stable-diffusion.cpp:3741 - generate_image completed in 1.0s',
    "[INFO ] main.cpp:421  - save result image 0 to 'output.png' (success)"
  ]

  it('shows upscaling after decoding and saves last', () => {
    const out = feed(new SdProgress(1, { upscale: true }), lines)
    expect(out.map((u) => u.stage)).toEqual(['decoding', 'upscaling', 'saving'])
    expect(out.at(-1)?.fraction).toBeGreaterThan(out[1].fraction)
  })

  it('without an upscaler the same lines go straight to saving', () => {
    const out = feed(new SdProgress(1), lines)
    expect(out.map((u) => u.stage)).toEqual(['decoding', 'saving'])
  })

  it('starts on the upscaling stage when only upscaling', () => {
    expect(new SdProgress(1, { upscaleOnly: true }).start()).toMatchObject({ stage: 'upscaling' })
  })
})

describe.skipIf(process.platform === 'win32')('SdCppBackend with a fake sd-cli', () => {
  let dir: string
  let bin: string
  let weights: string
  let up4: string
  let nomode: string
  let settings: Settings

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cairn-sd-'))
    bin = path.join(dir, 'sd-cli')
    weights = path.join(dir, 'model.safetensors')
    await fsp.writeFile(weights, 'x')
    const png = Buffer.from(fakePng(64, 64)).toString('base64')
    const bigPng = Buffer.from(fakePng(2048, 2048)).toString('base64')
    await fsp.writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const a = process.argv.slice(2)
if (a.includes('--help')) { console.log('usage: sd [--vae-tiling] [--upscale-model P] [--upscale-repeats N] [--lora-model-dir D] [--offload-to-cpu] [--clip-on-cpu] [--diffusion-fa] [--steps N] [--cfg-scale N] [--strength N]'); process.exit(0) }
const get = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined)
const prompt = get('-p'), out = get('-o'), count = Number(get('-b') || 1), steps = Number(get('--steps'))
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(a) + '\\n')
if (get('-M') === 'upscale') {
  if ((get('--upscale-model') || '').includes('NOMODE')) { console.error('error: invalid mode: upscale'); process.exit(1) }
  const um = get('--upscale-model') || ''
  if (um.includes('IGNORED')) console.error('[ERROR] stable-diffusion.cpp:100 - new_upscaler_ctx failed')
  else console.error('[INFO ] upscaling image')
  fs.writeFileSync(out, Buffer.from(um.includes('IGNORED') || um.includes('SILENT') ? '${png}' : '${bigPng}', 'base64'))
  process.exit(0)
}
if (prompt.includes('OOM')) { console.error('CUDA error: out of memory'); process.exit(1) }
console.error("[INFO ] stable-diffusion.cpp:200 - loading vae from 'ae.safetensors'")
console.error('[INFO ] stable-diffusion.cpp:300 - total params memory size = 100MB')
console.error('[INFO ] stable-diffusion.cpp:3250 - get_learned_condition completed, taking 10 ms')
const um = get('--upscale-model') || ''
const png = Buffer.from(um && !um.includes('IGNORED') && !um.includes('SILENT') ? '${bigPng}' : '${png}', 'base64')
let i = 0
const tick = () => {
  if (i >= count * steps) {
    console.error('[INFO ] stable-diffusion.cpp:3414 - generating ' + count + ' latent images completed, taking 1s')
    console.error('[INFO ] stable-diffusion.cpp:3417 - decoding ' + count + ' latents')
    if (prompt.includes('VAEFAIL')) console.error('[ERROR] ggml_extend.hpp:1724 - vae: failed to allocate compute buffer')
    console.error('[INFO ] stable-diffusion.cpp:3431 - decode_first_stage completed, taking 0.1s')
    console.error('[INFO ] stable-diffusion.cpp:3741 - generate_image completed in 1.0s')
    if (um.includes('IGNORED')) console.error('[ERROR] stable-diffusion.cpp:100 - new_upscaler_ctx failed')
    else if (um) console.error('[INFO ] upscaling image 1/' + count)
    console.error("[INFO ] main.cpp:421  - save result image 0 to 'output.png' (success)")
    for (let k = 0; k < count; k++) {
      const f = count > 1 ? out.replace(/\\.png$/, '_' + k + '.png') : out
      png[40] = k + 1
      fs.writeFileSync(f, png)
    }
    process.exit(0)
  }
  const step = (i % steps) + 1
  process.stderr.write('  |==================>      | ' + step + '/' + steps + ' - 0.50s/it\\r')
  i++
  setTimeout(tick, prompt.includes('SLOW') ? 400 : 5)
}
tick()
`,
      { mode: 0o755 }
    )
    up4 = path.join(dir, '4x.pth')
    nomode = path.join(dir, 'NOMODE.pth')
    await fsp.writeFile(up4, 'x')
    await fsp.writeFile(nomode, 'x')
    settings = defaultSettings(dir)
    settings.image.localModels = [{ ...blankSdModel('sd'), id: 'local1', name: 'Local One', model: weights, vaeTiling: true }]
  })
  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })
  beforeEach(() => clearFlagCache())

  const backend = () =>
    new SdCppBackend({
      getSettings: () => settings,
      tmpDir: dir,
      engines: { resolveBinary: () => bin, spawnEnv: () => process.env } as never
    })

  it('probes supported flags from --help', async () => {
    const flags = await probeFlags(bin, process.env)
    expect(flags?.has('--vae-tiling')).toBe(true)
    expect(flags?.has('--nope')).toBe(false)
  })

  it('generates an image and reports sampling progress', async () => {
    const h = hooks()
    const out = await backend().generate(params({ model: 'local1', steps: 4 }), h)
    expect(out).toHaveLength(1)
    expect(imageSize(out[0].data)).toEqual({ width: 64, height: 64 })
    expect(out[0].seed).toBe(42)
    const labels = h.log.map(([, l]) => l).filter(Boolean)
    expect(labels.some((l) => /Sampling · step 4 of 4/.test(l!))).toBe(true)
    expect(h.log.at(-1)?.[0]).toBe(1)
    const fracs = h.log.map(([f]) => f)
    expect([...fracs].sort((x, y) => x - y)).toEqual(fracs) // monotonic
  })

  it('reports the stages the engine goes through, with the decode stage last', async () => {
    const h = hooks()
    await backend().generate(params({ model: 'local1', steps: 3 }), h)
    const stages = h.log.map(([, , st]) => st).filter(Boolean) as ImageStage[]
    expect(stages.filter((s, i) => s !== stages[i - 1])).toEqual(['loading', 'encoding', 'sampling', 'decoding', 'saving'])
    expect(h.log[0][1]).toBe('Loading model files…')
  })

  it('fails clearly when decoding ran out of memory but the engine still exited cleanly', async () => {
    const err = await backend().generate(params({ model: 'local1', prompt: 'VAEFAIL please' }), hooks()).catch((e) => e)
    expect(err).toBeInstanceOf(BackendError)
    expect(err.message).toBe(VAE_FAILED_MESSAGE)
  })

  const lastCall = async (): Promise<string[]> => {
    const lines = (await fsp.readFile(path.join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n')
    return JSON.parse(lines[lines.length - 1])
  }

  it('passes LoRAs as prompt tags and tells the engine where the LoRA folder is', async () => {
    await backend().generate(params({ model: 'local1', steps: 1, prompt: 'a cat', loras: [{ id: 'pixel', strength: 0.8 }], loraDir: '/m/lora' }), hooks())
    const a = await lastCall()
    expect(a[a.indexOf('-p') + 1]).toBe('a cat <lora:pixel:0.8>')
    expect(a[a.indexOf('--lora-model-dir') + 1]).toBe('/m/lora')
  })

  it('upscales after drawing and ends on the upscaling stage before saving', async () => {
    const h = hooks()
    await backend().generate(params({ model: 'local1', steps: 2, upscale: { path: up4, repeats: 2 } }), h)
    const a = await lastCall()
    expect(a[a.indexOf('--upscale-model') + 1]).toBe(up4)
    expect(a[a.indexOf('--upscale-repeats') + 1]).toBe('2')
    const stages = h.log.map(([, , st]) => st).filter(Boolean) as ImageStage[]
    expect(stages.filter((s, i) => s !== stages[i - 1])).toEqual(['loading', 'encoding', 'sampling', 'decoding', 'upscaling', 'saving'])
  })

  it('upscales an existing picture on its own', async () => {
    const h = hooks()
    const out = await backend().upscale(fakePng(64, 64), { path: up4, repeats: 1 }, h)
    expect(out).toHaveLength(1)
    const a = await lastCall()
    expect(a.slice(0, 4)).toEqual(['-M', 'upscale', '--upscale-model', up4])
    expect(a).not.toContain('--upscale-repeats')
    expect(h.log.some(([, , st]) => st === 'upscaling')).toBe(true)
  })

  it('refuses to hand back an unchanged picture when the engine ignored the upscaler', async () => {
    for (const name of ['IGNORED.pth', 'SILENT.pth']) {
      const f = path.join(dir, name)
      await fsp.writeFile(f, 'x')
      const err = await backend().upscale(fakePng(64, 64), { path: f, repeats: 1 }, hooks()).catch((e) => e)
      expect(err, name).toBeInstanceOf(BackendError)
      expect(err.message, name).toMatch(/could not use the upscaler/)
      expect(err.message).toMatch(/RealESRGAN_x4plus_anime_6B/)
    }
    const f = path.join(dir, 'IGNORED.pth')
    expect((await backend().upscale(fakePng(64, 64), { path: f, repeats: 1 }, hooks()).catch((e) => e)).message).toMatch(/new_upscaler_ctx failed/)
  })

  it('keeps a drawn picture but warns when the upscaler was ignored', async () => {
    const f = path.join(dir, 'IGNORED.pth')
    const out = await backend().generate(params({ model: 'local1', steps: 1, width: 512, height: 512, upscale: { path: f, repeats: 1 } }), hooks())
    expect(out).toHaveLength(1)
    expect(out[0].warning).toMatch(/could not use the upscaler/)
    const silent = path.join(dir, 'SILENT.pth')
    expect((await backend().generate(params({ model: 'local1', steps: 1, width: 512, height: 512, upscale: { path: silent, repeats: 1 } }), hooks()))[0].warning).toMatch(/original size/)
  })

  it('gives no warning when the upscaler worked', async () => {
    const out = await backend().generate(params({ model: 'local1', steps: 1, width: 512, height: 512, upscale: { path: up4, repeats: 1 } }), hooks())
    expect(out[0].warning).toBeUndefined()
    expect(imageSize(out[0].data)).toEqual({ width: 2048, height: 2048 })
  })

  it('explains when the engine has no stand-alone upscale mode', async () => {
    const err = await backend().upscale(fakePng(64, 64), { path: nomode, repeats: 1 }, hooks()).catch((e) => e)
    expect(err).toBeInstanceOf(BackendError)
    expect(err.message).toMatch(/cannot upscale a finished picture on its own/)
  })

  it('returns every image of a batch with consecutive seeds', async () => {
    const out = await backend().generate(params({ model: 'local1', steps: 2, count: 3, seed: 100 }), hooks())
    expect(out.map((o) => o.seed)).toEqual([100, 101, 102])
    expect(new Set(out.map((o) => Buffer.from(o.data).toString('hex'))).size).toBe(3)
  })

  it('explains an out-of-memory failure', async () => {
    const err = await backend().generate(params({ model: 'local1', prompt: 'OOM please' }), hooks()).catch((e) => e)
    expect(err).toBeInstanceOf(BackendError)
    expect(err.message).toMatch(/ran out of memory/)
  })

  it('stops the process when cancelled', async () => {
    const ac = new AbortController()
    const started = Date.now()
    const p = backend().generate(params({ model: 'local1', prompt: 'SLOW', steps: 30 }), hooks(ac.signal))
    setTimeout(() => ac.abort(), 300)
    const err = await p.catch((e) => e)
    expect(err.message).toBe('Cancelled')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('validates the model selection and files', async () => {
    await expect(backend().generate(params({ model: 'missing' }), hooks())).rejects.toThrow(/no longer exists/)
    settings.image.localModels.push({ ...blankSdModel('sd'), id: 'nofile', name: 'No File', model: '' })
    await expect(backend().generate(params({ model: 'nofile' }), hooks())).rejects.toThrow(/no model file/)
    settings.image.localModels.push({ ...blankSdModel('sd'), id: 'gone', name: 'Gone', model: path.join(dir, 'gone.safetensors') })
    await expect(backend().generate(params({ model: 'gone' }), hooks())).rejects.toThrow(/not found/)
  })

  it('tells the user to install the engine when none is available', async () => {
    const be = new SdCppBackend({ getSettings: () => settings, tmpDir: dir, engines: { resolveBinary: () => null, spawnEnv: () => process.env } as never })
    await expect(be.test()).rejects.toThrow(/not installed/)
  })
})

/* ───────────────────────────── HTTP backends against mock servers ───────────────────────────── */

function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }))
  })
}
const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => resolve(b))
  })
const cfg = (kind: ImageBackendConfig['kind'], baseUrl: string, over: Partial<ImageBackendConfig> = {}): ImageBackendConfig => ({ id: kind, name: kind, kind, enabled: true, baseUrl, apiKey: '', comfyWorkflow: '', defaultModel: '', ...over })

describe('ComfyUI backend', () => {
  let srv: http.Server
  let url = ''
  let submitted: any = null
  let historyCalls = 0
  let failMode = false

  beforeAll(async () => {
    ;({ server: srv, url } = await listen(async (req, res) => {
      const u = new URL(req.url ?? '', 'http://x')
      const json = (o: unknown, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(o))
      }
      if (u.pathname === '/object_info/CheckpointLoaderSimple') return json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors', 'sd15.safetensors']] } } } })
      if (u.pathname === '/system_stats') return json({ system: { comfyui_version: '0.3.9' }, devices: [{ name: 'AMD Radeon RX 6900 XT' }] })
      if (u.pathname === '/prompt' && req.method === 'POST') {
        submitted = JSON.parse(await readBody(req))
        if (submitted.prompt['4'].inputs.ckpt_name === 'bad.safetensors') return json({ error: { message: 'Prompt outputs failed validation' }, node_errors: { '4': { class_type: 'CheckpointLoaderSimple', errors: [{ message: 'Value not in list' }] } } }, 400)
        return json({ prompt_id: 'pid1' })
      }
      if (u.pathname === '/history/pid1') {
        historyCalls++
        if (failMode) return json({ pid1: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] } } })
        if (historyCalls < 2) return json({})
        return json({ pid1: { status: { status_str: 'success' }, outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }, { filename: 'b.png', subfolder: 'x', type: 'output' }, { filename: 't.png', subfolder: '', type: 'temp' }] } } } })
      }
      if (u.pathname === '/view') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        return res.end(Buffer.from(fakePng(32, 32, u.searchParams.get('filename') === 'a.png' ? 1 : 2)))
      }
      res.writeHead(404)
      res.end()
    }))
  })
  afterAll(() => new Promise((r) => srv.close(r)))
  beforeEach(() => {
    submitted = null
    historyCalls = 0
    failMode = false
  })

  it('lists checkpoints and tests the connection', async () => {
    const be = new ComfyBackend(cfg('comfyui', url))
    expect((await be.listModels()).map((m) => m.id)).toEqual(['sdxl.safetensors', 'sd15.safetensors'])
    expect(await be.test()).toMatch(/Connected to ComfyUI 0\.3\.9 on AMD Radeon RX 6900 XT\. 2 checkpoints/)
  })

  it('submits the default workflow with typed values and returns the saved (non-temp) images', async () => {
    const be = new ComfyBackend(cfg('comfyui', url))
    const out = await be.generate(params({ model: 'sdxl.safetensors', negative: 'ugly', width: 832, height: 1216, steps: 25, cfg: 6.5, sampler: 'dpm++2m', count: 2, seed: 9 }), hooks())
    const w = submitted.prompt
    expect(w['3'].inputs).toMatchObject({ seed: 9, steps: 25, cfg: 6.5, sampler_name: 'dpmpp_2m' })
    expect(w['5'].inputs).toMatchObject({ width: 832, height: 1216, batch_size: 2 })
    expect(w['6'].inputs.text).toBe('a snowy peak at dawn')
    expect(w['7'].inputs.text).toBe('ugly')
    expect(w['4'].inputs.ckpt_name).toBe('sdxl.safetensors')
    expect(out).toHaveLength(2)
    expect(out.map((o) => o.seed)).toEqual([9, 10])
    expect(DEFAULT_COMFY_WORKFLOW['3'].inputs.model).toEqual(['4', 0]) // template itself is not mutated
  })

  it('uses a custom workflow with placeholders', async () => {
    const custom = JSON.stringify({ ...DEFAULT_COMFY_WORKFLOW, '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'Custom_{{seed}}', images: ['8', 0] } } })
    await new ComfyBackend(cfg('comfyui', url, { comfyWorkflow: custom })).generate(params({ model: 'sdxl.safetensors', seed: 5 }), hooks())
    expect(submitted.prompt['9'].inputs.filename_prefix).toBe('Custom_5')
  })

  it('rejects an invalid custom workflow before contacting the server', async () => {
    await expect(new ComfyBackend(cfg('comfyui', url, { comfyWorkflow: '{ nope' })).generate(params(), hooks())).rejects.toThrow(/not valid JSON/)
    expect(submitted).toBeNull()
  })

  it('surfaces validation errors and execution errors readably', async () => {
    const be = new ComfyBackend(cfg('comfyui', url))
    await expect(be.generate(params({ model: 'bad.safetensors' }), hooks())).rejects.toThrow(/Prompt outputs failed validation.*Value not in list/)
    failMode = true
    await expect(be.generate(params({ model: 'sdxl.safetensors' }), hooks())).rejects.toThrow(/CUDA out of memory/)
  })

  it('explains an unreachable server', async () => {
    await expect(new ComfyBackend(cfg('comfyui', 'http://127.0.0.1:9')).test()).rejects.toThrow(/Cannot reach ComfyUI/)
  })
})

describe('AUTOMATIC1111 backend', () => {
  let srv: http.Server
  let url = ''
  let lastBody: any = null
  let lastPath = ''
  let interrupted = false

  beforeAll(async () => {
    ;({ server: srv, url } = await listen(async (req, res) => {
      const json = (o: unknown, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(o))
      }
      if (req.url === '/sdapi/v1/sd-models') return json([{ title: 'dreamshaper_8.safetensors [abc]', model_name: 'dreamshaper_8' }])
      if (req.url?.startsWith('/sdapi/v1/progress')) return json({ progress: 0.5, state: { sampling_step: 10, sampling_steps: 20 } })
      if (req.url === '/sdapi/v1/interrupt') {
        interrupted = true
        return json({})
      }
      if (req.url === '/sdapi/v1/txt2img' || req.url === '/sdapi/v1/img2img') {
        lastPath = req.url
        lastBody = JSON.parse(await readBody(req))
        if (lastBody.prompt === 'FAIL') return json({ detail: 'CUDA OOM' }, 500)
        await new Promise((r) => setTimeout(r, lastBody.prompt === 'SLOW' ? 1500 : 900))
        const imgs = Array.from({ length: lastBody.batch_size }, (_, i) => Buffer.from(fakePng(16, 16, i)).toString('base64'))
        return json({ images: imgs, info: JSON.stringify({ all_seeds: imgs.map((_, i) => lastBody.seed + 1000 + i) }) })
      }
      res.writeHead(404)
      res.end()
    }))
  })
  afterAll(() => new Promise((r) => srv.close(r)))

  it('lists checkpoints by title', async () => {
    expect(await new A1111Backend(cfg('a1111', url)).listModels()).toEqual([{ id: 'dreamshaper_8.safetensors [abc]', label: 'dreamshaper_8' }])
  })

  it('generates with mapped parameters, real seeds, and live progress', async () => {
    const h = hooks()
    const out = await new A1111Backend(cfg('a1111', url)).generate(params({ model: 'dreamshaper_8.safetensors [abc]', sampler: 'euler_a', count: 2, negative: 'bad hands' }), h)
    expect(lastPath).toBe('/sdapi/v1/txt2img')
    expect(lastBody).toMatchObject({ sampler_name: 'Euler a', batch_size: 2, negative_prompt: 'bad hands', cfg_scale: 1, steps: 4, override_settings: { sd_model_checkpoint: 'dreamshaper_8.safetensors [abc]' } })
    expect(out.map((o) => o.seed)).toEqual([1042, 1043])
    expect(h.log.some(([, l]) => /Sampling step 10\/20/.test(l ?? ''))).toBe(true)
  })

  it('switches to img2img with an init image', async () => {
    await new A1111Backend(cfg('a1111', url)).generate(params({ initImage: fakePng(8, 8), strength: 0.3 }), hooks())
    expect(lastPath).toBe('/sdapi/v1/img2img')
    expect(lastBody.denoising_strength).toBe(0.3)
    expect(lastBody.init_images).toHaveLength(1)
  })

  it('reports server errors and interrupts on cancel', async () => {
    await expect(new A1111Backend(cfg('a1111', url)).generate(params({ prompt: 'FAIL' }), hooks())).rejects.toThrow(/HTTP 500.*CUDA OOM/)
    const ac = new AbortController()
    const p = new A1111Backend(cfg('a1111', url)).generate(params({ prompt: 'SLOW' }), hooks(ac.signal))
    setTimeout(() => ac.abort(), 200)
    await expect(p).rejects.toThrow('Cancelled')
    await new Promise((r) => setTimeout(r, 100))
    expect(interrupted).toBe(true)
  })

  it('explains an unreachable server', async () => {
    await expect(new A1111Backend(cfg('a1111', 'http://127.0.0.1:9')).test()).rejects.toThrow(/--api/)
  })
})

describe('OpenAI-compatible image backend', () => {
  let srv: http.Server
  let url = ''
  let bodies: any[] = []
  let auth = ''

  beforeAll(async () => {
    ;({ server: srv, url } = await listen(async (req, res) => {
      const json = (o: unknown, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(o))
      }
      auth = String(req.headers.authorization ?? '')
      if (req.url === '/v1/models') return json({ data: [{ id: 'flux-dev' }, { id: 'llama-3' }, { id: 'sdxl-turbo' }] })
      if (req.url === '/v1/images/generations') {
        const b = JSON.parse(await readBody(req))
        bodies.push(b)
        if (b.prompt === 'BLOCKED') return json({ error: { message: 'Your request was rejected by the safety system' } }, 400)
        if (b.prompt === 'URL') return json({ data: [{ url: `${url}/img.png` }] })
        return json({ data: [{ b64_json: Buffer.from(fakePng(1024, 1024, bodies.length)).toString('base64') }] })
      }
      if (req.url === '/img.png') {
        res.writeHead(200)
        return res.end(Buffer.from(fakePng(20, 20)))
      }
      res.writeHead(404)
      res.end()
    }))
    url = `${url}`
  })
  afterAll(() => new Promise((r) => srv.close(r)))
  beforeEach(() => (bodies = []))

  it('lists image-looking models for a compatible server', async () => {
    const be = new OpenAIImagesBackend(cfg('openai', `${url}/v1`, { defaultModel: 'my-model' }))
    expect((await be.listModels()).map((m) => m.id).sort()).toEqual(['flux-dev', 'my-model', 'sdxl-turbo'])
  })

  it('requests one image at a time with the exact size on compatible servers', async () => {
    const be = new OpenAIImagesBackend(cfg('openai', `${url}/v1`, { apiKey: 'sk-test' }))
    const out = await be.generate(params({ model: 'flux-dev', width: 832, height: 1216, count: 2 }), hooks())
    expect(out).toHaveLength(2)
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toMatchObject({ model: 'flux-dev', size: '832x1216', n: 1 })
    expect(bodies[0].response_format).toBeUndefined()
    expect(auth).toBe('Bearer sk-test')
  })

  it('downloads URL results and shows server error messages', async () => {
    const be = new OpenAIImagesBackend(cfg('openai', `${url}/v1`))
    const out = await be.generate(params({ model: 'flux-dev', prompt: 'URL' }), hooks())
    expect(imageSize(out[0].data)).toEqual({ width: 20, height: 20 })
    await expect(be.generate(params({ model: 'flux-dev', prompt: 'BLOCKED' }), hooks())).rejects.toThrow(/safety system/)
  })

  it('requires an API key for the official endpoint', async () => {
    await expect(new OpenAIImagesBackend(cfg('openai', 'https://api.openai.com/v1')).test()).rejects.toThrow(/API key/)
  })
})

/* ───────────────────────────── ImageService ───────────────────────────── */

class MockBackend implements ImageBackend {
  supportsImg2Img = true
  supportsInpaint = true
  supportsNegative = true
  calls: GenParams[] = []
  gate: Promise<void> | null = null
  outSize = { w: 640, h: 480 }
  models = [{ id: 'm1', label: 'Model One', defaults: { width: 512, height: 512, steps: 4, cfg: 1.5, sampler: 'euler' } }]
  failListing = false
  warning: string | undefined
  upscaleCalls: { up: { path: string; repeats: number }; size: number }[] = []
  async upscale(image: Uint8Array, up: { path: string; repeats: number }, h: BackendHooks) {
    this.upscaleCalls.push({ up, size: image.length })
    h.onProgress(0.5, 'Upscaling the picture…', 'upscaling')
    return [{ data: fakePng(2560, 1920, 9), seed: 0 }]
  }
  async listModels() {
    if (this.failListing) throw new Error('connection refused')
    return this.models
  }
  async test() {
    return 'ok'
  }
  async generate(p: GenParams, h: BackendHooks) {
    this.calls.push(p)
    h.onProgress(0.3, 'Sampling', 'sampling')
    if (this.gate) {
      await Promise.race([
        this.gate,
        new Promise<void>((_, rej) => h.signal.addEventListener('abort', () => rej(new BackendError('Cancelled')), { once: true }))
      ])
    }
    h.onProgress(0.9, 'Decoding', 'decoding')
    return Array.from({ length: p.count }, (_, i) => ({ data: fakePng(this.outSize.w, this.outSize.h, i + 1), seed: p.seed + i, warning: i === 0 ? this.warning : undefined }))
  }
}

describe('ImageService', () => {
  let dir: string
  let store: ImageStore
  let be: MockBackend
  let settings: Settings
  let unloaded = 0
  let events: ImageJob[] = []
  let svc: ImageService

  const req = (over: Partial<ImageGenRequest> = {}): ImageGenRequest => ({ prompt: 'mountain lake', width: 0, height: 0, seed: -1, count: 1, source: 'hub', ...over })
  const waitFor = async <T>(fn: () => T | undefined | false, ms = 3000): Promise<T> => {
    const t = Date.now()
    for (;;) {
      const v = fn()
      if (v) return v as T
      if (Date.now() - t > ms) throw new Error('waitFor timed out')
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  const status = (id: string) => svc.listJobs().find((j) => j.id === id)!.status

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cairn-svc-'))
    await fsp.mkdir(path.join(dir, 'images'), { recursive: true })
    await fsp.mkdir(path.join(dir, 'thumbs'), { recursive: true })
    store = new ImageStore({ imagesDir: path.join(dir, 'images'), thumbsDir: path.join(dir, 'thumbs'), indexFile: path.join(dir, 'images', 'index.json') })
    be = new MockBackend()
    settings = defaultSettings(dir)
    settings.image.backends = [cfg('comfyui', 'http://mock', { id: 'mock', name: 'Mock' })]
    settings.image.negativePrompt = 'default negative'
    unloaded = 0
    events = []
    setEventSink((ch, p) => {
      if (ch === 'images:job') events.push(p as ImageJob)
    })
    svc = new ImageService({
      getSettings: () => settings,
      store,
      engines: { resolveBinary: () => '/bin/sd', esrganModelsDir: () => null } as never,
      llama: { unloadForImages: async () => (unloaded++, true) },
      tmpDir: dir,
      modelsDir: () => dir,
      makeBackend: () => be
    })
  })
  afterEach(async () => {
    setEventSink(() => {})
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('fills in model defaults, snaps sizes, records real image size and emits job events', async () => {
    const job = svc.submit(req({ width: 519, height: 700, prompt: '  lake  ' }))
    await waitFor(() => status(job.id) === 'done')
    expect(be.calls).toHaveLength(1)
    const c = be.calls[0]
    expect(c).toMatchObject({ prompt: 'lake', width: 520, height: 704, steps: 4, cfg: 1.5, sampler: 'euler', model: 'm1', negative: 'default negative', count: 1 })
    expect(c.seed).toBeGreaterThanOrEqual(0)
    const final = svc.listJobs()[0]
    expect(final.resultIds).toHaveLength(1)
    const rec = store.get(final.resultIds[0]) as ImageRecord
    expect(rec).toMatchObject({ width: 640, height: 480, backendId: 'mock', model: 'Model One', source: 'hub', seed: c.seed, negativePrompt: 'default negative' })
    const seq = events.filter((e) => e.id === job.id).map((e) => e.status)
    expect(seq[0]).toBe('queued')
    expect(seq).toContain('running')
    expect(seq.at(-1)).toBe('done')
    expect(events.at(-1)?.progress).toBe(1)
  })

  it('passes the stage along with progress and clears it when the job ends', async () => {
    const job = svc.submit(req())
    await waitFor(() => status(job.id) === 'done')
    const mine = events.filter((e) => e.id === job.id)
    expect(mine.some((e) => e.stage === 'sampling' && e.label === 'Sampling')).toBe(true)
    expect(mine.some((e) => e.stage === 'decoding' && e.label === 'Decoding')).toBe(true)
    expect(mine.at(-1)?.stage).toBeUndefined()
  })

  it('rounds sizes to the multiple the model type needs (16 for FLUX, 8 for Stable Diffusion)', async () => {
    settings.image.backends = [cfg('builtin', '', { id: 'builtin', name: 'Built-in' })]
    settings.image.localModels = [
      { ...blankSdModel('flux'), id: 'f1', name: 'FLUX schnell', model: 'x' },
      { ...blankSdModel('sd'), id: 's1', name: 'SD 1.5', model: 'x' }
    ]
    be.models = [
      { id: 'f1', label: 'FLUX schnell', defaults: { width: 1024, height: 1024, steps: 4, cfg: 1, sampler: 'euler' } },
      { id: 's1', label: 'SD 1.5', defaults: { width: 512, height: 512, steps: 20, cfg: 7, sampler: 'euler' } }
    ]
    const a = svc.submit(req({ width: 1000, height: 1020, target: { backendId: 'builtin', model: 'f1' } }))
    await waitFor(() => status(a.id) === 'done')
    expect(be.calls[0]).toMatchObject({ model: 'f1', width: 1008, height: 1024 })
    const b = svc.submit(req({ width: 1005, height: 1020, target: { backendId: 'builtin', model: 's1' } }))
    await waitFor(() => status(b.id) === 'done')
    expect(be.calls[1]).toMatchObject({ model: 's1', width: 1008, height: 1024 })
  })

  it('uses model-default size when the request leaves it unset', async () => {
    const job = svc.submit(req())
    await waitFor(() => status(job.id) === 'done')
    expect(be.calls[0]).toMatchObject({ width: 512, height: 512 })
  })

  it('keeps an explicit seed and uses consecutive seeds for batches', async () => {
    const job = svc.submit(req({ seed: 1000, count: 3 }))
    await waitFor(() => status(job.id) === 'done')
    expect(svc.listJobs()[0].resultIds.map((id) => store.get(id)!.seed)).toEqual([1000, 1001, 1002])
  })

  it('drops the negative prompt for backends that do not support one', async () => {
    be.supportsNegative = false
    const job = svc.submit(req({ negativePrompt: 'ignored' }))
    await waitFor(() => status(job.id) === 'done')
    expect(be.calls[0].negative).toBe('')
  })

  it('runs jobs one at a time, in order', async () => {
    let release!: () => void
    be.gate = new Promise<void>((r) => (release = r))
    const a = svc.submit(req({ prompt: 'a' }))
    const b = svc.submit(req({ prompt: 'b' }))
    await waitFor(() => be.calls.length === 1)
    expect(status(a.id)).toBe('running')
    expect(status(b.id)).toBe('queued')
    release()
    await waitFor(() => status(b.id) === 'done')
    expect(be.calls.map((c) => c.prompt)).toEqual(['a', 'b'])
  })

  it('cancels a running job and a queued job', async () => {
    be.gate = new Promise<void>(() => {})
    const a = svc.submit(req({ prompt: 'a' }))
    const b = svc.submit(req({ prompt: 'b' }))
    await waitFor(() => be.calls.length === 1)
    svc.cancel(b.id)
    expect(status(b.id)).toBe('cancelled')
    svc.cancel(a.id)
    await waitFor(() => status(a.id) === 'cancelled')
    expect(be.calls.map((c) => c.prompt)).toEqual(['a'])
    expect(store.list()).toHaveLength(0)
    // the queue keeps working afterwards
    be.gate = null
    const c = svc.submit(req({ prompt: 'c' }))
    await waitFor(() => status(c.id) === 'done')
  })

  it('fails fast on an empty prompt and reports backend errors on the job', async () => {
    const empty = svc.submit(req({ prompt: '   ' }))
    expect(status(empty.id)).toBe('error')
    expect(svc.listJobs().find((j) => j.id === empty.id)?.error).toMatch(/Describe the image/)

    be.generate = async () => {
      throw new BackendError('GPU exploded')
    }
    const bad = svc.submit(req())
    await waitFor(() => status(bad.id) === 'error')
    expect(svc.listJobs().find((j) => j.id === bad.id)?.error).toBe('GPU exploded')
  })

  it('explains when no image model is ready', async () => {
    be.failListing = true
    svc.invalidate()
    const job = svc.submit(req())
    await waitFor(() => status(job.id) === 'error')
    expect(svc.listJobs().find((j) => j.id === job.id)?.error).toMatch(/No image model is ready.*connection refused/)
  })

  it('honours an explicit target and the saved default target', async () => {
    be.models = [
      { id: 'm1', label: 'Model One', defaults: { width: 512, height: 512, steps: 4, cfg: 1.5, sampler: 'euler' } },
      { id: 'm2', label: 'Model Two', defaults: { width: 1024, height: 1024, steps: 30, cfg: 5, sampler: 'dpm++2m' } }
    ]
    const a = svc.submit(req({ target: { backendId: 'mock', model: 'm2' } }))
    await waitFor(() => status(a.id) === 'done')
    expect(be.calls[0]).toMatchObject({ model: 'm2', width: 1024, steps: 30, sampler: 'dpm++2m' })
    settings.image.defaultTarget = { backendId: 'mock', model: 'm2' }
    const b = svc.submit(req())
    await waitFor(() => status(b.id) === 'done')
    expect(be.calls[1].model).toBe('m2')
    // a stale default falls back to the first usable model
    settings.image.defaultTarget = { backendId: 'gone', model: 'x' }
    const c = svc.submit(req())
    await waitFor(() => status(c.id) === 'done')
    expect(be.calls[2].model).toBe('m1')
  })

  it('refuses image-to-image on backends without support and loads the source image otherwise', async () => {
    const src = await store.add(fakePng(8, 8, 9), { prompt: 's', negativePrompt: '', backendId: 'b', backendName: 'B', model: 'm', width: 8, height: 8, seed: 1, durationMs: 1, source: 'hub' })
    be.supportsImg2Img = false
    const no = svc.submit(req({ initImageId: src.id }))
    await waitFor(() => status(no.id) === 'error')
    expect(svc.listJobs().find((j) => j.id === no.id)?.error).toMatch(/does not support image-to-image/)

    be.supportsImg2Img = true
    const yes = svc.submit(req({ initImageId: src.id, strength: 0.5 }))
    await waitFor(() => status(yes.id) === 'done')
    expect(be.calls.at(-1)?.initImage).toBeInstanceOf(Uint8Array)
    expect(be.calls.at(-1)?.strength).toBe(0.5)
    const rec = store.get(svc.listJobs().find((j) => j.id === yes.id)!.resultIds[0])
    expect(rec?.initImageId).toBe(src.id)
  })

  it('frees GPU memory before running the built-in engine, but not for other backends', async () => {
    settings.image.backends = [cfg('builtin', '', { id: 'builtin', name: 'Built-in' })]
    settings.image.unloadLlmForImages = true
    const a = svc.submit(req())
    await waitFor(() => status(a.id) === 'done')
    expect(unloaded).toBe(1)
    settings.image.unloadLlmForImages = false
    const b = svc.submit(req())
    await waitFor(() => status(b.id) === 'done')
    expect(unloaded).toBe(1)
    settings.image.unloadLlmForImages = true
    settings.image.backends = [cfg('comfyui', 'http://mock', { id: 'mock', name: 'Mock' })]
    svc.invalidate()
    const c = svc.submit(req())
    await waitFor(() => status(c.id) === 'done')
    expect(unloaded).toBe(1)
  })

  it('reports target availability and reasons', async () => {
    let t = await svc.targets()
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ backendId: 'mock', model: 'm1', label: 'Model One', available: true, supportsImg2Img: true })
    be.failListing = true
    t = await svc.targets(true)
    expect(t[0]).toMatchObject({ available: false })
    expect(t[0].unavailableReason).toMatch(/connection refused/)
    be.failListing = false
    be.models = []
    t = await svc.targets(true)
    expect(t[0].available).toBe(false)
  })

  it('says the engine is missing for the built-in backend', async () => {
    settings.image.backends = [cfg('builtin', '', { id: 'builtin', name: 'Built-in' })]
    const noEngine = new ImageService({ getSettings: () => settings, store, engines: { resolveBinary: () => null, esrganModelsDir: () => null } as never, llama: { unloadForImages: async () => false }, tmpDir: dir, makeBackend: () => be })
    const t = await noEngine.targets()
    expect(t[0].available).toBe(false)
    expect(t[0].unavailableReason).toMatch(/engine is not installed/)
    expect(noEngine.available()).toBe(false)
  })

  it('available() reflects configured backends', () => {
    expect(svc.available()).toBe(true)
    settings.image.backends = [cfg('comfyui', '', { id: 'x', name: 'x' })]
    expect(svc.available()).toBe(false)
    settings.image.backends = [cfg('openai', '', { id: 'o', name: 'o', apiKey: 'k' })]
    expect(svc.available()).toBe(true)
    settings.image.backends = [cfg('comfyui', 'http://x', { id: 'x', name: 'x', enabled: false })]
    expect(svc.available()).toBe(false)
  })

  it('generate() (chat API) returns refs, streams progress and honours the abort signal', async () => {
    const seen: number[] = []
    const refs = await svc.generate(req({ source: 'chat', conversationId: 'c1', prompt: 'peak' }), { onProgress: (f) => seen.push(f), signal: new AbortController().signal })
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ prompt: 'peak', width: 640, height: 480 })
    expect(store.get(refs[0].id)).toMatchObject({ source: 'chat', conversationId: 'c1' })
    expect(seen.length).toBeGreaterThan(0)

    be.gate = new Promise<void>(() => {})
    const ac = new AbortController()
    const p = svc.generate(req({ source: 'chat' }), { onProgress() {}, signal: ac.signal })
    await waitFor(() => be.calls.length === 2)
    ac.abort()
    await expect(p).rejects.toThrow('Cancelled')
  })

  it('tests a connection and clears the target cache', async () => {
    expect(await svc.testBackend('mock')).toEqual({ ok: true, message: 'ok' })
    expect(await svc.testBackend('missing')).toMatchObject({ ok: false })
    be.test = async () => {
      throw new Error('nope')
    }
    expect(await svc.testBackend('mock')).toEqual({ ok: false, message: 'nope' })
  })

  describe('starting from a picture', () => {
    const useBuiltin = () => {
      settings.image.backends = [cfg('builtin', '', { id: 'builtin', name: 'Built-in' })]
      settings.image.localModels = [{ ...blankSdModel('sd'), id: 'm1', name: 'Model One', model: 'x' }]
    }
    const addPic = (w: number, h: number, name = 'photo.png') => svc.importPicture(name, fakePng(w, h, 7))

    it('brings in a picture from a file and keeps it apart from made pictures', async () => {
      const rec = await addPic(1500, 1000, '/home/me/My Photos/lake.png')
      expect(rec).toMatchObject({ width: 1500, height: 1000, imported: true, backendId: 'import', prompt: 'lake.png', source: 'hub', favorite: false })
      expect(store.get(rec.id)).toBeTruthy()
      expect(events).toBeDefined()
    })

    it('refuses files that are not pictures, are too small, or are too large', async () => {
      await expect(svc.importPicture('x.png', new Uint8Array(0))).rejects.toThrow(/empty/)
      await expect(svc.importPicture('x.txt', new Uint8Array(200).fill(65))).rejects.toThrow(/not a PNG, JPEG or WebP/)
      await expect(addPic(32, 32)).rejects.toThrow(/too small/)
      await expect(addPic(9000, 100)).rejects.toThrow(/most allowed/)
      await expect(svc.importPicture('big.png', new Uint8Array(41 * 1024 * 1024))).rejects.toThrow(/too big/)
      expect(store.list()).toHaveLength(0)
    })

    it('draws from the picture, keeps its shape when no size is asked for, and records the strength', async () => {
      const pic = await addPic(1500, 1000)
      const job = svc.submit(req({ initImageId: pic.id, strength: 0.45 }))
      await waitFor(() => status(job.id) === 'done')
      const c = be.calls[0]
      expect(c.initImage).toBeInstanceOf(Uint8Array)
      expect(c.initImage!.length).toBe(64)
      expect(c.strength).toBe(0.45)
      expect(Math.abs(c.width / c.height - 1.5)).toBeLessThan(0.03)
      expect(c.width % 8).toBe(0)
      const rec = store.get(svc.listJobs()[0].resultIds[0]) as ImageRecord
      expect(rec).toMatchObject({ initImageId: pic.id, strength: 0.45 })
    })

    it('uses an exact size when one is asked for, and clamps a strength that is out of range', async () => {
      const pic = await addPic(1500, 1000)
      const a = svc.submit(req({ initImageId: pic.id, width: 512, height: 512, strength: 7 }))
      await waitFor(() => status(a.id) === 'done')
      expect(be.calls[0]).toMatchObject({ width: 512, height: 512, strength: 1 })
      const b = svc.submit(req({ initImageId: pic.id, width: 512, height: 512 }))
      await waitFor(() => status(b.id) === 'done')
      expect(be.calls[1].strength).toBe(0.6)
    })

    it('sends no starting picture or strength for an ordinary request', async () => {
      const job = svc.submit(req({ strength: 0.3 }))
      await waitFor(() => status(job.id) === 'done')
      expect(be.calls[0].initImage).toBeUndefined()
      expect(be.calls[0].strength).toBeUndefined()
      const rec = store.get(svc.listJobs()[0].resultIds[0]) as ImageRecord
      expect(rec.initImageId).toBeUndefined()
      expect(rec.strength).toBeUndefined()
    })

    it('says so when the starting picture is gone, and when the backend cannot use one', async () => {
      const gone = svc.submit(req({ initImageId: 'img_missing' }))
      await waitFor(() => status(gone.id) === 'error')
      expect(svc.listJobs().find((j) => j.id === gone.id)!.error).toMatch(/no longer exists/)
      const pic = await addPic(800, 600)
      be.supportsImg2Img = false
      const job = svc.submit(req({ initImageId: pic.id }))
      await waitFor(() => status(job.id) === 'error')
      expect(svc.listJobs().find((j) => j.id === job.id)!.error).toMatch(/does not support image-to-image/)
    })

    it('refuses a WebP starting picture on the built-in engine, which cannot read it', async () => {
      useBuiltin()
      const webp = await store.add(fakeWebpVp8x(800, 600), { prompt: 'w', negativePrompt: '', backendId: 'mock', backendName: 'Mock', model: '', width: 800, height: 600, seed: 1, durationMs: 1, source: 'hub' })
      const job = svc.submit(req({ target: { backendId: 'builtin', model: 'm1' }, initImageId: webp.id }))
      await waitFor(() => status(job.id) === 'error')
      expect(svc.listJobs().find((j) => j.id === job.id)!.error).toMatch(/WebP/)
      expect(be.calls).toHaveLength(0)
    })
  })

  describe('LoRAs and upscalers', () => {
    const useBuiltin = () => {
      settings.image.backends = [cfg('builtin', '', { id: 'builtin', name: 'Built-in' })]
      settings.image.localModels = [{ ...blankSdModel('sd'), id: 'm1', name: 'Model One', model: 'x' }]
    }
    const target = { backendId: 'builtin', model: 'm1' }
    const put = async (rel: string, bytes: Uint8Array | string = 'x') => {
      const f = path.join(dir, 'image', rel)
      await fsp.mkdir(path.dirname(f), { recursive: true })
      await fsp.writeFile(f, bytes)
      return f
    }

    it('adds trigger words to the prompt, keeps the typed prompt in the record and passes LoRAs on', async () => {
      useBuiltin()
      await put('lora/pixel.safetensors')
      const job = svc.submit(req({ target, prompt: 'a fox', loras: [{ id: 'pixel', strength: 9, trigger: ' pixelart ' }] }))
      await waitFor(() => status(job.id) === 'done')
      expect(be.calls[0].prompt).toBe('pixelart, a fox')
      expect(be.calls[0].loras).toEqual([{ id: 'pixel', strength: 2 }])
      expect(be.calls[0].loraDir).toBe(path.join(dir, 'image', 'lora'))
      const rec = store.get(svc.listJobs()[0].resultIds[0]) as ImageRecord
      expect(rec.prompt).toBe('a fox')
      expect(rec.loras).toEqual([{ id: 'pixel', strength: 9, trigger: ' pixelart ' }])
    })

    it('refuses LoRAs that are missing, that escape the folder, or that the engine cannot use', async () => {
      useBuiltin()
      for (const id of ['ghost', '../secret']) {
        const j = svc.submit(req({ target, loras: [{ id, strength: 1 }] }))
        await waitFor(() => status(j.id) === 'error')
      }
      expect(be.calls).toHaveLength(0)
      settings.image.backends = [cfg('comfyui', 'http://mock', { id: 'mock', name: 'Mock' })]
      await put('lora/pixel.safetensors')
      const j = svc.submit(req({ loras: [{ id: 'pixel', strength: 1 }] }))
      await waitFor(() => status(j.id) === 'error')
      expect(svc.listJobs().find((x) => x.id === j.id)?.error).toMatch(/only work with the built-in/)
      expect(be.calls).toHaveLength(0)
    })

    it('upscales while drawing and records the upscaler', async () => {
      useBuiltin()
      const up = await put('upscale/4x-UltraSharp.pth')
      const job = svc.submit(req({ target, upscale: { path: up, repeats: 9 } }))
      await waitFor(() => status(job.id) === 'done')
      expect(be.calls[0].upscale).toEqual({ path: up, repeats: 3 })
      expect((store.get(svc.listJobs()[0].resultIds[0]) as ImageRecord).upscaler).toBe('4x-UltraSharp')
    })

    it('keeps the picture and reports it when the engine ignored the upscaler', async () => {
      useBuiltin()
      const up = await put('upscale/4x.pth')
      be.warning = 'The image engine could not use the upscaler'
      const job = svc.submit(req({ target, upscale: { path: up } }))
      await waitFor(() => status(job.id) === 'done')
      const done = svc.listJobs().find((j) => j.id === job.id)!
      expect(done.resultIds).toHaveLength(1)
      expect(done.notice).toMatch(/could not use the upscaler/)
    })

    it('only accepts upscaler files from the upscale folder', async () => {
      useBuiltin()
      const outside = path.join(dir, 'evil.pth')
      await fsp.writeFile(outside, 'x')
      const job = svc.submit(req({ target, upscale: { path: outside } }))
      await waitFor(() => status(job.id) === 'error')
      expect(be.calls).toHaveLength(0)
    })

    it('upscales a picture from the gallery into a new record that remembers its source', async () => {
      useBuiltin()
      const first = svc.submit(req({ target, prompt: 'peak' }))
      await waitFor(() => status(first.id) === 'done')
      const src = store.get(svc.listJobs().find((j) => j.id === first.id)!.resultIds[0]) as ImageRecord
      const up = await put('upscale/RealESRGAN_x2plus.pth')
      const job = svc.submit(req({ target, prompt: src.prompt, upscaleOf: src.id, upscale: { path: up } }))
      await waitFor(() => status(job.id) === 'done')
      expect(be.calls).toHaveLength(1) // nothing was drawn again
      expect(be.upscaleCalls).toHaveLength(1)
      const rec = store.get(svc.listJobs().find((j) => j.id === job.id)!.resultIds[0]) as ImageRecord
      expect(rec).toMatchObject({ width: 2560, height: 1920, prompt: 'peak', upscaledFrom: src.id, upscaler: 'RealESRGAN_x2plus', seed: src.seed })
      expect(events.some((e) => e.id === job.id && e.stage === 'upscaling')).toBe(true)
    })

    it('fails clearly when the picture to upscale is gone', async () => {
      useBuiltin()
      const up = await put('upscale/4x.pth')
      const job = svc.submit(req({ target, upscaleOf: 'nope', upscale: { path: up } }))
      await waitFor(() => status(job.id) === 'error')
      expect(svc.listJobs().find((j) => j.id === job.id)?.error).toMatch(/no longer exists/)
    })

    describe('with the Real-ESRGAN upscaler', () => {
      const ncnn = async (name = 'realesrgan-x4plus') => {
        await put(`upscale/${name}.bin`, 'b')
        return put(`upscale/${name}.param`, 'p')
      }
      const esrganCalls: { path: string; repeats: number; label?: string }[] = []
      let esrganFails = false
      const withEsrgan = () =>
        new ImageService({
          getSettings: () => settings,
          store,
          engines: { resolveBinary: () => '/bin/sd', esrganModelsDir: () => null } as never,
          llama: { unloadForImages: async () => true },
          tmpDir: dir,
          modelsDir: () => dir,
          makeBackend: () => be,
          makeEsrgan: () => ({
            async upscale(_image, up, h, label) {
              esrganCalls.push({ ...up, label })
              h.onProgress(0.5, label ?? 'Upscaling…', 'upscaling')
              if (esrganFails) throw new BackendError('The GPU ran out of memory.')
              return [{ data: fakePng(2560, 1920, 7), seed: 0 }]
            }
          })
        })
      const statusOf = (s: ImageService, id: string) => s.listJobs().find((j) => j.id === id)!.status
      beforeEach(() => {
        esrganCalls.length = 0
        esrganFails = false
      })

      it('lists the upscaler as one that Real-ESRGAN runs', async () => {
        await ncnn()
        await put('upscale/old.pth')
        const list = await svc.listUpscalers()
        expect(list.map((u) => [u.name, u.engine])).toEqual([['realesrgan-x4plus', 'esrgan'], ['old', 'sd']])
      })

      it('draws without the built-in upscaler, then enlarges each finished picture with Real-ESRGAN', async () => {
        useBuiltin()
        const s = withEsrgan()
        const up = await ncnn()
        const job = s.submit(req({ target, count: 2, upscale: { path: up, repeats: 2 } }))
        await waitFor(() => statusOf(s, job.id) === 'done')
        expect(be.calls[0].upscale).toBeUndefined() // stable-diffusion.cpp was not asked to upscale
        expect(esrganCalls.map((c) => c.repeats)).toEqual([2, 2])
        expect(esrganCalls[0].label).toBe('Upscaling picture 1 of 2…')
        const recs = s.listJobs().find((j) => j.id === job.id)!.resultIds.map((id) => store.get(id) as ImageRecord)
        expect(recs).toHaveLength(2)
        for (const r of recs) expect(r).toMatchObject({ width: 2560, height: 1920, upscaler: 'realesrgan-x4plus' })
        expect(events.some((e) => e.id === job.id && e.stage === 'upscaling')).toBe(true)
      })

      it('works after other image backends too, which the built-in upscaler cannot do', async () => {
        const s = withEsrgan()
        const up = await ncnn()
        const job = s.submit(req({ upscale: { path: up } })) // the default backend is the mock ComfyUI one
        await waitFor(() => statusOf(s, job.id) === 'done')
        expect(esrganCalls).toHaveLength(1)
        const old = await put('upscale/old.pth')
        const refused = s.submit(req({ upscale: { path: old } }))
        await waitFor(() => statusOf(s, refused.id) === 'error')
        expect(s.listJobs().find((j) => j.id === refused.id)?.error).toMatch(/only works with the built-in image engine/)
      })

      it('keeps the drawn pictures and says so when enlarging fails', async () => {
        useBuiltin()
        const s = withEsrgan()
        const up = await ncnn()
        esrganFails = true
        const job = s.submit(req({ target, upscale: { path: up } }))
        await waitFor(() => statusOf(s, job.id) === 'done')
        const done = s.listJobs().find((j) => j.id === job.id)!
        expect(done.notice).toMatch(/could not be made bigger.*ran out of memory/)
        const rec = store.get(done.resultIds[0]) as ImageRecord
        expect(rec).toMatchObject({ width: 640, height: 480 })
        expect(rec.upscaler).toBeUndefined()
      })

      it('upscales a gallery picture without needing the built-in engine at all', async () => {
        settings.image.backends = [cfg('comfyui', 'http://mock', { id: 'mock', name: 'Mock' })]
        const s = withEsrgan()
        const first = s.submit(req({ prompt: 'peak' }))
        await waitFor(() => statusOf(s, first.id) === 'done')
        const src = store.get(s.listJobs().find((j) => j.id === first.id)!.resultIds[0]) as ImageRecord
        const up = await ncnn()
        const job = s.submit(req({ prompt: src.prompt, upscaleOf: src.id, upscale: { path: up } }))
        await waitFor(() => statusOf(s, job.id) === 'done')
        expect(be.upscaleCalls).toHaveLength(0)
        expect(esrganCalls).toHaveLength(1)
        const rec = store.get(s.listJobs().find((j) => j.id === job.id)!.resultIds[0]) as ImageRecord
        expect(rec).toMatchObject({ width: 2560, height: 1920, upscaledFrom: src.id, upscaler: 'realesrgan-x4plus' })
      })

      it('still needs the built-in engine for an upscaler only it can run', async () => {
        settings.image.backends = [cfg('comfyui', 'http://mock', { id: 'mock', name: 'Mock' })]
        const first = svc.submit(req({ prompt: 'peak' }))
        await waitFor(() => status(first.id) === 'done')
        const src = store.get(svc.listJobs().find((j) => j.id === first.id)!.resultIds[0]) as ImageRecord
        const old = await put('upscale/old.pth')
        const job = svc.submit(req({ upscaleOf: src.id, upscale: { path: old } }))
        await waitFor(() => status(job.id) === 'error')
        expect(svc.listJobs().find((j) => j.id === job.id)?.error).toMatch(/needs the built-in image engine/)
      })
    })

    describe('aliases and saved defaults', () => {
      const alias = (name: string, text: string) => ({ id: name, name, text })
      const record = (jobId: string) => store.get(svc.listJobs().find((j) => j.id === jobId)!.resultIds[0]) as ImageRecord

      it('expands aliases in the prompt and the avoid text, and the record keeps what the model was given', async () => {
        settings.image.aliases = [alias('moody', 'dramatic lighting, fog'), alias('bad', 'blurry, low quality')]
        const job = svc.submit(req({ prompt: 'a lake, Moody', negativePrompt: 'ugly, bad' }))
        await waitFor(() => status(job.id) === 'done')
        expect(be.calls[0].prompt).toBe('a lake, dramatic lighting, fog')
        expect(be.calls[0].negative).toBe('ugly, blurry, low quality')
        expect(record(job.id)).toMatchObject({ prompt: 'a lake, dramatic lighting, fog', negativePrompt: 'ugly, blurry, low quality' })
      })

      it('expands aliases in the default avoid text too, and puts LoRA trigger words in front', async () => {
        useBuiltin()
        settings.image.aliases = [alias('bad', 'blurry, low quality'), alias('fox', 'a red fox')]
        settings.image.negativePrompt = 'bad'
        await put('lora/pixel.safetensors')
        const job = svc.submit(req({ target, prompt: 'fox', loras: [{ id: 'pixel', strength: 1, trigger: 'pixelart' }] }))
        await waitFor(() => status(job.id) === 'done')
        expect(be.calls[0].prompt).toBe('pixelart, a red fox')
        expect(be.calls[0].negative).toBe('blurry, low quality')
      })

      it('leaves prompts alone when there are no aliases', async () => {
        const job = svc.submit(req({ prompt: 'plain words' }))
        await waitFor(() => status(job.id) === 'done')
        expect(be.calls[0].prompt).toBe('plain words')
        expect(record(job.id).prompt).toBe('plain words')
      })

      it('uses the steps and guidance saved for the model, but not for other models, and lets the request win', async () => {
        settings.image.modelDefaults = { 'mock::m1': { steps: 8, cfg: 2 } }
        const a = svc.submit(req({}))
        await waitFor(() => status(a.id) === 'done')
        expect(be.calls[0]).toMatchObject({ steps: 8, cfg: 2 })
        const b = svc.submit(req({ steps: 12 }))
        await waitFor(() => status(b.id) === 'done')
        expect(be.calls[1]).toMatchObject({ steps: 12, cfg: 2 })
        settings.image.modelDefaults = { 'mock::other': { steps: 99, cfg: 9 } }
        const c = svc.submit(req({}))
        await waitFor(() => status(c.id) === 'done')
        expect(be.calls[2]).toMatchObject({ steps: 4, cfg: 1.5 }) // the model's own defaults
      })

      it('applies only the part that was saved', async () => {
        settings.image.modelDefaults = { 'mock::m1': { cfg: 3 } }
        const job = svc.submit(req({}))
        await waitFor(() => status(job.id) === 'done')
        expect(be.calls[0]).toMatchObject({ steps: 4, cfg: 3 })
      })
    })

    it('marks only built-in models as LoRA-capable', async () => {
      useBuiltin()
      settings.image.backends.push(cfg('comfyui', 'http://mock', { id: 'mock', name: 'Mock' }))
      const t = await svc.targets(true)
      expect(t.find((o) => o.backendId === 'builtin')?.supportsLora).toBe(true)
      expect(t.find((o) => o.backendId === 'mock')?.supportsLora).toBe(false)
    })
  })
})

/* ───────────────────────────── attachments ───────────────────────────── */

describe('AttachmentStore', () => {
  let dir: string
  let store: AttachmentStore
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cairn-att-'))
    store = new AttachmentStore({ dir })
  })
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('stores images and loads them back as base64', async () => {
    const att = await store.save({ name: 'shot.png', mime: 'image/png', data: fakePng(10, 10) })
    expect(att).toMatchObject({ kind: 'image', mime: 'image/png', name: 'shot.png' })
    const loaded = await store.load(att)
    expect(loaded?.mime).toBe('image/png')
    expect(Buffer.from(loaded!.base64, 'base64')).toEqual(Buffer.from(fakePng(10, 10)))
  })

  it('detects images by content even when the MIME type is wrong', async () => {
    const att = await store.save({ name: 'x.bin', mime: 'application/octet-stream', data: fakeJpeg(4, 4) })
    expect(att.kind).toBe('image')
    expect(att.mime).toBe('image/jpeg')
  })

  it('extracts text from code and text files, truncating huge ones', async () => {
    const small = await store.save({ name: 'main.py', mime: '', data: new TextEncoder().encode('print("hi")\n') })
    expect(small).toMatchObject({ kind: 'text', text: 'print("hi")\n' })
    const big = await store.save({ name: 'big.txt', mime: 'text/plain', data: new TextEncoder().encode('x'.repeat(250_000)) })
    expect(big.text!.length).toBeLessThan(205_000)
    expect(big.text).toMatch(/truncated/)
  })

  it('rejects binary files it cannot use and keeps names safe', async () => {
    await expect(store.save({ name: 'tool.exe', mime: 'application/octet-stream', data: new Uint8Array([0, 1, 2, 3, 0, 0, 255, 254]) })).rejects.toThrow(/can't be attached/)
    const att = await store.save({ name: '../../evil.txt', mime: 'text/plain', data: new TextEncoder().encode('ok') })
    expect(path.dirname(store.filePath(att))).toBe(dir)
    expect(looksLikeText(new TextEncoder().encode('héllo wörld'))).toBe(true)
    expect(looksLikeText(new Uint8Array([1, 2, 3]))).toBe(false)
  })

  it('returns null for a missing attachment file', async () => {
    const att = await store.save({ name: 'a.txt', mime: 'text/plain', data: new TextEncoder().encode('x') })
    await fsp.rm(store.filePath(att))
    expect(await store.load(att)).toBeNull()
  })
})
