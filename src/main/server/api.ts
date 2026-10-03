import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import type { ImageGenRequest, ImageRef, ImageTargetOption, LocalModelFile, ServerLogEntry, ServerModelInfo, ServerState, ServerStatus, Settings } from '@shared/types'
import { assignModelIds, isLoopbackHost, normalizeOrigin, parseSize } from '@shared/serverPrefs'
import { emit } from '../events'

/**
 * Lets other programs use the models on this computer: a small web server that speaks the OpenAI API
 * (chat, completions, images and the model list). Chat goes to the managed llama.cpp server, pictures to the image engine.
 */

export interface ApiDeps {
  getSettings(): Settings
  llama: {
    acquire(modelPath: string, opts?: { noThink?: boolean; signal?: AbortSignal }): Promise<{ base: string; release(): void }>
    status(): { state: string; modelPath?: string }
  }
  local: { scan(force?: boolean): Promise<LocalModelFile[]> }
  images: {
    builtinTargets(): Promise<ImageTargetOption[]>
    generate(req: ImageGenRequest, hooks: { onProgress(fraction: number): void; signal: AbortSignal }): Promise<ImageRef[]>
  }
  imageStore: { readBytes(id: string): Promise<Uint8Array | null> }
  /** Where status changes go (the interface in the app; a stub in tests). */
  publish?(status: ServerStatus): void
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

const MAX_CHAT_BODY = 64 * 1024 * 1024
const MAX_SMALL_BODY = 1024 * 1024
const MAX_LOG = 40
const MAX_ACTIVE = 32
const PING_MS = 8000
const IMAGE_URL_TTL_S = 24 * 3600
const MAX_IMAGES = 4
const MAX_PROMPT = 8000
const SSE_HEADERS = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }

export function generateApiKey(): string {
  return `cairn-${crypto.randomBytes(24).toString('base64url')}`
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const digest = (s: string) => crypto.createHash('sha256').update(s).digest()
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Addresses of this computer that other devices on the network can use. */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address)
  }
  return out
}

export function errorBody(message: string, code: string, status: number): { error: { message: string; type: string; param: null; code: string } } {
  const type = status === 401 || status === 403 ? 'authentication_error' : status >= 500 ? 'server_error' : 'invalid_request_error'
  return { error: { message, type, param: null, code } }
}

/** Sets the model name in one line of a streamed answer, and reports how many tokens it says were written. */
export function rewriteSseLine(line: string, modelId: string): { line: string; tokens?: number } {
  if (!line.startsWith('data:')) return { line }
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return { line }
  try {
    const obj = JSON.parse(payload) as Record<string, unknown>
    if (!isRecord(obj)) return { line }
    if ('model' in obj) obj.model = modelId
    const usage = isRecord(obj.usage) ? obj.usage : null
    const tokens = usage && typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined
    return { line: `data: ${JSON.stringify(obj)}`, tokens }
  } catch {
    return { line }
  }
}

function sniffMime(data: Uint8Array): string {
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
  if (data[0] === 0x52 && data[1] === 0x49 && data[8] === 0x57) return 'image/webp'
  return 'application/octet-stream'
}

interface Ctx {
  id: number
  t0: number
  method: string
  path: string
  client: string
  model?: string
  tokens?: number
  error?: string
  /** Not worth listing (browser preflights and health checks). */
  quiet: boolean
}

export class ApiServer {
  private server: http.Server | null = null
  private listenKey = ''
  private state: ServerState = 'stopped'
  private error: string | undefined
  private port: number | undefined
  private startedAt: number | undefined
  private active = 0
  private total = 0
  private seq = 0
  private log: ServerLogEntry[] = []
  private chain: Promise<unknown> = Promise.resolve()
  private emitTimer: NodeJS.Timeout | null = null
  /** Signs picture links; new for every run of the app, so old links stop working after a restart. */
  private readonly secret = crypto.randomBytes(32)

  constructor(private d: ApiDeps) {}

  /* ───────────────────────────── lifecycle ───────────────────────────── */

  status(): ServerStatus {
    const s = this.d.getSettings().server
    const urls: string[] = []
    if (this.state === 'running' && this.port) {
      if (s.access === 'network') for (const a of lanAddresses()) urls.push(`http://${a}:${this.port}/v1`)
      urls.push(`http://127.0.0.1:${this.port}/v1`)
    }
    return { state: this.state, error: this.error, port: this.port, urls, active: this.active, total: this.total, startedAt: this.startedAt, recent: [...this.log] }
  }

  private publish(immediate = false): void {
    const send = () => {
      this.emitTimer = null
      const st = this.status()
      if (this.d.publish) this.d.publish(st)
      else emit('server:status', st)
    }
    if (immediate) {
      if (this.emitTimer) clearTimeout(this.emitTimer)
      send()
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(send, 250)
    }
  }

  /** Makes the server match the settings: starts it, stops it, or restarts it when the address changed. Never throws; problems show in the status. */
  apply(): Promise<void> {
    const run = this.chain.then(() => this.applyLocked())
    this.chain = run.catch(() => {})
    return run
  }

  private async applyLocked(): Promise<void> {
    const s = this.d.getSettings().server
    if (!s.enabled) {
      await this.closeServer()
      this.state = 'stopped'
      this.error = undefined
      this.port = undefined
      this.startedAt = undefined
      this.publish(true)
      return
    }
    const key = `${s.access}:${s.port}`
    if (this.server && this.listenKey === key) {
      this.publish(true) // the key, origins or shared models changed; the server reads those for every request
      return
    }
    await this.closeServer()
    this.state = 'starting'
    this.error = undefined
    this.publish(true)
    try {
      await this.listen(s.access === 'network' ? '0.0.0.0' : '127.0.0.1', s.port)
      this.listenKey = key
      this.state = 'running'
      this.startedAt = Date.now()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      this.state = 'error'
      this.port = undefined
      this.error =
        code === 'EADDRINUSE'
          ? `Port ${s.port} is already used by another program. Choose a different port.`
          : code === 'EACCES'
            ? `Not allowed to use port ${s.port}. Choose a port above 1024.`
            : `The server could not start: ${(e as Error).message}`
    }
    this.publish(true)
  }

  private listen(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res))
      server.requestTimeout = 0
      server.timeout = 0
      server.headersTimeout = 30_000
      server.keepAliveTimeout = 5000
      server.once('error', (e) => {
        this.server = null
        reject(e)
      })
      server.listen(port, host, () => {
        this.port = (server.address() as net.AddressInfo).port
        this.server = server
        server.on('error', (e) => console.error('API server error', e))
        resolve()
      })
    })
  }

  private async closeServer(): Promise<void> {
    const server = this.server
    this.server = null
    this.listenKey = ''
    if (!server) return
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000)
      server.close(() => {
        clearTimeout(t)
        resolve()
      })
      // Open answers are cut off here: their connections close, which stops the work behind them.
      server.closeAllConnections?.()
    })
  }

  async close(): Promise<void> {
    const run = this.chain.then(() => this.closeServer())
    this.chain = run.catch(() => {})
    await run
    this.state = 'stopped'
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
  }

  /* ───────────────────────────── models ───────────────────────────── */

  /** Every model that could be shared, with the name other programs use and whether it is shared. */
  async describeModels(): Promise<ServerModelInfo[]> {
    const s = this.d.getSettings()
    const sv = s.server
    const files = await this.d.local.scan()
    const chatIds = assignModelIds(files.map((f) => ({ key: f.path, name: f.label ?? f.name })))
    const chat: ServerModelInfo[] = files.map((f) => ({
      id: chatIds.get(f.path)!,
      type: 'chat',
      name: f.label ?? f.name,
      key: f.path,
      exposed: sv.exposeAll || sv.chatModels.includes(f.path),
      available: true,
      detail: [f.quant, f.mmprojPath ? 'vision' : ''].filter(Boolean).join(' · ') || undefined
    }))
    const opts = await this.d.images.builtinTargets()
    const imageIds = assignModelIds(
      opts.map((o) => ({ key: o.model, name: o.label })),
      new Set(chatIds.values())
    )
    const images: ServerModelInfo[] = opts.map((o) => ({
      id: imageIds.get(o.model)!,
      type: 'image',
      name: o.label,
      key: o.model,
      exposed: sv.exposeAll || sv.imageModels.includes(o.model),
      available: o.available,
      detail: o.available ? undefined : o.unavailableReason
    }))
    return [...chat.sort((a, b) => a.name.localeCompare(b.name)), ...images.sort((a, b) => a.name.localeCompare(b.name))]
  }

  private async resolveModel(type: 'chat' | 'image', wanted: string): Promise<ServerModelInfo> {
    const list = (await this.describeModels()).filter((m) => m.type === type && m.exposed)
    const what = type === 'chat' ? 'chat' : 'image'
    if (!list.length) throw new ApiError(404, 'model_not_found', `No ${what} models are shared. Share one in Cairn under Models → Serve.`)
    const w = wanted.trim()
    if (!w || w === 'default') {
      const s = this.d.getSettings()
      const last = type === 'chat' ? s.local.lastModelPath : s.image.defaultTarget?.model
      // Without a name, prefer the one used last, and a picture model that is ready over one that is not.
      const ready = list.filter((m) => m.available)
      return list.find((m) => m.key === last && m.available) ?? ready[0] ?? list[0]
    }
    const hit = list.find((m) => m.id === w) ?? list.find((m) => m.key === w) ?? list.find((m) => m.id.toLowerCase() === w.toLowerCase()) ?? list.find((m) => m.name === w)
    if (hit) return hit
    const names = list.slice(0, 10).map((m) => m.id)
    throw new ApiError(404, 'model_not_found', `The ${what} model '${w}' is not shared here. Available: ${names.join(', ')}${list.length > names.length ? ', …' : ''}.`)
  }

  /* ───────────────────────────── requests ───────────────────────────── */

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://cairn.local')
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname
    const ctx: Ctx = { id: ++this.seq, t0: Date.now(), method: req.method ?? 'GET', path, client: req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '', quiet: req.method === 'OPTIONS' || path === '/' || path === '/health' }
    this.active++
    if (!ctx.quiet) this.publish()
    res.once('close', () => {
      this.active = Math.max(0, this.active - 1)
      if (ctx.quiet) return
      this.total++
      this.log.unshift({ id: ctx.id, at: Date.now(), method: ctx.method, path: ctx.path, model: ctx.model, status: res.statusCode, ms: Date.now() - ctx.t0, client: ctx.client, tokens: ctx.tokens, error: ctx.error })
      if (this.log.length > MAX_LOG) this.log.length = MAX_LOG
      this.publish()
    })
    try {
      await this.route(req, res, ctx, path, url)
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(500, 'server_error', e instanceof Error ? e.message : String(e))
      ctx.error = err.message
      this.fail(res, err)
    }
  }

  private fail(res: http.ServerResponse, err: ApiError): void {
    if (res.headersSent) {
      if (!res.writableEnded) res.end()
      return
    }
    this.json(res, err.status, errorBody(err.message, err.code, err.status), err.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : undefined)
  }

  private json(res: http.ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers })
    res.end(text)
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse, ctx: Ctx, path: string, url: URL): Promise<void> {
    const settings = this.d.getSettings().server
    // A web page could reach a server on this computer by pointing its own name at 127.0.0.1; only real local names are accepted.
    if (settings.access === 'local' && !isLoopbackHost(req.headers.host)) throw new ApiError(403, 'host_not_allowed', 'This server only answers programs that use localhost or 127.0.0.1.')
    this.checkOrigin(req, res, settings.allowedOrigins)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Max-Age': '600' })
      res.end()
      return
    }

    if (path === '/' || path === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, 'method_not_allowed', 'Use GET.')
      return this.json(res, 200, { status: 'ok', name: 'Cairn' })
    }

    // Pictures are fetched from a link that signs itself, so a browser or a viewer can open it without the key.
    const file = /^\/v1\/files\/images\/([\w-]+)\.(?:png|jpe?g|webp)$/.exec(path)
    if (file) {
      if (req.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'Use GET.')
      return this.serveImage(res, ctx, file[1], url)
    }

    this.authorize(req, settings)

    if (path === '/v1/models') {
      if (req.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'Use GET.')
      return this.listModels(res)
    }
    const one = /^\/v1\/models\/(.+)$/.exec(path)
    if (one) {
      if (req.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'Use GET.')
      return this.listModels(res, decodeURIComponent(one[1]))
    }
    if (path === '/v1/chat/completions' || path === '/v1/completions') {
      if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Use POST.')
      if (this.active > MAX_ACTIVE) throw new ApiError(429, 'too_many_requests', 'Too many requests are running at once. Try again in a moment.')
      return this.proxyCompletion(req, res, ctx, path)
    }
    if (path === '/v1/images/generations') {
      if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Use POST.')
      if (this.active > MAX_ACTIVE) throw new ApiError(429, 'too_many_requests', 'Too many requests are running at once. Try again in a moment.')
      return this.generateImages(req, res, ctx)
    }
    if (path === '/v1/embeddings' || path === '/v1/images/edits' || path === '/v1/images/variations' || path.startsWith('/v1/audio/')) {
      throw new ApiError(501, 'not_supported', 'Cairn does not offer this endpoint. It serves chat completions, completions, image generations and the model list.')
    }
    throw new ApiError(404, 'not_found', `There is nothing at ${req.method} ${path}.`)
  }

  /** Browsers say which page is asking; a page that is not on the list is turned away before anything runs. */
  private checkOrigin(req: http.IncomingMessage, res: http.ServerResponse, allowed: string[]): void {
    const origin = req.headers.origin
    if (!origin) return
    const norm = normalizeOrigin(origin)
    let sameHost = false
    try {
      sameHost = new URL(origin).host === req.headers.host
    } catch {
      /* not a web address */
    }
    const any = allowed.includes('*')
    if (!sameHost && !any && !(norm && allowed.includes(norm))) {
      throw new ApiError(403, 'origin_not_allowed', `Web pages from ${origin} are not allowed to use this server. Add the address under Models → Serve → Web pages.`)
    }
    res.setHeader('Access-Control-Allow-Origin', any ? '*' : origin)
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-api-key')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (!any) res.setHeader('Vary', 'Origin')
  }

  private authorize(req: http.IncomingMessage, settings: Settings['server']): void {
    if (!settings.requireKey) return
    if (!settings.apiKey) throw new ApiError(401, 'invalid_api_key', 'No API key has been created yet. Open Models → Serve in Cairn.')
    const auth = req.headers.authorization
    const bearer = typeof auth === 'string' && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : ''
    const header = req.headers['x-api-key']
    const given = bearer || (typeof header === 'string' ? header.trim() : '')
    if (!given || !crypto.timingSafeEqual(digest(given), digest(settings.apiKey))) {
      throw new ApiError(401, 'invalid_api_key', 'The API key is missing or wrong. Send it as "Authorization: Bearer <key>".')
    }
  }

  private async readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      req.resume()
      throw new ApiError(413, 'request_too_large', 'The request is too large.')
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of req) {
      const b = c as Buffer
      size += b.length
      if (size > limit) {
        req.resume()
        throw new ApiError(413, 'request_too_large', 'The request is too large.')
      }
      chunks.push(b)
    }
    return Buffer.concat(chunks)
  }

  private async readJson(req: http.IncomingMessage, limit: number): Promise<Record<string, unknown>> {
    const raw = (await this.readBody(req, limit)).toString('utf8')
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      throw new ApiError(400, 'invalid_json', 'The request body is not valid JSON.')
    }
    if (!isRecord(body)) throw new ApiError(400, 'invalid_json', 'The request body must be a JSON object.')
    return body
  }

  /** Aborts when the other program hangs up, which stops the work being done for it. */
  private abortOnClose(res: http.ServerResponse): AbortController {
    const ac = new AbortController()
    res.once('close', () => {
      if (!res.writableFinished) ac.abort()
    })
    return ac
  }

  /* ───────────────────────────── endpoints ───────────────────────────── */

  private async listModels(res: http.ServerResponse, only?: string): Promise<void> {
    const loaded = this.d.llama.status()
    const all = (await this.describeModels()).filter((m) => m.exposed)
    const row = (m: ServerModelInfo) => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: 'cairn',
      type: m.type,
      name: m.name,
      ...(m.type === 'chat' ? { loaded: loaded.state === 'running' && loaded.modelPath === m.key } : { available: m.available })
    })
    if (only !== undefined) {
      const m = all.find((x) => x.id === only)
      if (!m) throw new ApiError(404, 'model_not_found', `The model '${only}' is not shared here.`)
      return this.json(res, 200, row(m))
    }
    this.json(res, 200, { object: 'list', data: all.map(row) })
  }

  private async proxyCompletion(req: http.IncomingMessage, res: http.ServerResponse, ctx: Ctx, path: string): Promise<void> {
    const body = await this.readJson(req, MAX_CHAT_BODY)
    const model = await this.resolveModel('chat', typeof body.model === 'string' ? body.model : '')
    ctx.model = model.id
    const stream = body.stream === true
    const ac = this.abortOnClose(res)
    let ping: NodeJS.Timeout | undefined

    // A model can take a minute to load. Answer right away and keep the line open, so the other program does not give up.
    if (stream) {
      res.writeHead(200, SSE_HEADERS)
      res.flushHeaders()
      ping = setInterval(() => {
        if (!res.writableEnded) res.write(': loading the model\n\n')
      }, PING_MS)
    }
    const held: { release?: () => void } = {}
    try {
      const lease = await this.d.llama.acquire(model.key, { signal: ac.signal })
      held.release = lease.release
      if (ping) clearInterval(ping)
      ping = undefined
      const upstream = await fetch(`${lease.base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, model: 'local' }),
        signal: ac.signal
      })
      if (!stream) {
        const text = await upstream.text()
        let out: string = text
        if (upstream.ok) {
          try {
            const obj = JSON.parse(text) as Record<string, unknown>
            if ('model' in obj) obj.model = model.id
            const usage = isRecord(obj.usage) ? obj.usage : null
            if (usage && typeof usage.completion_tokens === 'number') ctx.tokens = usage.completion_tokens
            out = JSON.stringify(obj)
          } catch {
            /* send what the engine said */
          }
        } else {
          ctx.error = this.upstreamMessage(text)
        }
        res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json', 'Content-Length': Buffer.byteLength(out) })
        res.end(out)
        return
      }
      if (!upstream.ok || !upstream.body) {
        const msg = this.upstreamMessage(await upstream.text().catch(() => ''))
        ctx.error = msg
        this.sseError(res, msg, 'upstream_error')
        return
      }
      await this.pipeStream(upstream.body, res, model.id, ctx)
    } catch (e) {
      if (ac.signal.aborted) return
      const err = e instanceof ApiError ? e : new ApiError(502, 'upstream_error', e instanceof Error ? e.message : String(e))
      ctx.error = err.message
      if (res.headersSent) this.sseError(res, err.message, err.code)
      else this.fail(res, err)
    } finally {
      if (ping) clearInterval(ping)
      held.release?.()
    }
  }

  private upstreamMessage(text: string): string {
    try {
      const obj = JSON.parse(text) as { error?: { message?: string } | string }
      if (typeof obj.error === 'string') return obj.error
      if (obj.error?.message) return obj.error.message
    } catch {
      /* not JSON */
    }
    return text.trim().slice(0, 500) || 'The model engine reported an error.'
  }

  private sseError(res: http.ServerResponse, message: string, code: string): void {
    if (res.writableEnded) return
    res.write(`data: ${JSON.stringify(errorBody(message, code, 502))}\n\ndata: [DONE]\n\n`)
    res.end()
  }

  private async pipeStream(body: ReadableStream<Uint8Array>, res: http.ServerResponse, modelId: string, ctx: Ctx): Promise<void> {
    const write = (s: string): Promise<void> | undefined => {
      if (res.write(s)) return undefined
      return new Promise<void>((resolve) => {
        const done = () => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.once('drain', done)
        res.once('close', done)
      })
    }
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    const one = (line: string) => {
      const r = rewriteSseLine(line, modelId)
      if (r.tokens !== undefined) ctx.tokens = r.tokens
      return r.line
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '')
          buf = buf.slice(i + 1)
          await write(`${one(line)}\n`)
        }
      }
      buf += decoder.decode()
      if (buf) await write(`${one(buf)}\n`)
      if (!res.writableEnded) res.end()
    } finally {
      reader.cancel().catch(() => {})
    }
  }

  private async generateImages(req: http.IncomingMessage, res: http.ServerResponse, ctx: Ctx): Promise<void> {
    const body = await this.readJson(req, MAX_SMALL_BODY)
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) throw new ApiError(400, 'invalid_prompt', 'The "prompt" field is required.')
    if (prompt.length > MAX_PROMPT) throw new ApiError(400, 'invalid_prompt', `The prompt is too long (the limit is ${MAX_PROMPT} characters).`)
    const format = body.response_format === undefined ? 'url' : body.response_format
    if (format !== 'url' && format !== 'b64_json') throw new ApiError(400, 'invalid_response_format', 'response_format must be "url" or "b64_json".')
    const model = await this.resolveModel('image', typeof body.model === 'string' ? body.model : '')
    ctx.model = model.id
    if (!model.available) throw new ApiError(503, 'model_unavailable', model.detail ?? 'This image model is not ready.')
    const opts = (await this.d.images.builtinTargets()).find((o) => o.model === model.key)
    const n = typeof body.n === 'number' && Number.isFinite(body.n) ? clamp(Math.round(body.n), 1, MAX_IMAGES) : 1
    const size = parseSize(body.size)
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    const steps = num(body.steps)
    const cfg = num(body.cfg_scale) ?? num(body.guidance_scale)
    const seed = typeof body.seed === 'number' && Number.isInteger(body.seed) ? body.seed : -1
    const gen: ImageGenRequest = {
      prompt,
      negativePrompt: typeof body.negative_prompt === 'string' ? body.negative_prompt.slice(0, MAX_PROMPT) : undefined,
      target: { backendId: opts?.backendId ?? 'builtin', model: model.key },
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      steps: steps !== undefined ? clamp(Math.round(steps), 1, 150) : undefined,
      cfgScale: cfg !== undefined ? clamp(cfg, 0, 30) : undefined,
      seed,
      sampler: typeof body.sampler === 'string' && body.sampler.trim() ? body.sampler.trim().slice(0, 40) : undefined,
      count: n,
      source: 'hub'
    }
    const ac = this.abortOnClose(res)
    let refs: ImageRef[]
    try {
      refs = await this.d.images.generate(gen, { onProgress: () => {}, signal: ac.signal })
    } catch (e) {
      if (ac.signal.aborted) return
      throw new ApiError(500, 'image_generation_failed', e instanceof Error ? e.message : String(e))
    }
    if (ac.signal.aborted) return
    const base = this.baseFor(req)
    const data: Record<string, string>[] = []
    for (const r of refs) {
      if (format === 'b64_json') {
        const bytes = await this.d.imageStore.readBytes(r.id)
        if (!bytes) continue
        data.push({ b64_json: Buffer.from(bytes).toString('base64') })
      } else {
        data.push({ url: this.signedUrl(base, r) })
      }
    }
    if (!data.length) throw new ApiError(500, 'image_generation_failed', 'No picture was produced.')
    this.json(res, 200, { created: Math.floor(Date.now() / 1000), data })
  }

  private baseFor(req: http.IncomingMessage): string {
    const host = req.headers.host
    return `http://${host && /^[\w.\-:[\]]+$/.test(host) ? host : `127.0.0.1:${this.port ?? ''}`}`
  }

  private sign(id: string, exp: number): string {
    return crypto.createHmac('sha256', this.secret).update(`${id}.${exp}`).digest('hex').slice(0, 40)
  }

  private signedUrl(base: string, ref: ImageRef): string {
    const exp = Math.floor(Date.now() / 1000) + IMAGE_URL_TTL_S
    const ext = ref.file.match(/\.(png|jpe?g|webp)$/i)?.[1]?.toLowerCase() ?? 'png'
    return `${base}/v1/files/images/${ref.id}.${ext}?exp=${exp}&sig=${this.sign(ref.id, exp)}`
  }

  private async serveImage(res: http.ServerResponse, ctx: Ctx, id: string, url: URL): Promise<void> {
    const exp = Number(url.searchParams.get('exp'))
    const sig = url.searchParams.get('sig') ?? ''
    const want = Number.isFinite(exp) ? this.sign(id, exp) : ''
    const ok = want.length === sig.length && want.length > 0 && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))
    if (!ok || exp * 1000 < Date.now()) throw new ApiError(403, 'invalid_link', 'This picture link is not valid or has expired.')
    const bytes = await this.d.imageStore.readBytes(id)
    if (!bytes) throw new ApiError(404, 'not_found', 'This picture no longer exists.')
    res.writeHead(200, { 'Content-Type': sniffMime(bytes), 'Content-Length': bytes.byteLength, 'Cache-Control': 'private, max-age=3600' })
    res.end(Buffer.from(bytes))
  }
}
