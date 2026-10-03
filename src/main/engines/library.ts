import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ImageWeightFile, LocalModelFile } from '@shared/types'

const IMAGE_DIR_HINT = /[\\/](checkpoints?|diffusion_models?|unet|vae|clip|text_encoders?|loras?|controlnet|stable-diffusion|image|embeddings|upscale_models?)[\\/]/i

/** `Q4_K_M`, `IQ3_XS`, `F16`, `BF16` … from a GGUF file name. */
export function quantFromName(name: string): string | undefined {
  const m = /(?:^|[-_.])((?:IQ|Q)\d(?:_[A-Z0-9]+)*|BF16|F16|F32)(?=[-_.]|$)/i.exec(name.replace(/\.gguf$/i, ''))
  return m ? m[1].toUpperCase() : undefined
}

export function isMmproj(file: string): boolean {
  return /mmproj/i.test(path.basename(file))
}

/** Multi-part GGUFs are named `-00001-of-00003.gguf`; only the first part should be listed/loaded. */
export function isSecondaryShard(file: string): boolean {
  const m = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(file)
  return !!m && m[1] !== '00001'
}

async function* walk(root: string, depth = 6): AsyncGenerator<{ file: string; size: number }> {
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isDirectory()) {
      if (depth > 0 && !e.name.startsWith('.')) yield* walk(full, depth - 1)
    } else if (e.isFile()) {
      try {
        yield { file: full, size: (await fsp.stat(full)).size }
      } catch {
        /* vanished */
      }
    }
  }
}

export async function scanGguf(roots: string[]): Promise<LocalModelFile[]> {
  const found = new Map<string, LocalModelFile>()
  const mmprojs: { file: string; dir: string }[] = []
  for (const root of roots) {
    for await (const { file, size } of walk(root)) {
      if (!/\.gguf$/i.test(file)) continue
      if (isMmproj(file)) {
        mmprojs.push({ file, dir: path.dirname(file) })
        continue
      }
      if (isSecondaryShard(file) || IMAGE_DIR_HINT.test(file)) continue
      if (found.has(file)) continue
      found.set(file, { path: file, name: path.basename(file).replace(/\.gguf$/i, ''), sizeBytes: size, quant: quantFromName(path.basename(file)), root })
    }
  }
  // Pair vision projectors that sit in the same folder.
  for (const m of found.values()) {
    const dir = path.dirname(m.path)
    const here = mmprojs.filter((p) => p.dir === dir)
    if (here.length === 1) m.mmprojPath = here[0].file
    else if (here.length > 1) {
      const stem = m.name.toLowerCase()
      const best = here.find((p) => path.basename(p.file).toLowerCase().includes(stem.split(/[-_.]q\d/)[0]))
      m.mmprojPath = (best ?? here[0]).file
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function scanImageWeights(roots: string[]): Promise<ImageWeightFile[]> {
  const out = new Map<string, ImageWeightFile>()
  for (const root of roots) {
    for await (const { file, size } of walk(root)) {
      if (!/\.(safetensors|ckpt|sft|pt|gguf)$/i.test(file)) continue
      if (/\.gguf$/i.test(file) && !IMAGE_DIR_HINT.test(file) && !/[\\/]image[\\/]/i.test(file)) continue
      if (isMmproj(file) || out.has(file)) continue
      out.set(file, { path: file, name: path.basename(file), sizeBytes: size, root })
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Find the vision projector for a model path (same folder). */
export async function findMmproj(modelPath: string): Promise<string | null> {
  const dir = path.dirname(modelPath)
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return null
  }
  const cands = names.filter((n) => /\.gguf$/i.test(n) && isMmproj(n))
  if (!cands.length) return null
  if (cands.length === 1) return path.join(dir, cands[0])
  const stem = path.basename(modelPath).toLowerCase().split(/[-_.]q\d/)[0]
  return path.join(dir, cands.find((n) => n.toLowerCase().includes(stem)) ?? cands[0])
}

/** Split a command-line string respecting quotes (for the "extra arguments" settings). */
export function splitArgs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === '\\')) cur += s[++i]
      else cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += c
    }
  }
  if (cur || has) out.push(cur)
  return out
}
