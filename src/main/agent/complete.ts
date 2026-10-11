import type { ChatMessage } from '@shared/types'
import type { Provider } from '../providers/types'

export interface CompleteOpts {
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  timeoutMs?: number
  /** Same as the chat's, so a local server is not restarted with other flags for this request. */
  thinking?: 'on' | 'off'
}

/** One-shot, tool-less completion with the model's reasoning and why it stopped kept apart from the answer. */
export async function completeTextDetailed(provider: Provider, model: string, system: string, user: string, opts: CompleteOpts = {}): Promise<{ text: string; reasoning: string; finishReason?: string }> {
  const msg: ChatMessage = { id: 'tmp', role: 'user', createdAt: Date.now(), content: user }
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60000)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  let text = ''
  let reasoning = ''
  let finishReason: string | undefined
  for await (const ev of provider.stream({
    model,
    system,
    messages: [msg],
    tools: [],
    params: { temperature: opts.temperature ?? 0.4, maxTokens: opts.maxTokens ?? 256 },
    thinking: opts.thinking,
    signal,
    loadAttachment: async () => null
  })) {
    if (ev.type === 'text') text += ev.text
    else if (ev.type === 'reasoning') reasoning += ev.text
    else if (ev.type === 'finish') finishReason = ev.reason
  }
  return { text: text.trim(), reasoning, finishReason }
}

/** One-shot, tool-less completion that returns the concatenated text. Used for titles and prompt enhancement. */
export async function completeText(provider: Provider, model: string, system: string, user: string, opts: CompleteOpts = {}): Promise<string> {
  return (await completeTextDetailed(provider, model, system, user, opts)).text
}

export function cleanTitle(raw: string): string {
  let t = raw.split('\n').find((l) => l.trim()) ?? ''
  t = t.replace(/^(title|chat title)\s*[:：-]\s*/i, '').replace(/^["'“”‘’`*#\s]+|["'“”‘’`*.\s]+$/g, '').trim()
  if (t.length > 60) t = t.slice(0, 57).trimEnd() + '…'
  return t
}
