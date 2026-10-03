import type { AttachmentInput } from '@shared/types'

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export interface ReadResult {
  files: AttachmentInput[]
  skipped: string[]
}

/** Reads browser File objects (picker, drop, paste) into the shape the main process expects. */
export async function readFiles(files: File[]): Promise<ReadResult> {
  const out: AttachmentInput[] = []
  const skipped: string[] = []
  for (const f of files) {
    if (f.size > MAX_ATTACHMENT_BYTES) {
      skipped.push(`${f.name} is larger than 25 MB`)
      continue
    }
    const data = new Uint8Array(await f.arrayBuffer())
    out.push({ name: f.name || (f.type.startsWith('image/') ? `pasted.${f.type.split('/')[1] || 'png'}` : 'file'), mime: f.type || 'application/octet-stream', data })
  }
  return { files: out, skipped }
}

export function previewUrl(a: AttachmentInput): string | undefined {
  if (!a.mime.startsWith('image/')) return undefined
  // Copy into a plain ArrayBuffer-backed view so the Blob constructor accepts it in every TS lib target.
  return URL.createObjectURL(new Blob([new Uint8Array(a.data)], { type: a.mime }))
}
