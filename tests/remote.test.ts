import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultRemoteSettings, defaultSettings } from '../src/shared/defaults'
import { decodeJson, encodeJson, fromBase64, toBase64 } from '../src/shared/remoteCodec'
import { PAIR_ALPHABET, cleanDeviceName, deviceNameFromUserAgent, formatPairCode, normalizePairCode, normalizePublicUrl, pairCodeFromText, publicUrlProblem, sanitizeRemote } from '../src/shared/remotePrefs'
import type { IpcEventMap } from '../src/shared/ipc'
import type { RemoteDevice, RemoteScopes } from '../src/shared/types'
import { freePort } from '../src/main/engines/llama-server'
import type { Handlers } from '../src/main/ipc'
import { DeviceStore, MAX_DEVICES } from '../src/main/remote/devices'
import { classifyAddress, remoteAddresses } from '../src/main/remote/net'
import { PAIR_TTL_MS, PairingBook, randomPairCode } from '../src/main/remote/pairing'
import { RemoteError, allowedChannels, dispatchRemote, eventAllowed, remoteSettingsView, remoteSystemInfo } from '../src/main/remote/policy'
import { COOKIE, RemoteServer } from '../src/main/remote/server'
import { fakePng } from './helpers/png'

declare global {
  interface Response {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json(): Promise<any>
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('Timed out waiting for a condition')
    await sleep(10)
  }
}

describe('remote codec', () => {
  it('round-trips bytes of every length', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255)
      expect(fromBase64(toBase64(bytes))).toEqual(bytes)
    }
    expect(toBase64(new Uint8Array([104, 101, 108, 108, 111]))).toBe(Buffer.from('hello').toString('base64'))
    const big = new Uint8Array(1_000_000).map((_, i) => (i * 7) & 255)
    expect(Buffer.from(fromBase64(toBase64(big))).equals(Buffer.from(big))).toBe(true)
  })

  it('accepts the URL-safe alphabet and rejects junk', () => {
    expect(fromBase64('-_8=')).toEqual(new Uint8Array([251, 255]))
    expect(() => fromBase64('ab$d')).toThrow(/base64/)
  })

  it('turns bytes inside any message into text and back, Buffers included', () => {
    const msg = { a: [1, 'x', { data: new Uint8Array([1, 2, 3]) }], buf: Buffer.from([9, 8, 7]), n: null, s: '__b64' }
    const text = encodeJson(msg)
    expect(text).not.toContain('"data":[1')
    const back = decodeJson<{ a: [number, string, { data: Uint8Array }]; buf: Uint8Array; n: null; s: string }>(text)
    expect(back.a[2].data).toBeInstanceOf(Uint8Array)
    expect([...back.a[2].data]).toEqual([1, 2, 3])
    expect([...back.buf]).toEqual([9, 8, 7])
    expect(back.s).toBe('__b64')
  })

  it('leaves objects that merely look similar alone', () => {
    const back = decodeJson<{ x: { __b64: string; other: number } }>('{"x":{"__b64":"AQID","other":1}}')
    expect(back.x).toEqual({ __b64: 'AQID', other: 1 })
  })
})

describe('companion settings and codes', () => {
  it('cleans stored settings', () => {
    expect(sanitizeRemote(undefined)).toEqual(defaultRemoteSettings())
    expect(sanitizeRemote({ enabled: true, port: 99999, publicUrl: 'nonsense://x', keepAwake: 'yes' })).toEqual({ enabled: true, port: 8742, publicUrl: '', keepAwake: false })
    expect(sanitizeRemote({ enabled: true, port: 9000, publicUrl: 'my-pc.tail1234.ts.net:8742/path', keepAwake: true })).toEqual({ enabled: true, port: 9000, publicUrl: 'http://my-pc.tail1234.ts.net:8742', keepAwake: true })
  })

  it('accepts addresses with or without a scheme', () => {
    expect(normalizePublicUrl('https://pc.example.com/')).toBe('https://pc.example.com')
    expect(normalizePublicUrl('192.168.1.20:8742')).toBe('http://192.168.1.20:8742')
    expect(normalizePublicUrl('ftp://x')).toBeNull()
    expect(normalizePublicUrl('')).toBeNull()
    expect(publicUrlProblem('')).toBeNull()
    expect(publicUrlProblem('http://')).toMatch(/not a web address/)
  })

  it('formats and reads pairing codes however they are typed', () => {
    expect(formatPairCode('K7QM4TXD')).toBe('K7QM-4TXD')
    expect(normalizePairCode('k7qm-4txd')).toBe('K7QM4TXD')
    expect(normalizePairCode(' K7QM 4TXD ')).toBe('K7QM4TXD')
    expect(normalizePairCode('K7QM4TX')).toBeNull()
    expect(normalizePairCode('K7QM4TX0')).toBeNull() // 0 is never in a code
    expect(normalizePairCode(42)).toBeNull()
    expect(pairCodeFromText('http://192.168.1.20:8742/#pair=K7QM4TXD')).toBe('K7QM4TXD')
    expect(pairCodeFromText('K7QM-4TXD')).toBe('K7QM4TXD')
    expect(pairCodeFromText('hello')).toBeNull()
  })

  it('names devices in a way people recognise', () => {
    expect(deviceNameFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari')
    expect(deviceNameFromUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36')).toBe('Android phone · Chrome')
    expect(deviceNameFromUserAgent('Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120.0 Safari/537.36')).toBe('Android tablet · Chrome')
    expect(deviceNameFromUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toBe('iPad · Safari')
    expect(deviceNameFromUserAgent(undefined)).toBe('Phone')
    expect(cleanDeviceName('  Corey\u0007’s   phone  ')).toBe('Corey’s phone')
    expect(cleanDeviceName('', 'Phone')).toBe('Phone')
    expect(cleanDeviceName('x'.repeat(100)).length).toBe(40)
  })
})

describe('pairing codes', () => {
  it('makes codes from the readable alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const c = randomPairCode()
      expect(c).toHaveLength(8)
      for (const ch of c) expect(PAIR_ALPHABET).toContain(ch)
    }
    // Bytes that would favour some symbols are skipped, not folded in.
    const stream = [...Array(40).fill(255), ...Array(16).fill(0)]
    let at = 0
    const code = randomPairCode((n) => new Uint8Array(Array.from({ length: n }, () => stream[at++ % stream.length])))
    expect(code).toBe('AAAAAAAA')
  })

  it('works once and then never again', () => {
    const book = new PairingBook()
    const { code } = book.create()
    expect(book.redeem(code, 'a')).toEqual({ ok: true })
    expect(book.redeem(code, 'a')).toMatchObject({ ok: false, reason: 'none' })
  })

  it('accepts the code as typed with a dash and any case', () => {
    const book = new PairingBook()
    const { code } = book.create()
    expect(book.redeem(`${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase(), 'a')).toEqual({ ok: true })
  })

  it('runs out after a few minutes', () => {
    let now = 1_000
    const book = new PairingBook({ now: () => now })
    const { code } = book.create()
    expect(book.active()?.code).toBe(code)
    now += PAIR_TTL_MS + 1
    expect(book.active()).toBeNull()
    expect(book.redeem(code, 'a')).toMatchObject({ ok: false, reason: 'none' })
  })

  it('a new offer replaces the old one', () => {
    const book = new PairingBook()
    const a = book.create().code
    const b = book.create().code
    expect(book.redeem(a, 'x').ok).toBe(false)
    expect(book.redeem(b, 'x')).toEqual({ ok: true })
  })

  it('pauses an address that keeps guessing, even when it then types the right code', () => {
    let now = 0
    const book = new PairingBook({ now: () => now })
    const { code } = book.create()
    for (let i = 0; i < 5; i++) expect(book.redeem('ABCDEFGH', 'bad')).toMatchObject({ ok: false, reason: 'invalid' })
    const locked = book.redeem(code, 'bad')
    expect(locked).toMatchObject({ ok: false, reason: 'locked' })
    // Somebody else on the network is not held back…
    expect(book.redeem(code, 'good')).toEqual({ ok: true })
    // …and the pause ends.
    const again = book.create().code
    now += 61_000
    expect(book.redeem(again, 'bad')).toEqual({ ok: true })
  })

  it('throws the code away after too many wrong guesses from anywhere', () => {
    const book = new PairingBook()
    const { code } = book.create()
    for (let i = 0; i < 15; i++) book.redeem('ABCDEFGH', `ip${i}`)
    expect(book.active()).toBeNull()
    expect(book.redeem(code, 'fresh')).toMatchObject({ ok: false })
  })
})

describe('paired devices', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-dev-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('signs a device in with its token, and only that token', async () => {
    const store = new DeviceStore(path.join(dir, 'd.json'))
    const { device, token } = store.add('My phone', '10.0.0.5')
    expect(device.scopes).toEqual({ images: true, tools: false })
    expect(store.authenticate(token, '10.0.0.5')?.id).toBe(device.id)
    expect(store.authenticate(`${token}x`)).toBeNull()
    expect(store.authenticate('')).toBeNull()
    expect(store.authenticate(undefined)).toBeNull()
  })

  it('stores only a hash of the token and survives a restart', async () => {
    const file = path.join(dir, 'd.json')
    const store = new DeviceStore(file)
    const { device, token } = store.add('Tablet', undefined, { images: false, tools: true })
    await store.save()
    expect(fs.readFileSync(file, 'utf8')).not.toContain(token)
    const again = new DeviceStore(file)
    await again.load()
    expect(again.authenticate(token)?.id).toBe(device.id)
    expect(again.list()[0]).toMatchObject({ name: 'Tablet', scopes: { images: false, tools: true } })
    expect(JSON.stringify(again.list())).not.toContain('tokenHash')
  })

  it('renames, changes what a device may do, and signs it out for good', async () => {
    const store = new DeviceStore(path.join(dir, 'd.json'))
    const { device, token } = store.add('Phone')
    expect(store.update(device.id, { name: '  Corey phone ', scopes: { tools: true } })).toMatchObject({ name: 'Corey phone', scopes: { images: true, tools: true } })
    expect(store.update('nope', { name: 'x' })).toBeNull()
    expect(store.remove(device.id)).toBe(true)
    expect(store.authenticate(token)).toBeNull()
    expect(store.remove(device.id)).toBe(false)
  })

  it('makes room by dropping the device that was quiet the longest', () => {
    let now = 1000
    const store = new DeviceStore(path.join(dir, 'd.json'), () => now)
    const first = store.add('first')
    for (let i = 0; i < MAX_DEVICES; i++) {
      now += 1000
      store.add(`d${i}`)
    }
    expect(store.list()).toHaveLength(MAX_DEVICES)
    expect(store.authenticate(first.token)).toBeNull()
  })

  it('tells the interface when the list changes', () => {
    const store = new DeviceStore(path.join(dir, 'd.json'))
    let n = 0
    store.onChange(() => n++)
    const { device } = store.add('p')
    store.update(device.id, { name: 'q' })
    store.remove(device.id)
    expect(n).toBe(3)
  })
})

describe('network addresses', () => {
  it('sorts addresses by what a phone can use', () => {
    expect(classifyAddress('192.168.1.20')).toBe('lan')
    expect(classifyAddress('100.101.102.103')).toBe('tailscale')
    expect(classifyAddress('100.20.0.1')).toBe('lan')
    expect(classifyAddress('169.254.3.4')).toBeNull()
    expect(classifyAddress('127.0.0.1')).toBeNull()
    expect(classifyAddress('fe80::1')).toBeNull()
  })

  it('lists your own address first, then Tailscale, then the home network, and skips virtual adapters', () => {
    const ifaces = {
      eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
      docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
      tailscale0: [{ address: '100.64.1.2', family: 'IPv4', internal: false }],
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      wlan0: [{ address: '10.0.0.7', family: 'IPv4', internal: false }]
    } as unknown as ReturnType<typeof os.networkInterfaces>
    const out = remoteAddresses(8742, 'https://pc.example.com', ifaces)
    expect(out.map((a) => a.url)).toEqual(['https://pc.example.com', 'http://100.64.1.2:8742', 'http://192.168.1.20:8742', 'http://10.0.0.7:8742'])
    expect(out.map((a) => a.kind)).toEqual(['custom', 'tailscale', 'lan', 'lan'])
    expect(remoteAddresses(8742, '', {} as ReturnType<typeof os.networkInterfaces>)).toEqual([])
  })
})

/* ───────────────────────────── what a phone may ask ───────────────────────────── */

const BASIC: RemoteScopes = { images: false, tools: false }
const FULL: RemoteScopes = { images: true, tools: true }

function fakeHandlers(calls: { channel: string; args: unknown[] }[]): Handlers {
  const record =
    (channel: string, result: unknown = null) =>
    (...args: unknown[]) => {
      calls.push({ channel, args })
      return result
    }
  return new Proxy({} as Handlers, {
    get: (_t, channel: string) => {
      if (channel === 'settings:get') return record(channel, { ...defaultSettings('/home/me/models'), paths: { modelsDir: '/home/me/models', extraModelDirs: [], hfEndpoint: '', hfToken: 'hf_secret', civitaiToken: 'civ_secret' }, providers: [{ id: 'p', apiKey: 'sk-secret' }], defaultModel: 'local::a' })
      if (channel === 'system:info') return record(channel, { platform: 'win32', arch: 'x64', appVersion: '1', dataDir: 'C:\\Users\\me\\AppData', modelsDir: 'C:\\models', home: 'C:\\Users\\me', isPackaged: true })
      return record(channel, { runId: 'r1' })
    }
  })
}

describe('what a paired phone may ask for', () => {
  it('chatting is always open, pictures and tools are not', () => {
    const base = allowedChannels(BASIC)
    expect(base.has('chat:send')).toBe(true)
    expect(base.has('conversations:list')).toBe(true)
    expect(base.has('images:generate')).toBe(false)
    expect(base.has('chat:approve')).toBe(false)
    expect(allowedChannels({ images: true, tools: false }).has('images:generate')).toBe(true)
    expect(allowedChannels({ images: false, tools: true }).has('chat:approve')).toBe(true)
  })

  it('never offers the computer itself: settings, files, models, engines, folders', () => {
    const all = allowedChannels(FULL)
    for (const c of ['settings:update', 'system:openPath', 'system:selectFile', 'system:showItem', 'system:openExternal', 'library:delete', 'llama:start', 'engines:install', 'downloads:start', 'tools:test', 'images:reveal', 'images:saveAs', 'images:openFolder', 'conversations:export', 'server:newKey', 'remote:pair', 'remote:removeDevice', 'remote:status', 'mcp:reconnect', 'providers:detect']) {
      expect(all.has(c as never), c).toBe(false)
    }
  })

  it('refuses unknown and forbidden requests with a reason', async () => {
    const calls: { channel: string; args: unknown[] }[] = []
    const h = fakeHandlers(calls)
    await expect(dispatchRemote(h, FULL, 'system:openPath', ['/etc'])).rejects.toMatchObject({ status: 404 })
    await expect(dispatchRemote(h, FULL, 42, [])).rejects.toBeInstanceOf(RemoteError)
    await expect(dispatchRemote(h, BASIC, 'images:list', [])).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/Pictures/) })
    await expect(dispatchRemote(h, BASIC, 'chat:approve', ['a', 'allow'])).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/Tools/) })
    expect(calls).toHaveLength(0)
  })

  it('stops a chat from reaching other files through a made-up id', async () => {
    const calls: { channel: string; args: unknown[] }[] = []
    const h = fakeHandlers(calls)
    for (const bad of ['../../secret', 'a/b', 'a\\b', '', 'x'.repeat(200), 7, null]) {
      await expect(dispatchRemote(h, FULL, 'conversations:delete', [bad]), String(bad)).rejects.toBeInstanceOf(RemoteError)
      await expect(dispatchRemote(h, FULL, 'images:delete', [[bad]]), String(bad)).rejects.toBeInstanceOf(RemoteError)
    }
    expect(calls).toHaveLength(0)
    await dispatchRemote(h, FULL, 'conversations:delete', ['c_ab12-xyz'])
    expect(calls).toEqual([{ channel: 'conversations:delete', args: ['c_ab12-xyz'] }])
  })

  it('runs a phone chat without tools unless the phone may use them', async () => {
    const calls: { channel: string; args: unknown[] }[] = []
    const h = fakeHandlers(calls)
    await dispatchRemote(h, BASIC, 'chat:send', [{ conversationId: 'c_1', text: 'hi', noTools: false, mode: 'chat' }])
    await dispatchRemote(h, BASIC, 'chat:regenerate', ['c_1'])
    await dispatchRemote(h, FULL, 'chat:send', [{ conversationId: 'c_1', text: 'hi', noTools: true }])
    await dispatchRemote(h, FULL, 'chat:regenerate', ['c_1'])
    expect(calls[0].args[0]).toMatchObject({ noTools: true })
    expect(calls[1].args).toEqual(['c_1', { noTools: true }])
    expect(calls[2].args[0]).toMatchObject({ noTools: false })
    expect(calls[3].args).toEqual(['c_1', { noTools: false }])
  })

  it('checks messages and attachments before they reach the chat', async () => {
    const calls: { channel: string; args: unknown[] }[] = []
    const h = fakeHandlers(calls)
    const file = { name: 'a.png', mime: 'image/png', data: fakePng(4, 4) }
    await dispatchRemote(h, BASIC, 'chat:send', [{ conversationId: 'c_1', text: '', attachments: [file] }])
    expect((calls[0].args[0] as { attachments: unknown[] }).attachments).toHaveLength(1)
    await expect(dispatchRemote(h, BASIC, 'chat:send', [{ conversationId: 'c_1', text: 'x', attachments: [{ name: 'a', mime: 'b', data: 'not bytes' }] }])).rejects.toBeInstanceOf(RemoteError)
    await expect(dispatchRemote(h, BASIC, 'chat:send', [{ conversationId: 'c_1', text: 'x', attachments: Array(13).fill(file) }])).rejects.toMatchObject({ message: expect.stringMatching(/Too many/) })
    await expect(dispatchRemote(h, BASIC, 'chat:send', [{ conversationId: 'c_1', text: 5 }])).rejects.toBeInstanceOf(RemoteError)
    await expect(dispatchRemote(h, BASIC, 'chat:send', [{ conversationId: 'c_1', text: 'x', mode: 'image' }])).rejects.toMatchObject({ status: 403 })
    await dispatchRemote(h, FULL, 'chat:send', [{ conversationId: 'c_1', text: 'draw', mode: 'image' }])
    expect(calls).toHaveLength(2)
  })

  it('keeps the folder and tool switch of a chat out of reach without tool access', async () => {
    const calls: { channel: string; args: unknown[] }[] = []
    const h = fakeHandlers(calls)
    await dispatchRemote(h, BASIC, 'conversations:update', ['c_1', { title: 'T', workspace: '/home/me', toolsEnabled: true, pinned: true, evil: 1 }])
    await dispatchRemote(h, FULL, 'conversations:update', ['c_1', { title: 'T', workspace: '/home/me', toolsEnabled: true, evil: 1 }])
    await dispatchRemote(h, BASIC, 'conversations:create', [{ workspace: '/x' }])
    await dispatchRemote(h, FULL, 'conversations:create', [{ toolsEnabled: true }])
    expect(calls[0].args[1]).toEqual({ title: 'T', pinned: true })
    expect(calls[1].args[1]).toEqual({ title: 'T', workspace: '/home/me', toolsEnabled: true })
    expect(calls[2].args[0]).toEqual({ toolsEnabled: false })
    expect(calls[3].args[0]).toEqual({ toolsEnabled: true })
  })

  it('files pictures asked for from a phone under the Image Hub', async () => {
    const calls: { channel: string; args: unknown[] }[] = []
    const h = fakeHandlers(calls)
    const req = { prompt: 'a lighthouse', width: 512, height: 512, seed: -1, count: 1, source: 'chat', conversationId: 'c_1' }
    await dispatchRemote(h, { images: true, tools: false }, 'images:generate', [req])
    expect(calls[0].args[0]).toMatchObject({ prompt: 'a lighthouse', source: 'hub', conversationId: undefined })
    await expect(dispatchRemote(h, { images: true, tools: false }, 'images:generate', [{ ...req, initImageId: '../x' }])).rejects.toBeInstanceOf(RemoteError)
  })

  it('hides keys, tokens and folders from the settings and system info a phone sees', async () => {
    const h = fakeHandlers([])
    const settings = (await dispatchRemote(h, BASIC, 'settings:get', [])) as ReturnType<typeof defaultSettings>
    const text = JSON.stringify(settings)
    expect(text).not.toContain('sk-secret')
    expect(text).not.toContain('hf_secret')
    expect(text).not.toContain('civ_secret')
    expect(text).not.toContain('/home/me')
    expect(settings.defaultModel).toBe('local::a')
    expect(settings.providers.every((p) => !p.apiKey)).toBe(true)
    const info = (await dispatchRemote(h, BASIC, 'system:info', [])) as { dataDir: string; home: string; modelsDir: string; appVersion: string }
    expect(info).toMatchObject({ dataDir: '', home: '', modelsDir: '', appVersion: '1' })
    expect(remoteSystemInfo({ platform: 'linux', arch: 'x', appVersion: '2', dataDir: '/d', modelsDir: '/m', home: '/h', isPackaged: false }).home).toBe('')
    expect(remoteSettingsView(defaultSettings('/m')).paths.modelsDir).toBe('')
  })

  it('sends a phone only the events it may see', () => {
    const approval = { type: 'approval', runId: 'r', conversationId: 'c', approval: {} } as IpcEventMap['chat:event']
    const message = { type: 'run-start', runId: 'r', conversationId: 'c' } as IpcEventMap['chat:event']
    expect(eventAllowed('chat:event', message, BASIC)).toBe(true)
    expect(eventAllowed('chat:event', approval, BASIC)).toBe(false)
    expect(eventAllowed('chat:event', approval, FULL)).toBe(true)
    expect(eventAllowed('conversations:removed', 'c', BASIC)).toBe(true)
    expect(eventAllowed('images:added', {} as IpcEventMap['images:added'], BASIC)).toBe(false)
    expect(eventAllowed('images:added', {} as IpcEventMap['images:added'], { images: true, tools: false })).toBe(true)
    expect(eventAllowed('settings:changed', {} as IpcEventMap['settings:changed'], FULL)).toBe(false)
    expect(eventAllowed('llama:status', {} as IpcEventMap['llama:status'], FULL)).toBe(false)
    expect(eventAllowed('remote:status', {} as IpcEventMap['remote:status'], FULL)).toBe(false)
  })
})

/* ───────────────────────────── the web server ───────────────────────────── */

describe('companion server', () => {
  let dir: string
  let port: number
  let base: string
  let server: RemoteServer
  let devices: DeviceStore
  let pairing: PairingBook
  let calls: { channel: string; args: unknown[] }[]
  let sinks: Set<(c: string, p: unknown) => void>
  let paired: RemoteDevice[]

  const emitEvent = (c: string, p: unknown) => sinks.forEach((s) => s(c, p))

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-remote-'))
    for (const d of ['client/assets', 'images', 'thumbs', 'attachments']) fs.mkdirSync(path.join(dir, d), { recursive: true })
    fs.writeFileSync(path.join(dir, 'client/index.html'), '<!doctype html><title>Cairn Remote</title>')
    fs.writeFileSync(path.join(dir, 'client/assets/app.js'), 'console.log(1)')
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'nope')
    fs.writeFileSync(path.join(dir, 'images/pic.png'), fakePng(8, 8, 1))
    fs.writeFileSync(path.join(dir, 'thumbs/pic.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    fs.writeFileSync(path.join(dir, 'attachments/att.png'), fakePng(8, 8, 2))
    devices = new DeviceStore(path.join(dir, 'devices.json'))
    pairing = new PairingBook()
    calls = []
    sinks = new Set()
    paired = []
    server = new RemoteServer({
      handlers: () => fakeHandlers(calls),
      devices,
      pairing,
      paths: { images: path.join(dir, 'images'), thumbs: path.join(dir, 'thumbs'), attachments: path.join(dir, 'attachments') },
      clientDir: path.join(dir, 'client'),
      events: (l) => {
        sinks.add(l as (c: string, p: unknown) => void)
        return () => sinks.delete(l as (c: string, p: unknown) => void)
      },
      appVersion: '9.9.9',
      onPaired: (d) => paired.push(d)
    })
    port = await freePort()
    await server.listen(port)
    base = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await server.close()
    await devices.save()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Pairs a fresh browser and returns the cookie it would keep. */
  async function pairBrowser(name = 'Test phone'): Promise<string> {
    const { code } = pairing.create()
    const res = await fetch(`${base}/remote/pair`, { method: 'POST', body: JSON.stringify({ code, name }) })
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`${COOKIE}=`)
    return cookie.split(';')[0]
  }

  const rpc = async (cookie: string | null, channel: string, args: unknown[] = []) => {
    const res = await fetch(`${base}/remote/rpc`, { method: 'POST', headers: cookie ? { cookie } : {}, body: encodeJson({ channel, args }) })
    return { status: res.status, body: decodeJson<{ ok?: boolean; result?: unknown; error?: string; status?: number }>(await res.text()) }
  }

  it('serves the web app to anyone, and nothing outside its folder', async () => {
    const home = await fetch(`${base}/`)
    expect(home.status).toBe(200)
    expect(await home.text()).toContain('Cairn Remote')
    expect(home.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect((await fetch(`${base}/chats/some-page`)).status).toBe(200)
    const asset = await fetch(`${base}/assets/app.js`)
    expect(asset.headers.get('content-type')).toContain('javascript')
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404)
    expect((await fetch(`${base}/..%2fsecret.txt`)).status).not.toBe(200)
    expect((await fetch(`${base}/%2e%2e/secret.txt`)).status).not.toBe(200)
    expect((await fetch(`${base}/remote/ping`)).status).toBe(200)
  })

  it('explains itself when the web app has not been built', async () => {
    fs.rmSync(path.join(dir, 'client'), { recursive: true })
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('not built')
  })

  it('refuses everything private until a device is paired', async () => {
    expect((await fetch(`${base}/remote/session`)).status).toBe(401)
    expect((await rpc(null, 'chat:active')).status).toBe(401)
    expect((await fetch(`${base}/remote/events`)).status).toBe(401)
    expect((await fetch(`${base}/remote/media/image/pic.png`)).status).toBe(401)
    expect((await rpc('cairn_remote=forged', 'chat:active')).status).toBe(401)
  })

  it('pairs with the code, once, and signs the browser in', async () => {
    const { code } = pairing.create()
    const res = await fetch(`${base}/remote/pair`, { method: 'POST', headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' }, body: JSON.stringify({ code }) })
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Lax/)
    const body = await res.json()
    expect(body.device.name).toBe('iPhone · Safari')
    expect(body.host.version).toBe('9.9.9')
    expect(JSON.stringify(body)).not.toContain('tokenHash')
    expect(paired).toHaveLength(1)

    const again = await fetch(`${base}/remote/pair`, { method: 'POST', body: JSON.stringify({ code }) })
    expect(again.status).toBe(401)

    const session = await fetch(`${base}/remote/session`, { headers: { cookie: cookie.split(';')[0] } })
    expect(session.status).toBe(200)
    expect((await session.json()).device.id).toBe(body.device.id)
  })

  it('answers a wrong code kindly and locks out a guesser', async () => {
    pairing.create()
    const wrong = await fetch(`${base}/remote/pair`, { method: 'POST', body: JSON.stringify({ code: 'ABCD-EFGH' }) })
    expect(wrong.status).toBe(401)
    expect((await wrong.json()).error).toMatch(/not right/)
    let last = wrong
    for (let i = 0; i < 6; i++) last = await fetch(`${base}/remote/pair`, { method: 'POST', body: JSON.stringify({ code: 'ABCD-EFGH' }) })
    expect(last.status).toBe(429)
    expect(last.headers.get('retry-after')).toBeTruthy()
    expect(devices.list()).toHaveLength(0)
  })

  it('tells a person when the code has expired or was never shown', async () => {
    const res = await fetch(`${base}/remote/pair`, { method: 'POST', body: JSON.stringify({ code: 'ABCD-EFGH' }) })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/expired/)
  })

  it('refuses requests that another website makes with the cookie', async () => {
    const cookie = await pairBrowser()
    const res = await fetch(`${base}/remote/rpc`, { method: 'POST', headers: { cookie, origin: 'https://evil.example' }, body: encodeJson({ channel: 'chat:active', args: [] }) })
    expect(res.status).toBe(403)
    const ok = await fetch(`${base}/remote/rpc`, { method: 'POST', headers: { cookie, origin: base }, body: encodeJson({ channel: 'chat:active', args: [] }) })
    expect(ok.status).toBe(200)
  })

  it('runs allowed requests and carries pictures as bytes', async () => {
    const cookie = await pairBrowser()
    const listed = await rpc(cookie, 'conversations:list')
    expect(listed.body).toMatchObject({ ok: true })
    const sent = await rpc(cookie, 'chat:send', [{ conversationId: 'c_1', text: 'hello', attachments: [{ name: 'a.png', mime: 'image/png', data: new Uint8Array([1, 2, 3]) }] }])
    expect(sent.body).toMatchObject({ ok: true, result: { runId: 'r1' } })
    const call = calls.find((c) => c.channel === 'chat:send')!
    const att = (call.args[0] as { attachments: { data: Uint8Array }[]; noTools: boolean }).attachments[0]
    expect(att.data).toBeInstanceOf(Uint8Array)
    expect([...att.data]).toEqual([1, 2, 3])
    expect((call.args[0] as { noTools: boolean }).noTools).toBe(true)
  })

  it('reports why a request was not allowed, and changes with the device settings', async () => {
    const cookie = await pairBrowser()
    expect((await rpc(cookie, 'system:openPath', ['/'])).body).toMatchObject({ ok: false, status: 404 })
    expect((await rpc(cookie, 'settings:update', [{}])).body).toMatchObject({ ok: false })
    const id = devices.list()[0].id
    expect((await rpc(cookie, 'images:list')).body).toMatchObject({ ok: true })
    devices.update(id, { scopes: { images: false } })
    expect((await rpc(cookie, 'images:list')).body).toMatchObject({ ok: false, status: 403 })
    expect(calls.filter((c) => c.channel === 'images:list')).toHaveLength(1)
  })

  it('serves pictures to devices that may see them', async () => {
    const cookie = await pairBrowser()
    const img = await fetch(`${base}/remote/media/image/pic.png`, { headers: { cookie } })
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await img.arrayBuffer()).equals(Buffer.from(fakePng(8, 8, 1)))).toBe(true)
    expect((await fetch(`${base}/remote/media/thumb/pic.png`, { headers: { cookie } })).status).toBe(200)
    expect((await fetch(`${base}/remote/media/attachment/att.png`, { headers: { cookie } })).status).toBe(200)
    expect((await fetch(`${base}/remote/media/image/..%2Fsecret.txt`, { headers: { cookie } })).status).toBe(404)
    expect((await fetch(`${base}/remote/media/image/index.json`, { headers: { cookie } })).status).toBe(404)
    expect((await fetch(`${base}/remote/media/other/pic.png`, { headers: { cookie } })).status).toBe(404)
    devices.update(devices.list()[0].id, { scopes: { images: false } })
    expect((await fetch(`${base}/remote/media/image/pic.png`, { headers: { cookie } })).status).toBe(403)
    expect((await fetch(`${base}/remote/media/attachment/att.png`, { headers: { cookie } })).status).toBe(200)
  })

  it('streams live updates and filters them by what the device may see', async () => {
    const cookie = await pairBrowser()
    devices.update(devices.list()[0].id, { scopes: { images: false } })
    const ctrl = new AbortController()
    const res = await fetch(`${base}/remote/events`, { headers: { cookie }, signal: ctrl.signal })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let text = ''
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          text += dec.decode(value)
        }
      } catch {
        /* aborted */
      }
    })()
    await until(() => text.includes('"hello"'))
    expect(server.isOnline(devices.list()[0].id)).toBe(true)

    emitEvent('chat:event', { type: 'delta', runId: 'r', conversationId: 'c', messageId: 'm', content: 'Hi' })
    emitEvent('images:added', { id: 'i' })
    emitEvent('settings:changed', { secret: true })
    emitEvent('chat:event', { type: 'approval', runId: 'r', conversationId: 'c', approval: {} })
    emitEvent('conversations:removed', 'c_9')
    await until(() => text.includes('c_9'))
    expect(text).toContain('"Hi"')
    expect(text).not.toContain('images:added')
    expect(text).not.toContain('settings:changed')
    expect(text).not.toContain('approval')

    devices.update(devices.list()[0].id, { scopes: { images: true, tools: true } })
    emitEvent('images:added', { id: 'i2' })
    await until(() => text.includes('images:added'))
    ctrl.abort()
    await pump
    await until(() => !server.isOnline(devices.list()[0].id))
  })

  it('cuts a device off the moment it is signed out', async () => {
    const cookie = await pairBrowser()
    const id = devices.list()[0].id
    const res = await fetch(`${base}/remote/events`, { headers: { cookie } })
    const reader = res.body!.getReader()
    await reader.read()
    devices.remove(id)
    server.disconnect(id)
    const end = await Promise.race([
      (async () => {
        for (;;) {
          const { done } = await reader.read()
          if (done) return 'closed'
        }
      })(),
      sleep(2000).then(() => 'open')
    ])
    expect(end).toBe('closed')
    expect((await fetch(`${base}/remote/session`, { headers: { cookie } })).status).toBe(401)
  })

  it('lets a phone sign itself out', async () => {
    const cookie = await pairBrowser()
    const res = await fetch(`${base}/remote/logout`, { method: 'POST', headers: { cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(devices.list()).toHaveLength(0)
    expect((await fetch(`${base}/remote/session`, { headers: { cookie } })).status).toBe(401)
  })

  it('stops listening when closed and can start again', async () => {
    await server.close()
    await expect(fetch(`${base}/remote/ping`)).rejects.toBeTruthy()
    await server.listen(port)
    expect((await fetch(`${base}/remote/ping`)).status).toBe(200)
  })

  it('says so when the port is taken', async () => {
    const other = new RemoteServer({ handlers: () => null, devices, pairing, paths: { images: dir, thumbs: dir, attachments: dir }, clientDir: dir, events: () => () => {}, appVersion: '1' })
    await expect(other.listen(port)).rejects.toThrow(/already in use/)
  })
})
