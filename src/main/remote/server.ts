import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo, Socket } from 'node:net'
import type { EventChannel, IpcEventMap } from '@shared/ipc'
import { decodeJson, encodeJson } from '@shared/remoteCodec'
import { cleanDeviceName, deviceNameFromUserAgent } from '@shared/remotePrefs'
import type { RemoteDevice } from '@shared/types'
import type { Handlers } from '../ipc'
import { resolveMedia } from '../media'
import type { AppPaths } from '../paths'
import type { DeviceStore } from './devices'
import { clientAddress } from './net'
import type { PairingBook } from './pairing'
import { RemoteError, dispatchRemote, eventAllowed } from './policy'

/**
 * The web server phones and tablets talk to. It serves the companion web app and a small private API:
 *   POST /remote/pair   trade a pairing code for a signed-in browser (a cookie)
 *   GET  /remote/session  who am I
 *   POST /remote/rpc    run one allowed request (the same calls the desktop window makes)
 *   GET  /remote/events live updates (Server-Sent Events)
 *   GET  /remote/media/<kind>/<file>  pictures and thumbnails
 * Nothing but the web app itself and the pairing call works without a signed-in device.
 */

export const COOKIE = 'cairn_remote'
const MAX_BODY = 64 * 1024 * 1024
const MAX_PAIR_BODY = 8 * 1024
/** A phone on a slow connection that falls this far behind is cut off and catches up by reconnecting. */
const MAX_SSE_BACKLOG = 4 * 1024 * 1024
const HEARTBEAT_MS = 20_000
const BATCH_MS = 30
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365

export type EventSource = (listener: <K extends EventChannel>(channel: K, payload: IpcEventMap[K]) => void) => () => void

export interface RemoteServerDeps {
  handlers: () => Handlers | null
  devices: DeviceStore
  pairing: PairingBook
  paths: Pick<AppPaths, 'images' | 'thumbs' | 'attachments'>
  /** Folder with the built companion web app (index.html and assets). */
  clientDir: string
  events: EventSource
  appVersion: string
  onPaired?(device: RemoteDevice): void
  /** A device connected or disconnected its live channel. */
  onPresence?(): void
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json'
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  // The page and its own assets only; pictures can come from this server or be made on the phone (blob, data).
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'That is too large to send.')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'That is too large to send.')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

interface SseClient {
  res: http.ServerResponse
  deviceId: string
  buf: string[]
  timer: NodeJS.Timeout | null
  /** What this device was last told it may do, so a change on the computer reaches it. */
  scopes: string
}

export class RemoteServer {
  private server: http.Server | null = null
  private sockets = new Set<Socket>()
  private clients = new Set<SseClient>()
  private stopEvents: (() => void) | null = null
  private stopDevices: (() => void) | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private badTokens = new Map<string, { n: number; reset: number }>()
  port: number | null = null

  constructor(private d: RemoteServerDeps) {}

  get listening(): boolean {
    return this.server !== null
  }

  isOnline(deviceId: string): boolean {
    for (const c of this.clients) if (c.deviceId === deviceId) return true
    return false
  }

  /** Starts listening on every network interface (a phone has to reach it). Rejects with a readable message when the port is taken. */
  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res))
      server.on('connection', (s) => {
        this.sockets.add(s)
        s.on('close', () => this.sockets.delete(s))
      })
      server.once('error', (err: NodeJS.ErrnoException) => {
        reject(new Error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Choose another port.` : err.code === 'EACCES' ? `Not allowed to use port ${port}. Choose a port above 1024.` : err.message))
      })
      server.listen(port, '0.0.0.0', () => {
        this.server = server
        this.port = (server.address() as AddressInfo | null)?.port ?? port
        this.stopEvents = this.d.events((channel, payload) => this.broadcast(channel, payload))
        this.stopDevices = this.d.devices.onChange(() => this.tellScopes())
        this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS)
        this.heartbeat.unref?.()
        resolve()
      })
    })
  }

  async close(): Promise<void> {
    this.stopEvents?.()
    this.stopEvents = null
    this.stopDevices?.()
    this.stopDevices = null
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const c of [...this.clients]) this.dropClient(c)
    const server = this.server
    this.server = null
    this.port = null
    if (!server) return
    for (const s of this.sockets) s.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    this.d.onPresence?.()
  }

  /* ───────────────────────────── requests ───────────────────────────── */

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v)
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const p = url.pathname
      if (p.startsWith('/remote/')) {
        await this.api(req, res, p)
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed')
      await this.serveClient(req, res, p)
    } catch (e) {
      if (res.headersSent) return void res.end()
      const status = e instanceof HttpError ? e.status : e instanceof RemoteError ? e.status : 500
      this.json(res, status, { error: e instanceof Error ? e.message : String(e) })
    }
  }

  private json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
    res.end(encodeJson(body))
  }

  private clientOf(req: http.IncomingMessage): string {
    return clientAddress(req.socket.remoteAddress)
  }

  /** The signed-in device for this request, or null. Too many wrong tokens from one address pauses it for a minute. */
  private who(req: http.IncomingMessage): RemoteDevice | null {
    const token = parseCookies(req.headers.cookie)[COOKIE]
    if (!token) return null
    const ip = this.clientOf(req)
    const now = Date.now()
    const bad = this.badTokens.get(ip)
    if (bad && bad.reset > now && bad.n >= 30) throw new HttpError(429, 'Too many attempts. Wait a minute.')
    const dev = this.d.devices.authenticate(token, ip)
    if (!dev) {
      if (this.badTokens.size > 1000) this.badTokens.clear()
      const cur = bad && bad.reset > now ? bad : { n: 0, reset: now + 60_000 }
      cur.n++
      this.badTokens.set(ip, cur)
    }
    return dev
  }

  private requireDevice(req: http.IncomingMessage): RemoteDevice {
    const dev = this.who(req)
    if (!dev) throw new HttpError(401, 'This device is not paired. Scan the code on your computer to pair it.')
    return dev
  }

  /** Blocks requests that web pages on other sites try to make with a signed-in browser's cookie. */
  private sameOrigin(req: http.IncomingMessage): void {
    const origin = req.headers.origin
    if (!origin) return
    let host = ''
    try {
      host = new URL(origin).host
    } catch {
      /* fall through */
    }
    if (!host || host !== req.headers.host) throw new HttpError(403, 'Blocked: this request came from another website.')
  }

  private cookieHeader(req: http.IncomingMessage, token: string, maxAge = COOKIE_MAX_AGE): string {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  }

  private hostInfo() {
    return { name: os.hostname(), version: this.d.appVersion }
  }

  private async api(req: http.IncomingMessage, res: http.ServerResponse, p: string): Promise<void> {
    const method = req.method ?? 'GET'

    if (p === '/remote/ping' && method === 'GET') return this.json(res, 200, { app: 'cairn-remote', version: this.d.appVersion })

    if (p === '/remote/pair' && method === 'POST') {
      this.sameOrigin(req)
      const body = decodeJson<{ code?: unknown; name?: unknown }>(await readBody(req, MAX_PAIR_BODY))
      const ip = this.clientOf(req)
      const r = this.d.pairing.redeem(body?.code, ip)
      if (!r.ok) {
        if (r.reason === 'locked') {
          const wait = Math.ceil(r.retryAfterMs / 1000)
          return this.json(res, 429, { error: `Too many wrong codes. Try again in ${wait > 90 ? `${Math.ceil(wait / 60)} minutes` : `${wait} seconds`}.`, code: 'locked' }, { 'Retry-After': String(wait) })
        }
        const msg = r.reason === 'invalid' ? 'That code is not right. Check it on your computer and try again.' : 'That code has expired. Press “Connect your phone” on your computer to get a new one.'
        return this.json(res, 401, { error: msg, code: r.reason })
      }
      const name = cleanDeviceName(body?.name, deviceNameFromUserAgent(req.headers['user-agent']))
      const { device, token } = this.d.devices.add(name, ip)
      this.d.onPaired?.(device)
      return this.json(res, 200, { device: this.publicDevice(device), host: this.hostInfo() }, { 'Set-Cookie': this.cookieHeader(req, token) })
    }

    if (p === '/remote/session' && method === 'GET') {
      const dev = this.who(req)
      if (!dev) throw new HttpError(401, 'Not paired.')
      return this.json(res, 200, { device: this.publicDevice(dev), host: this.hostInfo() })
    }

    if (p === '/remote/logout' && method === 'POST') {
      this.sameOrigin(req)
      const dev = this.who(req)
      if (dev) this.d.devices.remove(dev.id)
      return this.json(res, 200, { ok: true }, { 'Set-Cookie': this.cookieHeader(req, '', 0) })
    }

    if (p === '/remote/rpc' && method === 'POST') {
      this.sameOrigin(req)
      const dev = this.requireDevice(req)
      const handlers = this.d.handlers()
      if (!handlers) throw new HttpError(503, 'Cairn is still starting. Try again in a moment.')
      const body = decodeJson<{ channel?: unknown; args?: unknown }>(await readBody(req, MAX_BODY))
      try {
        const result = await dispatchRemote(handlers, dev.scopes, body?.channel, body?.args)
        return this.json(res, 200, { ok: true, result: result === undefined ? null : result })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return this.json(res, 200, { ok: false, error: message, status: e instanceof RemoteError ? e.status : 500 })
      }
    }

    if (p === '/remote/events' && method === 'GET') {
      const dev = this.requireDevice(req)
      return this.openEvents(req, res, dev)
    }

    if (p.startsWith('/remote/media/') && (method === 'GET' || method === 'HEAD')) {
      const dev = this.requireDevice(req)
      const [kind, ...rest] = p.slice('/remote/media/'.length).split('/')
      if ((kind === 'image' || kind === 'thumb') && !dev.scopes.images) throw new HttpError(403, 'Pictures are turned off for this device.')
      if (kind !== 'image' && kind !== 'thumb' && kind !== 'attachment') throw new HttpError(404, 'Not found')
      const target = resolveMedia(this.d.paths, `cairn-media://${kind}/${rest.join('/')}`)
      if (!target) throw new HttpError(404, 'Not found')
      for (const file of target.candidates) {
        try {
          const data = await fsp.readFile(file)
          res.writeHead(200, { 'Content-Type': target.mime, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=31536000, immutable' })
          return void res.end(method === 'HEAD' ? undefined : data)
        } catch {
          /* try the next candidate */
        }
      }
      throw new HttpError(404, 'Not found')
    }

    throw new HttpError(404, 'Not found')
  }

  private publicDevice(d: RemoteDevice) {
    return { id: d.id, name: d.name, scopes: d.scopes }
  }

  /* ───────────────────────────── live updates ───────────────────────────── */

  private openEvents(req: http.IncomingMessage, res: http.ServerResponse, dev: RemoteDevice): void {
    req.socket.setTimeout(0)
    req.socket.setKeepAlive(true, 15_000)
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    res.write(`retry: 3000\n\n`)
    const client: SseClient = { res, deviceId: dev.id, buf: [], timer: null, scopes: JSON.stringify(dev.scopes) }
    this.clients.add(client)
    this.send(client, 'hello', { at: Date.now() })
    this.d.onPresence?.()
    const drop = () => this.dropClient(client)
    req.on('close', drop)
    res.on('close', drop)
    res.on('error', drop)
  }

  private dropClient(c: SseClient): void {
    if (!this.clients.delete(c)) return
    if (c.timer) clearTimeout(c.timer)
    try {
      c.res.end()
    } catch {
      /* already closed */
    }
    this.d.onPresence?.()
  }

  private send(c: SseClient, channel: string, payload: unknown): void {
    c.buf.push(`data: ${encodeJson({ c: channel, p: payload })}\n\n`)
    // Streamed replies come as hundreds of tiny updates; they leave together every few milliseconds.
    if (!c.timer) c.timer = setTimeout(() => this.flush(c), BATCH_MS)
  }

  private flush(c: SseClient): void {
    c.timer = null
    if (!c.buf.length) return
    if (c.res.writableLength > MAX_SSE_BACKLOG) return this.dropClient(c)
    const text = c.buf.join('')
    c.buf = []
    try {
      c.res.write(text)
    } catch {
      this.dropClient(c)
    }
  }

  /** A device whose permissions changed on the computer is told, so its screens match what it may now do. */
  private tellScopes(): void {
    for (const c of this.clients) {
      const dev = this.d.devices.get(c.deviceId)
      if (!dev) continue
      const now = JSON.stringify(dev.scopes)
      if (now === c.scopes) continue
      c.scopes = now
      this.send(c, 'scopes', dev.scopes)
    }
  }

  private ping(): void {
    for (const c of this.clients) {
      // A device that was signed out from the computer stops receiving at once.
      if (!this.d.devices.get(c.deviceId)) {
        this.dropClient(c)
        continue
      }
      try {
        c.res.write(': ping\n\n')
      } catch {
        this.dropClient(c)
      }
    }
  }

  private broadcast<K extends EventChannel>(channel: K, payload: IpcEventMap[K]): void {
    for (const c of this.clients) {
      const dev = this.d.devices.get(c.deviceId)
      if (!dev) {
        this.dropClient(c)
        continue
      }
      if (eventAllowed(channel, payload, dev.scopes)) this.send(c, channel, payload)
    }
  }

  /** Disconnects a device's live channel (it was signed out). */
  disconnect(deviceId: string): void {
    for (const c of [...this.clients]) if (c.deviceId === deviceId) this.dropClient(c)
  }

  /* ───────────────────────────── the web app ───────────────────────────── */

  private async serveClient(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): Promise<void> {
    let rel: string
    try {
      rel = decodeURIComponent(urlPath)
    } catch {
      throw new HttpError(400, 'Bad address')
    }
    const root = path.resolve(this.d.clientDir)
    let file = path.resolve(root, '.' + path.posix.normalize('/' + rel))
    if (file !== root && !file.startsWith(root + path.sep)) throw new HttpError(404, 'Not found')
    const ext = path.extname(file).toLowerCase()
    // Pages of the app (no file extension) all open index.html; a missing asset is a real 404.
    if (!ext || file === root) file = path.join(root, 'index.html')
    let data: Buffer
    try {
      data = await fsp.readFile(file)
    } catch {
      if (!ext || file === path.join(root, 'index.html')) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        return void res.end(MISSING_PAGE)
      }
      throw new HttpError(404, 'Not found')
    }
    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
    const isAsset = /[\\/]assets[\\/]/.test(file)
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache' })
    res.end(req.method === 'HEAD' ? undefined : data)
  }
}

const MISSING_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cairn</title>
<body style="font-family:system-ui,sans-serif;background:#14171d;color:#e8e6e3;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center">
<div><h1 style="font-size:20px">Cairn is running, but the phone app is not built yet.</h1><p style="opacity:.7">On the computer, run <code>npm run build</code> and restart Cairn.</p></div></body>`
