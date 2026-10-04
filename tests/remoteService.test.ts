import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RemoteSettings, RemoteStatus } from '../src/shared/types'
import { normalizePairCode } from '../src/shared/remotePrefs'
import { freePort } from '../src/main/engines/llama-server'
import { RemoteService } from '../src/main/remote/service'

describe('companion service', () => {
  let dir: string
  let settings: RemoteSettings
  let svc: RemoteService
  let published: RemoteStatus[]
  let awake: { started: number; stopped: number[] }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-rsvc-'))
    fs.mkdirSync(path.join(dir, 'client'))
    fs.writeFileSync(path.join(dir, 'client/index.html'), '<title>x</title>')
    settings = { enabled: false, port: await freePort(), publicUrl: 'https://my-pc.example.com', keepAwake: false }
    published = []
    awake = { started: 0, stopped: [] }
    svc = new RemoteService({
      paths: { data: dir, images: path.join(dir, 'images'), thumbs: path.join(dir, 'thumbs'), attachments: path.join(dir, 'attachments') },
      getSettings: () => settings,
      clientDir: path.join(dir, 'client'),
      appVersion: '1.2.3',
      keepAwake: { start: () => ++awake.started, stop: (id) => awake.stopped.push(id) },
      publish: (s) => published.push(s)
    })
  })

  afterEach(async () => {
    await svc.shutdown()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('stays off until it is turned on, and refuses to pair while off', async () => {
    await svc.apply()
    expect(svc.status()).toMatchObject({ state: 'stopped', addresses: [], devices: [], awake: false, missingClient: false })
    expect(() => svc.pair()).toThrow(/Turn on the companion/)
  })

  it('starts, offers a code with a link per address, and stops again', async () => {
    settings.enabled = true
    await svc.apply()
    const st = svc.status()
    expect(st.state).toBe('running')
    expect(st.port).toBe(settings.port)
    expect(st.addresses[0]).toMatchObject({ kind: 'custom', url: 'https://my-pc.example.com' })
    const offer = svc.pair()
    expect(offer.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(offer.links[0].url).toBe(`https://my-pc.example.com/#pair=${normalizePairCode(offer.code)}`)
    expect(offer.expiresAt).toBeGreaterThan(Date.now())
    expect((await fetch(`http://127.0.0.1:${settings.port}/remote/ping`)).status).toBe(200)

    settings.enabled = false
    await svc.apply()
    expect(svc.status().state).toBe('stopped')
    await expect(fetch(`http://127.0.0.1:${settings.port}/remote/ping`)).rejects.toBeTruthy()
    // A code from before the switch-off does not survive it.
    expect(svc.pairing.active()).toBeNull()
  })

  it('moves to another port when the setting changes', async () => {
    settings.enabled = true
    await svc.apply()
    const first = settings.port
    settings.port = await freePort()
    await svc.apply()
    expect(svc.status().port).toBe(settings.port)
    await expect(fetch(`http://127.0.0.1:${first}/remote/ping`)).rejects.toBeTruthy()
    expect((await fetch(`http://127.0.0.1:${settings.port}/remote/ping`)).status).toBe(200)
  })

  it('shows a readable problem when the port is taken', async () => {
    settings.enabled = true
    await svc.apply()
    const other = new RemoteService({ paths: { data: path.join(dir, 'other'), images: dir, thumbs: dir, attachments: dir }, getSettings: () => settings, clientDir: dir, appVersion: '1' })
    fs.mkdirSync(path.join(dir, 'other'))
    await other.apply()
    expect(other.status()).toMatchObject({ state: 'error', error: expect.stringMatching(/already in use/) })
    await other.shutdown()
  })

  it('keeps the computer awake only while it is running and the person asked for that', async () => {
    settings.enabled = true
    settings.keepAwake = true
    await svc.apply()
    expect(awake.started).toBe(1)
    expect(svc.status().awake).toBe(true)
    await svc.apply()
    expect(awake.started).toBe(1)
    settings.keepAwake = false
    await svc.apply()
    expect(awake.stopped).toEqual([1])
    expect(svc.status().awake).toBe(false)
    settings.keepAwake = true
    await svc.apply()
    settings.enabled = false
    await svc.apply()
    expect(awake.stopped).toHaveLength(2)
  })

  it('lists paired devices and signs them out', async () => {
    settings.enabled = true
    await svc.apply()
    const offer = svc.pair()
    const res = await fetch(`http://127.0.0.1:${settings.port}/remote/pair`, { method: 'POST', body: JSON.stringify({ code: offer.code, name: 'Phone A' }) })
    expect(res.status).toBe(200)
    const st = svc.status()
    expect(st.devices).toHaveLength(1)
    expect(st.devices[0]).toMatchObject({ name: 'Phone A', online: false, scopes: { images: true, tools: false } })
    expect(svc.updateDevice(st.devices[0].id, { scopes: { tools: true } })?.scopes.tools).toBe(true)
    svc.removeDevice(st.devices[0].id)
    expect(svc.status().devices).toHaveLength(0)
    expect(published.length).toBeGreaterThan(0)
  })

  it('remembers paired devices across restarts', async () => {
    settings.enabled = true
    await svc.apply()
    const offer = svc.pair()
    const res = await fetch(`http://127.0.0.1:${settings.port}/remote/pair`, { method: 'POST', body: JSON.stringify({ code: offer.code }) })
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
    await svc.shutdown()

    const again = new RemoteService({
      paths: { data: dir, images: path.join(dir, 'images'), thumbs: path.join(dir, 'thumbs'), attachments: path.join(dir, 'attachments') },
      getSettings: () => settings,
      clientDir: path.join(dir, 'client'),
      appVersion: '1'
    })
    await again.apply()
    expect((await fetch(`http://127.0.0.1:${settings.port}/remote/session`, { headers: { cookie } })).status).toBe(200)
    await again.shutdown()
  })

  it('notices a missing web app', async () => {
    fs.rmSync(path.join(dir, 'client/index.html'))
    expect(svc.status().missingClient).toBe(true)
  })
})
