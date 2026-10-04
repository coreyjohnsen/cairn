import type { EventChannel, IpcEventMap } from '@shared/ipc'
import { decodeJson, encodeJson } from '@shared/remoteCodec'
import type { RemoteScopes } from '@shared/types'

/**
 * How the phone talks to the computer: one request at a time over HTTP, and one long-lived stream of updates.
 * Plain TypeScript with no page or Electron dependencies, so it can be tested against the real server.
 */

export interface SessionInfo {
  device: { id: string; name: string; scopes: RemoteScopes }
  host: { name: string; version: string }
}

export type PairResult = { ok: true; session: SessionInfo } | { ok: false; error: string; code?: 'locked' | 'invalid' | 'none' | 'expired' | 'network' }

export class CallError extends Error {
  constructor(
    message: string,
    public status = 0
  ) {
    super(message)
    this.name = 'CallError'
  }
}

export interface TransportOptions {
  /** Address of the computer; empty when the page was opened from it (the normal case). */
  base?: string
  fetch?: typeof fetch
  /** Extra headers on every request (tests use this to carry the cookie a browser would send by itself). */
  headers?: Record<string, string>
  onEvent?<K extends EventChannel>(channel: K, payload: IpcEventMap[K]): void
  /** The live stream came up (`again` is true after the first time: time to catch up on what was missed). */
  onLive?(again: boolean): void
  onOffline?(): void
  /** What this device may do was changed on the computer. */
  onScopes?(scopes: RemoteScopes): void
  /** The computer no longer knows this device. */
  onAuthLost?(): void
  /** How long the stream may stay silent before it is considered dead. The computer pings every 20 seconds. */
  silenceMs?: number
}

const UNREACHABLE = "Can't reach your computer. Check that Cairn is running there and that you are online."

export class RemoteTransport {
  private base: string
  private f: typeof fetch
  private abort: AbortController | null = null
  private wake: (() => void) | null = null
  private running = false
  private opened = false
  live = false

  constructor(private o: TransportOptions = {}) {
    this.base = (o.base ?? '').replace(/\/+$/, '')
    this.f = o.fetch ?? ((...a) => fetch(...a))
  }

  private url(p: string): string {
    return `${this.base}${p}`
  }

  private async send(p: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.f(this.url(p), { ...init, headers: { ...(this.o.headers ?? {}), ...(init.headers as Record<string, string> | undefined) } })
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e
      throw new CallError(UNREACHABLE)
    }
  }

  /** Who this browser is signed in as, or null when it is not paired (or the computer forgot it). */
  async session(): Promise<SessionInfo | null> {
    const res = await this.send('/remote/session')
    if (res.status === 401) return null
    if (!res.ok) throw new CallError(await this.errorOf(res), res.status)
    return decodeJson<SessionInfo>(await res.text())
  }

  async pair(code: string, name?: string): Promise<PairResult> {
    let res: Response
    try {
      res = await this.send('/remote/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) })
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : UNREACHABLE, code: 'network' }
    }
    const body = decodeJson<Partial<SessionInfo> & { error?: string; code?: string }>(await res.text().catch(() => '{}'))
    if (res.ok && body.device && body.host) return { ok: true, session: { device: body.device, host: body.host } }
    return { ok: false, error: body.error ?? 'Could not pair.', code: body.code as 'locked' | 'invalid' | 'none' | 'expired' | undefined }
  }

  async logout(): Promise<void> {
    this.disconnect()
    await this.send('/remote/logout', { method: 'POST' }).catch(() => {})
  }

  private async errorOf(res: Response): Promise<string> {
    try {
      const b = decodeJson<{ error?: string }>(await res.text())
      if (b.error) return b.error
    } catch {
      /* fall through */
    }
    return `The computer answered with an error (${res.status}).`
  }

  /** Runs one request on the computer and returns its answer, or throws what went wrong in words. */
  async invoke(channel: string, args: unknown[]): Promise<unknown> {
    const res = await this.send('/remote/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: encodeJson({ channel, args }) })
    if (res.status === 401) {
      this.o.onAuthLost?.()
      throw new CallError('This device was signed out. Pair it again from your computer.', 401)
    }
    if (!res.ok) throw new CallError(await this.errorOf(res), res.status)
    const body = decodeJson<{ ok: boolean; result?: unknown; error?: string; status?: number }>(await res.text())
    if (!body.ok) throw new CallError(body.error ?? 'Something went wrong.', body.status ?? 500)
    return body.result
  }

  /* ───────────────────────────── live updates ───────────────────────────── */

  /** Opens the stream of updates and keeps it open, retrying with a growing pause while the computer cannot be reached. */
  connect(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  disconnect(): void {
    this.running = false
    this.abort?.abort()
    this.wake?.()
    this.setLive(false)
  }

  /** Try again right now (the phone came back from the background, or the person pressed Retry). */
  nudge(): void {
    if (!this.running) return
    if (this.live) return
    this.wake?.()
  }

  private setLive(v: boolean): void {
    if (this.live === v) return
    this.live = v
    if (!v) this.o.onOffline?.()
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms)
      const self = this
      function done() {
        clearTimeout(t)
        self.wake = null
        resolve()
      }
      this.wake = done
    })
  }

  private async loop(): Promise<void> {
    let delay = 1000
    while (this.running) {
      const ctrl = new AbortController()
      this.abort = ctrl
      let watchdog: ReturnType<typeof setTimeout> | undefined
      const arm = () => {
        clearTimeout(watchdog)
        watchdog = setTimeout(() => ctrl.abort(), this.o.silenceMs ?? 45_000)
      }
      try {
        const res = await this.send('/remote/events', { signal: ctrl.signal })
        if (res.status === 401) {
          this.running = false
          this.o.onAuthLost?.()
          break
        }
        if (!res.ok || !res.body) throw new CallError(`Live updates are not available (${res.status}).`)
        arm()
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          arm()
          buf += dec.decode(value, { stream: true })
          let end: number
          while ((end = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, end)
            buf = buf.slice(end + 2)
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue
              const msg = decodeJson<{ c: string; p: unknown }>(line.slice(5).trim())
              if (msg.c === 'hello') {
                delay = 1000
                this.live = true
                const again = this.opened
                this.opened = true
                this.o.onLive?.(again)
              } else if (msg.c === 'scopes') this.o.onScopes?.(msg.p as RemoteScopes)
              else this.o.onEvent?.(msg.c as EventChannel, msg.p as never)
            }
          }
        }
      } catch {
        /* the stream broke or timed out: fall through to retry */
      } finally {
        clearTimeout(watchdog)
      }
      this.setLive(false)
      if (!this.running) break
      // Is it that this device was signed out, rather than the network? Then stop for good.
      try {
        if ((await this.session()) === null) {
          this.running = false
          this.o.onAuthLost?.()
          break
        }
      } catch {
        /* still unreachable */
      }
      await this.pause(delay)
      delay = Math.min(delay * 2, 10_000)
    }
  }
}
