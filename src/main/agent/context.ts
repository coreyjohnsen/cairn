import type { ChatMessage } from '@shared/types'
import { repairToolPairs } from '../providers/convert'

const IMAGE_TOKENS = 900

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6)
}

export function messageTokens(m: ChatMessage): number {
  let n = estimateTokens(m.content ?? '') + 6
  for (const tc of m.toolCalls ?? []) n += estimateTokens(tc.name) + estimateTokens(tc.arguments) + 8
  for (const a of m.attachments ?? []) {
    if (a.kind === 'image') n += IMAGE_TOKENS
    else if (a.text) n += estimateTokens(a.text)
  }
  return n
}

export function totalTokens(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages) n += messageTokens(m)
  return n
}

/**
 * Messages that should be sent to the model. Interrupted/empty assistant turns and pure notices are dropped.
 * If no tools are offered, tool traffic is flattened away so servers without tool support do not choke on it.
 */
export function historyFor(messages: ChatMessage[], toolsActive: boolean): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      let msg = m
      if (!toolsActive && m.toolCalls?.length) msg = { ...m, toolCalls: undefined }
      if (!msg.content && !msg.toolCalls?.length) continue
      out.push(msg)
    } else if (m.role === 'tool') {
      if (toolsActive) out.push(m)
    } else {
      out.push(m)
    }
  }
  return toolsActive ? repairToolPairs(out) : out
}

/**
 * Shrink history to fit a token budget: first truncate stale tool output, then drop the oldest whole turns.
 * The most recent user turn is always kept.
 */
export function fitHistory(messages: ChatMessage[], budget: number, keepRecent = 6): ChatMessage[] {
  if (budget <= 0 || totalTokens(messages) <= budget) return messages

  let msgs = messages.map((m, i) => {
    if (m.role === 'tool' && i < messages.length - keepRecent && m.content.length > 500) {
      return { ...m, content: `${m.content.slice(0, 400)}\n[… output truncated to save context …]` }
    }
    return m
  })
  if (totalTokens(msgs) <= budget) return msgs

  // Split into turns that each start with a user message.
  const turnStarts: number[] = []
  msgs.forEach((m, i) => {
    if (m.role === 'user') turnStarts.push(i)
  })
  while (turnStarts.length > 1 && totalTokens(msgs) > budget) {
    const cut = turnStarts[1]
    msgs = msgs.slice(cut)
    const shift = cut
    for (let i = 0; i < turnStarts.length; i++) turnStarts[i] -= shift
    turnStarts.shift()
  }
  // Still too big with a single huge turn: trim old tool outputs inside it harder.
  // Tool results after the last assistant message are what the model is about to read; shrinking those makes it ask again.
  if (totalTokens(msgs) > budget) {
    let lastAssistant = -1
    msgs.forEach((m, i) => {
      if (m.role === 'assistant') lastAssistant = i
    })
    msgs = msgs.map((m, i) =>
      m.role === 'tool' && i < lastAssistant && m.content.length > 200 ? { ...m, content: `${m.content.slice(0, 150)}\n[… truncated …]` } : m
    )
  }
  return repairToolPairs(msgs)
}
