import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { EngineManager } from '../engines/manager'
import { killTree } from '../tools/shell'
import { upscaleFactor } from './assets'
import { imageSize } from './size'
import { type BackendHooks, type BackendImage, BackendError, sniffImageExt } from './types'

/**
 * Upscaling with Real-ESRGAN-ncnn-vulkan, a small stand-alone program that runs on any Vulkan GPU (NVIDIA, AMD, Intel).
 * Unlike stable-diffusion.cpp's built-in upscaler, it loads ncnn models (`name.param` + `name.bin`), including the general
 * `realesrgan-x4plus` model that suits photographs and realistic or painted art, not only anime.
 */

export interface EsrganDeps {
  engines: EngineManager
  tmpDir: string
}

/** Longest side, and total pixels, Cairn will ask the upscaler to produce. Beyond this the PNG alone needs gigabytes. */
export const MAX_UPSCALED_SIDE = 16384
export const MAX_UPSCALED_PIXELS = 120_000_000

/** Is this upscaler file one that Real-ESRGAN runs (an ncnn `.param` file)? */
export const isNcnnModel = (file: string): boolean => /\.param$/i.test(file)

/** `-m <folder> -n <model name>` for a `.param` path. */
export function esrganModelArgs(modelPath: string): string[] {
  return ['-m', path.dirname(modelPath), '-n', path.basename(modelPath).replace(/\.param$/i, '')]
}

/** Command line for one pass. `tile` 0 lets the program choose; a smaller tile uses less video memory. */
export function esrganArgs(o: { input: string; output: string; modelPath: string; scale: number; tile?: number }): string[] {
  const args = ['-i', o.input, '-o', o.output, ...esrganModelArgs(o.modelPath), '-s', String(o.scale), '-f', 'png']
  if (o.tile && o.tile > 0) args.push('-t', String(o.tile))
  return args
}

/** The picture size after `repeats` passes of an upscaler that multiplies by `scale`. */
export function upscaledSize(width: number, height: number, scale: number, repeats: number): { width: number; height: number } {
  const f = scale ** repeats
  return { width: Math.round(width * f), height: Math.round(height * f) }
}

/** Why a run that would be too large is refused, or null when it is fine. */
export function tooLargeMessage(width: number, height: number, scale: number, repeats: number): string | null {
  const out = upscaledSize(width, height, scale, repeats)
  if (out.width > MAX_UPSCALED_SIDE || out.height > MAX_UPSCALED_SIDE || out.width * out.height > MAX_UPSCALED_PIXELS) {
    return `That would make a ${out.width} × ${out.height} picture, which is more than the upscaler can save. Use fewer passes or a smaller picture.`
  }
  return null
}

/** The program prints a percentage per tile ("37.50%"); this reads the last one on a line. */
export function parseEsrganPercent(line: string): number | null {
  const all = [...line.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)]
  if (!all.length) return null
  const n = Number(all[all.length - 1][1])
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n / 100 : null
}

const OOM_RE = /vkAllocateMemory|out of (?:device )?memory|ErrorOutOfDeviceMemory|vkQueueSubmit failed|vkWaitForFences failed|failed to allocate|bad_alloc/i
const NO_GPU_RE = /invalid gpu device|no vulkan|vkEnumeratePhysicalDevices|failed to create (?:vulkan )?instance|vkCreateInstance/i
const READ_RE = /decode image .* failed|failed to (?:read|open|decode)|imread/i

export function explainEsrganFailure(code: number | null, tail: string[]): string {
  const text = tail.join('\n')
  let hint = ''
  if (OOM_RE.test(text)) hint = '\n\nThe GPU ran out of memory. Close other programs that use the graphics card, or upscale a smaller picture.'
  else if (NO_GPU_RE.test(text)) hint = '\n\nNo usable Vulkan graphics device was found. Update your graphics driver, then try again.'
  else if (READ_RE.test(text)) hint = '\n\nThe upscaler could not read the picture.'
  else if (code === 3221225477 || code === -1073741819 || code === 139) hint = '\n\nThe upscaler crashed, which is usually a graphics driver problem. Update the driver, or try a different upscaler model.'
  return `The Real-ESRGAN upscaler stopped (exit code ${code}).${tail.length ? `\n${tail.slice(-6).join('\n')}` : ''}${hint}`
}

export class EsrganUpscaler {
  constructor(private d: EsrganDeps) {}

  binary(): string {
    const bin = this.d.engines.resolveBinary('esrgan')
    if (!bin) throw new BackendError('The upscaler is not installed. Open Models → Image models → Upscalers and choose "Install the upscaler".')
    return bin
  }

  /** Runs the program once, reporting 0..1 for this pass. */
  private runPass(bin: string, args: string[], hooks: BackendHooks, onFraction: (f: number) => void): Promise<void> {
    const env = this.d.engines.spawnEnv('esrgan', bin)
    return new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { cwd: path.dirname(bin), env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      const tail: string[] = []
      const onAbort = () => killTree(child.pid)
      hooks.signal.addEventListener('abort', onAbort, { once: true })
      const feed = (chunk: string) => {
        for (const piece of chunk.split(/[\r\n]+/)) {
          const line = piece.trim()
          if (!line) continue
          const f = parseEsrganPercent(line)
          if (f !== null) onFraction(f)
          else {
            tail.push(line.slice(0, 300))
            if (tail.length > 30) tail.shift()
          }
        }
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', feed)
      child.stderr.on('data', feed)
      child.on('error', (e) => {
        hooks.signal.removeEventListener('abort', onAbort)
        reject(new BackendError(`Could not start the upscaler: ${e.message}`))
      })
      child.on('close', (code) => {
        hooks.signal.removeEventListener('abort', onAbort)
        if (hooks.signal.aborted) return reject(new BackendError('Cancelled'))
        if (code !== 0) return reject(new BackendError(explainEsrganFailure(code, tail)))
        resolve()
      })
    })
  }

  async test(): Promise<string> {
    const bin = this.binary()
    const dir = this.d.engines.esrganModelsDir()
    return `Upscaler found: ${path.basename(bin)}${dir ? ` with models in ${dir}` : ''}.`
  }

  /**
   * Make a picture bigger. `up.path` is the model's `.param` file. `repeats` runs it again on its own result.
   * Progress is reported for the whole job, 0..1, with the "upscaling" stage.
   */
  async upscale(image: Uint8Array, up: { path: string; repeats: number }, hooks: BackendHooks, label = 'Upscaling the picture…'): Promise<BackendImage[]> {
    if (!isNcnnModel(up.path)) throw new BackendError(`"${path.basename(up.path)}" is not a Real-ESRGAN (ncnn) model.`)
    if (!fs.existsSync(up.path) || !fs.existsSync(up.path.replace(/\.param$/i, '.bin'))) {
      throw new BackendError(`The upscaler model is missing a file: both ${path.basename(up.path)} and its .bin must be together.`)
    }
    const bin = this.binary()
    const scale = upscaleFactor(path.basename(up.path))
    const repeats = Math.max(1, Math.min(3, Math.round(up.repeats || 1)))
    const before = imageSize(image)
    if (before) {
      const tooBig = tooLargeMessage(before.width, before.height, scale, repeats)
      if (tooBig) throw new BackendError(tooBig)
    }
    const work = await fsp.mkdtemp(path.join(this.d.tmpDir, 'esrgan-'))
    try {
      let current = path.join(work, `in.${sniffImageExt(image)}`)
      await fsp.writeFile(current, image)
      for (let pass = 0; pass < repeats; pass++) {
        const output = path.join(work, `pass${pass + 1}.png`)
        const report = (f: number) => hooks.onProgress((pass + f) / repeats, repeats > 1 ? `${label.replace(/…$/, '')} (pass ${pass + 1} of ${repeats})…` : label, 'upscaling')
        report(0)
        const args = (tile?: number) => esrganArgs({ input: current, output, modelPath: up.path, scale, tile })
        try {
          await this.runPass(bin, args(), hooks, report)
        } catch (e) {
          // Large pictures can exhaust video memory with the program's own tile choice; smaller tiles need far less.
          if (e instanceof BackendError && /ran out of memory/.test(e.message) && !hooks.signal.aborted) {
            report(0)
            await this.runPass(bin, args(128), hooks, report)
          } else throw e
        }
        if (!fs.existsSync(output)) throw new BackendError('The upscaler finished but produced no picture. Check that the model files are complete.')
        current = output
      }
      const data = await fsp.readFile(current)
      const after = imageSize(data)
      if (before && after && after.width <= before.width && after.height <= before.height) {
        throw new BackendError('The upscaler gave back a picture that is not bigger. Try another upscaler model.')
      }
      hooks.onProgress(1, 'Done', 'upscaling')
      return [{ data, seed: 0 }]
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {})
    }
  }
}
