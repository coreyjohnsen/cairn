import fsp from 'node:fs/promises'
import path from 'node:path'
import type { DownloadItem, DownloadSpec, Settings } from '@shared/types'
import { newId } from '@shared/defaults'
import { safeFileName } from '../util/fsx'
import { downloadFile } from './download'

export interface DownloadDeps {
  getSettings(): Settings
  modelsDir(): string
  onUpdate(item: DownloadItem): void
}

/** Where a spec will be saved. Always inside the models directory. */
export function destFor(modelsDir: string, spec: DownloadSpec): string {
  const sub = spec.subdir
    .split(/[\\/]+/)
    .filter((p) => p && p !== '.' && p !== '..')
    .map(safeFileName)
  return path.join(modelsDir, ...sub, safeFileName(spec.filename))
}

export function headersFor(settings: Settings, spec: DownloadSpec): { headers: Record<string, string>; url: string } {
  const headers: Record<string, string> = {}
  let url = spec.url
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    /* validated by caller */
  }
  const hf = (() => {
    try {
      return new URL(settings.paths.hfEndpoint || 'https://huggingface.co').host
    } catch {
      return 'huggingface.co'
    }
  })()
  if ((spec.source === 'hf' || host === hf || host.endsWith('huggingface.co')) && settings.paths.hfToken) {
    headers.Authorization = `Bearer ${settings.paths.hfToken}`
  }
  if ((spec.source === 'civitai' || host.endsWith('civitai.com')) && settings.paths.civitaiToken) {
    headers.Authorization = `Bearer ${settings.paths.civitaiToken}`
    if (!/[?&]token=/.test(url)) url += `${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(settings.paths.civitaiToken)}`
  }
  return { headers, url }
}

/**
 * Downloads one file at a time. Running them sequentially avoids the rate limiting and
 * dropped CDN connections that parallel multi-GB downloads tend to trigger.
 */
export class DownloadManager {
  private items = new Map<string, DownloadItem>()
  private controllers = new Map<string, AbortController>()
  private queue: string[] = []
  private running = false

  constructor(private d: DownloadDeps) {}

  list(): DownloadItem[] {
    return [...this.items.values()]
  }

  private update(item: DownloadItem, patch: Partial<DownloadItem>): void {
    Object.assign(item, patch)
    this.d.onUpdate({ ...item })
  }

  async start(spec: DownloadSpec): Promise<{ id: string }> {
    let parsed: URL
    try {
      parsed = new URL(spec.url)
    } catch {
      throw new Error('That is not a valid URL.')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Only http(s) downloads are supported.')
    const dest = destFor(this.d.modelsDir(), spec)

    // Same file already queued or downloading? Reuse it.
    for (const it of this.items.values()) {
      if (it.dest === dest && (it.status === 'queued' || it.status === 'downloading')) return { id: it.id }
    }
    const item: DownloadItem = { id: newId('dl_'), spec, dest, status: 'queued', received: 0, total: 0 }
    this.items.set(item.id, item)

    try {
      const st = await fsp.stat(dest)
      if (st.size > 0) {
        item.received = item.total = st.size
        this.update(item, { status: 'done' })
        return { id: item.id }
      }
    } catch {
      /* not downloaded yet */
    }
    this.d.onUpdate({ ...item })
    this.queue.push(item.id)
    void this.pump()
    return { id: item.id }
  }

  cancel(id: string): void {
    const item = this.items.get(id)
    if (!item) return
    if (item.status === 'queued') {
      this.queue = this.queue.filter((q) => q !== id)
      this.update(item, { status: 'cancelled' })
    } else if (item.status === 'downloading') {
      this.controllers.get(id)?.abort()
    }
  }

  clearFinished(): void {
    for (const [id, it] of [...this.items]) {
      if (it.status === 'done' || it.status === 'error' || it.status === 'cancelled') this.items.delete(id)
    }
  }

  cancelAll(): void {
    for (const id of [...this.items.keys()]) this.cancel(id)
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!
        const item = this.items.get(id)
        if (!item || item.status !== 'queued') continue
        const ac = new AbortController()
        this.controllers.set(id, ac)
        this.update(item, { status: 'downloading', error: undefined })
        const { headers, url } = headersFor(this.d.getSettings(), item.spec)
        try {
          await downloadFile({
            url,
            dest: item.dest,
            headers,
            signal: ac.signal,
            onProgress: (received, total, speed) => this.update(item, { received, total, speedBps: speed })
          })
          this.update(item, { status: 'done', speedBps: 0 })
        } catch (e) {
          if (ac.signal.aborted) this.update(item, { status: 'cancelled' })
          else this.update(item, { status: 'error', error: e instanceof Error ? e.message : String(e) })
        } finally {
          this.controllers.delete(id)
        }
      }
    } finally {
      this.running = false
    }
  }
}
