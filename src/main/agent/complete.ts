import type { ChatMessage } from '@shared/types'
import type { Provider } from '../providers/types'

/** One-shot, tool-less completion that returns the concatenated text. Used for titles and prompt enhancement. */
export async function completeText(
  provider: Provider,
  model: string,
  system: string,
  user: string,
  opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<string> {
  const msg: ChatMessage = { id: 'tmp', role: 'user', createdAt: Date.now(), content: user }
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60000)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  let out = ''
  for await (const ev of provider.stream({
    model,
    system,
    messages: [msg],
    tools: [],
    params: { temperature: opts.temperature ?? 0.4, maxTokens: opts.maxTokens ?? 256 },
    signal,
    loadAttachment: async () => null
  })) {
    if (ev.type === 'text') out += ev.text
  }
  return out.trim()
}

export function cleanTitle(raw: string): string {
  let t = raw.split('\n').find((l) => l.trim()) ?? ''
  t = t.replace(/^(title|chat title)\s*[:：-]\s*/i, '').replace(/^["'“”‘’`*#\s]+|["'“”‘’`*.\s]+$/g, '').trim()
  if (t.length > 60) t = t.slice(0, 57).trimEnd() + '…'
  return t
}
