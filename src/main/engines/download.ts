import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export interface DownloadOptions {
  url: string
  dest: string
  headers?: Record<string, string>
  signal?: AbortSignal
  onProgress?: (received: number, total: number, speedBps: number) => void
  /** Retries for transient failures (network drops, 5xx, 429, expired CDN signatures). */
  retries?: number
  /** Abort a stalled connection after this long without data. */
  stallMs?: number
}

export class DownloadError extends Error {
  constructor(
    message: string,
    public fatal = false
  ) {
    super(message)
    this.name = 'DownloadError'
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new DownloadError('Cancelled', true))
      },
      { once: true }
    )
  })

function describeStatus(status: number, host: string): string {
  if (status === 401 || status === 403) return `HTTP ${status} from ${host}: access denied. For gated Hugging Face models accept the licence on the model page and add an access token in Settings → Storage; for Civitai add your API key.`
  if (status === 404) return `HTTP 404 from ${host}: file not found (the URL may have moved).`
  if (status === 429) return `HTTP 429 from ${host}: rate limited.`
  return `HTTP ${status} from ${host}.`
}

/**
 * Resumable download with automatic retry. Data is written to `<dest>.part` and renamed on success,
 * so an interrupted download continues where it left off — also across app restarts.
 * Every retry re-requests the original URL, which also refreshes expired CDN redirect signatures
 * (the usual cause of random 403 errors on Hugging Face's CDN).
 */
export async function downloadFile(opts: DownloadOptions): Promise<void> {
  const { url, dest, signal } = opts
  const retries = opts.retries ?? 5
  const stallMs = opts.stallMs ?? 45000
  const part = `${dest}.part`
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const origin = new URL(url).host
  let attempt = 0

  for (;;) {
    if (signal?.aborted) throw new DownloadError('Cancelled', true)
    let existing = 0
    try {
      existing = (await fsp.stat(part)).size
    } catch {
      existing = 0
    }
    const stall = new AbortController()
    let stallTimer: NodeJS.Timeout | null = null
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => stall.abort(new DownloadError('Connection stalled', false)), stallMs)
    }
    const combined = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal
    try {
      armStall()
      const headers: Record<string, string> = { 'User-Agent': 'Cairn/1.0', ...(opts.headers ?? {}) }
      if (existing > 0) headers.Range = `bytes=${existing}-`
      const res = await fetch(url, { headers, redirect: 'follow', signal: combined })
      const host = (() => {
        try {
          return new URL(res.url).host
        } catch {
          return origin
        }
      })()

      if (res.status === 416) {
        // Our partial file is longer than / equal to the real file: it may already be complete.
        const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? 0)
        if (total && existing === total) {
          await fsp.rename(part, dest)
          return
        }
        await fsp.rm(part, { force: true })
        throw new DownloadError('Resuming failed; restarting', false)
      }
      if (!res.ok) {
        const redirectedCdn = host !== origin
        const transient = res.status >= 500 || res.status === 429 || (res.status === 403 && redirectedCdn)
        const err = new DownloadError(describeStatus(res.status, host), !transient)
        if (res.status === 429) {
          const wait = Number(res.headers.get('retry-after'))
          if (Number.isFinite(wait) && wait > 0) await sleep(Math.min(wait, 60) * 1000, signal)
        }
        throw err
      }
      if (!res.body) throw new DownloadError('Empty response body', false)

      const resumed = res.status === 206 && existing > 0
      const lenHeader = Number(res.headers.get('content-length') ?? 0)
      const crTotal = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? 0)
      const total = resumed ? crTotal || existing + lenHeader : lenHeader
      let received = resumed ? existing : 0
      const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' })
      const writeErr = new Promise<never>((_, reject) => out.on('error', reject))
      writeErr.catch(() => {})
      const reader = res.body.getReader()
      let lastReport = 0
      let windowStart = Date.now()
      let windowBytes = 0
      let speed = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          armStall()
          received += value.length
          windowBytes += value.length
          if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
          const now = Date.now()
          if (now - windowStart >= 1000) {
            speed = (windowBytes * 1000) / (now - windowStart)
            windowStart = now
            windowBytes = 0
          }
          if (now - lastReport > 150) {
            lastReport = now
            opts.onProgress?.(received, total, speed)
          }
        }
      } finally {
        await new Promise<void>((resolve) => out.end(() => resolve()))
      }
      if (total && received < total) throw new DownloadError(`Connection closed early (${received} of ${total} bytes)`, false)
      opts.onProgress?.(received, total || received, speed)
      await fsp.rm(dest, { force: true })
      await fsp.rename(part, dest)
      return
    } catch (e) {
      if (stallTimer) clearTimeout(stallTimer)
      if (signal?.aborted) throw new DownloadError('Cancelled', true)
      const fatal = e instanceof DownloadError && e.fatal
      if (fatal || attempt >= retries) {
        if (e instanceof DownloadError) throw e
        throw new DownloadError(`Download failed: ${(e as Error).message}`, true)
      }
      attempt++
      await sleep(Math.min(30000, 1000 * 2 ** (attempt - 1)), signal)
    } finally {
      if (stallTimer) clearTimeout(stallTimer)
    }
  }
}
