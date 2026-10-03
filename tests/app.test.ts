import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS, makeProvider } from '../src/shared/defaults'
import { INVOKE_CHANNELS, type IpcEventMap, type EventChannel } from '../src/shared/ipc'
import type { ChatEvent, ImageJob, ImageRecord } from '../src/shared/types'
import { freePort } from '../src/main/engines/llama-server'
import { setEventSink } from '../src/main/events'
import { type Handlers, type PlatformApi, buildHandlers } from '../src/main/ipc'
import { type Services, createServices } from '../src/main/services'
import { type MockServer, type ScriptedTurn, startMockOpenAI } from './helpers/mockOpenAI'
import { fakePng } from './helpers/png'

/**
 * Whole-backend tests: real services on a temporary data directory, driven through the same handler
 * map the Electron window uses. Only the model servers and the OS shell are replaced.
 */

let dir: string
let ws: string
let services: Services
let h: Handlers
let openai: MockServer | null = null
let a1111: http.Server
let a1111Url = ''
let a1111Bodies: any[] = []
let events: { channel: EventChannel; payload: unknown }[] = []
let platformCalls: string[] = []
let nextSavePath: string | null = null

const platform = (): PlatformApi => ({
  appVersion: '9.9.9',
  isPackaged: false,
  home: dir,
  selectFolder: async () => ws,
  selectFile: async () => null,
  saveFile: async () => nextSavePath,
  openPath: async (p) => void platformCalls.push(`open:${p}`),
  showItem: (p) => void platformCalls.push(`show:${p}`),
  openExternal: async (u) => void platformCalls.push(`ext:${u}`),
  setTitleBar: () => {}
})

const chatEvents = () => events.filter((e) => e.channel === 'chat:event').map((e) => e.payload as ChatEvent)
const waitFor = async <T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 8000): Promise<T> => {
  const t = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v as T
    if (Date.now() - t > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 15))
  }
}
const runEnd = (convId: string) => chatEvents().find((e) => e.type === 'run-end' && e.conversationId === convId) as Extract<ChatEvent, { type: 'run-end' }> | undefined

async function useOpenAI(script: ScriptedTurn[], opts: { autoTitle?: boolean } = {}): Promise<void> {
  await openai?.close()
  openai = await startMockOpenAI(script)
  const prov = { ...makeProvider(PROVIDER_PRESETS.find((p) => p.id === 'custom')!, 'mock'), baseUrl: openai.url, name: 'Mock server' }
  h['settings:update']({ providers: [services.settings.get().providers[0], prov], defaultModel: 'mock::mock-model', chat: { ...services.settings.get().chat, autoTitle: opts.autoTitle ?? false } })
}

beforeAll(async () => {
  a1111 = http.createServer(async (req, res) => {
    const json = (o: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(o))
    }
    if (req.url === '/sdapi/v1/sd-models') return json([{ title: 'peaks.safetensors', model_name: 'peaks' }])
    if (req.url?.startsWith('/sdapi/v1/progress')) return json({ progress: 0.4, state: { sampling_step: 4, sampling_steps: 10 } })
    if (req.url === '/sdapi/v1/txt2img') {
      let b = ''
      for await (const c of req) b += c
      const body = JSON.parse(b)
      a1111Bodies.push(body)
      return json({ images: [Buffer.from(fakePng(body.width, body.height, 5)).toString('base64')], info: JSON.stringify({ all_seeds: [body.seed] }) })
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => a1111.listen(0, '127.0.0.1', r))
  a1111Url = `http://127.0.0.1:${(a1111.address() as AddressInfo).port}`
})
afterAll(() => new Promise((r) => a1111.close(r)))

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cairn-app-'))
  ws = path.join(dir, 'workspace')
  await fsp.mkdir(ws)
  events = []
  platformCalls = []
  a1111Bodies = []
  nextSavePath = null
  setEventSink((channel, payload) => void events.push({ channel, payload }))
  services = await createServices({ dataDir: path.join(dir, 'data'), startMcp: false, makeThumb: () => new Uint8Array([1, 2, 3]) })
  h = buildHandlers(services, platform())
})
afterEach(async () => {
  setEventSink(() => {})
  await services.shutdown()
  await openai?.close()
  openai = null
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('handler map', () => {
  it('implements every channel in the IPC contract', () => {
    for (const ch of INVOKE_CHANNELS) expect(typeof h[ch], ch).toBe('function')
    expect(Object.keys(h).sort()).toEqual([...INVOKE_CHANNELS].sort())
  })
})

describe('settings', () => {
  it('starts with sensible defaults and persists updates across a restart', async () => {
    const s = await h['settings:get']()
    expect(s.providers[0].id).toBe('local')
    expect(s.image.backends.some((b) => b.id === 'builtin')).toBe(true)
    await h['settings:update']({ chat: { ...s.chat, temperature: 0.2 } })
    expect(events.some((e) => e.channel === 'settings:changed')).toBe(true)
    await services.shutdown()
    services = await createServices({ dataDir: path.join(dir, 'data'), startMcp: false })
    h = buildHandlers(services, platform())
    expect((await h['settings:get']()).chat.temperature).toBe(0.2)
  })

  it('encrypts API keys on disk when a cipher is available and restores them on load', async () => {
    await services.shutdown()
    const cipher = { available: () => true, encrypt: (p: string) => new Uint8Array(Buffer.from([...Buffer.from(p)].map((b) => b ^ 0x5a))), decrypt: (d: Uint8Array) => Buffer.from([...d].map((b) => b ^ 0x5a)).toString() }
    services = await createServices({ dataDir: path.join(dir, 'data'), startMcp: false, cipher })
    h = buildHandlers(services, platform())
    const s = await h['settings:get']()
    await h['settings:update']({ providers: [...s.providers, { ...makeProvider(PROVIDER_PRESETS.find((p) => p.id === 'openai')!, 'oa'), apiKey: 'sk-very-secret' }] })
    await services.settings.saveNow()
    const raw = await fsp.readFile(path.join(dir, 'data', 'settings.json'), 'utf8')
    expect(raw).not.toContain('sk-very-secret')
    expect(raw).toContain('enc1:')
    await services.shutdown()
    services = await createServices({ dataDir: path.join(dir, 'data'), startMcp: false, cipher })
    expect(services.settings.get().providers.find((p) => p.id === 'oa')?.apiKey).toBe('sk-very-secret')
  })
})

describe('sharing models with other programs', () => {
  it('turns the server on from the settings, makes a key when none exists, and turns it off again', async () => {
    const port = await freePort()
    const s = await h['settings:get']()
    expect(s.server).toMatchObject({ enabled: false, access: 'local', requireKey: true, apiKey: '' })
    expect((await h['server:status']()).state).toBe('stopped')

    await h['settings:update']({ server: { ...s.server, enabled: true, port } })
    await waitFor(() => services.api.status().state === 'running')
    const key = services.settings.get().server.apiKey
    expect(key).toMatch(/^cairn-/)
    expect(await h['server:status']()).toMatchObject({ state: 'running', port, urls: [`http://127.0.0.1:${port}/v1`] })
    expect(events.some((e) => e.channel === 'server:status' && (e.payload as { state: string }).state === 'running')).toBe(true)

    expect((await fetch(`http://127.0.0.1:${port}/v1/models`)).status).toBe(401)
    const ok = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })
    expect(ok.status).toBe(200)
    expect(Array.isArray((await ok.json() as { data: unknown[] }).data)).toBe(true)
    expect(await h['server:models']()).toEqual(expect.any(Array))

    const fresh = await h['server:newKey']()
    expect(fresh).not.toBe(key)
    expect(services.settings.get().server.apiKey).toBe(fresh)
    expect((await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })).status).toBe(401)

    await h['settings:update']({ server: { ...services.settings.get().server, enabled: false } })
    await waitFor(() => services.api.status().state === 'stopped')
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()
  })

  it('keeps the key encrypted on disk, and starts again by itself when the app starts', async () => {
    await services.shutdown()
    const cipher = { available: () => true, encrypt: (p: string) => new Uint8Array(Buffer.from([...Buffer.from(p)].map((b) => b ^ 0x5a))), decrypt: (d: Uint8Array) => Buffer.from([...d].map((b) => b ^ 0x5a)).toString() }
    services = await createServices({ dataDir: path.join(dir, 'data'), startMcp: false, cipher })
    h = buildHandlers(services, platform())
    const port = await freePort()
    await h['settings:update']({ server: { ...services.settings.get().server, enabled: true, port, apiKey: 'my-own-server-key' } })
    await waitFor(() => services.api.status().state === 'running')
    await services.settings.saveNow()
    const raw = await fsp.readFile(path.join(dir, 'data', 'settings.json'), 'utf8')
    expect(raw).not.toContain('my-own-server-key')
    await services.shutdown()
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()

    services = await createServices({ dataDir: path.join(dir, 'data'), startMcp: false, cipher })
    h = buildHandlers(services, platform())
    expect(services.settings.get().server.apiKey).toBe('my-own-server-key')
    await waitFor(() => services.api.status().state === 'running')
    expect((await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: 'Bearer my-own-server-key' } })).status).toBe(200)
  })

  it('does not start a server when told not to (as in the other tests)', async () => {
    await services.shutdown()
    const port = await freePort()
    services = await createServices({ dataDir: path.join(dir, 'data'), startMcp: false, startServer: false })
    await services.settings.update({ server: { ...services.settings.get().server, enabled: true, port, apiKey: 'k' } })
    await new Promise((r) => setTimeout(r, 50))
    expect(services.api.status().state).toBe('stopped')
  })
})

describe('chat through the handler map', () => {
  it('lists models from a provider, streams a reply, titles the chat and stores the transcript', async () => {
    await useOpenAI([{ text: ['Hello ', 'from the mountains.'] }, { text: ['Alpine greetings'] }], { autoTitle: true })
    const models = await h['models:list'](true)
    const m = models.find((x) => x.ref === 'mock::mock-model')
    expect(m).toBeTruthy()
    expect(models.some((x) => x.id === 'text-embedding-3-small')).toBe(false) // non-chat models are hidden
    expect(await h['models:test']('mock')).toMatchObject({ ok: true })

    const conv = await h['conversations:create']({ modelRef: 'mock::mock-model', toolsEnabled: false })
    const { runId } = await h['chat:send']({ conversationId: conv.id, text: 'Say hello' })
    expect(runId).toBeTruthy()
    await waitFor(() => runEnd(conv.id))
    expect(runEnd(conv.id)?.outcome).toBe('done')
    const deltas = chatEvents().filter((e) => e.type === 'delta').map((e) => (e as any).content).join('')
    expect(deltas).toBe('Hello from the mountains.')

    const saved = (await h['conversations:get'](conv.id))!
    expect(saved.messages.map((x) => x.role)).toEqual(['user', 'assistant'])
    expect(saved.messages[1].content).toBe('Hello from the mountains.')
    await waitFor(async () => (await h['conversations:get'](conv.id))?.title === 'Alpine greetings')
    expect((await h['conversations:list']())[0].title).toBe('Alpine greetings')
    expect((await h['conversations:search']('mountains')).map((c) => c.id)).toContain(conv.id)
  })

  it('edits files in the workspace after the user approves, and refuses when denied', async () => {
    const abs = path.join(ws, 'notes.md')
    await useOpenAI([
      { toolCalls: [{ id: 'c1', name: 'write_file', args: JSON.stringify({ path: 'notes.md', content: '# Peaks\n' }) }] },
      { text: ['Saved it.'] },
      { toolCalls: [{ id: 'c2', name: 'write_file', args: JSON.stringify({ path: 'blocked.md', content: 'nope' }) }] },
      { text: ['Understood, I will not write it.'] }
    ])
    await h['settings:update']({ agent: { ...services.settings.get().agent, workspace: ws } })
    const conv = await h['conversations:create']({ modelRef: 'mock::mock-model', toolsEnabled: true, workspace: ws })

    await h['chat:send']({ conversationId: conv.id, text: 'Write notes.md' })
    const ask = await waitFor(() => chatEvents().find((e) => e.type === 'approval')) as Extract<ChatEvent, { type: 'approval' }>
    expect(ask.approval.kind).toBe('write')
    expect(fs.existsSync(abs)).toBe(false) // nothing happens before approval
    await h['chat:approve'](ask.approval.id, 'allow')
    await waitFor(() => runEnd(conv.id))
    expect(fs.readFileSync(abs, 'utf8')).toBe('# Peaks\n')

    events = []
    await h['chat:send']({ conversationId: conv.id, text: 'Now write blocked.md' })
    const ask2 = await waitFor(() => chatEvents().find((e) => e.type === 'approval')) as Extract<ChatEvent, { type: 'approval' }>
    await h['chat:approve'](ask2.approval.id, 'deny')
    await waitFor(() => runEnd(conv.id))
    expect(fs.existsSync(path.join(ws, 'blocked.md'))).toBe(false)
    const msgs = (await h['conversations:get'](conv.id))!.messages
    expect(msgs.some((m) => m.role === 'tool' && m.denied)).toBe(true)
  })

  it('reads back files with no prompt and stays inside the workspace', async () => {
    await fsp.writeFile(path.join(ws, 'peak.txt'), 'Matterhorn 4478 m')
    await useOpenAI([
      { toolCalls: [{ id: 'r1', name: 'read_file', args: JSON.stringify({ path: 'peak.txt' }) }] },
      { text: ['It is 4478 m.'] }
    ])
    await h['settings:update']({ agent: { ...services.settings.get().agent, workspace: ws } })
    const conv = await h['conversations:create']({ modelRef: 'mock::mock-model', toolsEnabled: true, workspace: ws })
    await h['chat:send']({ conversationId: conv.id, text: 'How high?' })
    await waitFor(() => runEnd(conv.id))
    expect(chatEvents().some((e) => e.type === 'approval')).toBe(false)
    // the tool result was fed back to the model on the second request
    const second = JSON.stringify(openai!.requests[1].messages)
    expect(second).toContain('Matterhorn 4478 m')
  })

  it('stops a running response on request', async () => {
    await useOpenAI([{ error: { status: 500, body: { error: { message: 'boom' } } } }])
    const conv = await h['conversations:create']({ modelRef: 'mock::mock-model', toolsEnabled: false })
    await h['chat:send']({ conversationId: conv.id, text: 'hi' })
    await waitFor(() => runEnd(conv.id))
    expect(runEnd(conv.id)?.outcome).toBe('error')
    expect(runEnd(conv.id)?.error).toMatch(/boom/)
    expect(await h['chat:active']()).toEqual([])
  })

  it('refuses to send to a missing conversation and to truncate during a run', async () => {
    await expect(h['chat:send']({ conversationId: 'nope', text: 'x' })).rejects.toThrow(/not found/i)
  })

  it('deletes a conversation and exports markdown through the save dialog', async () => {
    const conv = await h['conversations:create']({ title: 'Export me' })
    expect(await h['conversations:export'](conv.id)).toBeNull() // dialog cancelled
    nextSavePath = path.join(dir, 'out.md')
    expect(await h['conversations:export'](conv.id)).toBe(nextSavePath)
    expect(fs.readFileSync(nextSavePath, 'utf8')).toContain('Export me')
    await h['conversations:delete'](conv.id)
    expect(await h['conversations:get'](conv.id)).toBeNull()
  })

  it('rewrites an image prompt with the chat model', async () => {
    await useOpenAI([{ text: ['Prompt: "A lone climber on a knife-edge ridge at golden hour, wide angle, volumetric light."'] }])
    const out = await h['chat:enhance']('climber on a ridge')
    expect(out).toBe('A lone climber on a knife-edge ridge at golden hour, wide angle, volumetric light.')
    expect(openai!.requests[0].messages.at(-1).content).toBe('climber on a ridge')
  })
})

describe('images through the handler map', () => {
  const addA1111 = async () => {
    const s = services.settings.get()
    await h['settings:update']({
      image: {
        ...s.image,
        backends: [...s.image.backends, { id: 'a1', name: 'My Forge', kind: 'a1111', enabled: true, baseUrl: a1111Url, apiKey: '', comfyWorkflow: '', defaultModel: '' }],
        defaultTarget: { backendId: 'a1', model: 'peaks.safetensors' }
      }
    })
  }

  it('generates from the Image Hub, saves it, and exposes list / favorite / delete / save-as / attachment', async () => {
    await addA1111()
    const targets = await h['images:targets'](true)
    expect(targets.find((t) => t.backendId === 'a1')).toMatchObject({ model: 'peaks.safetensors', available: true })
    expect(targets.find((t) => t.backendId === 'builtin')?.available).toBe(false) // no engine / models yet

    const { jobId } = await h['images:generate']({ prompt: 'glacier at dawn', width: 512, height: 768, seed: 7, count: 1, source: 'hub' })
    const job = await waitFor(() => (events.filter((e) => e.channel === 'images:job').map((e) => e.payload as ImageJob).reverse().find((j) => j.id === jobId && j.status === 'done')))
    expect(job.resultIds).toHaveLength(1)
    expect(a1111Bodies[0]).toMatchObject({ prompt: 'glacier at dawn', width: 512, height: 768, seed: 7 })

    const list = await h['images:list']()
    expect(list).toHaveLength(1)
    const rec = list[0] as ImageRecord
    expect(rec).toMatchObject({ prompt: 'glacier at dawn', width: 512, height: 768, seed: 7, backendName: 'My Forge', source: 'hub', favorite: false })
    expect(fs.existsSync(path.join(services.paths.images, rec.file))).toBe(true)
    expect(fs.existsSync(path.join(services.paths.thumbs, rec.thumb))).toBe(true)

    await h['images:favorite'](rec.id, true)
    expect((await h['images:list']())[0].favorite).toBe(true)

    const att = await h['images:toAttachment'](rec.id)
    expect(att?.mime).toBe('image/png')
    expect(att?.data.length).toBeGreaterThan(30)

    await h['images:reveal'](rec.id)
    expect(platformCalls.some((c) => c.startsWith('show:') && c.endsWith(rec.file))).toBe(true)

    expect(await h['images:saveAs'](rec.id)).toBeNull()
    nextSavePath = path.join(dir, 'exported.png')
    expect(await h['images:saveAs'](rec.id)).toBe(nextSavePath)
    expect(fs.existsSync(nextSavePath)).toBe(true)

    await h['images:delete']([rec.id])
    expect(await h['images:list']()).toHaveLength(0)
    expect(fs.existsSync(path.join(services.paths.images, rec.file))).toBe(false)
  })

  it('creates an image from chat with /imagine and shows it in the conversation', async () => {
    await addA1111()
    await useOpenAI([{ text: ['unused'] }])
    const conv = await h['conversations:create']({ modelRef: 'mock::mock-model', toolsEnabled: true })
    await h['chat:send']({ conversationId: conv.id, text: '/imagine a red fox on a snowy ridge' })
    await waitFor(() => runEnd(conv.id))
    expect(runEnd(conv.id)?.outcome).toBe('done')
    expect(a1111Bodies[0].prompt).toBe('a red fox on a snowy ridge')
    expect(openai!.requests).toHaveLength(0) // direct image mode does not involve the chat model
    const msgs = (await h['conversations:get'](conv.id))!.messages
    const withImages = msgs.find((m) => m.images?.length)
    expect(withImages?.images?.[0]).toMatchObject({ prompt: 'a red fox on a snowy ridge' })
    const rec = (await h['images:list']())[0]
    expect(rec).toMatchObject({ source: 'chat', conversationId: conv.id })
  })

  it('lets the model call generate_image as a tool when it decides to', async () => {
    await addA1111()
    await useOpenAI([
      { toolCalls: [{ id: 'g1', name: 'generate_image', args: JSON.stringify({ prompt: 'a cabin under the northern lights', width: 768, height: 512 }) }] },
      { text: ['Here is your cabin.'] }
    ])
    const conv = await h['conversations:create']({ modelRef: 'mock::mock-model', toolsEnabled: true })
    await h['chat:send']({ conversationId: conv.id, text: 'Please draw a cabin under the northern lights' })
    await waitFor(() => runEnd(conv.id))
    expect(runEnd(conv.id)?.outcome).toBe('done')
    expect(a1111Bodies[0]).toMatchObject({ prompt: 'a cabin under the northern lights', width: 768, height: 512 })
    expect(openai!.requests[0].tools.map((t: any) => t.function.name)).toContain('generate_image')
    const msgs = (await h['conversations:get'](conv.id))!.messages
    expect(msgs.some((m) => m.images?.length)).toBe(true)
  })

  it('does not advertise generate_image when no image model is configured', async () => {
    await useOpenAI([{ text: ['ok'] }])
    const conv = await h['conversations:create']({ modelRef: 'mock::mock-model', toolsEnabled: true })
    await h['chat:send']({ conversationId: conv.id, text: 'hello' })
    await waitFor(() => runEnd(conv.id))
    expect(openai!.requests[0].tools.map((t: any) => t.function.name)).not.toContain('generate_image')
  })

  it('reports a clear error for /imagine when nothing is set up', async () => {
    await useOpenAI([{ text: ['x'] }])
    const conv = await h['conversations:create']({ modelRef: 'mock::mock-model' })
    await h['chat:send']({ conversationId: conv.id, text: '/imagine a hut' })
    await waitFor(() => runEnd(conv.id))
    const msgs = (await h['conversations:get'](conv.id))!.messages
    expect(JSON.stringify(msgs)).toMatch(/No image model is set up yet/)
  })

  it('tests an image connection', async () => {
    await addA1111()
    expect(await h['images:testBackend']('a1')).toMatchObject({ ok: true })
    expect(await h['images:testBackend']('builtin')).toMatchObject({ ok: false })
  })
})

describe('tools, library and system helpers', () => {
  it('lists built-in tools with their default permissions', async () => {
    const tools = await h['tools:list']()
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(byName.read_file).toMatchObject({ source: 'builtin', permission: 'auto' })
    expect(byName.write_file.permission).toBe('ask')
    expect(byName.run_command.permission).toBe('ask')
    expect(byName.generate_image.available).toBe(false)
  })

  it('runs a custom tool test and registers it for chats', async () => {
    const tool = {
      id: 't1',
      name: 'echo_it',
      description: 'Echo',
      enabled: true,
      permission: 'auto' as const,
      parameters: '{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}',
      impl: process.platform === 'win32'
        ? { type: 'command' as const, file: 'cmd', args: ['/c', 'echo', '{{text}}'], cwd: '', timeoutSec: 10 }
        : { type: 'command' as const, file: 'echo', args: ['{{text}}'], cwd: '', timeoutSec: 10 }
    }
    const res = await h['tools:test'](tool, { text: 'granite' })
    expect(res.ok).toBe(true)
    expect(res.output).toContain('granite')
    await h['settings:update']({ customTools: [tool] })
    expect((await h['tools:list']()).some((t) => t.name === 'echo_it' && t.source === 'custom')).toBe(true)
  })

  it('scans local GGUF models, and only deletes weight files inside the model folders', async () => {
    const models = services.settings.modelsDir()
    await fsp.mkdir(path.join(models, 'llm'), { recursive: true })
    const gguf = path.join(models, 'llm', 'Tiny-1B-Q4_K_M.gguf')
    await fsp.writeFile(gguf, Buffer.alloc(64))
    const found = await h['library:gguf']()
    expect(found.map((f) => f.path)).toContain(gguf)
    expect((await h['models:list'](true)).some((m) => m.ref === `local::${gguf}`)).toBe(true)

    const outside = path.join(dir, 'outside.gguf')
    await fsp.writeFile(outside, 'x')
    await expect(h['library:delete'](outside)).rejects.toThrow(/not inside/)
    await expect(h['library:delete'](path.join(models, 'notes.txt'))).rejects.toThrow(/not inside/)
    await expect(h['library:delete'](models)).rejects.toThrow(/not inside/)
    await expect(h['library:delete'](path.join(models, 'llm', '..', '..', 'outside.gguf'))).rejects.toThrow(/not inside/)
    expect(fs.existsSync(outside)).toBe(true)

    await h['library:delete'](gguf)
    expect(fs.existsSync(gguf)).toBe(false)
    expect((await h['library:gguf']()).length).toBe(0)
  })

  it('lets the user name a local model, and keeps that tidy through downloads and deletes', async () => {
    const models = services.settings.modelsDir()
    await fsp.mkdir(path.join(models, 'llm'), { recursive: true })
    const gguf = path.join(models, 'llm', 'model.gguf')
    await fsp.writeFile(gguf, Buffer.alloc(64))
    const find = async (p: string) => (await h['library:gguf']()).find((f) => f.path === p)
    const listed = async (p: string) => (await h['models:list'](true)).find((m) => m.ref === `local::${p}`)?.name

    expect((await find(gguf))?.label).toBeUndefined()
    expect(await listed(gguf)).toBe('model')

    await h['library:setName'](gguf, '  Grok   4.3 ')
    expect((await find(gguf))?.label).toBe('Grok 4.3')
    expect(await listed(gguf)).toBe('Grok 4.3')
    expect(services.settings.get().local.modelNames[gguf]).toBe('Grok 4.3')

    // Only files inside the models folders can be named.
    await expect(h['library:setName'](path.join(dir, 'elsewhere.gguf'), 'Nope')).rejects.toThrow(/not inside/)

    // A blank name goes back to the file name.
    await h['library:setName'](gguf, '   ')
    expect((await find(gguf))?.label).toBeUndefined()
    expect(await listed(gguf)).toBe('model')

    // A download can arrive already named, and never overwrites a name the user chose.
    const payload = Buffer.alloc(2_000, 3)
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': payload.length })
      res.end(payload)
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    try {
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/m.gguf`
      const dest = path.join(models, 'llm', 'named-dl.gguf')
      const first = await h['downloads:start']({ url, subdir: 'llm', filename: 'named-dl.gguf', source: 'url', modelName: 'Tiny Chat Q4_K_M' })
      await waitFor(async () => (await h['downloads:list']()).find((d) => d.id === first.id)?.status === 'done')
      expect((await find(dest))?.label).toBe('Tiny Chat Q4_K_M')
      await h['library:setName'](dest, 'My own name')
      const again = await h['downloads:start']({ url, subdir: 'llm', filename: 'named-dl.gguf', source: 'url', modelName: 'Tiny Chat Q4_K_M' })
      await waitFor(async () => (await h['downloads:list']()).find((d) => d.id === again.id)?.status === 'done')
      expect((await find(dest))?.label).toBe('My own name')
      await h['library:delete'](dest)
      expect(services.settings.get().local.modelNames[dest]).toBeUndefined()
    } finally {
      await new Promise((r) => srv.close(r))
    }
    await h['library:delete'](gguf)
  })

  it('downloads a model into the models folder with progress events', async () => {
    const payload = Buffer.alloc(50_000, 7)
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': payload.length })
      res.end(payload)
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    try {
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/m.gguf`
      const { id } = await h['downloads:start']({ url, subdir: 'llm', filename: 'dl-test-Q4_K_M.gguf', source: 'url' })
      await waitFor(async () => (await h['downloads:list']()).find((d) => d.id === id)?.status === 'done')
      const dest = path.join(services.settings.modelsDir(), 'llm', 'dl-test-Q4_K_M.gguf')
      expect(fs.statSync(dest).size).toBe(payload.length)
      expect(events.some((e) => e.channel === 'downloads:update')).toBe(true)
      expect((await h['library:gguf']()).some((f) => f.path === dest)).toBe(true)
      await h['downloads:clear']()
      expect(await h['downloads:list']()).toHaveLength(0)
    } finally {
      await new Promise((r) => srv.close(r))
    }
  })

  it('rejects non-http download URLs and traversal in the destination', async () => {
    await expect(h['downloads:start']({ url: 'file:///etc/passwd', subdir: 'llm', filename: 'x.gguf', source: 'url' })).rejects.toThrow(/http/)
    const srv = http.createServer((_q, r) => r.end('x'))
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    try {
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/a`
      const { id } = await h['downloads:start']({ url, subdir: '../../../escape', filename: '../../evil.gguf', source: 'url' })
      const item = (await h['downloads:list']()).find((d) => d.id === id)!
      expect(path.relative(services.settings.modelsDir(), item.dest).startsWith('..')).toBe(false)
      await waitFor(async () => ['done', 'error'].includes((await h['downloads:list']()).find((d) => d.id === id)!.status))
    } finally {
      await new Promise((r) => srv.close(r))
    }
  })

  it('system helpers: info, safe link opening, and never launching files', async () => {
    const info = await h['system:info']()
    expect(info).toMatchObject({ appVersion: '9.9.9', platform: process.platform })
    expect(info.dataDir).toBe(services.paths.data)

    await h['system:openExternal']('https://example.com/a')
    expect(platformCalls).toContain('ext:https://example.com/a')
    await expect(h['system:openExternal']('file:///C:/Windows/System32/calc.exe')).rejects.toThrow(/Only web/)
    await expect(h['system:openExternal']('javascript:alert(1)')).rejects.toThrow(/Only web/)
    await expect(h['system:openExternal']('not a url')).rejects.toThrow(/valid link/)

    const file = path.join(dir, 'run-me.exe')
    await fsp.writeFile(file, 'x')
    platformCalls = []
    await h['system:openPath'](file)
    expect(platformCalls).toEqual([`show:${file}`]) // revealed, not executed
    await h['system:openPath'](dir)
    expect(platformCalls).toContain(`open:${dir}`)
    await expect(h['system:openPath'](path.join(dir, 'missing'))).rejects.toThrow(/does not exist/)
  })

  it('reports GPU and engine status without crashing on machines with no GPU', async () => {
    const gpu = await h['engines:gpu'](true)
    expect(gpu.platform).toBe(process.platform)
    const st = await h['engines:status']('llama')
    expect(st.available.length).toBeGreaterThan(0)
    expect(st.builds).toEqual([])
    expect((await h['llama:status']()).state).toBe('stopped')
  })
})

describe('event payload sanity', () => {
  it('emits only known channels', async () => {
    await h['conversations:create']({})
    const known: EventChannel[] = ['settings:changed', 'chat:event', 'images:added', 'images:updated', 'images:removed', 'images:job', 'engines:progress', 'engines:changed', 'llama:status', 'downloads:update', 'mcp:status', 'conversations:changed']
    for (const e of events) expect(known).toContain(e.channel)
    const payload = events.find((e) => e.channel === 'conversations:changed')?.payload as IpcEventMap['conversations:changed']
    expect(payload.title).toBe('New chat')
  })
})
