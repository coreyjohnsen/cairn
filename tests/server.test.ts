import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '../src/shared/defaults'
import { assignModelIds, hostName, isLoopbackHost, normalizeOrigin, originProblem, parseSize, sanitizeServer, serveExamples, slugModelName } from '../src/shared/serverPrefs'
import type { ImageGenRequest, ImageRef, ImageTargetOption, LocalModelFile, Settings } from '../src/shared/types'
import { LlamaManager, freePort } from '../src/main/engines/llama-server'
import { ApiServer, generateApiKey, rewriteSseLine } from '../src/main/server/api'
import { fakePng } from './helpers/png'

declare global {
  interface Response {
    // The test only looks at fields it knows; a loose type keeps the checks short.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json(): Promise<any>
  }
}

const KEY = 'test-key-123'
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('Timed out waiting for a condition')
    await sleep(10)
  }
}

describe('server settings and names', () => {
  it('cleans what is stored and always asks for a key when open to the network', () => {
    expect(sanitizeServer(undefined)).toEqual({ enabled: false, access: 'local', port: 8321, requireKey: true, apiKey: '', allowedOrigins: [], exposeAll: true, chatModels: [], imageModels: [] })
    const s = sanitizeServer({ enabled: true, access: 'network', port: 99999, requireKey: false, apiKey: '  abc  ', allowedOrigins: ['https://a.com/path', 'nonsense', '*', 'https://a.com', 5], exposeAll: false, chatModels: ['/m/a.gguf', '/m/a.gguf', '', 3], imageModels: 'x' })
    expect(s).toMatchObject({ enabled: true, access: 'network', port: 8321, requireKey: true, apiKey: 'abc', allowedOrigins: ['https://a.com', '*'], exposeAll: false, chatModels: ['/m/a.gguf'], imageModels: [] })
    expect(sanitizeServer({ access: 'local', requireKey: false, port: 1234 })).toMatchObject({ requireKey: false, port: 1234 })
    expect(sanitizeServer({ access: 'bogus', port: 1.5 })).toMatchObject({ access: 'local', port: 8321 })
  })

  it('checks web addresses, host names and sizes', () => {
    expect(normalizeOrigin('http://localhost:3000/some/page')).toBe('http://localhost:3000')
    expect(normalizeOrigin('*')).toBe('*')
    expect(normalizeOrigin('ftp://x.com')).toBeNull()
    expect(normalizeOrigin('example.com')).toBeNull()
    expect(originProblem('')).toMatch(/Type a web address/)
    expect(originProblem('example.com')).toMatch(/not a web address/)
    expect(originProblem('https://example.com')).toBeNull()
    expect(hostName('Localhost:8321')).toBe('localhost')
    expect(hostName('[::1]:8321')).toBe('[::1]')
    expect(isLoopbackHost('127.0.0.1:8321')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('[::1]:1')).toBe(true)
    expect(isLoopbackHost('evil.example:8321')).toBe(false)
    expect(isLoopbackHost('127.0.0.1.evil.example')).toBe(false)
    expect(isLoopbackHost(undefined)).toBe(false)
    expect(parseSize('512x768')).toEqual({ width: 512, height: 768 })
    expect(parseSize('1024×1024')).toEqual({ width: 1024, height: 1024 })
    expect(parseSize('auto')).toBeNull()
    expect(parseSize('10x10')).toBeNull()
    expect(parseSize('9000x9000')).toBeNull()
    expect(parseSize(5)).toBeNull()
  })

  it('names models so they can be typed anywhere, and keeps the names steady', () => {
    expect(slugModelName('Llama 3.1 8B Instruct.gguf')).toBe('Llama-3.1-8B-Instruct')
    expect(slugModelName('  ***  ')).toBe('model')
    expect(slugModelName('qwen/coder:7b')).toBe('qwencoder:7b')
    const models = [{ key: '/m/b.gguf', name: 'Same' }, { key: '/m/a.gguf', name: 'same' }, { key: '/m/c.gguf', name: 'Other' }]
    const ids = assignModelIds(models)
    expect(ids.get('/m/a.gguf')).toBe('same') // sorted by key, so the first path keeps the plain name
    expect(ids.get('/m/b.gguf')).toBe('Same-2')
    expect(ids.get('/m/c.gguf')).toBe('Other')
    // Adding or removing a different model does not rename these.
    expect(assignModelIds(models.slice(0, 2)).get('/m/b.gguf')).toBe('Same-2')
    // Names already taken (by chat models) are avoided for image models.
    expect(assignModelIds([{ key: 'x', name: 'Other' }], new Set(['other'])).get('x')).toBe('Other-2')
  })

  it('makes a long random key and rewrites the model name in a streamed line', () => {
    const k = generateApiKey()
    expect(k).toMatch(/^cairn-[\w-]{30,}$/)
    expect(generateApiKey()).not.toBe(k)
    const r = rewriteSseLine('data: {"model":"local","usage":{"completion_tokens":9},"x":1}', 'my-model')
    expect(JSON.parse(r.line.slice(6))).toEqual({ model: 'my-model', usage: { completion_tokens: 9 }, x: 1 })
    expect(r.tokens).toBe(9)
    expect(rewriteSseLine('data: [DONE]', 'm')).toEqual({ line: 'data: [DONE]' })
    expect(rewriteSseLine(': ping', 'm')).toEqual({ line: ': ping' })
    expect(rewriteSseLine('data: not json', 'm')).toEqual({ line: 'data: not json' })
    expect(rewriteSseLine('data: {"choices":[]}', 'm').line).toBe('data: {"choices":[]}')
  })
})

describe('examples for the Serve tab', () => {
  it('writes examples with the address, the model name and the key', () => {
    const ex = serveExamples({ base: 'http://127.0.0.1:8321/v1/', key: 'cairn-abc', chat: 'Qwen-Coder', image: 'SDXL-Turbo' })
    expect(ex.curl).toContain('curl http://127.0.0.1:8321/v1/chat/completions')
    expect(ex.curl).toContain('Authorization: Bearer cairn-abc')
    expect(ex.curl).toContain('"model": "Qwen-Coder"')
    expect(ex.powershell).toContain('Invoke-RestMethod -Uri "http://127.0.0.1:8321/v1/chat/completions"')
    expect(ex.powershell).toContain('-Headers @{ Authorization = "Bearer cairn-abc" }')
    expect(ex.powershell).toContain('model = "Qwen-Coder"')
    expect(ex.python).toContain('base_url="http://127.0.0.1:8321/v1"')
    expect(ex.python).toContain('api_key="cairn-abc"')
    expect(ex.images).toContain('model="SDXL-Turbo"')
    const open = serveExamples({ base: 'http://x/v1', key: null, chat: 'm' })
    expect(open.curl).not.toContain('Authorization')
    expect(open.powershell).not.toContain('Authorization')
    expect(open.python).toContain('api_key="not-needed"')
    expect(open.images).toContain('your-image-model')
  })
})

describe('model leases', () => {
  const make = () => {
    const m = new LlamaManager({ getSettings: () => defaultSettings('/m'), engines: {} as never })
    const loaded: string[] = []
    ;(m as unknown as { ensure: (p: string) => Promise<string> }).ensure = async (p: string) => {
      loaded.push(p)
      return 'http://x'
    }
    return { m, loaded }
  }

  it('lets requests for the same model share it, and makes another model wait its turn', async () => {
    const { m } = make()
    const a1 = await m.acquire('/m/a.gguf')
    const a2 = await m.acquire('/m/a.gguf')
    let gotB = false
    const pb = m.acquire('/m/b.gguf').then((l) => ((gotB = true), l))
    await sleep(30)
    expect(gotB).toBe(false)
    a1.release()
    await sleep(30)
    expect(gotB).toBe(false) // a2 still has it
    a2.release()
    a2.release() // releasing twice changes nothing
    const b = await pb
    expect(gotB).toBe(true)
    expect(b.base).toBe('http://x')
    b.release()
  })

  it('serves in order: a later request for the same model does not jump the queue', async () => {
    const { m } = make()
    const a1 = await m.acquire('/m/a.gguf')
    const order: string[] = []
    const pb = m.acquire('/m/b.gguf').then((l) => (order.push('b'), l))
    await sleep(10)
    const pa = m.acquire('/m/a.gguf').then((l) => (order.push('a2'), l))
    await sleep(30)
    expect(order).toEqual([])
    a1.release()
    const b = await pb
    expect(order).toEqual(['b'])
    b.release()
    ;(await pa).release()
    expect(order).toEqual(['b', 'a2'])
  })

  it('stops waiting when cancelled, and lets those behind go ahead', async () => {
    const { m } = make()
    const a1 = await m.acquire('/m/a.gguf')
    const ac = new AbortController()
    const pb = m.acquire('/m/b.gguf', { signal: ac.signal })
    const caught = pb.catch((e) => e as Error)
    let gotA = false
    const pa = m.acquire('/m/a.gguf').then((l) => ((gotA = true), l))
    await sleep(20)
    expect(gotA).toBe(false) // behind the waiting b
    ac.abort()
    expect(((await caught) as Error).message).toBe('Cancelled')
    ;(await pa).release()
    expect(gotA).toBe(true)
    a1.release()
    await expect(m.acquire('/m/a.gguf', { signal: AbortSignal.abort() })).rejects.toThrow('Cancelled')
  })

  it('lets go of the claim when the model fails to load', async () => {
    const { m } = make()
    let fail = true
    ;(m as unknown as { ensure: () => Promise<string> }).ensure = async () => {
      if (fail) throw new Error('no model')
      return 'http://x'
    }
    await expect(m.acquire('/m/a.gguf')).rejects.toThrow('no model')
    fail = false
    const l = await Promise.race([m.acquire('/m/b.gguf'), sleep(500).then(() => null)])
    expect(l).not.toBeNull() // nothing is left holding the line
  })

  it('waits for answers in progress before freeing memory for pictures', async () => {
    const { m } = make()
    const a = await m.acquire('/m/a.gguf')
    let unloaded = false
    const p = m.unloadForImages().then(() => (unloaded = true))
    await sleep(30)
    expect(unloaded).toBe(false)
    a.release()
    await p
    expect(unloaded).toBe(true)
  })
})

interface Upstream {
  base: string
  requests: { path: string; body: Record<string, unknown> }[]
  mode: 'ok' | 'hang' | 'error'
  closed: number
  close(): Promise<void>
}

/** Stands in for llama-server: answers chat and completion requests the way it does. */
async function startUpstream(): Promise<Upstream> {
  const up: Upstream = { base: '', requests: [], mode: 'ok', closed: 0, close: async () => {} }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      up.requests.push({ path: req.url ?? '', body })
      res.on('close', () => {
        if (!res.writableFinished) up.closed++
      })
      if (up.mode === 'error') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'context too long', type: 'exceed_context_size_error' } }))
        return
      }
      const chunk = (content: string) => ({ id: 'c1', object: 'chat.completion.chunk', model: 'local', choices: [{ index: 0, delta: { content } }] })
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify(chunk('Hel'))}\n\n`)
        if (up.mode === 'hang') return
        res.write(`data: ${JSON.stringify(chunk('lo'))}\n\n`)
        res.write(`data: ${JSON.stringify({ id: 'c1', model: 'local', choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: 'local', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 5 } }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  up.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  up.close = () =>
    new Promise((r) => {
      server.closeAllConnections()
      server.close(() => r())
    })
  return up
}

const file = (p: string, name: string, extra: Partial<LocalModelFile> = {}): LocalModelFile => ({ path: p, name, sizeBytes: 1, root: '/m', ...extra })
const target = (model: string, label: string, available = true): ImageTargetOption => ({
  backendId: 'builtin',
  backendName: 'Built-in',
  kind: 'builtin',
  model,
  label,
  supportsImg2Img: true,
  supportsNegative: true,
  available,
  unavailableReason: available ? undefined : 'The model file is missing.'
})

describe('API server', () => {
  let up: Upstream
  let api: ApiServer
  let settings: Settings
  let held: number
  let acquired: string[]
  let gate: Promise<void> | null
  let failAcquire: string | null
  let generated: ImageGenRequest[]
  let published: number

  const files = [file('/m/Llama 3 8B.gguf', 'Llama 3 8B', { quant: 'Q4_K_M' }), file('/m/qwen.gguf', 'qwen', { label: 'Qwen Coder', mmprojPath: '/m/mm.gguf' })]

  const start = async (patch: Partial<Settings['server']> = {}) => {
    settings.server = { ...settings.server, enabled: true, port: 0, apiKey: KEY, ...patch }
    await api.apply()
    expect(api.status().error).toBeUndefined()
  }
  const url = (p: string) => `http://127.0.0.1:${api.status().port}${p}`
  const auth = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...extra })
  const post = (p: string, body: unknown, headers = auth(), init: RequestInit = {}) => fetch(url(p), { method: 'POST', headers, body: JSON.stringify(body), ...init })

  beforeEach(async () => {
    up = await startUpstream()
    settings = defaultSettings('/m')
    held = 0
    acquired = []
    gate = null
    failAcquire = null
    generated = []
    published = 0
    const imageIds = new Set(['img0', 'img1', 'img2', 'img3'])
    api = new ApiServer({
      getSettings: () => settings,
      llama: {
        async acquire(p, opts) {
          if (gate) {
            const signal = opts?.signal
            await Promise.race([gate, new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }))])
          }
          if (failAcquire) throw new Error(failAcquire)
          held++
          acquired.push(p)
          let done = false
          return {
            base: up.base,
            release() {
              if (!done) {
                done = true
                held--
              }
            }
          }
        },
        status: () => ({ state: 'running', modelPath: '/m/qwen.gguf' })
      },
      local: { scan: async () => files },
      images: {
        builtinTargets: async () => [target('sdxl-1', 'SDXL Turbo'), target('flux-1', 'FLUX', false)],
        async generate(req) {
          generated.push(req)
          if (req.prompt === 'explode') throw new Error('out of memory')
          return Array.from({ length: req.count }, (_, i): ImageRef => ({ id: `img${i}`, file: `img${i}.png`, thumb: '', prompt: req.prompt, width: 512, height: 512 }))
        }
      },
      imageStore: { readBytes: async (id) => (imageIds.has(id) ? fakePng(512, 512, 7) : null) },
      publish: () => void published++
    })
  })
  afterEach(async () => {
    await api.close()
    await up.close()
  })

  describe('access', () => {
    it('starts, shows where it can be reached, and stops when turned off', async () => {
      await start()
      const st = api.status()
      expect(st.state).toBe('running')
      expect(st.urls).toEqual([`http://127.0.0.1:${st.port}/v1`])
      expect(published).toBeGreaterThan(0)
      expect((await fetch(url('/health'))).status).toBe(200)
      settings.server = { ...settings.server, enabled: false }
      await api.apply()
      expect(api.status().state).toBe('stopped')
      await expect(fetch(url('/health'))).rejects.toThrow()
    })

    it('needs the key for everything but the health check', async () => {
      await start()
      expect((await fetch(url('/v1/models'))).status).toBe(401)
      const wrong = await fetch(url('/v1/models'), { headers: { Authorization: 'Bearer nope' } })
      expect(wrong.status).toBe(401)
      expect(wrong.headers.get('www-authenticate')).toBe('Bearer')
      const body = await wrong.json()
      expect(body.error).toMatchObject({ type: 'authentication_error', code: 'invalid_api_key' })
      expect((await fetch(url('/v1/models'), { headers: { Authorization: `Bearer ${KEY}` } })).status).toBe(200)
      expect((await fetch(url('/v1/models'), { headers: { 'x-api-key': KEY } })).status).toBe(200)
      expect((await fetch(url('/v1/models'), { headers: { Authorization: `bearer   ${KEY}` } })).status).toBe(200)
      expect((await fetch(url('/'))).status).toBe(200)
    })

    it('can run without a key on this computer, but refuses everything if a key is required and none exists', async () => {
      await start({ requireKey: false })
      expect((await fetch(url('/v1/models'))).status).toBe(200)
      settings.server = { ...settings.server, requireKey: true, apiKey: '' }
      const r = await fetch(url('/v1/models'))
      expect(r.status).toBe(401)
      expect((await r.json()).error.message).toMatch(/No API key/)
    })

    const rawGet = (port: number, path: string, headers: Record<string, string>) =>
      new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, headers, method: 'GET' }, (res) => {
          let body = ''
          res.on('data', (c) => (body += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
        })
        req.on('error', reject)
        req.end()
      })

    it('turns away a made-up host name when only this computer is allowed, even with the right key', async () => {
      await start()
      const bad = await rawGet(api.status().port!, '/v1/models', { Host: 'evil.example', Authorization: `Bearer ${KEY}` })
      expect(bad.status).toBe(403)
      expect(JSON.parse(bad.body).error.code).toBe('host_not_allowed')
      const good = await rawGet(api.status().port!, '/v1/models', { Host: 'localhost', Authorization: `Bearer ${KEY}` })
      expect(good.status).toBe(200)
    })

    it('answers any host name when open to the network, and lists the addresses to use', async () => {
      await start({ access: 'network' })
      const r = await rawGet(api.status().port!, '/v1/models', { Host: '192.168.1.20:8321', Authorization: `Bearer ${KEY}` })
      expect(r.status).toBe(200)
      expect(api.status().urls.at(-1)).toBe(`http://127.0.0.1:${api.status().port}/v1`)
    })

    it('turns away web pages that are not on the list, and lets listed ones in', async () => {
      await start({ allowedOrigins: ['https://app.example'] })
      const bad = await fetch(url('/v1/models'), { headers: { ...auth(), Origin: 'https://evil.example' } })
      expect(bad.status).toBe(403)
      expect((await bad.json()).error.code).toBe('origin_not_allowed')
      expect(up.requests).toHaveLength(0)
      const ok = await fetch(url('/v1/models'), { headers: { ...auth(), Origin: 'https://app.example' } })
      expect(ok.status).toBe(200)
      expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example')
      const pre = await fetch(url('/v1/chat/completions'), { method: 'OPTIONS', headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'POST' } })
      expect(pre.status).toBe(204)
      expect(pre.headers.get('access-control-allow-headers')).toMatch(/authorization/)
      const badPre = await fetch(url('/v1/chat/completions'), { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })
      expect(badPre.status).toBe(403)
      // Programs that are not browsers send no Origin and are not affected.
      expect((await fetch(url('/v1/models'), { headers: auth() })).headers.get('access-control-allow-origin')).toBeNull()
    })

    it('lets every page in with *', async () => {
      await start({ allowedOrigins: ['*'] })
      const r = await fetch(url('/v1/models'), { headers: { ...auth(), Origin: 'https://anything.example' } })
      expect(r.status).toBe(200)
      expect(r.headers.get('access-control-allow-origin')).toBe('*')
    })

    it('restarts on a new port and says so when a port is taken', async () => {
      await start()
      const first = api.status().port
      const free = await freePort()
      settings.server = { ...settings.server, port: free }
      await api.apply()
      expect(api.status().port).toBe(free)
      expect(free).not.toBe(first)
      expect((await fetch(`http://127.0.0.1:${free}/health`)).status).toBe(200)

      const blocker = net.createServer()
      await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
      const busy = (blocker.address() as AddressInfo).port
      try {
        settings.server = { ...settings.server, port: busy }
        await api.apply()
        expect(api.status()).toMatchObject({ state: 'error', port: undefined })
        expect(api.status().error).toMatch(/already used/)
      } finally {
        await new Promise((r) => blocker.close(r))
      }
      settings.server = { ...settings.server, port: free }
      await api.apply()
      expect(api.status().state).toBe('running')
    })
  })

  describe('models', () => {
    it('lists the shared models with the names to use, and which one is loaded', async () => {
      await start()
      const r = await fetch(url('/v1/models'), { headers: auth() })
      const body = await r.json()
      expect(body.object).toBe('list')
      expect(body.data.map((m: { id: string; type: string }) => [m.id, m.type])).toEqual([
        ['Llama-3-8B', 'chat'],
        ['Qwen-Coder', 'chat'],
        ['FLUX', 'image'],
        ['SDXL-Turbo', 'image']
      ])
      const byId = Object.fromEntries(body.data.map((m: { id: string }) => [m.id, m]))
      expect(byId['Qwen-Coder']).toMatchObject({ object: 'model', owned_by: 'cairn', loaded: true })
      expect(byId['Llama-3-8B'].loaded).toBe(false)
      expect(byId['FLUX'].available).toBe(false)
      expect(byId['SDXL-Turbo'].available).toBe(true)
      const one = await fetch(url('/v1/models/Qwen-Coder'), { headers: auth() })
      expect((await one.json()).id).toBe('Qwen-Coder')
      expect((await fetch(url('/v1/models/nope'), { headers: auth() })).status).toBe(404)
    })

    it('shares only the chosen models when not sharing everything', async () => {
      await start({ exposeAll: false, chatModels: ['/m/qwen.gguf'], imageModels: [] })
      const body = await (await fetch(url('/v1/models'), { headers: auth() })).json()
      expect(body.data.map((m: { id: string }) => m.id)).toEqual(['Qwen-Coder'])
      // The names do not change when others are hidden, and a hidden model cannot be used.
      const r = await post('/v1/chat/completions', { model: 'Llama-3-8B', messages: [] })
      expect(r.status).toBe(404)
      expect((await r.json()).error.message).toMatch(/not shared here\. Available: Qwen-Coder/)
      expect(up.requests).toHaveLength(0)
      const all = await api.describeModels()
      expect(all.find((m) => m.id === 'Llama-3-8B')).toMatchObject({ exposed: false, key: '/m/Llama 3 8B.gguf', type: 'chat' })
      expect(all.find((m) => m.id === 'Qwen-Coder')).toMatchObject({ exposed: true, detail: 'vision' })
    })
  })

  describe('chat', () => {
    it('answers a chat request and puts the shared model name in the reply', async () => {
      await start()
      const r = await post('/v1/chat/completions', { model: 'Llama-3-8B', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, max_tokens: 20 })
      expect(r.status).toBe(200)
      const body = await r.json()
      expect(body.model).toBe('Llama-3-8B')
      expect(body.choices[0].message.content).toBe('Hello')
      expect(acquired).toEqual(['/m/Llama 3 8B.gguf'])
      expect(held).toBe(0)
      expect(up.requests[0].path).toBe('/v1/chat/completions')
      expect(up.requests[0].body).toMatchObject({ model: 'local', temperature: 0.2, max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] })
      const log = api.status().recent[0]
      expect(log).toMatchObject({ method: 'POST', path: '/v1/chat/completions', model: 'Llama-3-8B', status: 200, tokens: 5 })
      expect(api.status().total).toBe(1)
    })

    it('accepts the file name, a different spelling, or no model at all', async () => {
      await start()
      settings.local.lastModelPath = '/m/qwen.gguf'
      await post('/v1/chat/completions', { model: 'llama-3-8b', messages: [] })
      await post('/v1/chat/completions', { model: '/m/qwen.gguf', messages: [] })
      await post('/v1/chat/completions', { messages: [] })
      await post('/v1/chat/completions', { model: 'default', messages: [] })
      expect(acquired).toEqual(['/m/Llama 3 8B.gguf', '/m/qwen.gguf', '/m/qwen.gguf', '/m/qwen.gguf']) // no name: the one used last
    })

    it('says which models exist when the name is wrong', async () => {
      await start()
      const r = await post('/v1/chat/completions', { model: 'gpt-4', messages: [] })
      expect(r.status).toBe(404)
      const e = (await r.json()).error
      expect(e).toMatchObject({ code: 'model_not_found', type: 'invalid_request_error' })
      expect(e.message).toContain("'gpt-4'")
      expect(e.message).toContain('Llama-3-8B, Qwen-Coder')
      expect(acquired).toEqual([])
    })

    it('streams the answer with the shared model name, and ends with [DONE]', async () => {
      await start()
      const r = await post('/v1/chat/completions', { model: 'Qwen-Coder', stream: true, messages: [] })
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toMatch(/text\/event-stream/)
      const text = await r.text()
      const lines = text.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      expect(lines).toHaveLength(3)
      for (const l of lines) expect(JSON.parse(l.slice(6)).model).toBe('Qwen-Coder')
      expect(JSON.parse(lines[0].slice(6)).choices[0].delta.content).toBe('Hel')
      expect(text.trim().endsWith('data: [DONE]')).toBe(true)
      await until(() => held === 0)
      expect(api.status().recent[0]).toMatchObject({ status: 200, tokens: 5, model: 'Qwen-Coder' })
    })

    it('opens the stream before the model has loaded, so the other program does not give up', async () => {
      await start()
      let open!: () => void
      gate = new Promise<void>((r) => (open = r))
      const r = await post('/v1/chat/completions', { model: 'Qwen-Coder', stream: true, messages: [] }) // resolves on the headers
      expect(r.status).toBe(200)
      expect(acquired).toEqual([])
      open()
      expect(await r.text()).toContain('"Hel"')
    })

    it('reports a failed model load inside the stream', async () => {
      await start()
      failAcquire = 'The llama.cpp engine is not installed yet.'
      const r = await post('/v1/chat/completions', { model: 'Qwen-Coder', stream: true, messages: [] })
      expect(r.status).toBe(200)
      const text = await r.text()
      expect(text).toContain('not installed yet')
      expect(text.trim().endsWith('data: [DONE]')).toBe(true)
      expect(held).toBe(0)
    })

    it('reports a failed model load as an error when not streaming', async () => {
      await start()
      failAcquire = 'Model file not found: /m/qwen.gguf'
      const r = await post('/v1/chat/completions', { model: 'Qwen-Coder', messages: [] })
      expect(r.status).toBe(502)
      expect((await r.json()).error.message).toMatch(/Model file not found/)
    })

    it('hands on the engine\'s own error for a request it refuses', async () => {
      await start()
      up.mode = 'error'
      const r = await post('/v1/chat/completions', { model: 'Qwen-Coder', messages: [] })
      expect(r.status).toBe(400)
      expect((await r.json()).error.message).toBe('context too long')
      expect(api.status().recent[0].error).toBe('context too long')
      const s = await post('/v1/chat/completions', { model: 'Qwen-Coder', stream: true, messages: [] })
      const text = await s.text()
      expect(text).toContain('context too long')
      expect(text.trim().endsWith('data: [DONE]')).toBe(true)
      expect(held).toBe(0)
    })

    it('serves plain completions too', async () => {
      await start()
      const r = await post('/v1/completions', { model: 'Qwen-Coder', prompt: 'Once upon' })
      expect(r.status).toBe(200)
      expect(up.requests[0].path).toBe('/v1/completions')
      expect(up.requests[0].body).toMatchObject({ prompt: 'Once upon', model: 'local' })
    })

    it('stops the model and gives it back when the other program hangs up', async () => {
      await start()
      up.mode = 'hang'
      const ac = new AbortController()
      const r = await post('/v1/chat/completions', { model: 'Qwen-Coder', stream: true, messages: [] }, auth(), { signal: ac.signal })
      const reader = r.body!.getReader()
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain('Hel')
      expect(held).toBe(1)
      ac.abort()
      await until(() => held === 0)
      await until(() => up.closed === 1)
      await expect(reader.read()).rejects.toThrow()
    })

    it('gives the model back when the program hangs up while still waiting for it', async () => {
      await start()
      gate = new Promise<void>(() => {}) // never opens
      const ac = new AbortController()
      void post('/v1/chat/completions', { model: 'Qwen-Coder', messages: [] }, auth(), { signal: ac.signal }).catch(() => {})
      await sleep(50)
      ac.abort()
      await sleep(50)
      expect(held).toBe(0)
      expect(api.status().active).toBe(0)
    })

    it('rejects a body that is not JSON, and one that is not an object', async () => {
      await start()
      const bad = await fetch(url('/v1/chat/completions'), { method: 'POST', headers: auth(), body: '{nope' })
      expect(bad.status).toBe(400)
      expect((await bad.json()).error.code).toBe('invalid_json')
      expect((await post('/v1/chat/completions', [1, 2])).status).toBe(400)
    })
  })

  describe('pictures', () => {
    it('makes pictures and returns links that open without the key', async () => {
      await start()
      const r = await post('/v1/images/generations', { model: 'SDXL-Turbo', prompt: ' a red fox ', n: 2, size: '512x768', steps: 6, cfg_scale: 1.5, seed: 42, negative_prompt: 'blurry', sampler: 'euler' })
      expect(r.status).toBe(200)
      const body = await r.json()
      expect(body.created).toBeGreaterThan(1_600_000_000)
      expect(body.data).toHaveLength(2)
      expect(generated[0]).toMatchObject({
        prompt: 'a red fox',
        negativePrompt: 'blurry',
        target: { backendId: 'builtin', model: 'sdxl-1' },
        width: 512,
        height: 768,
        steps: 6,
        cfgScale: 1.5,
        seed: 42,
        sampler: 'euler',
        count: 2,
        source: 'hub'
      })
      const link = body.data[0].url as string
      expect(link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${api.status().port}/v1/files/images/img0\\.png\\?exp=\\d+&sig=[0-9a-f]{40}$`))
      const img = await fetch(link) // no key
      expect(img.status).toBe(200)
      expect(img.headers.get('content-type')).toBe('image/png')
      expect(new Uint8Array(await img.arrayBuffer())).toEqual(fakePng(512, 512, 7))
    })

    it('can return the picture itself, and uses the model\'s own size and settings when none are given', async () => {
      await start()
      const r = await post('/v1/images/generations', { prompt: 'a fox', response_format: 'b64_json' })
      const body = await r.json()
      expect(Buffer.from(body.data[0].b64_json, 'base64')).toEqual(Buffer.from(fakePng(512, 512, 7)))
      expect(generated[0]).toMatchObject({ width: 0, height: 0, seed: -1, count: 1, target: { model: 'sdxl-1' } })
      expect(generated[0].steps).toBeUndefined()
      await post('/v1/images/generations', { prompt: 'a fox', n: 99, size: 'auto' })
      expect(generated[1].count).toBe(4)
      expect(generated[1].width).toBe(0)
    })

    it('does not accept links that were changed, expired or made up', async () => {
      await start()
      const body = await (await post('/v1/images/generations', { prompt: 'x' })).json()
      const link = new URL(body.data[0].url)
      const bad = (q: string) => fetch(`${link.origin}${link.pathname}?${q}`)
      expect((await bad(`exp=${link.searchParams.get('exp')}&sig=${'0'.repeat(40)}`)).status).toBe(403)
      expect((await bad(`exp=${Number(link.searchParams.get('exp')) + 1}&sig=${link.searchParams.get('sig')}`)).status).toBe(403)
      expect((await bad('')).status).toBe(403)
      const other = await fetch(`${link.origin}/v1/files/images/img1.png${link.search}`) // signature belongs to img0
      expect(other.status).toBe(403)
      const expired = (api as unknown as { sign(id: string, exp: number): string }).sign('img0', 5)
      expect((await bad(`exp=5&sig=${expired}`)).status).toBe(403)
    })

    it('checks the request before drawing anything', async () => {
      await start()
      const err = async (b: unknown) => (await post('/v1/images/generations', b)).json()
      expect((await err({})).error.message).toMatch(/prompt/)
      expect((await err({ prompt: 'x'.repeat(9000) })).error.message).toMatch(/too long/)
      expect((await err({ prompt: 'x', response_format: 'svg' })).error.code).toBe('invalid_response_format')
      expect((await err({ prompt: 'x', model: 'nope' })).error.code).toBe('model_not_found')
      expect((await err({ prompt: 'x', model: 'FLUX' })).error).toMatchObject({ code: 'model_unavailable', message: 'The model file is missing.' })
      expect((await err({ prompt: 'x', model: 'Qwen-Coder' })).error.code).toBe('model_not_found') // a chat model is not a picture model
      expect(generated).toHaveLength(0)
    })

    it('reports a failed drawing', async () => {
      await start()
      const r = await post('/v1/images/generations', { prompt: 'explode' })
      expect(r.status).toBe(500)
      expect((await r.json()).error).toMatchObject({ code: 'image_generation_failed', message: 'out of memory' })
    })
  })

  describe('other requests', () => {
    it('says plainly what it does not offer, and what does not exist', async () => {
      await start()
      const emb = await post('/v1/embeddings', { input: 'x' })
      expect(emb.status).toBe(501)
      expect((await emb.json()).error.code).toBe('not_supported')
      expect((await post('/v1/audio/speech', {})).status).toBe(501)
      expect((await fetch(url('/v1/nothing'), { headers: auth() })).status).toBe(404)
      const wrong = await fetch(url('/v1/chat/completions'), { headers: auth() })
      expect(wrong.status).toBe(405)
      expect((await fetch(url('/v1/models'), { method: 'POST', headers: auth(), body: '{}' })).status).toBe(405)
    })

    it('keeps a short list of recent requests without the prompts', async () => {
      await start()
      await post('/v1/chat/completions', { model: 'Qwen-Coder', messages: [{ role: 'user', content: 'a secret question' }] })
      await fetch(url('/v1/models'), { headers: auth() })
      await fetch(url('/health'))
      await fetch(url('/v1/models'))
      await until(() => api.status().total === 3)
      const st = api.status()
      expect(st.recent.map((e) => [e.method, e.path, e.status])).toEqual([
        ['GET', '/v1/models', 401],
        ['GET', '/v1/models', 200],
        ['POST', '/v1/chat/completions', 200]
      ]) // the health check is not listed
      expect(JSON.stringify(st.recent)).not.toContain('secret')
      expect(st.recent[0].client).toBe('127.0.0.1')
      for (let i = 0; i < 50; i++) await fetch(url('/v1/models'))
      await until(() => api.status().total === 53)
      expect(api.status().recent.length).toBe(40)
    })

    it('closes open answers when the server is turned off', async () => {
      await start()
      up.mode = 'hang'
      const r = await post('/v1/chat/completions', { model: 'Qwen-Coder', stream: true, messages: [] })
      const reader = r.body!.getReader()
      await reader.read()
      settings.server = { ...settings.server, enabled: false }
      await api.apply()
      await expect(reader.read()).rejects.toThrow()
      await until(() => held === 0)
      expect(api.status().state).toBe('stopped')
    })
  })
})
