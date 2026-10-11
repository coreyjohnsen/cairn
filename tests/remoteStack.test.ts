import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatEvent, ConversationSummary } from '../src/shared/types'
import { freePort } from '../src/main/engines/llama-server'
import { type Handlers, type PlatformApi, buildHandlers } from '../src/main/ipc'
import { type Services, createServices } from '../src/main/services'
import { CallError, RemoteTransport } from '../src/remote/src/lib/transport'
import { type MockServer, startMockOpenAI } from './helpers/mockOpenAI'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('Timed out waiting for a condition')
    await sleep(15)
  }
}

function jarFetch(): typeof fetch {
  let cookie = ''
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    if (cookie) headers.set('cookie', cookie)
    const res = await fetch(input, { ...init, headers })
    const set = res.headers.get('set-cookie')
    if (set) cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0]
    return res
  }
}

const platform: PlatformApi = {
  appVersion: '1.0.0',
  isPackaged: false,
  home: '/home/someone',
  selectFolder: async () => null,
  selectFile: async () => null,
  saveFile: async () => null,
  openPath: async () => {},
  showItem: () => {},
  openExternal: async () => {},
  setTitleBar: () => {}
}

/** The real chat, conversation and settings services, a real model server (scripted), and a phone talking to them over the network. */
describe('a phone using the real app', () => {
  let dir: string
  let services: Services
  let handlers: Handlers
  let model: MockServer
  let port: number
  let phone: RemoteTransport
  let events: { channel: string; payload: unknown }[]

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-stack-'))
    fs.mkdirSync(path.join(dir, 'client'))
    fs.writeFileSync(path.join(dir, 'client/index.html'), '<title>phone</title>')
    model = await startMockOpenAI([{ text: ['Hello ', 'from ', 'the model.'] }])
    services = await createServices({ dataDir: path.join(dir, 'data'), startMcp: false, startServer: false, startRemote: false, remoteClientDir: path.join(dir, 'client'), appVersion: '1.0.0' })
    handlers = buildHandlers(services, platform)
    port = await freePort()
    const s = services.settings.get()
    services.settings.update({
      defaultModel: 'mock::mock-model',
      providers: [...s.providers, { id: 'mock', name: 'Mock', kind: 'openai', baseUrl: model.url, apiKey: 'sk-very-secret', enabled: true, headers: {}, manualModels: [], capOverrides: {} }],
      remote: { enabled: true, port, publicUrl: '', keepAwake: false }
    })
    await services.remote.apply()
    events = []
    phone = new RemoteTransport({ base: `http://127.0.0.1:${port}`, fetch: jarFetch(), onEvent: (channel, payload) => events.push({ channel, payload }) })
    const offer = services.remote.pair()
    const paired = await phone.pair(offer.code, 'Test phone')
    expect(paired.ok).toBe(true)
    phone.connect()
    await until(() => phone.live)
  })

  afterEach(async () => {
    phone.disconnect()
    await services.shutdown()
    await model.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Requests that answer a message (the model is also asked once to name a new chat). */
  const replies = () => model.requests.filter((r) => !String(r.messages?.[r.messages.length - 1]?.content ?? '').startsWith('Write a title'))
  const chatEvents = () => events.filter((e) => e.channel === 'chat:event').map((e) => e.payload as ChatEvent)

  it('chats with the real model through the computer and sees the reply stream in', async () => {
    const conv = (await phone.invoke('conversations:create', [{}])) as { id: string; toolsEnabled: boolean }
    // A chat started from a phone without tool access starts with tools off.
    expect(conv.toolsEnabled).toBe(false)
    await phone.invoke('chat:send', [{ conversationId: conv.id, text: 'Say hello' }])
    await until(() => chatEvents().some((e) => e.type === 'run-end'))
    expect(chatEvents().find((e) => e.type === 'run-end')).toMatchObject({ outcome: 'done' })
    const streamed = chatEvents()
      .filter((e): e is Extract<ChatEvent, { type: 'delta' }> => e.type === 'delta')
      .map((e) => e.content ?? '')
      .join('')
    expect(streamed).toBe('Hello from the model.')

    const saved = (await phone.invoke('conversations:get', [conv.id])) as { messages: { role: string; content: string }[] }
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(saved.messages[1].content).toBe('Hello from the model.')
    // The same chat is on the computer.
    expect(services.conversations.get(conv.id)?.messages).toHaveLength(2)
    expect(events.some((e) => e.channel === 'conversations:changed')).toBe(true)
  })

  it('never offers tools to the model for a phone that may not use them, but does for one that may', async () => {
    const conv = (await phone.invoke('conversations:create', [{}])) as { id: string }
    // Even if the chat itself has tools switched on (it was made on the computer), the phone's turn runs without them.
    services.conversations.update(conv.id, { toolsEnabled: true })
    await phone.invoke('chat:send', [{ conversationId: conv.id, text: 'list my files' }])
    await until(() => chatEvents().some((e) => e.type === 'run-end'))
    expect(replies()[0].tools).toBeUndefined()

    // The computer's own window is unaffected.
    await handlers['chat:send']({ conversationId: conv.id, text: 'again' })
    await until(() => chatEvents().filter((e) => e.type === 'run-end').length === 2)
    expect(replies()[1].tools?.length).toBeGreaterThan(0)

    // Turn tools on for the phone and it gets them too.
    services.remote.updateDevice(services.remote.devices.list()[0].id, { scopes: { tools: true } })
    await phone.invoke('chat:send', [{ conversationId: conv.id, text: 'and now' }])
    await until(() => chatEvents().filter((e) => e.type === 'run-end').length === 3)
    expect(replies()[2].tools?.length).toBeGreaterThan(0)
  })

  it('shows the phone the same chat list and keeps it in step when the computer changes it', async () => {
    const a = (await phone.invoke('conversations:create', [{ title: 'From the phone' }])) as ConversationSummary
    const onComputer = services.conversations.create({ title: 'From the computer' })
    const list = (await phone.invoke('conversations:list', [])) as ConversationSummary[]
    expect(list.map((c) => c.title).sort()).toEqual(['From the computer', 'From the phone'])

    // Deleting on the computer tells the phone.
    await handlers['conversations:delete'](onComputer.id)
    await until(() => events.some((e) => e.channel === 'conversations:removed' && e.payload === onComputer.id))
    // Cutting messages off on the computer tells the phone too.
    services.conversations.upsertMessage(a.id, { id: 'm_1', role: 'user', content: 'hi', createdAt: Date.now(), status: 'done' })
    services.conversations.upsertMessage(a.id, { id: 'm_2', role: 'assistant', content: 'hello', createdAt: Date.now(), status: 'done' })
    events.length = 0
    await handlers['conversations:truncate'](a.id, 'm_2')
    await until(() => events.some((e) => e.channel === 'conversations:changed' && (e.payload as ConversationSummary).id === a.id))
    expect((events.find((e) => e.channel === 'conversations:changed')!.payload as ConversationSummary).messageCount).toBe(1)
  })

  it('keeps keys, folders and the computer itself out of reach', async () => {
    const settings = JSON.stringify(await phone.invoke('settings:get', []))
    expect(settings).not.toContain('sk-very-secret')
    expect(settings).not.toContain(dir)
    const info = JSON.stringify(await phone.invoke('system:info', []))
    expect(info).not.toContain(dir)
    expect(info).not.toContain('/home/someone')
    for (const channel of ['settings:update', 'system:openPath', 'library:delete', 'llama:start', 'remote:pair', 'remote:removeDevice', 'remote:status']) {
      await expect(phone.invoke(channel, [{}]), channel).rejects.toBeInstanceOf(CallError)
    }
    // The pairing window is unreachable from a phone: it cannot mint codes for itself or sign other devices out.
    expect(services.remote.devices.list()).toHaveLength(1)
    const models = (await phone.invoke('models:list', [])) as { ref: string }[]
    expect(models.some((m) => m.ref === 'mock::mock-model')).toBe(true)
  })

  it('tells the interface that a phone paired, and shows it in the device list', async () => {
    const status = services.remote.status()
    expect(status.state).toBe('running')
    expect(status.devices[0]).toMatchObject({ name: 'Test phone', online: true, scopes: { images: true, tools: false } })
  })
})
