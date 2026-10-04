import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '../src/shared/defaults'
import type { IpcEventMap } from '../src/shared/ipc'
import { freePort } from '../src/main/engines/llama-server'
import type { Handlers } from '../src/main/ipc'
import { DeviceStore } from '../src/main/remote/devices'
import { PairingBook } from '../src/main/remote/pairing'
import { RemoteServer } from '../src/main/remote/server'
import { applyPrefs, cleanPrefs, prefsFromPatch } from '../src/remote/src/lib/prefs'
import { CallError, RemoteTransport } from '../src/remote/src/lib/transport'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('Timed out waiting for a condition')
    await sleep(10)
  }
}

/** A browser's cookie jar, for the one site under test. */
function jarFetch(): { fetch: typeof fetch; clear(): void } {
  let cookie = ''
  return {
    clear: () => (cookie = ''),
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers)
      if (cookie) headers.set('cookie', cookie)
      const res = await fetch(input, { ...init, headers })
      const set = res.headers.get('set-cookie')
      if (set) cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0]
      return res
    }
  }
}

describe('phone transport against the real server', () => {
  let dir: string
  let port: number
  let server: RemoteServer
  let devices: DeviceStore
  let pairing: PairingBook
  let sinks: Set<(c: string, p: unknown) => void>
  let calls: { channel: string; args: unknown[] }[]
  let transport: RemoteTransport | null
  let jar: ReturnType<typeof jarFetch>

  const handlers = (): Handlers =>
    new Proxy({} as Handlers, {
      get: (_t, channel: string) => (...args: unknown[]) => {
        calls.push({ channel, args })
        if (channel === 'conversations:list') return [{ id: 'c_1', title: 'Hello', createdAt: 1, updatedAt: 2, messageCount: 0, preview: '' }]
        if (channel === 'images:toAttachment') return { name: 'a.png', mime: 'image/png', data: new Uint8Array([1, 2, 3, 250]) }
        if (channel === 'chat:enhance') throw new Error('No model is loaded.')
        return null
      }
    })

  const make = (o: ConstructorParameters<typeof RemoteTransport>[0] = {}) => {
    transport = new RemoteTransport({ base: `http://127.0.0.1:${port}`, fetch: jar.fetch, ...o })
    return transport
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-rc-'))
    fs.mkdirSync(path.join(dir, 'client'))
    devices = new DeviceStore(path.join(dir, 'd.json'))
    pairing = new PairingBook()
    sinks = new Set()
    calls = []
    transport = null
    jar = jarFetch()
    server = new RemoteServer({
      handlers,
      devices,
      pairing,
      paths: { images: dir, thumbs: dir, attachments: dir },
      clientDir: path.join(dir, 'client'),
      events: (l) => {
        sinks.add(l as (c: string, p: unknown) => void)
        return () => sinks.delete(l as (c: string, p: unknown) => void)
      },
      appVersion: '3.1.4'
    })
    port = await freePort()
    await server.listen(port)
  })

  afterEach(async () => {
    transport?.disconnect()
    await server.close()
    await devices.save()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is not signed in until it pairs', async () => {
    const t = make()
    expect(await t.session()).toBeNull()
    const wrong = await t.pair('ABCD-EFGH', 'Phone')
    expect(wrong).toMatchObject({ ok: false, code: 'none' })
    pairing.create()
    expect(await t.pair('ABCD-EFGH')).toMatchObject({ ok: false, code: 'invalid', error: expect.stringMatching(/not right/) })
  })

  it('pairs with the code and then knows who it is', async () => {
    const t = make()
    const { code } = pairing.create()
    const r = await t.pair(code, 'Corey’s phone')
    expect(r).toMatchObject({ ok: true, session: { device: { name: 'Corey’s phone', scopes: { images: true, tools: false } }, host: { version: '3.1.4' } } })
    expect(await t.session()).toMatchObject({ device: { name: 'Corey’s phone' } })
  })

  it('reports an unreachable computer in words', async () => {
    const t = new RemoteTransport({ base: 'http://127.0.0.1:1', fetch: jar.fetch })
    await expect(t.session()).rejects.toThrow(/Can't reach your computer/)
    expect(await t.pair('ABCD-EFGH')).toMatchObject({ ok: false, code: 'network' })
  })

  it('runs requests, brings bytes back as bytes and turns refusals into readable errors', async () => {
    const t = make()
    await t.pair(pairing.create().code)
    expect(await t.invoke('conversations:list', [])).toEqual([{ id: 'c_1', title: 'Hello', createdAt: 1, updatedAt: 2, messageCount: 0, preview: '' }])
    const att = (await t.invoke('images:toAttachment', ['img_1'])) as { data: Uint8Array }
    expect(att.data).toBeInstanceOf(Uint8Array)
    expect([...att.data]).toEqual([1, 2, 3, 250])
    await expect(t.invoke('chat:enhance', ['x'])).rejects.toMatchObject({ message: 'No model is loaded.' })
    await expect(t.invoke('system:openPath', ['/'])).rejects.toMatchObject({ status: 404 })
    await expect(t.invoke('conversations:delete', ['../x'])).rejects.toBeInstanceOf(CallError)
  })

  it('learns that it was signed out', async () => {
    let lost = 0
    const t = make({ onAuthLost: () => lost++ })
    await t.pair(pairing.create().code)
    devices.remove(devices.list()[0].id)
    await expect(t.invoke('chat:active', [])).rejects.toMatchObject({ status: 401 })
    expect(lost).toBe(1)
  })

  it('receives live updates, in order', async () => {
    const got: string[] = []
    let live = 0
    const t = make({ onEvent: (c, p) => got.push(`${c}:${JSON.stringify(p)}`), onLive: () => live++ })
    await t.pair(pairing.create().code)
    t.connect()
    await until(() => live === 1)
    expect(t.live).toBe(true)
    sinks.forEach((s) => s('chat:event', { type: 'delta', runId: 'r', conversationId: 'c', messageId: 'm', content: 'a' } satisfies IpcEventMap['chat:event']))
    sinks.forEach((s) => s('chat:event', { type: 'delta', runId: 'r', conversationId: 'c', messageId: 'm', content: 'b' } satisfies IpcEventMap['chat:event']))
    sinks.forEach((s) => s('conversations:removed', 'c_7'))
    await until(() => got.length === 3)
    expect(got[0]).toContain('"content":"a"')
    expect(got[1]).toContain('"content":"b"')
    expect(got[2]).toBe('conversations:removed:"c_7"')
  })

  it('reconnects by itself after the computer restarts, and says it is a return', async () => {
    const live: boolean[] = []
    let offline = 0
    const t = make({ onLive: (again) => live.push(again), onOffline: () => offline++ })
    await t.pair(pairing.create().code)
    t.connect()
    await until(() => live.length === 1)
    await server.close()
    await until(() => !t.live)
    expect(offline).toBeGreaterThan(0)
    await server.listen(port)
    t.nudge()
    await until(() => live.length === 2, 8000)
    expect(live).toEqual([false, true])
  })

  it('gives up for good when the device was signed out while away', async () => {
    let lost = 0
    const t = make({ onAuthLost: () => lost++ })
    await t.pair(pairing.create().code)
    t.connect()
    await until(() => t.live)
    const id = devices.list()[0].id
    devices.remove(id)
    server.disconnect(id)
    await until(() => lost === 1, 8000)
    expect(t.live).toBe(false)
  })

  it('does not hang on a stream that has gone quiet', async () => {
    const live: boolean[] = []
    const t = make({ silenceMs: 200, onLive: (again) => live.push(again) })
    await t.pair(pairing.create().code)
    t.connect()
    await until(() => live.length >= 2, 8000)
    expect(live[1]).toBe(true)
  })

  it('signs out on request', async () => {
    const t = make()
    await t.pair(pairing.create().code)
    await t.logout()
    expect(devices.list()).toHaveLength(0)
    expect(await t.session()).toBeNull()
  })
})

describe('what a phone keeps for itself', () => {
  it('lays its own choices over the computer’s settings', () => {
    const host = defaultSettings('/m')
    const merged = applyPrefs(host, { theme: 'glacier', fontScale: 1.2, sendOnEnter: !host.chat.sendOnEnter })
    expect(merged.appearance.theme).toBe('glacier')
    expect(merged.appearance.fontScale).toBe(1.2)
    expect(merged.chat.sendOnEnter).toBe(!host.chat.sendOnEnter)
    expect(merged.chat.temperature).toBe(host.chat.temperature)
    expect(applyPrefs(host, {})).toEqual(host)
  })

  it('takes only the phone’s own choices from a settings change', () => {
    const next = prefsFromPatch({ appearance: { theme: 'granite', fontScale: 1.1, ridgelines: true, reduceMotion: true }, chat: { sendOnEnter: false } as never, server: { enabled: true } as never, defaultModel: 'x' }, {})
    expect(next).toEqual({ theme: 'granite', fontScale: 1.1, reduceMotion: true, sendOnEnter: false })
    expect(prefsFromPatch({ appearance: { theme: 'glacier' } as never }, next)).toMatchObject({ theme: 'glacier', fontScale: 1.1 })
  })

  it('ignores junk read back from storage', () => {
    expect(cleanPrefs({ theme: 'neon', fontScale: 9, reduceMotion: 'yes', sendOnEnter: true })).toEqual({ sendOnEnter: true })
    expect(cleanPrefs(null)).toEqual({})
    expect(cleanPrefs('x')).toEqual({})
  })
})
