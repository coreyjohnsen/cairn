import path from 'node:path'
import type { RemoteDevice, RemotePairing, RemoteScopes, RemoteSettings, RemoteStatus, RemoteState } from '@shared/types'
import { formatPairCode } from '@shared/remotePrefs'
import type { EventChannel, IpcEventMap } from '@shared/ipc'
import fs from 'node:fs'
import { addEventSink, emit } from '../events'
import type { Handlers } from '../ipc'
import type { AppPaths } from '../paths'
import { DeviceStore } from './devices'
import { remoteAddresses } from './net'
import { PairingBook } from './pairing'
import { RemoteServer } from './server'

/** Keeps the computer from sleeping (Electron's powerSaveBlocker in the app). */
export interface KeepAwake {
  start(): number
  stop(id: number): void
}

export interface RemoteServiceDeps {
  paths: Pick<AppPaths, 'data' | 'images' | 'thumbs' | 'attachments'>
  getSettings: () => RemoteSettings
  /** Folder with the built companion web app. */
  clientDir: string
  appVersion: string
  keepAwake?: KeepAwake
  /** Used by tests to see events without a window. */
  publish?: (status: RemoteStatus) => void
  now?: () => number
}

/** Runs the companion: the web server, the paired devices and the pairing codes, kept in line with the settings. */
export class RemoteService {
  readonly devices: DeviceStore
  readonly pairing: PairingBook
  private server: RemoteServer
  private handlers: Handlers | null = null
  private state: RemoteState = 'stopped'
  private error: string | undefined
  private chain: Promise<void> = Promise.resolve()
  private awakeId: number | null = null
  private emitTimer: NodeJS.Timeout | null = null
  private loaded = false

  constructor(private d: RemoteServiceDeps) {
    this.devices = new DeviceStore(path.join(d.paths.data, 'remote-devices.json'), d.now)
    this.pairing = new PairingBook({ now: d.now })
    this.server = new RemoteServer({
      handlers: () => this.handlers,
      devices: this.devices,
      pairing: this.pairing,
      paths: d.paths,
      clientDir: d.clientDir,
      appVersion: d.appVersion,
      events: (listener) => addEventSink(listener as <K extends EventChannel>(c: K, p: IpcEventMap[K]) => void),
      onPaired: (device) => {
        emit('remote:paired', device)
        this.publish(true)
      },
      onPresence: () => this.publish()
    })
    this.devices.onChange(() => this.publish())
  }

  /** The handler map of the desktop app, used to answer allowed requests from phones. */
  attach(handlers: Handlers): void {
    this.handlers = handlers
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    await this.devices.load()
  }

  get port(): number | null {
    return this.server.port
  }

  /* ───────────────────────────── lifecycle ───────────────────────────── */

  /** Makes the server match the settings: starts it, stops it, or restarts it on another port. Never throws; problems show in the status. */
  apply(): Promise<void> {
    this.chain = this.chain.then(() => this.applyNow()).catch(() => {})
    return this.chain
  }

  private async applyNow(): Promise<void> {
    await this.load()
    const s = this.d.getSettings()
    if (!s.enabled) {
      await this.server.close()
      this.pairing.cancel()
      this.state = 'stopped'
      this.error = undefined
    } else if (!this.server.listening || this.server.port !== s.port) {
      this.state = 'starting'
      this.publish(true)
      await this.server.close()
      try {
        await this.server.listen(s.port)
        this.state = 'running'
        this.error = undefined
      } catch (e) {
        this.state = 'error'
        this.error = e instanceof Error ? e.message : String(e)
      }
    }
    this.syncAwake()
    this.publish(true)
  }

  /** The computer stays awake only while the companion is running and the person asked for that. */
  private syncAwake(): void {
    const want = this.state === 'running' && this.d.getSettings().keepAwake && !!this.d.keepAwake
    if (want && this.awakeId === null) this.awakeId = this.d.keepAwake!.start()
    if (!want && this.awakeId !== null) {
      this.d.keepAwake?.stop(this.awakeId)
      this.awakeId = null
    }
  }

  async shutdown(): Promise<void> {
    await this.server.close()
    if (this.awakeId !== null) this.d.keepAwake?.stop(this.awakeId)
    this.awakeId = null
    if (this.emitTimer) clearTimeout(this.emitTimer)
    await this.devices.save()
  }

  /* ───────────────────────────── what the interface shows ───────────────────────────── */

  status(): RemoteStatus {
    const s = this.d.getSettings()
    const running = this.state === 'running' && this.server.port
    return {
      state: this.state,
      error: this.error,
      port: this.server.port ?? undefined,
      addresses: running ? remoteAddresses(this.server.port!, s.publicUrl) : [],
      devices: this.devices.list((id) => this.server.isOnline(id)),
      awake: this.awakeId !== null,
      missingClient: !fs.existsSync(path.join(this.d.clientDir, 'index.html'))
    }
  }

  private publish(immediate = false): void {
    const send = () => {
      this.emitTimer = null
      const st = this.status()
      if (this.d.publish) this.d.publish(st)
      else emit('remote:status', st)
    }
    if (immediate) {
      if (this.emitTimer) clearTimeout(this.emitTimer)
      send()
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(send, 200)
    }
  }

  /** A fresh one-time code and the links that open the web app already signed in (the QR code holds one of them). */
  pair(): RemotePairing {
    const st = this.status()
    if (st.state !== 'running' || !st.addresses.length) {
      throw new Error(st.state === 'running' ? 'This computer has no network address a phone can reach. Connect it to Wi-Fi, or enter an address in the settings.' : 'Turn on the companion first.')
    }
    const offer = this.pairing.create()
    return {
      code: formatPairCode(offer.code),
      expiresAt: offer.expiresAt,
      links: st.addresses.map((a) => ({ label: a.label, kind: a.kind, url: `${a.url}/#pair=${offer.code}` }))
    }
  }

  cancelPair(): void {
    this.pairing.cancel()
  }

  updateDevice(id: string, patch: { name?: string; scopes?: Partial<RemoteScopes> }): RemoteDevice | null {
    return this.devices.update(id, patch)
  }

  removeDevice(id: string): void {
    this.devices.remove(id)
    this.server.disconnect(id)
  }
}
