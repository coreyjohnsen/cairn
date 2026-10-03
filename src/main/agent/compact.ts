import { compactionText } from '@shared/compaction'
import type { ChatMessage, Compaction, LedgerEntry } from '@shared/types'
import { parseToolArgs } from '../util/json'
import { estimateTokens, messageTokens } from './context'

/**
 * Below this much room for the conversation a summary would take about as much memory as it frees,
 * so the older messages are simply trimmed instead.
 */
export const MIN_COMPACT_BUDGET = 2500

/** Most tool calls the ledger keeps, however long the chat runs. */
const LEDGER_CAP = 140
/** How many of the user's own requests are kept word for word. */
const ASKS_KEPT = 4

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1)).trimEnd()}…`)
const clipMiddle = (s: string, head: number, tail: number): string => (s.length <= head + tail + 40 ? s : `${s.slice(0, head)}\n[… ${s.length - head - tail} characters left out …]\n${s.slice(-tail)}`)
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/* ───────────── what the model sees ───────────── */

/** The summary, when it still belongs to this chat (the message it ends at has not been removed). */
export function validCompaction(messages: ChatMessage[], c: Compaction | undefined): Compaction | undefined {
  return c && messages.some((m) => m.id === c.upToMessageId) ? c : undefined
}

/** Index of the first message the model still sees in full; 0 when nothing is summarized. */
export function keptFrom(messages: ChatMessage[], c: Compaction | undefined): number {
  const v = validCompaction(messages, c)
  return v ? messages.findIndex((m) => m.id === v.upToMessageId) + 1 : 0
}

/**
 * The messages to send: the summary stands in for everything it covers. It goes in the user's seat, because many chat
 * templates require the conversation to start with the user and to alternate, and a system message in the middle breaks that.
 */
export function applyCompaction(messages: ChatMessage[], c: Compaction | undefined): ChatMessage[] {
  const v = validCompaction(messages, c)
  if (!v) return messages
  const kept = messages.slice(keptFrom(messages, v))
  const text = compactionText(v)
  if (kept[0]?.role === 'user') {
    return [{ ...kept[0], content: `${text}\n\n[The user's message now]\n${kept[0].content}` }, ...kept.slice(1)]
  }
  const lead: ChatMessage = { id: `summary_${v.upToMessageId}`, role: 'user', createdAt: v.createdAt, content: `${text}\n\nContinue the task from where you left off.`, status: 'done' }
  return [lead, ...kept]
}

/* ───────────── where to cut ───────────── */

/**
 * Where the summarized part ends: messages before the returned index are summarized, the rest are kept as they are.
 * The kept part is the most recent messages up to `tailTokens` (the last exchange always stays), and it never begins
 * with a tool result, because the call that asked for it would be gone. Returns `from` when there is nothing to summarize.
 */
export function chooseCut(messages: ChatMessage[], from: number, tailTokens: number): number {
  const n = messages.length
  // Everything after the summary already fits as it is: there is nothing to gain.
  if (messages.slice(from).reduce((sum, m) => sum + messageTokens(m), 0) <= tailTokens) return from
  let tail = 0
  let cut = n
  for (let i = n - 1; i > from; i--) {
    const t = messageTokens(messages[i])
    if (cut < n && tail + t > tailTokens) break
    tail += t
    cut = i
  }
  while (cut > from + 1 && messages[cut]?.role === 'tool') cut--
  if (cut <= from || messages[cut]?.role === 'tool') return from
  return cut
}

/* ───────────── the list of tool calls ───────────── */

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const text = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

/** One tool call as a line of the ledger. */
export function describeCall(name: string, rawArgs: string, result?: ChatMessage): LedgerEntry {
  const parsed = parseToolArgs(rawArgs)
  const a: Record<string, unknown> = parsed.ok ? parsed.value : {}
  const failed = result?.isError && !result.denied ? 'failed' : undefined
  const entry = (k: LedgerEntry['k'], t: string, note?: string): LedgerEntry => ({ k: result?.denied ? 'denied' : k, t: oneLine(t) || name, n: 1, note: result?.denied ? undefined : (failed ?? note) })
  switch (name) {
    case 'read_file': {
      const offset = num(a.offset)
      const limit = num(a.limit)
      const range = limit > 0 ? `lines ${Math.max(1, offset)}-${Math.max(1, offset) + limit - 1}` : offset > 1 ? `from line ${offset}` : undefined
      return entry('read', text(a.path), range)
    }
    case 'write_file':
      return entry('wrote', text(a.path), 'written')
    case 'edit_file':
      return entry('wrote', text(a.path), 'edited')
    case 'move_path':
      return entry('wrote', `${text(a.from)} → ${text(a.to)}`, 'moved')
    case 'delete_path':
      return entry('wrote', text(a.path), 'deleted')
    case 'list_directory':
      return entry('find', `list ${text(a.path) || '.'}`)
    case 'search_files':
      return entry('find', `search "${clip(text(a.pattern), 60)}"${a.path ? ` in ${text(a.path)}` : ''}`)
    case 'find_files':
      return entry('find', `files ${clip(text(a.glob), 60)}${a.path ? ` in ${text(a.path)}` : ''}`)
    case 'run_command': {
      const code = /^Exit code:\s*(-?\d+)/m.exec(result?.content ?? '')?.[1]
      return entry('cmd', text(a.command).split('\n')[0], code !== undefined ? `exit ${code}` : undefined)
    }
    case 'fetch_url':
      return entry('web', text(a.url).replace(/^https?:\/\//, ''))
    case 'web_search':
      return entry('web', `search "${clip(text(a.query), 80)}"`)
    default: {
      const first = Object.values(a).find((v) => typeof v === 'string' || typeof v === 'number')
      return entry('misc', `${name}${first !== undefined ? ` ${clip(text(first), 80)}` : ''}`)
    }
  }
}

/** The tool calls in these messages, in order, with how each ended. */
export function ledgerFrom(messages: ChatMessage[]): { entries: LedgerEntry[]; calls: number } {
  const results = new Map<string, ChatMessage>()
  for (const m of messages) if (m.role === 'tool' && m.toolCallId) results.set(m.toolCallId, m)
  const entries: LedgerEntry[] = []
  let calls = 0
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const tc of m.toolCalls ?? []) {
      calls++
      entries.push(describeCall(tc.name, tc.arguments, results.get(tc.id)))
    }
  }
  return { entries, calls }
}

/** Add newer entries to older ones: the same call repeated is counted once with a total, ordered by when it last happened. */
export function mergeLedger(prior: LedgerEntry[], add: LedgerEntry[]): LedgerEntry[] {
  const out = new Map<string, LedgerEntry>()
  for (const e of [...prior, ...add]) {
    const key = `${e.k}|${e.t}`
    const old = out.get(key)
    out.delete(key)
    out.set(key, old ? { ...e, n: old.n + e.n, note: e.note ?? old.note } : { ...e })
  }
  return [...out.values()].slice(-LEDGER_CAP)
}

/** The user's own requests, shortened, the most recent few kept. */
export function asksFrom(prior: string[], messages: ChatMessage[]): string[] {
  const now = messages.filter((m) => m.role === 'user' && m.content.trim()).map((m) => clip(oneLine(m.content), 420))
  return [...prior, ...now].slice(-ASKS_KEPT)
}

/* ───────────── asking the model to summarize ───────────── */

export const SUMMARY_SYSTEM =
  'You compress the middle of a long working session between a user and an AI assistant that reads and edits files and runs commands. The assistant will carry on from your summary alone, so anything you leave out is lost. Be exact and compact, never invent anything, and write plain text only.'

/** One block of text per message, with tool output cut down to the part that tells what it was. */
export function transcriptBlocks(messages: ChatMessage[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const files = (m.attachments ?? []).map((a) => `[attached: ${a.name}]`).join(' ')
      out.push(`USER: ${clip(m.content, 1800)}${files ? ` ${files}` : ''}`)
    } else if (m.role === 'assistant') {
      const calls = (m.toolCalls ?? []).map((tc) => `\n  CALL ${tc.name} ${clip(tc.arguments, 260)}`).join('')
      if (m.content || calls) out.push(`ASSISTANT: ${clip(m.content, 1400)}${calls}`)
    } else {
      const state = m.denied ? 'declined by the user' : m.isError ? 'error' : 'ok'
      // A command's useful part is usually its end (the failure); a file's is its start.
      const body = m.toolName === 'run_command' ? clipMiddle(m.content, 220, 520) : clipMiddle(m.content, 560, 240)
      out.push(`RESULT of ${m.toolName ?? 'tool'} (${state}, ${m.content.length} characters): ${body}`)
    }
  }
  return out
}

/** Group blocks into pieces that each fit `capacityTokens`; a block that is too large alone is cut down. */
export function packBlocks(blocks: string[], capacityTokens: number): string[] {
  const cap = Math.max(300, capacityTokens)
  const chunks: string[] = []
  let cur: string[] = []
  let used = 0
  for (let b of blocks) {
    let t = estimateTokens(b)
    if (t > cap) {
      b = clipMiddle(b, Math.floor(cap * 2.2), Math.floor(cap * 0.8))
      t = estimateTokens(b)
    }
    if (used + t > cap && cur.length) {
      chunks.push(cur.join('\n\n'))
      cur = []
      used = 0
    }
    cur.push(b)
    used += t
  }
  if (cur.length) chunks.push(cur.join('\n\n'))
  return chunks
}

export function summaryRequest(prior: string, transcript: string, words: number): string {
  return [
    prior ? `Summary so far, from the earlier messages. Keep what still matters and fold the new messages into it:\n${prior}\n` : '',
    `New messages to fold in:\n${transcript}\n`,
    'Write the updated summary with exactly these headings:',
    'Goal: what the user wants overall, with constraints, preferences, names and numbers kept exactly.',
    'Done: what is finished, naming the files and how they changed.',
    'Learned: facts from tool results that matter later, file by file or command by command: what it contains or defines (function and class names, structure), errors, test results, decisions and why.',
    'Next: the very next step, what is unfinished, and any question the user has not answered yet.',
    `Keep exact file paths, identifiers, commands and error text. Under ${words} words. Start directly with "Goal:".`
  ]
    .filter(Boolean)
    .join('\n')
}

/** What came back, without reasoning tags or code fences, or '' when it is too thin to be a summary. */
export function cleanNarrative(raw: string, maxChars: number): string {
  let t = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*```[a-z]*\n?|\n?```\s*$/gi, '')
    .trim()
  const start = t.search(/\bGoal\s*:/i)
  if (start > 0) t = t.slice(start)
  if (t.length < 40) return ''
  return clip(t, maxChars)
}

export type Complete = (system: string, user: string, maxTokens: number) => Promise<string>

/**
 * Have the model write the narrative, folding the new messages into the earlier one. Long stretches go in pieces that
 * each fit the model's memory, one after the other. Returns null when nothing usable came back.
 */
export async function writeNarrative(complete: Complete, args: { prior: string; blocks: string[]; capacityTokens: number; words: number }): Promise<string | null> {
  const maxChars = args.words * 8
  const chunks = packBlocks(args.blocks, args.capacityTokens)
  let narrative = args.prior
  let changed = false
  for (const chunk of chunks) {
    const out = cleanNarrative(await complete(SUMMARY_SYSTEM, summaryRequest(narrative, chunk, args.words), Math.ceil(args.words * 2.2)), maxChars)
    if (!out) break
    narrative = out
    changed = true
  }
  return changed ? narrative : null
}

/** Whether a server's error says the request did not fit in the model's memory. */
export function isContextOverflow(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /exceed\w*[^.]{0,60}(context|n_ctx)|context[^.]{0,24}(length|size|window)|maximum context|prompt is too long|too many tokens|n_ctx|input is too long/i.test(msg)
}
