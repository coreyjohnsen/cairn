import type { ChatMessage, ProviderModel } from '@shared/types'
import { parseToolArgs } from '../util/json'
import { inferCaps } from './caps'
import { imageAttachments, repairToolPairs, userText } from './convert'
import { toProviderError } from './openai'
import { parseSse } from './sse'
import { type Provider, ProviderError, type ProviderRequest, type StreamEvent } from './types'

export interface AnthropicConfig {
  id: string
  baseUrl: string
  apiKey: string
  headers: Record<string, string>
}

const API_VERSION = '2023-06-01'

export function normalizeAnthropicBase(url: string): string {
  let u = (url || 'https://api.anthropic.com').trim().replace(/\/+$/, '')
  if (u.endsWith('/v1')) u = u.slice(0, -3)
  return u
}

type Block = Record<string, unknown>
interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: Block[]
}

export class AnthropicProvider implements Provider {
  readonly id: string
  private base: string

  constructor(private cfg: AnthropicConfig) {
    this.id = cfg.id
    this.base = normalizeAnthropicBase(cfg.baseUrl)
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': API_VERSION,
      ...(this.cfg.apiKey ? { 'x-api-key': this.cfg.apiKey } : {}),
      ...this.cfg.headers
    }
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    const res = await fetch(`${this.base}/v1/models?limit=200`, {
      headers: this.headers(),
      signal: signal ?? AbortSignal.timeout(15000)
    })
    if (!res.ok) throw await toProviderError(res, 'Listing models failed')
    const j = (await res.json()) as any
    const out: ProviderModel[] = []
    for (const m of j?.data ?? []) {
      if (!m?.id) continue
      out.push({ id: m.id, name: m.display_name ?? m.id, ...inferCaps(m.id, 'anthropic') })
    }
    return out
  }

  private async buildMessages(req: ProviderRequest): Promise<AnthropicMessage[]> {
    const out: AnthropicMessage[] = []
    const push = (role: 'user' | 'assistant', blocks: Block[]) => {
      if (blocks.length === 0) return
      const last = out[out.length - 1]
      if (last && last.role === role) last.content.push(...blocks)
      else out.push({ role, content: blocks })
    }
    const msgs: ChatMessage[] = repairToolPairs(req.messages)
    for (const m of msgs) {
      if (m.role === 'user') {
        const blocks: Block[] = []
        for (const a of imageAttachments(m)) {
          const loaded = await req.loadAttachment(a)
          if (loaded) blocks.push({ type: 'image', source: { type: 'base64', media_type: loaded.mime, data: loaded.base64 } })
        }
        const text = userText(m)
        if (text.trim()) blocks.push({ type: 'text', text })
        push('user', blocks)
      } else if (m.role === 'assistant') {
        const blocks: Block[] = []
        if (m.content?.trim()) blocks.push({ type: 'text', text: m.content })
        for (const tc of m.toolCalls ?? []) {
          const parsed = parseToolArgs(tc.arguments)
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parsed.ok ? parsed.value : {} })
        }
        push('assistant', blocks)
      } else if (m.role === 'tool') {
        push('user', [
          { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content || '(no output)', ...(m.isError ? { is_error: true } : {}) }
        ])
      }
    }
    // The API requires the first message to be from the user.
    if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation continues)' }] })
    return out
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.params.maxTokens && req.params.maxTokens > 0 ? req.params.maxTokens : 8192,
      messages: await this.buildMessages(req),
      stream: true
    }
    if (req.system) body.system = req.system
    if (req.params.temperature !== undefined) body.temperature = Math.min(1, Math.max(0, req.params.temperature))
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
    }

    const res = await fetch(`${this.base}/v1/messages`, {
      method: 'POST',
      headers: { ...this.headers(), Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: req.signal
    })
    if (!res.ok) throw await toProviderError(res)
    if (!res.body) throw new ProviderError('The server returned an empty response body')

    const toolIndex = new Map<number, number>()
    let toolCounter = 0
    let promptTokens: number | undefined
    let completionTokens: number | undefined
    let stop: string | undefined

    for await (const msg of parseSse(res.body, req.signal)) {
      let j: any
      try {
        j = JSON.parse(msg.data)
      } catch {
        continue
      }
      switch (j?.type) {
        case 'message_start':
          promptTokens = j.message?.usage?.input_tokens
          break
        case 'content_block_start': {
          const cb = j.content_block
          if (cb?.type === 'tool_use') {
            const idx = toolCounter++
            toolIndex.set(j.index, idx)
            yield { type: 'tool_call', index: idx, id: cb.id, name: cb.name }
          } else if (cb?.type === 'text' && cb.text) {
            yield { type: 'text', text: cb.text }
          }
          break
        }
        case 'content_block_delta': {
          const d = j.delta
          if (d?.type === 'text_delta' && d.text) yield { type: 'text', text: d.text }
          else if (d?.type === 'thinking_delta' && d.thinking) yield { type: 'reasoning', text: d.thinking }
          else if (d?.type === 'input_json_delta') {
            const idx = toolIndex.get(j.index)
            if (idx !== undefined) yield { type: 'tool_call', index: idx, args: d.partial_json ?? '' }
          }
          break
        }
        case 'message_delta':
          if (j.usage?.output_tokens !== undefined) completionTokens = j.usage.output_tokens
          if (j.delta?.stop_reason) stop = j.delta.stop_reason
          break
        case 'error':
          throw new ProviderError(j.error?.message ?? 'Anthropic API error')
        default:
          break
      }
    }
    yield { type: 'usage', promptTokens, completionTokens }
    yield { type: 'finish', reason: stop }
  }
}
