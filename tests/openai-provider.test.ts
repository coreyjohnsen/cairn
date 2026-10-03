import { afterEach, describe, expect, it } from 'vitest'
import { OpenAIProvider, normalizeOpenAIBase } from '../src/main/providers/openai'
import type { StreamEvent } from '../src/main/providers/types'
import { type MockServer, startMockOpenAI } from './helpers/mockOpenAI'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

const msg = (content: string) => ({ id: '1', role: 'user' as const, createdAt: 0, content })

async function run(provider: OpenAIProvider, extra: Partial<Parameters<OpenAIProvider['stream']>[0]> = {}) {
  const events: StreamEvent[] = []
  for await (const e of provider.stream({
    model: 'mock-model',
    system: 'sys',
    messages: [msg('hello')],
    tools: [],
    params: { temperature: 0.5, maxTokens: 100 },
    signal: new AbortController().signal,
    loadAttachment: async () => null,
    ...extra
  })) events.push(e)
  return events
}

describe('OpenAIProvider', () => {
  it('streams text, reasoning and usage', async () => {
    server = await startMockOpenAI([{ reasoning: ['hmm'], text: ['Hel', 'lo'] }])
    const p = new OpenAIProvider({ id: 'x', baseUrl: server.url, apiKey: 'k', headers: {} })
    const ev = await run(p)
    expect(ev.filter((e) => e.type === 'text').map((e: any) => e.text).join('')).toBe('Hello')
    expect(ev.find((e) => e.type === 'reasoning')).toMatchObject({ text: 'hmm' })
    expect(ev.find((e) => e.type === 'usage')).toMatchObject({ promptTokens: 11, completionTokens: 7 })
    const body = server.requests[0]
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(body.temperature).toBe(0.5)
    expect(body.max_tokens).toBe(100)
    expect(body.stream).toBe(true)
  })

  it('accumulates streamed tool-call arguments', async () => {
    server = await startMockOpenAI([{ toolCalls: [{ id: 'call_1', name: 'read_file', args: '{"path":"a.txt"}' }] }])
    const p = new OpenAIProvider({ id: 'x', baseUrl: server.url, apiKey: '', headers: {} })
    const ev = await run(p, { tools: [{ name: 'read_file', description: 'd', parameters: { type: 'object', properties: {} } }] })
    const calls = ev.filter((e) => e.type === 'tool_call') as Extract<StreamEvent, { type: 'tool_call' }>[]
    expect(calls[0]).toMatchObject({ index: 0, id: 'call_1', name: 'read_file' })
    expect(calls.map((c) => c.args ?? '').join('')).toBe('{"path":"a.txt"}')
    expect(server.requests[0].tools[0].function.name).toBe('read_file')
  })

  it('turns HTTP errors into helpful messages', async () => {
    server = await startMockOpenAI([{ error: { status: 401, body: { error: { message: 'bad key' } } } }])
    const p = new OpenAIProvider({ id: 'x', baseUrl: server.url, apiKey: 'k', headers: {} })
    await expect(run(p)).rejects.toThrow(/401.*bad key.*API key/)
  })

  it('lists chat models and filters embeddings', async () => {
    server = await startMockOpenAI([{ text: ['x'] }])
    const p = new OpenAIProvider({ id: 'x', baseUrl: server.url, apiKey: '', headers: {} })
    const models = await p.listModels()
    expect(models.map((m) => m.id)).toEqual(['mock-model', 'mock-vision-vl'])
    expect(models.find((m) => m.id === 'mock-vision-vl')?.vision).toBe(true)
  })

  it('sends tool results back in OpenAI format and repairs dangling calls', async () => {
    server = await startMockOpenAI([{ text: ['ok'] }])
    const p = new OpenAIProvider({ id: 'x', baseUrl: server.url, apiKey: '', headers: {} })
    await run(p, {
      messages: [
        msg('go'),
        { id: '2', role: 'assistant', createdAt: 0, content: '', toolCalls: [{ id: 'c1', name: 't', arguments: '' }, { id: 'c2', name: 't', arguments: '{}' }] },
        { id: '3', role: 'tool', createdAt: 0, content: 'result', toolCallId: 'c1', toolName: 't' }
      ]
    })
    const sent = server.requests[0].messages
    expect(sent[2].tool_calls[0].function.arguments).toBe('{}')
    expect(sent.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id)).toEqual(['c1', 'c2'])
  })
})

describe('normalizeOpenAIBase', () => {
  it('appends /v1 only for bare origins', () => {
    expect(normalizeOpenAIBase('http://localhost:11434')).toBe('http://localhost:11434/v1')
    expect(normalizeOpenAIBase('http://localhost:11434/')).toBe('http://localhost:11434/v1')
    expect(normalizeOpenAIBase('https://openrouter.ai/api/v1/')).toBe('https://openrouter.ai/api/v1')
  })
})
