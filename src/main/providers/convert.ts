import type { Attachment, ChatMessage } from '@shared/types'

/** The user's text plus any text-file attachments, as the model should see it. */
export function userText(m: ChatMessage): string {
  let text = m.content ?? ''
  for (const a of m.attachments ?? []) {
    if (a.kind === 'text' && a.text !== undefined) {
      text += `${text ? '\n\n' : ''}[Attached file: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\``
    }
  }
  return text
}

export function imageAttachments(m: ChatMessage): Attachment[] {
  return (m.attachments ?? []).filter((a) => a.kind === 'image')
}

export function argsOrEmptyObject(s: string | undefined): string {
  const t = (s ?? '').trim()
  return t === '' ? '{}' : t
}

/**
 * Make sure every assistant tool call has a matching tool message (providers reject dangling calls)
 * and drop orphan tool messages. Returns a new array; messages are not mutated.
 */
export function repairToolPairs(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    // Tool messages are emitted together with the assistant turn that requested them (orphans are dropped).
    if (m.role === 'tool') continue
    out.push(m)
    if (m.role === 'assistant' && m.toolCalls?.length) {
      // Match results only inside the contiguous block that follows, so reused call ids never cross turns.
      const block: ChatMessage[] = []
      let j = i + 1
      while (j < messages.length && messages[j].role === 'tool') block.push(messages[j++])
      const used = new Set<ChatMessage>()
      for (const tc of m.toolCalls) {
        const found = block.find((b) => b.toolCallId === tc.id && !used.has(b))
        if (found) {
          used.add(found)
          out.push(found)
        } else {
          out.push({
            id: `synthetic_${tc.id}`,
            role: 'tool',
            createdAt: m.createdAt,
            content: 'The tool call was interrupted before it returned a result.',
            toolCallId: tc.id,
            toolName: tc.name,
            isError: true
          })
        }
      }
      i = j - 1
    }
  }
  return out
}
