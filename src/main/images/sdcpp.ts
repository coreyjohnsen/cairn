import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ImageStage, SdModelConfig, Settings } from '@shared/types'
import { splitArgs } from '../engines/library'
import type { EngineManager } from '../engines/manager'
import { killTree } from '../tools/shell'
import { imageSize } from './size'
import { type BackendHooks, type BackendImage, BackendError, type BackendModel, type GenParams, type ImageBackend } from './types'

export interface SdDeps {
  getSettings(): Settings
  engines: EngineManager
  tmpDir: string
}

const flagCache = new Map<string, Set<string> | null>()

/** Ask the binary which long flags it understands, so optional flags are only passed when supported. */
export async function probeFlags(binary: string, env: NodeJS.ProcessEnv): Promise<Set<string> | null> {
  if (flagCache.has(binary)) return flagCache.get(binary)!
  const text = await new Promise<string | null>((resolve) => {
    try {
      const p = spawn(binary, ['--help'], { env, windowsHide: true, cwd: path.dirname(binary), stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', (d) => (out += d))
      const t = setTimeout(() => {
        killTree(p.pid)
        resolve(out || null)
      }, 8000)
      p.on('error', () => {
        clearTimeout(t)
        resolve(null)
      })
      p.on('close', () => {
        clearTimeout(t)
        resolve(out)
      })
    } catch {
      resolve(null)
    }
  })
  const flags = text ? new Set([...text.matchAll(/--[a-z][a-z0-9_-]+/gi)].map((m) => m[0])) : null
  const result = flags && flags.size > 5 ? flags : null
  flagCache.set(binary, result)
  return result
}

export function clearFlagCache(): void {
  flagCache.clear()
}

/** The prompt with a `<lora:name:strength>` tag for each chosen LoRA, which is how the engine is told to use them. */
export function promptWithLoras(p: Pick<GenParams, 'prompt' | 'loras'>): string {
  if (!p.loras?.length) return p.prompt
  const tags = p.loras.map((l) => `<lora:${l.id}:${Number(l.strength.toFixed(2))}>`)
  return `${p.prompt} ${tags.join(' ')}`
}

/** Build the sd-cli command line (pure; exported for tests). */
export function buildSdArgs(
  model: SdModelConfig,
  p: GenParams,
  outFile: string,
  supported: Set<string> | null,
  initPath?: string,
  maskPath?: string
): string[] {
  const ok = (flag: string) => !supported || supported.has(flag)
  const args: string[] = []
  if (model.model) args.push('-m', model.model)
  if (model.diffusionModel) args.push('--diffusion-model', model.diffusionModel)
  if (model.vae) args.push('--vae', model.vae)
  if (model.clipL) args.push('--clip_l', model.clipL)
  if (model.clipG) args.push('--clip_g', model.clipG)
  if (model.t5xxl) args.push('--t5xxl', model.t5xxl)
  if (model.llm) args.push('--llm', model.llm)
  args.push('-p', promptWithLoras(p))
  if (p.loras?.length && p.loraDir) args.push('--lora-model-dir', p.loraDir)
  if (p.negative.trim()) args.push('-n', p.negative)
  args.push('-W', String(p.width), '-H', String(p.height))
  args.push('--steps', String(p.steps), '--cfg-scale', String(p.cfg))
  args.push('--sampling-method', p.sampler)
  args.push('-s', String(p.seed))
  if (p.count > 1) args.push('-b', String(p.count))
  args.push('-o', outFile)
  if (initPath) args.push('-i', initPath, '--strength', String(p.strength ?? 0.6))
  if (initPath && maskPath) args.push('--mask', maskPath)
  if (p.upscale) {
    args.push('--upscale-model', p.upscale.path)
    if (p.upscale.repeats > 1 && ok('--upscale-repeats')) args.push('--upscale-repeats', String(p.upscale.repeats))
  }
  if (model.vaeTiling && ok('--vae-tiling')) args.push('--vae-tiling')
  if (model.offloadToCpu && ok('--offload-to-cpu')) args.push('--offload-to-cpu')
  if (model.clipOnCpu && ok('--clip-on-cpu')) args.push('--clip-on-cpu')
  if (model.flashAttn && ok('--diffusion-fa')) args.push('--diffusion-fa')
  args.push(...splitArgs(model.extraArgs))
  return args
}

/** Explains why an upscaler gave back a picture of the same size. */
export function upscalerIgnoredMessage(name: string, engineLine?: string): string {
  return (
    `The image engine could not use the upscaler "${name}", so the picture came back at its original size. ` +
    'stable-diffusion.cpp only supports certain upscaler models, and RealESRGAN_x4plus_anime_6B is the one it documents; ' +
    'others (4x-UltraSharp, for example) are often ignored. Models → Image models → LoRAs and upscalers has a one-click download for the supported one.' +
    (engineLine ? `\n\nThe engine said: ${engineLine}` : '')
  )
}

/** Turn raw stderr into advice the user can act on. */
export function explainSdFailure(code: number | null, tail: string[]): string {
  const text = tail.join('\n')
  let hint = ''
  if (/out of memory|failed to allocate|alloc.*fail|ErrorOutOfDeviceMemory|bad_alloc|cudaMalloc failed/i.test(text)) {
    hint = '\n\nThe GPU ran out of memory. Try a smaller size, enable "VAE tiling" and "Offload to CPU" for this model, use a smaller or quantised model, or free VRAM by closing other GPU apps.'
  } else if (/unknown (argument|option)|invalid (argument|parameter)|unrecognized/i.test(text)) {
    hint = '\n\nThe engine did not recognise one of the arguments. Check "Extra arguments" for this model, or update the engine under Models → Engines.'
  } else if (/failed to (load|init)|get sd version from file failed|unknown model|load model.*failed/i.test(text)) {
    hint = '\n\nThe model could not be loaded. Make sure the model type matches the files (FLUX and SD3 need separate VAE/text-encoder files and use "Diffusion model" instead of "Checkpoint").'
  }
  return `stable-diffusion.cpp exited with code ${code}.\n${tail.slice(-8).join('\n')}${hint}`
}

/* ───────────── reading the engine's log ───────────── */

const STEP_RE = /(\d+)\s*\/\s*(\d+)\s*-\s*([\d.]+)\s*(s\/it|it\/s)/
/** The model is in memory and the engine has moved on to the request itself. */
const ENCODE_RE = /loading tensors completed|total params memory size|running in .{1,32} mode|\b(?:txt2img|img2img|generate_image)\s+\d+x\d+|encode_first_stage/i
const SAMPLE_RE = /sampling using|get_learned_condition completed/i
const IMAGE_RE = /generating image:\s*(\d+)\s*\/\s*(\d+)/i
const SAMPLED_RE = /sampling completed/i
const DECODE_RE = /generating\s+\d+\s+latent images?\s+completed|decoding\s+(\d+)\s+latents?/i
const LATENT_RE = /latent\s+(\d+)\s+decoded/i
const SAVE_RE = /decode_first_stage completed|(?:generate_image|txt2img|img2img) completed in|save result image/i
/** Out-of-memory reports, as printed by the Vulkan and CUDA backends. */
const OOM_RE = /failed to allocate|out of (?:device )?memory|ErrorOutOfDeviceMemory|Device memory allocation .* failed|cudaMalloc failed/i
/**
 * stable-diffusion.cpp logs this and then saves the picture at its original size, with a clean exit code,
 * when it cannot load or run the upscaler model.
 */
const UPSCALE_FAIL_RE = /new_upscaler_ctx failed|upscale failed|(?:esrgan|upscaler)[^\n]*(?:fail|error|unsupported|not supported)/i
const VAE_FAIL_RE = /vae[^\n]*failed to allocate|vae alloc compute buffer failed/i

/** The line that means the file is being written, after any upscaling. */
const FINAL_SAVE_RE = /save result image/i
const STAGE_RANK: Record<ImageStage, number> = { loading: 0, encoding: 1, sampling: 2, decoding: 3, upscaling: 4, saving: 5 }

export interface SdUpdate {
  fraction: number
  label: string
  stage: ImageStage
}

const duration = (sec: number): string => (sec < 90 ? `${Math.max(1, Math.round(sec))}s` : `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, '0')}s`)

/**
 * Follows stable-diffusion.cpp's console output and says which part of the job it is in.
 * The engine mentions the VAE (the image decoder) while loading too, so stages are only taken from
 * lines that really mark the start of a part, and only ever move forward.
 */
export class SdProgress {
  private stage: ImageStage = 'loading'
  /** Which image of a batch is being sampled (0-based). */
  private image = 0
  private lastStep = 0
  /** How many latents the engine will decode: one per image, unless it says otherwise. */
  private decodeTotal: number
  /** Set when the engine reported running out of memory while decoding, which it can do and still exit cleanly. */
  vaeFailed = false
  /** The engine said it could not upscale (the picture then comes back unchanged). */
  upscaleFailed = false
  upscaleLine = ''

  /**
   * `upscale`: the result is made bigger after decoding, so the last stage is upscaling, not saving.
   * `upscaleOnly`: nothing is drawn; an existing picture is made bigger.
   */
  constructor(
    private count: number,
    private opts: { upscale?: boolean; upscaleOnly?: boolean } = {}
  ) {
    this.decodeTotal = Math.max(1, count)
  }

  start(): SdUpdate {
    if (this.opts.upscaleOnly) {
      this.stage = 'upscaling'
      return { fraction: 0.1, label: 'Upscaling the picture…', stage: 'upscaling' }
    }
    return { fraction: 0.02, label: 'Loading model files…', stage: 'loading' }
  }

  static isStepLine(line: string): boolean {
    return STEP_RE.test(line)
  }

  feed(line: string): SdUpdate | null {
    if (UPSCALE_FAIL_RE.test(line)) {
      this.upscaleFailed = true
      this.upscaleLine = line.slice(0, 160)
    }
    if (VAE_FAIL_RE.test(line) || (this.stage === 'decoding' && OOM_RE.test(line))) this.vaeFailed = true

    const step = STEP_RE.exec(line)
    if (step) return this.onStep(Number(step[1]), Math.max(1, Number(step[2])), Number(step[3]), step[4])

    const img = IMAGE_RE.exec(line)
    if (img) return this.onImage(Number(img[1]))

    if (SAVE_RE.test(line)) {
      // Finishing the decode is followed by upscaling, when it was asked for, and only then by saving.
      if (this.opts.upscale && !FINAL_SAVE_RE.test(line)) return this.advance('upscaling', 0.95, 'Upscaling the finished image…')
      return this.advance('saving', 0.99, 'Saving the image…')
    }

    const lat = LATENT_RE.exec(line)
    if (lat) {
      const n = Number(lat[1])
      if (this.stage === 'decoding' && this.decodeTotal > 1 && n < this.decodeTotal) {
        return { fraction: 0.9 + 0.08 * (n / this.decodeTotal), label: this.decodeLabel(n + 1), stage: 'decoding' }
      }
      return null
    }

    const dec = DECODE_RE.exec(line)
    if (dec) {
      if (dec[1]) this.decodeTotal = Number(dec[1])
      return this.advance('decoding', 0.9, this.decodeLabel(1))
    }
    // With several images "sampling completed" follows each one; only the last leads on to decoding.
    if (SAMPLED_RE.test(line) && this.image + 1 >= this.count) return this.advance('decoding', 0.9, this.decodeLabel(1))

    if (SAMPLE_RE.test(line)) return this.advance('sampling', this.sampleFraction(0), 'Starting to sample…')
    if (ENCODE_RE.test(line)) return this.advance('encoding', 0.06, 'Reading your prompt…')
    return null
  }

  private sampleFraction(within: number): number {
    return 0.1 + 0.8 * ((this.image + within) / Math.max(1, this.count))
  }

  private decodeLabel(n: number): string {
    return this.decodeTotal > 1 ? `Decoding the finished images (${Math.min(n, this.decodeTotal)} of ${this.decodeTotal})` : 'Decoding the finished image'
  }

  private onImage(n: number): SdUpdate | null {
    if (STAGE_RANK[this.stage] > STAGE_RANK.sampling) return null
    this.image = Math.max(0, Math.min(n - 1, this.count - 1))
    this.lastStep = 0
    this.stage = 'sampling'
    return { fraction: this.sampleFraction(0), label: this.count > 1 ? `Sampling · image ${this.image + 1} of ${this.count}` : 'Starting to sample…', stage: 'sampling' }
  }

  private onStep(step: number, total: number, rate: number, unit: string): SdUpdate {
    const secPerStep = unit === 's/it' ? rate : rate > 0 ? 1 / rate : NaN
    // A step counter that starts over means the next image in a batch has begun.
    if (step < this.lastStep) this.image = Math.min(this.image + 1, Math.max(0, this.count - 1))
    this.lastStep = step
    this.stage = 'sampling'
    const left = (total - step + (this.count - 1 - this.image) * total) * secPerStep
    const parts = [`Sampling · step ${step} of ${total}`]
    if (this.count > 1) parts.push(`image ${this.image + 1} of ${this.count}`)
    if (Number.isFinite(left) && left >= 8) parts.push(`about ${duration(left)} left`)
    return { fraction: this.sampleFraction(step / total), label: parts.join(' · '), stage: 'sampling' }
  }

  /** Move on to a later stage; earlier or repeated ones are ignored. */
  private advance(stage: ImageStage, fraction: number, label: string): SdUpdate | null {
    if (STAGE_RANK[stage] <= STAGE_RANK[this.stage]) return null
    this.stage = stage
    return { fraction, label, stage }
  }
}

export const VAE_FAILED_MESSAGE =
  'The GPU ran out of memory while decoding the finished image, so the result would have been blank or grey. Turn on "VAE tiling" for this model (Models, Image models, then the pencil), or choose a smaller size, and try again.'

export class SdCppBackend implements ImageBackend {
  readonly supportsImg2Img = true
  readonly supportsInpaint = true
  readonly supportsNegative = true

  constructor(private d: SdDeps) {}

  async listModels(): Promise<BackendModel[]> {
    return this.d.getSettings().image.localModels.map((m) => ({
      id: m.id,
      label: m.name,
      defaults: { width: m.width, height: m.height, steps: m.steps, cfg: m.cfg, sampler: m.sampler },
      arch: m.arch,
      vaeTiling: m.vaeTiling
    }))
  }

  private binary(): string {
    const bin = this.d.engines.resolveBinary('sd')
    if (!bin) throw new BackendError('The stable-diffusion.cpp engine is not installed. Open Models → Engines and install it (one click), or choose your own sd-cli binary.')
    return bin
  }

  async test(): Promise<string> {
    const bin = this.binary()
    const flags = await probeFlags(bin, this.d.engines.spawnEnv('sd', bin))
    const models = this.d.getSettings().image.localModels.length
    return `Engine found: ${path.basename(bin)}${flags ? ` (${flags.size} options detected)` : ''}. ${models} image model${models === 1 ? '' : 's'} configured.`
  }

  /** Run the engine to completion, turning its log into progress. Rejects with advice on failure. */
  private run(bin: string, env: NodeJS.ProcessEnv, args: string[], hooks: BackendHooks, tracker: SdProgress): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { cwd: path.dirname(bin), env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      const tail: string[] = []
      const onAbort = () => killTree(child.pid)
      hooks.signal.addEventListener('abort', onAbort, { once: true })
      const push = (u: SdUpdate | null) => {
        if (u) hooks.onProgress(u.fraction, u.label, u.stage)
      }
      push(tracker.start())
      const feed = (chunk: string) => {
        for (const piece of chunk.split(/[\r\n]+/)) {
          const line = piece.trim()
          if (!line) continue
          if (!SdProgress.isStepLine(line)) {
            tail.push(line.slice(0, 300))
            if (tail.length > 40) tail.shift()
          }
          push(tracker.feed(line))
        }
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', feed)
      child.stderr.on('data', feed)
      child.on('error', (e) => {
        hooks.signal.removeEventListener('abort', onAbort)
        reject(new BackendError(`Could not start the image engine: ${e.message}`))
      })
      child.on('close', (code) => {
        hooks.signal.removeEventListener('abort', onAbort)
        if (hooks.signal.aborted) return reject(new BackendError('Cancelled'))
        if (code !== 0) return reject(new BackendError(explainSdFailure(code, tail)))
        if (tracker.vaeFailed) return reject(new BackendError(VAE_FAILED_MESSAGE))
        resolve()
      })
    })
  }

  async upscale(image: Uint8Array, up: { path: string; repeats: number }, hooks: BackendHooks): Promise<BackendImage[]> {
    if (!fs.existsSync(up.path)) throw new BackendError(`Upscaler file not found: ${up.path}`)
    const bin = this.binary()
    const env = this.d.engines.spawnEnv('sd', bin)
    const supported = await probeFlags(bin, env)
    const work = await fsp.mkdtemp(path.join(this.d.tmpDir, 'sd-up-'))
    try {
      const inFile = path.join(work, 'in.png')
      const outFile = path.join(work, 'out.png')
      await fsp.writeFile(inFile, image)
      const args = ['-M', 'upscale', '--upscale-model', up.path, '-i', inFile, '-o', outFile]
      if (up.repeats > 1 && (!supported || supported.has('--upscale-repeats'))) args.push('--upscale-repeats', String(up.repeats))
      const tracker = new SdProgress(1, { upscaleOnly: true })
      try {
        await this.run(bin, env, args, hooks, tracker)
      } catch (e) {
        if (e instanceof BackendError && /invalid.*mode|unknown.*mode|unrecogni[sz]ed.*(mode|-M)|--mode|upscale.*(not|unsupported)/i.test(e.message)) {
          throw new BackendError('This version of the image engine cannot upscale a finished picture on its own. Update it under Models, Engines, or pick an upscaler under "Upscale when done" when you create an image.')
        }
        throw e
      }
      const files = (await fsp.readdir(work)).filter((f) => /^out.*\.(png|jpg|jpeg|webp)$/i.test(f))
      if (!files.length) throw new BackendError('The engine finished but produced no image. Check the upscaler file.')
      const data = await fsp.readFile(path.join(work, files[0]))
      // The engine saves the original picture when it cannot load the upscaler, and still exits cleanly.
      const before = imageSize(image)
      const after = imageSize(data)
      const grew = !before || !after || after.width > before.width || after.height > before.height
      if (tracker.upscaleFailed || !grew) throw new BackendError(upscalerIgnoredMessage(path.basename(up.path), tracker.upscaleLine))
      hooks.onProgress(1, 'Done')
      return [{ data, seed: 0 }]
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {})
    }
  }

  async generate(p: GenParams, hooks: BackendHooks): Promise<BackendImage[]> {
    const model = this.d.getSettings().image.localModels.find((m) => m.id === p.model)
    if (!model) throw new BackendError('That image model no longer exists. Pick another one.')
    if (!model.model && !model.diffusionModel) throw new BackendError(`"${model.name}" has no model file selected. Open Models → Image models and choose one.`)
    for (const f of [model.model, model.diffusionModel, model.vae, model.clipL, model.clipG, model.t5xxl, model.llm]) {
      if (f && !fs.existsSync(f)) throw new BackendError(`Model file not found: ${f}`)
    }
    const bin = this.binary()
    const env = this.d.engines.spawnEnv('sd', bin)
    const supported = await probeFlags(bin, env)

    const work = await fsp.mkdtemp(path.join(this.d.tmpDir, 'sd-'))
    try {
      let initPath: string | undefined
      if (p.initImage) {
        initPath = path.join(work, 'init.png')
        await fsp.writeFile(initPath, p.initImage)
      }
      let maskPath: string | undefined
      if (p.mask) {
        if (!initPath) throw new BackendError('A mask needs a starting picture.')
        if (supported && !supported.has('--mask')) throw new BackendError('This version of the built-in engine cannot use a mask. Update it under Models → Engines.')
        maskPath = path.join(work, 'mask.png')
        await fsp.writeFile(maskPath, p.mask)
      }
      const outFile = path.join(work, 'out.png')
      const args = buildSdArgs(model, p, outFile, supported, initPath, maskPath)

      const tracker = new SdProgress(p.count, { upscale: !!p.upscale })
      await this.run(bin, env, args, hooks, tracker)

      const files = (await fsp.readdir(work))
        .filter((f) => /^out.*\.(png|jpg|jpeg|webp)$/i.test(f))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      if (!files.length) throw new BackendError('The engine finished but produced no image. Check the model files and settings.')
      const out: BackendImage[] = []
      for (let i = 0; i < files.length; i++) {
        out.push({ data: await fsp.readFile(path.join(work, files[i])), seed: p.seed + i })
      }
      if (p.upscale) {
        // Same size as asked for means the upscaler did nothing. The pictures are still good, so keep them and say so.
        const size = imageSize(out[0].data)
        const unchanged = !!size && p.width > 0 && p.height > 0 && size.width <= p.width && size.height <= p.height
        if (tracker.upscaleFailed || unchanged) out[0].warning = upscalerIgnoredMessage(path.basename(p.upscale.path), tracker.upscaleLine)
      }
      hooks.onProgress(1, 'Done')
      return out
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {})
    }
  }
}
