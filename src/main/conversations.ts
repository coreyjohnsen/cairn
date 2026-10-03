import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ChatMessage, Conversation, ConversationPatch, ConversationSummary } from '@shared/types'
import { newId } from '@shared/defaults'
import { ensureDir, readJson, writeFileAtomic } from './util/fsx'

export const DEFAULT_TITLE = 'New chat'

export class ConversationStore {
  private map = new Map<string, Conversation>()
  private dirty = new Set<string>()
  private timer: NodeJS.Timeout | null = null

  constructor(private dir: string) {}

  async init(): Promise<void> {
    await ensureDir(this.dir)
    let files: string[] = []
    try {
      files = await fsp.readdir(this.dir)
    } catch {
      files = []
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const c = await readJson<Conversation>(path.join(this.dir, f))
      if (c && typeof c.id === 'string' && Array.isArray(c.messages)) {
        // Anything still "streaming" after a restart was interrupted.
        for (const m of c.messages) {
          if (m.status === 'streaming') m.status = 'aborted'
        }
        c.params ??= {}
        c.toolsEnabled ??= true
        this.map.set(c.id, c)
      }
    }
  }

  summary(c: Conversation): ConversationSummary {
    let preview = ''
    for (let i = c.messages.length - 1; i >= 0; i--) {
      const m = c.messages[i]
      if (m.role === 'user' || (m.role === 'assistant' && m.content)) {
        preview = m.content.replace(/\s+/g, ' ').trim().slice(0, 140)
        break
      }
    }
    return {
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      pinned: c.pinned,
      messageCount: c.messages.filter((m) => m.role !== 'tool').length,
      preview
    }
  }

  list(): ConversationSummary[] {
    return [...this.map.values()].map((c) => this.summary(c)).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): Conversation | null {
    return this.map.get(id) ?? null
  }

  create(init: ConversationPatch & { toolsEnabled?: boolean } = {}): Conversation {
    const now = Date.now()
    const c: Conversation = {
      id: newId('c_'),
      title: init.title ?? DEFAULT_TITLE,
      createdAt: now,
      updatedAt: now,
      pinned: init.pinned,
      modelRef: init.modelRef,
      systemPrompt: init.systemPrompt,
      workspace: init.workspace,
      toolsEnabled: init.toolsEnabled ?? true,
      imageTarget: init.imageTarget,
      params: init.params ?? {},
      messages: []
    }
    this.map.set(c.id, c)
    this.markDirty(c.id)
    return c
  }

  update(id: string, patch: ConversationPatch): Conversation {
    const c = this.require(id)
    if (patch.title !== undefined) {
      c.title = patch.title.trim() || DEFAULT_TITLE
      c.titleSet = true
    }
    if (patch.modelRef !== undefined) c.modelRef = patch.modelRef || undefined
    if (patch.systemPrompt !== undefined) c.systemPrompt = patch.systemPrompt || undefined
    if (patch.workspace !== undefined) c.workspace = patch.workspace || undefined
    if (patch.toolsEnabled !== undefined) c.toolsEnabled = patch.toolsEnabled
    if (patch.imageTarget !== undefined) c.imageTarget = patch.imageTarget
    if (patch.params !== undefined) c.params = patch.params
    if (patch.pinned !== undefined) c.pinned = patch.pinned || undefined
    this.markDirty(id)
    return c
  }

  setAutoTitle(id: string, title: string): void {
    const c = this.map.get(id)
    if (!c || c.titleSet) return
    c.title = title
    this.markDirty(id)
  }

  /** Insert or replace a message (matched by id). */
  upsertMessage(id: string, msg: ChatMessage): void {
    const c = this.require(id)
    const i = c.messages.findIndex((m) => m.id === msg.id)
    if (i >= 0) c.messages[i] = msg
    else c.messages.push(msg)
    this.markDirty(id)
  }

  /** Remove `fromMessageId` and everything after it. */
  truncateFrom(id: string, fromMessageId: string): Conversation {
    const c = this.require(id)
    const i = c.messages.findIndex((m) => m.id === fromMessageId)
    if (i >= 0) c.messages.splice(i)
    this.markDirty(id)
    return c
  }

  async delete(id: string): Promise<void> {
    this.map.delete(id)
    this.dirty.delete(id)
    await fsp.rm(path.join(this.dir, `${id}.json`), { force: true })
  }

  search(query: string): ConversationSummary[] {
    const q = query.trim().toLowerCase()
    if (!q) return this.list()
    const hits: ConversationSummary[] = []
    for (const c of this.map.values()) {
      const inTitle = c.title.toLowerCase().includes(q)
      const inBody = !inTitle && c.messages.some((m) => m.role !== 'tool' && m.content.toLowerCase().includes(q))
      if (inTitle || inBody) hits.push(this.summary(c))
    }
    return hits.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  markDirty(id: string): void {
    const c = this.map.get(id)
    if (c) c.updatedAt = Date.now()
    this.dirty.add(id)
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), 700)
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const ids = [...this.dirty]
    this.dirty.clear()
    for (const id of ids) {
      const c = this.map.get(id)
      if (!c) continue
      try {
        await writeFileAtomic(path.join(this.dir, `${id}.json`), JSON.stringify(c))
      } catch (err) {
        console.error('Failed to save conversation', id, err)
        this.dirty.add(id)
      }
    }
  }

  exportMarkdown(id: string): string {
    const c = this.require(id)
    const lines: string[] = [`# ${c.title}`, '', `_Exported ${new Date().toLocaleString()}_`, '']
    for (const m of c.messages) {
      if (m.role === 'user') {
        lines.push('## You', '', m.content, '')
      } else if (m.role === 'assistant') {
        lines.push(`## Assistant${m.model ? ` (${m.model})` : ''}`, '')
        if (m.content) lines.push(m.content, '')
        for (const tc of m.toolCalls ?? []) lines.push(`> Tool call: \`${tc.name}\` ${tc.arguments}`, '')
      } else if (m.role === 'tool') {
        lines.push(`> Tool result (${m.toolName ?? 'tool'}):`, '', '```', m.content.slice(0, 2000), '```', '')
      }
    }
    return lines.join('\n')
  }

  private require(id: string): Conversation {
    const c = this.map.get(id)
    if (!c) throw new Error(`Conversation not found: ${id}`)
    return c
  }
}
