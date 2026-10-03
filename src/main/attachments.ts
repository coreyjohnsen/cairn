import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Attachment } from '@shared/types'
import { newId } from '@shared/defaults'
import type { AttachmentApi } from './agent/runner'
import type { LoadedAttachment } from './providers/types'
import { safeFileName, writeFileAtomic } from './util/fsx'
import { sniffImageExt } from './images/types'

const MAX_TEXT_CHARS = 200_000
const MAX_FILE_BYTES = 50 * 1024 * 1024

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'rst', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log', 'xml', 'html', 'htm', 'css', 'scss',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'php', 'swift', 'sh', 'bash', 'zsh',
  'ps1', 'bat', 'cmd', 'sql', 'lua', 'r', 'dart', 'vue', 'svelte', 'tex', 'env', 'gitignore', 'dockerfile'
])

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }

export interface AttachmentDeps {
  dir: string
  /** Optional: downscale/re-encode large images (Electron nativeImage in the app). Return null to keep the original. */
  prepareImage?: (data: Uint8Array, mime: string) => { data: Uint8Array; mime: string } | null
}

/** True when the bytes decode as text with no control characters other than whitespace. */
export function looksLikeText(data: Uint8Array): boolean {
  const sample = data.subarray(0, 8192)
  for (const b of sample) {
    if (b === 0) return false
    if (b < 9 || (b > 13 && b < 32)) return false
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.length < data.length ? sample.subarray(0, sample.length - 3) : sample)
    return true
  } catch {
    return false
  }
}

function isImageData(data: Uint8Array, mime: string): boolean {
  if (/^image\/(png|jpe?g|webp)$/i.test(mime)) return true
  const png = data.length > 3 && data[0] === 0x89 && data[1] === 0x50
  const jpg = data.length > 2 && data[0] === 0xff && data[1] === 0xd8
  const webp = data.length > 12 && data[0] === 0x52 && data[8] === 0x57
  return png || jpg || webp
}

export class AttachmentStore implements AttachmentApi {
  constructor(private d: AttachmentDeps) {}

  filePath(att: Attachment): string {
    return path.join(this.d.dir, path.basename(att.file))
  }

  async save(input: { name: string; mime: string; data: Uint8Array }): Promise<Attachment> {
    const name = safeFileName(input.name || 'file') || 'file'
    if (input.data.length > MAX_FILE_BYTES) throw new Error(`"${name}" is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`)
    const id = newId('att')

    if (isImageData(input.data, input.mime)) {
      let data = input.data
      let mime = IMAGE_MIME[sniffImageExt(data)] ?? 'image/png'
      const prepared = this.d.prepareImage?.(data, mime)
      if (prepared) {
        data = prepared.data
        mime = prepared.mime
      }
      const ext = sniffImageExt(data)
      const file = `${id}.${ext}`
      await writeFileAtomic(path.join(this.d.dir, file), data)
      return { id, kind: 'image', name, mime, file, size: data.length }
    }

    const ext = path.extname(name).slice(1).toLowerCase()
    const textual = TEXT_EXT.has(ext) || /^text\//.test(input.mime) || /json|xml|javascript|yaml/.test(input.mime) || looksLikeText(input.data)
    if (!textual || !looksLikeText(input.data)) {
      throw new Error(`"${name}" can't be attached. Images and text or code files are supported.`)
    }
    let text = new TextDecoder('utf-8').decode(input.data)
    if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n\n[… truncated, file is ${text.length.toLocaleString()} characters]`
    const file = `${id}${ext ? `.${ext.replace(/[^a-z0-9]/g, '')}` : '.txt'}`
    await writeFileAtomic(path.join(this.d.dir, file), input.data)
    return { id, kind: 'text', name, mime: input.mime || 'text/plain', file, size: input.data.length, text }
  }

  async load(att: Attachment): Promise<LoadedAttachment | null> {
    try {
      const data = await fsp.readFile(this.filePath(att))
      return { mime: att.mime, base64: Buffer.from(data).toString('base64') }
    } catch {
      return null
    }
  }
}
