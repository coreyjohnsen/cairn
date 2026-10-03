import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ImageRecord } from '@shared/types'
import { newId } from '@shared/defaults'
import { emit } from '../events'
import { readJson, writeFileAtomic } from '../util/fsx'
import { sniffImageExt } from './types'

export interface ImageStoreDeps {
  imagesDir: string
  thumbsDir: string
  indexFile: string
  /** Produce a JPEG thumbnail (longest edge `maxEdge`) or null when it can't be decoded. Injected so tests don't need Electron. */
  makeThumb?: (data: Uint8Array, maxEdge: number) => Uint8Array | null
}

export type NewImageMeta = Omit<ImageRecord, 'id' | 'file' | 'thumb' | 'createdAt' | 'favorite'>

const THUMB_EDGE = 360

export class ImageStore {
  private records = new Map<string, ImageRecord>()
  private saveTimer: NodeJS.Timeout | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private d: ImageStoreDeps) {}

  /** Load the index and forget records whose files were deleted outside the app. */
  async load(): Promise<void> {
    const raw = await readJson<ImageRecord[]>(this.d.indexFile)
    this.records.clear()
    let dropped = false
    for (const r of Array.isArray(raw) ? raw : []) {
      if (!r || typeof r.id !== 'string' || typeof r.file !== 'string') continue
      try {
        await fsp.access(path.join(this.d.imagesDir, r.file))
        this.records.set(r.id, r)
      } catch {
        dropped = true
      }
    }
    if (dropped) this.scheduleSave()
  }

  list(): ImageRecord[] {
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): ImageRecord | undefined {
    return this.records.get(id)
  }

  filePath(rec: ImageRecord): string {
    return path.join(this.d.imagesDir, rec.file)
  }

  thumbPath(rec: ImageRecord): string {
    // Without a generated thumbnail the original image doubles as its own thumbnail.
    return rec.thumb === rec.file ? this.filePath(rec) : path.join(this.d.thumbsDir, rec.thumb)
  }

  async readBytes(id: string): Promise<Uint8Array | null> {
    const rec = this.records.get(id)
    if (!rec) return null
    try {
      return await fsp.readFile(this.filePath(rec))
    } catch {
      return null
    }
  }

  async add(data: Uint8Array, meta: NewImageMeta): Promise<ImageRecord> {
    const id = newId('img')
    const ext = sniffImageExt(data)
    const file = `${id}.${ext}`
    await writeFileAtomic(path.join(this.d.imagesDir, file), data)

    let thumb = file
    const t = this.d.makeThumb?.(data, THUMB_EDGE) ?? null
    if (t && t.length) {
      thumb = `${id}.jpg`
      await writeFileAtomic(path.join(this.d.thumbsDir, thumb), t)
    } else {
      // No thumbnail available: serve the original from the thumbs route as well.
      thumb = file
    }

    const rec: ImageRecord = { ...meta, id, file, thumb, createdAt: Date.now(), favorite: false }
    this.records.set(id, rec)
    this.scheduleSave()
    emit('images:added', rec)
    return rec
  }

  setFavorite(id: string, favorite: boolean): void {
    const rec = this.records.get(id)
    if (!rec || rec.favorite === favorite) return
    rec.favorite = favorite
    this.scheduleSave()
    emit('images:updated', rec)
  }

  async remove(ids: string[]): Promise<void> {
    const removed: string[] = []
    for (const id of ids) {
      const rec = this.records.get(id)
      if (!rec) continue
      this.records.delete(id)
      removed.push(id)
      await fsp.rm(this.filePath(rec), { force: true }).catch(() => {})
      if (rec.thumb !== rec.file) await fsp.rm(this.thumbPath(rec), { force: true }).catch(() => {})
    }
    if (removed.length) {
      this.scheduleSave()
      emit('images:removed', removed)
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, 400)
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.list(), null, 1)
    this.writing = this.writing.then(() => writeFileAtomic(this.d.indexFile, snapshot)).catch(() => {})
    return this.writing
  }

  /** Write any pending changes now (called on quit). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.save()
  }
}
