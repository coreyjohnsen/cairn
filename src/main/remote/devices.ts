import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { RemoteDevice, RemoteScopes } from '@shared/types'
import { cleanDeviceName } from '@shared/remotePrefs'
import { readJson, writeFileAtomic } from '../util/fsx'

/**
 * The phones and tablets that have been paired. Each one gets a long random token that only its own browser keeps;
 * what is stored here is a one-way hash of it, so a copy of this file cannot be used to sign in.
 */

export const MAX_DEVICES = 20
export const DEFAULT_SCOPES: RemoteScopes = { images: true, tools: false }
/** How often a device's "last seen" time is written to disk. */
const SAVE_EVERY_MS = 60_000

interface StoredDevice {
  id: string
  name: string
  tokenHash: string
  createdAt: number
  lastSeenAt: number
  lastAddress?: string
  scopes: RemoteScopes
}

interface FileShape {
  version: 1
  devices: StoredDevice[]
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export function cleanScopes(input: unknown, base: RemoteScopes = DEFAULT_SCOPES): RemoteScopes {
  const r = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  return { images: typeof r.images === 'boolean' ? r.images : base.images, tools: typeof r.tools === 'boolean' ? r.tools : base.tools }
}

export class DeviceStore {
  private devices = new Map<string, StoredDevice>()
  /** Token hash → device id, so a request is matched without scanning the list. */
  private byHash = new Map<string, string>()
  private listeners = new Set<() => void>()
  private saveTimer: NodeJS.Timeout | null = null
  private lastSaved = 0
  /** Writes happen one after another, so an older copy can never land on top of a newer one. */
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private file: string,
    private now: () => number = Date.now
  ) {}

  async load(): Promise<void> {
    const data = await readJson<FileShape>(this.file)
    this.devices.clear()
    this.byHash.clear()
    for (const d of data?.devices ?? []) {
      if (!d || typeof d.id !== 'string' || typeof d.tokenHash !== 'string') continue
      const dev: StoredDevice = {
        id: d.id,
        name: cleanDeviceName(d.name),
        tokenHash: d.tokenHash,
        createdAt: Number(d.createdAt) || this.now(),
        lastSeenAt: Number(d.lastSeenAt) || 0,
        lastAddress: typeof d.lastAddress === 'string' ? d.lastAddress : undefined,
        scopes: cleanScopes(d.scopes)
      }
      this.devices.set(dev.id, dev)
      this.byHash.set(dev.tokenHash, dev.id)
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed(): void {
    for (const l of this.listeners) l()
  }

  /** The list without the token hashes. `online` is filled in by whoever knows who is connected. */
  list(isOnline: (id: string) => boolean = () => false): RemoteDevice[] {
    return [...this.devices.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt || b.createdAt - a.createdAt)
      .map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, lastAddress: d.lastAddress, scopes: { ...d.scopes }, online: isOnline(d.id) }))
  }

  get(id: string): RemoteDevice | null {
    return this.list().find((d) => d.id === id) ?? null
  }

  /** Adds a device and returns the one token that signs it in. It is never stored in readable form. */
  add(name: string, address?: string, scopes: RemoteScopes = DEFAULT_SCOPES): { device: RemoteDevice; token: string } {
    if (this.devices.size >= MAX_DEVICES) {
      // The device that has been quiet the longest makes room, so pairing never fails over old phones.
      const oldest = [...this.devices.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0]
      if (oldest) this.drop(oldest.id)
    }
    const token = randomBytes(32).toString('base64url')
    const now = this.now()
    const dev: StoredDevice = { id: randomUUID(), name: cleanDeviceName(name), tokenHash: hashToken(token), createdAt: now, lastSeenAt: now, lastAddress: address, scopes: cleanScopes(scopes) }
    this.devices.set(dev.id, dev)
    this.byHash.set(dev.tokenHash, dev.id)
    void this.save()
    this.changed()
    return { device: this.get(dev.id)!, token }
  }

  /** The device a token belongs to, or null. A hit refreshes "last seen". */
  authenticate(token: string | undefined, address?: string): RemoteDevice | null {
    if (!token || token.length > 200) return null
    const id = this.byHash.get(hashToken(token))
    const dev = id ? this.devices.get(id) : undefined
    if (!dev) return null
    const now = this.now()
    const moved = address !== undefined && address !== dev.lastAddress
    // Only touch the list when something people can see changes, not on every request.
    if (now - dev.lastSeenAt > 30_000 || moved) {
      dev.lastSeenAt = now
      if (address !== undefined) dev.lastAddress = address
      this.scheduleSave()
      this.changed()
    }
    return this.get(dev.id)
  }

  update(id: string, patch: { name?: string; scopes?: Partial<RemoteScopes> }): RemoteDevice | null {
    const dev = this.devices.get(id)
    if (!dev) return null
    if (patch.name !== undefined) dev.name = cleanDeviceName(patch.name, dev.name)
    if (patch.scopes) dev.scopes = cleanScopes(patch.scopes, dev.scopes)
    void this.save()
    this.changed()
    return this.get(id)
  }

  /** Signs a device out for good: its token stops working at once. */
  remove(id: string): boolean {
    const ok = this.drop(id)
    if (ok) {
      void this.save()
      this.changed()
    }
    return ok
  }

  private drop(id: string): boolean {
    const dev = this.devices.get(id)
    if (!dev) return false
    this.byHash.delete(dev.tokenHash)
    this.devices.delete(id)
    return true
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    const wait = Math.max(0, SAVE_EVERY_MS - (this.now() - this.lastSaved))
    this.saveTimer = setTimeout(() => void this.save(), wait)
    this.saveTimer.unref?.()
  }

  async save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.lastSaved = this.now()
    const data: FileShape = { version: 1, devices: [...this.devices.values()] }
    const text = JSON.stringify(data, null, 2)
    this.writing = this.writing.then(async () => {
      try {
        await writeFileAtomic(this.file, text)
      } catch (err) {
        console.error('Failed to save paired devices', err)
      }
    })
    await this.writing
  }
}
