import fsp from 'node:fs/promises'
import path from 'node:path'
import type { LoraFile, UpscalerFile } from '@shared/types'
import { guessSizeArch } from '@shared/imageSize'

type Base = NonNullable<LoraFile['base']>

const LORA_EXT = /\.(safetensors|ckpt|gguf|pt)$/i
const UPSCALER_EXT = /\.(pth|pt|safetensors|gguf|bin|param)$/i
/** LoRA headers are small; a bigger one is not worth reading. */
const MAX_HEADER = 16 * 1024 * 1024
const MAX_DEPTH = 3

async function* walkFiles(root: string, depth = 0): AsyncGenerator<{ file: string; size: number }> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) yield* walkFiles(full, depth + 1)
    } else if (e.isFile()) {
      try {
        yield { file: full, size: (await fsp.stat(full)).size }
      } catch {
        /* vanished */
      }
    }
  }
}

export interface LoraInfo {
  base?: Base
  triggers: string[]
  title?: string
}

/** What kind of model a LoRA is for, from the notes the trainer wrote into it. */
export function baseFromMetadata(meta: Record<string, string>, keys: string[] = []): Base | undefined {
  const text = `${meta['ss_base_model_version'] ?? ''} ${meta['modelspec.architecture'] ?? ''}`.toLowerCase()
  if (/flux/.test(text)) return 'flux'
  if (/sd3|stable-diffusion-3/.test(text)) return 'sd3'
  if (/sdxl|stable-diffusion-xl|xl/.test(text)) return 'sdxl'
  if (/sd[_-]?v?[12]|stable-diffusion-v[12]|v1|v2/.test(text)) return 'sd'
  // No notes: the names of the weights give the family away in some cases.
  if (keys.some((k) => k.includes('lora_te2_') || k.includes('conditioner.embedders.1'))) return 'sdxl'
  if (keys.some((k) => /double_blocks|single_blocks|single_transformer_blocks/.test(k))) return 'flux'
  return undefined
}

/** The most used tags from the training notes, as trigger-word candidates. */
export function triggersFromMetadata(meta: Record<string, string>, max = 5): string[] {
  const out: string[] = []
  const phrase = meta['modelspec.trigger_phrase']?.trim()
  if (phrase) out.push(phrase)
  const raw = meta['ss_tag_frequency']
  if (raw) {
    try {
      const sets = JSON.parse(raw) as Record<string, Record<string, number>>
      const total = new Map<string, number>()
      for (const tags of Object.values(sets)) for (const [t, n] of Object.entries(tags ?? {})) total.set(t.trim(), (total.get(t.trim()) ?? 0) + Number(n || 0))
      const top = [...total.entries()].filter(([t]) => t && t.length <= 60).sort((a, b) => b[1] - a[1]).slice(0, max)
      for (const [t] of top) if (!out.includes(t)) out.push(t)
    } catch {
      /* not JSON */
    }
  }
  return out.slice(0, max)
}

/** Read the header of a .safetensors file (cheap: no weights are loaded). */
export async function readLoraInfo(file: string): Promise<LoraInfo> {
  const none: LoraInfo = { triggers: [] }
  if (!/\.safetensors$/i.test(file)) return none
  let fh: import('node:fs/promises').FileHandle | undefined
  try {
    fh = await fsp.open(file, 'r')
    const lenBuf = Buffer.alloc(8)
    await fh.read(lenBuf, 0, 8, 0)
    const len = Number(lenBuf.readBigUInt64LE(0))
    if (!Number.isFinite(len) || len <= 2 || len > MAX_HEADER) return none
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, 8)
    const header = JSON.parse(buf.toString('utf8')) as Record<string, unknown>
    const meta = (header['__metadata__'] ?? {}) as Record<string, string>
    const keys = Object.keys(header).filter((k) => k !== '__metadata__')
    return { base: baseFromMetadata(meta, keys), triggers: triggersFromMetadata(meta), title: meta['modelspec.title'] || meta['ss_output_name'] }
  } catch {
    return none
  } finally {
    await fh?.close().catch(() => {})
  }
}

export const loraDirOf = (modelsDir: string): string => path.join(modelsDir, 'image', 'lora')
export const upscaleDirOf = (modelsDir: string): string => path.join(modelsDir, 'image', 'upscale')

/** The id used in the prompt tag: the path inside the folder, no extension, forward slashes. */
export function loraId(dir: string, file: string): string {
  return path.relative(dir, file).replace(/\\/g, '/').replace(LORA_EXT, '')
}

export async function scanLoras(dir: string): Promise<LoraFile[]> {
  const out: LoraFile[] = []
  for await (const { file, size } of walkFiles(dir)) {
    if (!LORA_EXT.test(file)) continue
    const info = await readLoraInfo(file)
    const id = loraId(dir, file)
    let base = info.base
    let guessed = false
    if (!base) {
      const g = guessSizeArch(path.basename(file))
      if (g !== 'other' && g !== 'zimage') {
        base = g
        guessed = true
      }
    }
    out.push({ id, name: info.title && info.title !== id ? info.title : path.basename(file).replace(LORA_EXT, ''), path: file, sizeBytes: size, base, baseGuessed: base ? guessed : undefined, triggers: info.triggers })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** How much bigger an upscaler makes a picture, going by "4x", "x4", "x2plus" and the like. */
export function upscaleFactor(name: string): number {
  const m = /(?:^|[^a-z0-9])(?:x([2348])|([2348])x)(?:[^a-z0-9]|plus|$)/i.exec(name) ?? /x([2348])plus/i.exec(name)
  const n = Number(m?.[1] ?? m?.[2])
  return n === 2 || n === 3 || n === 4 || n === 8 ? n : 4
}

/** Anime and cartoon models smooth textures into flat colour; the rest are for photographs and realistic or painted art. */
export function upscalerStyle(name: string): 'general' | 'anime' {
  return /anime|cartoon|toon|manga|waifu/i.test(name) ? 'anime' : 'general'
}

/**
 * Upscaler models. Real-ESRGAN (ncnn) models come as a `.param` file with a `.bin` beside it and are listed once, by the
 * `.param`; they run in the Real-ESRGAN program. Any other file is a PyTorch-style model that only stable-diffusion.cpp
 * can try. `bundledDir` is the `models` folder that came with the Real-ESRGAN download.
 */
export async function scanUpscalers(dir: string, bundledDir?: string | null): Promise<UpscalerFile[]> {
  const out: UpscalerFile[] = []
  const seen = new Set<string>()
  const scan = async (root: string, bundled: boolean) => {
    const found: { file: string; size: number }[] = []
    for await (const f of walkFiles(root)) found.push(f)
    const sizes = new Map(found.map((f) => [f.file.toLowerCase(), f.size]))
    for (const { file, size } of found) {
      if (!UPSCALER_EXT.test(file)) continue
      const stem = file.replace(UPSCALER_EXT, '')
      const base = path.basename(file)
      const name = base.replace(UPSCALER_EXT, '')
      if (/\.param$/i.test(file)) {
        const bin = sizes.get(`${stem}.bin`.toLowerCase())
        if (bin === undefined) continue // half a model
        if (seen.has(`esrgan:${name.toLowerCase()}`)) continue
        seen.add(`esrgan:${name.toLowerCase()}`)
        out.push({ path: file, name, sizeBytes: size + bin, scale: upscaleFactor(base), engine: 'esrgan', style: upscalerStyle(name), bundled: bundled || undefined })
        continue
      }
      if (/\.bin$/i.test(file) && sizes.has(`${stem}.param`.toLowerCase())) continue // the weights half of an ncnn model
      if (bundled) continue
      out.push({ path: file, name, sizeBytes: size, scale: upscaleFactor(base), engine: 'sd', style: upscalerStyle(name) })
    }
  }
  await scan(dir, false)
  if (bundledDir) await scan(bundledDir, true)
  const rank = (u: UpscalerFile) => (u.engine === 'esrgan' ? 0 : 1) * 2 + (u.style === 'general' ? 0 : 1)
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** Resolve a LoRA id from the interface to a file inside the LoRA folder, or null. */
export async function resolveLora(dir: string, id: string): Promise<string | null> {
  if (!id || /[<>:|?*"]/.test(id) || id.split('/').some((p) => p === '..' || p === '')) return null
  for (const ext of ['.safetensors', '.ckpt', '.gguf', '.pt']) {
    const full = path.join(dir, ...id.split('/')) + ext
    const rel = path.relative(dir, full)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null
    try {
      if ((await fsp.stat(full)).isFile()) return full
    } catch {
      /* next extension */
    }
  }
  return null
}
