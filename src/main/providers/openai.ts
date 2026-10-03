import type { ProviderModel } from '@shared/types'
import { inferCaps, isNonChatModel, prettyModelName } from './caps'
import { argsOrEmptyObject, imageAttachments, repairToolPairs, userText } from './convert'
import { parseSse } from './sse'
import { ThinkSplitter, thinkingBody } from './think'
import { type Provider, ProviderError, type ProviderRequest, type StreamEvent } from './types'

export interface OpenAIConfig {
  id: string
  baseUrl: string
  apiKey: string
  headers: Record<string, string>
}

export function normalizeOpenAIBase(url: string): string {
  let u = (url ?? '').trim().replace(/\/+$/, '')
  if (!u) return u
  try {
    const parsed = new URL(u)
    if (parsed.pathname === '' || parsed.pathname === '/') u = `${parsed.origin}/v1`
  } catch {
    /* leave as typed */
  }
  return u
}

/** OpenAI's reasoning-family models reject temperature/top_p and use max_completion_tokens. */
function isOpenAIReasoning(baseUrl: string, model: string): boolean {
  return /api\.openai\.com/.test(baseUrl) && /^(o\d|gpt-5)/i.test(model)
}

export async function toProviderError(res: Response, hint?: string): Promise<ProviderError> {
  let text = ''
  try {
    text = await res.text()
  } catch {
    /* ignore */
  }
  let msg = text.slice(0, 400)
  try {
    const j = JSON.parse(text)
    msg = j?.error?.message ?? j?.error ?? j?.message ?? j?.detail ?? msg
    if (typeof msg !== 'string') msg = JSON.stringify(msg)
  } catch {
    /* plain text */
  }
  let extra = ''
  if (res.status === 401 || res.status === 403) extra = ' — check the API key for this connection.'
  else if (res.status === 404) extra = ' — endpoint not found; check the base URL (it usually ends in /v1) and the model name.'
  else if (res.status === 400 && /tool|function/i.test(msg)) extra = ' — this model may not support tool calling; turn Tools off for this chat.'
  else if (res.status === 429) extra = ' — rate limited; wait a moment and retry.'
  return new ProviderError(`${hint ? hint + ': ' : ''}HTTP ${res.status}: ${msg || res.statusText}${extra}`, res.status)
}

export class OpenAIProvider implements Provider {
  readonly id: string
  private base: string

  constructor(private cfg: OpenAIConfig) {
    this.id = cfg.id
    this.base = normalizeOpenAIBase(cfg.baseUrl)
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', ...this.cfg.headers }
    if (this.cfg.apiKey) h.Authorization = `Bearer ${this.cfg.apiKey}`
    return h
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    const res = await fetch(`${this.base}/models`, { headers: this.headers(), signal: signal ?? AbortSignal.timeout(15000) })
    if (!res.ok) throw await toProviderError(res, 'Listing models failed')
    const j = (await res.json()) as any
    const arr: any[] = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : []
    const out: ProviderModel[] = []
    for (const m of arr) {
      const id: string = m?.id ?? m?.name ?? m?.model
      if (!id || typeof id !== 'string') continue
      if (isNonChatModel(id)) continue
      const caps = inferCaps(id, 'openai')
      // OpenRouter-style metadata
      const inputs: string[] | undefined = m?.architecture?.input_modalities
      if (Array.isArray(inputs)) caps.vision = inputs.includes('image')
      if (Array.isArray(m?.supported_parameters)) caps.tools = m.supported_parameters.includes('tools')
      const ctx = m?.context_length ?? m?.max_context_length ?? m?.context_window
      out.push({
        id,
        name: m?.name && typeof m.name === 'string' && m.name !== id ? m.name : prettyModelName(id),
        contextLength: typeof ctx === 'number' ? ctx : undefined,
        ...caps
      })
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  private async buildMessages(req: ProviderRequest): Promise<unknown[]> {
    const out: unknown[] = []
    if (req.system) out.push({ role: 'system', content: req.system })
    for (const m of repairToolPairs(req.messages)) {
      if (m.role === 'user') {
        const text = userText(m)
        const imgs = imageAttachments(m)
        if (imgs.length === 0) {
          out.push({ role: 'user', content: text })
        } else {
          const parts: unknown[] = []
          if (text) parts.push({ type: 'text', text })
          for (const a of imgs) {
            const loaded = await req.loadAttachment(a)
            if (loaded) parts.push({ type: 'image_url', image_url: { url: `data:${loaded.mime};base64,${loaded.base64}` } })
          }
          out.push({ role: 'user', content: parts.length ? parts : text })
        }
      } else if (m.role === 'assistant') {
        const msg: Record<string, unknown> = { role: 'assistant', content: m.content || (m.toolCalls?.length ? null : '') }
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: argsOrEmptyObject(tc.arguments) }
          }))
        }
        out.push(msg)
      } else if (m.role === 'tool') {
        out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content || '(no output)' })
      }
    }
    return out
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const reasoningModel = isOpenAIReasoning(this.base, req.model)
    const body: Record<string, unknown> = {
      model: req.model,
      messages: await this.buildMessages(req),
      stream: true,
      stream_options: { include_usage: true }
    }
    if (!reasoningModel) {
      if (req.params.temperature !== undefined) body.temperature = req.params.temperature
      if (req.params.topP !== undefined) body.top_p = req.params.topP
    }
    if (req.params.maxTokens && req.params.maxTokens > 0) {
      body[reasoningModel ? 'max_completion_tokens' : 'max_tokens'] = req.params.maxTokens
    }
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }))
    }
    Object.assign(body, thinkingBody({ baseUrl: this.base, model: req.modelHint ?? req.model, thinking: req.thinking }))

    const res = await fetch(`${this.base}/chat/completions`, {
      method: 'POST',
      headers: { ...this.headers(), Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: req.signal
    })
    if (!res.ok) throw await toProviderError(res)
    if (!res.body) throw new ProviderError('The server returned an empty response body')

    const splitter = new ThinkSplitter()
    let toolCounter = 0
    const toolIndexMap = new Map<number, number>()
    let finish: string | undefined

    for await (const msg of parseSse(res.body, req.signal)) {
      if (msg.data === '[DONE]') break
      let json: any
      try {
        json = JSON.parse(msg.data)
      } catch {
        continue
      }
      if (json?.error) {
        const m = typeof json.error === 'string' ? json.error : (json.error.message ?? JSON.stringify(json.error))
        throw new ProviderError(m)
      }
      const choice = json?.choices?.[0]
      const delta = choice?.delta
      if (delta) {
        const reasoning: string | undefined = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', text: reasoning }
        if (typeof delta.content === 'string' && delta.content) {
          const s = splitter.push(delta.content)
          if (s.reasoning) yield { type: 'reasoning', text: s.reasoning }
          if (s.text) yield { type: 'text', text: s.text }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (let i = 0; i < delta.tool_calls.length; i++) {
            const tc = delta.tool_calls[i]
            const upstreamIndex: number = typeof tc.index === 'number' ? tc.index : i
            let idx = toolIndexMap.get(upstreamIndex)
            if (idx === undefined) {
              idx = toolCounter++
              toolIndexMap.set(upstreamIndex, idx)
            }
            let args: string | undefined
            const rawArgs = tc.function?.arguments
            if (typeof rawArgs === 'string') args = rawArgs
            else if (rawArgs && typeof rawArgs === 'object') args = JSON.stringify(rawArgs)
            yield { type: 'tool_call', index: idx, id: tc.id || undefined, name: tc.function?.name || undefined, args }
          }
        }
      }
      if (choice?.finish_reason) finish = choice.finish_reason
      const usage = json?.usage
      const timings = json?.timings
      if (usage || timings) {
        yield {
          type: 'usage',
          promptTokens: usage?.prompt_tokens ?? timings?.prompt_n,
          completionTokens: usage?.completion_tokens ?? timings?.predicted_n,
          tokensPerSecond: typeof timings?.predicted_per_second === 'number' ? timings.predicted_per_second : undefined
        }
      }
    }
    const tail = splitter.flush()
    if (tail.reasoning) yield { type: 'reasoning', text: tail.reasoning }
    if (tail.text) yield { type: 'text', text: tail.text }
    yield { type: 'finish', reason: finish }
  }
}
