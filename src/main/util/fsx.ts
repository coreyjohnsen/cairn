import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
}

/** Write via temp file + rename so a crash never leaves a half-written JSON file. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  await fsp.writeFile(tmp, data)
  try {
    await fsp.rename(tmp, file)
    return
  } catch {
    // Windows can fail the rename if the destination is briefly locked (AV / OneDrive sync); retry once.
    await new Promise((r) => setTimeout(r, 60))
  }
  try {
    await fsp.rename(tmp, file)
  } catch {
    await fsp.copyFile(tmp, file)
    await fsp.rm(tmp, { force: true })
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    const txt = await fsp.readFile(file, 'utf8')
    return JSON.parse(txt) as T
  } catch {
    return null
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, null, 2))
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Fill in missing keys of `loaded` from `defaults` (objects merge recursively, arrays/primitives are kept). */
export function mergeDefaults<T>(defaults: T, loaded: unknown): T {
  if (!isPlainObject(defaults) || !isPlainObject(loaded)) {
    return (loaded === undefined || loaded === null ? defaults : loaded) as T
  }
  const out: Record<string, unknown> = { ...loaded }
  for (const key of Object.keys(defaults)) {
    const d = (defaults as Record<string, unknown>)[key]
    if (!(key in loaded) || loaded[key] === undefined) {
      out[key] = d
    } else if (isPlainObject(d) && isPlainObject(loaded[key])) {
      out[key] = mergeDefaults(d, loaded[key])
    }
  }
  return out as T
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '?'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, 120) || 'file'
}
