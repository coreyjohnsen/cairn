import { create } from 'zustand'
import type { ApprovalDecision, ApprovalRequest, AttachmentInput, ChatEvent, ChatMessage, Conversation, ConversationPatch, ConversationSummary, ToolProgress } from '@shared/types'
import { invoke, on } from '@/lib/api'
import { DeltaBatch } from '@/lib/deltaBatch'
import { errorText } from '@/lib/format'
import { useApp } from './app'

interface ChatState {
  list: ConversationSummary[]
  query: string
  results: ConversationSummary[] | null
  activeId: string | null
  cache: Record<string, Conversation>
  running: Record<string, boolean>
  approvals: Record<string, ApprovalRequest[]>
  status: Record<string, string>
  progress: Record<string, ToolProgress>
  runError: Record<string, string>
  /** Settings picked before the first message of a new chat; applied when the chat is created. */
  draft: ConversationPatch
  init(): Promise<void>
  refreshList(): Promise<void>
  select(id: string | null): Promise<void>
  create(init?: ConversationPatch): Promise<Conversation>
  patch(id: string, patch: ConversationPatch): Promise<void>
  /** Patch the open chat, or remember the choice for the next new chat. */
  patchActive(patch: ConversationPatch): void
  newChat(): void
  remove(id: string): Promise<void>
  setQuery(q: string): void
  send(text: string, attachments?: AttachmentInput[], mode?: 'chat' | 'image'): Promise<boolean>
  stop(): void
  regenerate(): Promise<void>
  truncateFrom(messageId: string): Promise<void>
  approve(a: ApprovalRequest, d: ApprovalDecision): void
  handle(e: ChatEvent): void
}

function sortList(list: ConversationSummary[]): ConversationSummary[] {
  return [...list].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)
}

function upsertMessage(conv: Conversation, msg: ChatMessage): Conversation {
  const i = conv.messages.findIndex((m) => m.id === msg.id)
  const messages = i >= 0 ? conv.messages.map((m, k) => (k === i ? msg : m)) : [...conv.messages, msg]
  return { ...conv, messages, updatedAt: Math.max(conv.updatedAt, msg.createdAt) }
}

// Streaming tokens arrive far faster than the screen refreshes: batch them per animation frame.
const deltas = new DeltaBatch()
let flushScheduled = false

export const useChat = create<ChatState>()((set, get) => {
  const flushDeltas = () => {
    flushScheduled = false
    if (!deltas.size) return
    const batch = deltas.take()
    set((s) => {
      const cache = { ...s.cache }
      for (const [msgId, d] of batch) {
        const conv = cache[d.conv]
        if (!conv) continue
        cache[d.conv] = {
          ...conv,
          messages: conv.messages.map((m) => (m.id === msgId ? { ...m, content: m.content + d.content, reasoning: d.reasoning ? (m.reasoning ?? '') + d.reasoning : m.reasoning } : m))
        }
      }
      return { cache }
    })
  }

  return {
    list: [],
    query: '',
    results: null,
    activeId: null,
    cache: {},
    running: {},
    approvals: {},
    status: {},
    progress: {},
    runError: {},
    draft: {},

    async init() {
      on('chat:event', (e) => get().handle(e))
      on('conversations:changed', (summary) => {
        set((s) => ({ list: sortList([summary, ...s.list.filter((c) => c.id !== summary.id)]) }))
      })
      const [list, active] = await Promise.all([invoke('conversations:list'), invoke('chat:active')])
      set({ list: sortList(list), running: Object.fromEntries(active.map((id) => [id, true])) })
      if (list.length) await get().select(sortList(list)[0].id)
    },

    async refreshList() {
      try {
        set({ list: sortList(await invoke('conversations:list')) })
      } catch {
        /* non-critical */
      }
    },

    async select(id) {
      if (!id) return void set({ activeId: null, draft: {} })
      set({ activeId: id })
      if (get().running[id] && get().cache[id]) return
      try {
        const conv = await invoke('conversations:get', id)
        if (conv) set((s) => ({ cache: { ...s.cache, [id]: conv } }))
        else set({ activeId: null })
      } catch (e) {
        useApp.getState().toast('error', errorText(e))
      }
    },

    async create(init) {
      const conv = await invoke('conversations:create', { ...get().draft, ...init })
      set((s) => ({ cache: { ...s.cache, [conv.id]: conv }, activeId: conv.id, draft: {} }))
      await get().refreshList()
      return conv
    },

    async patch(id, patch) {
      try {
        const conv = await invoke('conversations:update', id, patch)
        set((s) => ({ cache: { ...s.cache, [id]: { ...(s.cache[id] ?? conv), ...patch, messages: s.cache[id]?.messages ?? conv.messages } } }))
      } catch (e) {
        useApp.getState().toast('error', errorText(e))
      }
    },

    patchActive(patch) {
      const id = get().activeId
      if (id) void get().patch(id, patch)
      else set((s) => ({ draft: { ...s.draft, ...patch } }))
    },

    newChat() {
      set({ activeId: null, draft: {} })
    },

    async remove(id) {
      await invoke('conversations:delete', id)
      set((s) => {
        const { [id]: _gone, ...cache } = s.cache
        const list = s.list.filter((c) => c.id !== id)
        return { cache, list, activeId: s.activeId === id ? (sortList(list)[0]?.id ?? null) : s.activeId }
      })
      const next = get().activeId
      if (next && !get().cache[next]) await get().select(next)
    },

    setQuery(q) {
      set({ query: q })
      if (!q.trim()) return set({ results: null })
      invoke('conversations:search', q)
        .then((results) => get().query === q && set({ results }))
        .catch(() => {})
    },

    async send(text, attachments, mode) {
      let id = get().activeId
      try {
        if (!id) id = (await get().create({ toolsEnabled: get().draft.toolsEnabled ?? useApp.getState().settings?.chat.toolsDefault ?? true })).id
        set((s) => ({ runError: { ...s.runError, [id!]: '' } }))
        await invoke('chat:send', { conversationId: id, text, attachments, mode })
        return true
      } catch (e) {
        useApp.getState().toast('error', errorText(e))
        return false
      }
    },

    stop() {
      const id = get().activeId
      if (id) void invoke('chat:abort', id)
    },

    async regenerate() {
      const id = get().activeId
      if (!id) return
      try {
        set((s) => ({ runError: { ...s.runError, [id]: '' } }))
        await invoke('chat:regenerate', id)
      } catch (e) {
        useApp.getState().toast('error', errorText(e))
      }
    },

    async truncateFrom(messageId) {
      const id = get().activeId
      if (!id) return
      try {
        const conv = await invoke('conversations:truncate', id, messageId)
        set((s) => ({ cache: { ...s.cache, [id]: conv } }))
        void get().refreshList()
      } catch (e) {
        useApp.getState().toast('error', errorText(e))
      }
    },

    approve(a, d) {
      void invoke('chat:approve', a.id, d)
      set((s) => {
        const conv = Object.keys(s.approvals).find((k) => s.approvals[k].some((x) => x.id === a.id))
        if (!conv) return {}
        return { approvals: { ...s.approvals, [conv]: s.approvals[conv].filter((x) => x.id !== a.id) } }
      })
    },

    handle(e) {
      switch (e.type) {
        case 'run-start':
          set((s) => ({ running: { ...s.running, [e.conversationId]: true } }))
          break
        case 'run-end':
          flushDeltas()
          set((s) => ({
            running: { ...s.running, [e.conversationId]: false },
            approvals: { ...s.approvals, [e.conversationId]: [] },
            status: { ...s.status, [e.conversationId]: '' },
            runError: e.outcome === 'error' && e.error ? { ...s.runError, [e.conversationId]: e.error } : s.runError
          }))
          void get().refreshList()
          break
        case 'message':
          // A message snapshot already contains every token sent before it. Deltas still waiting for the
          // next animation frame would be added on top of it, repeating the last words of the reply.
          deltas.drop(e.message.id)
          set((s) => {
            const conv = s.cache[e.conversationId]
            if (!conv) return {}
            return { cache: { ...s.cache, [e.conversationId]: upsertMessage(conv, e.message) } }
          })
          if (!get().cache[e.conversationId] && get().activeId === e.conversationId) void get().select(e.conversationId)
          break
        case 'delta': {
          deltas.add(e.messageId, e.conversationId, e.content, e.reasoning)
          if (!flushScheduled) {
            flushScheduled = true
            requestAnimationFrame(flushDeltas)
          }
          break
        }
        case 'tool-progress':
          set((s) => ({ progress: { ...s.progress, [e.toolCallId]: { label: e.label, progress: e.progress, stage: e.stage } } }))
          break
        case 'approval':
          set((s) => ({ approvals: { ...s.approvals, [e.conversationId]: [...(s.approvals[e.conversationId] ?? []).filter((a) => a.id !== e.approval.id), e.approval] } }))
          break
        case 'approval-resolved':
          set((s) => ({ approvals: { ...s.approvals, [e.conversationId]: (s.approvals[e.conversationId] ?? []).filter((a) => a.id !== e.approvalId) } }))
          break
        case 'status':
          set((s) => ({ status: { ...s.status, [e.conversationId]: e.status } }))
          break
        case 'title':
          set((s) => ({
            list: s.list.map((c) => (c.id === e.conversationId ? { ...c, title: e.title } : c)),
            cache: s.cache[e.conversationId] ? { ...s.cache, [e.conversationId]: { ...s.cache[e.conversationId], title: e.title, titleSet: true } } : s.cache
          }))
          break
      }
    }
  }
})
