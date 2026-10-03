import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApprovalManager } from '../src/main/agent/approvals'
import { ChatRunner, type RunnerDeps } from '../src/main/agent/runner'
import { ConversationStore } from '../src/main/conversations'
import { LocalProvider } from '../src/main/engines/local-provider'
import { OpenAIProvider } from '../src/main/providers/openai'
import { isLocalHost, thinkingBody } from '../src/main/providers/think'
import type { StreamEvent } from '../src/main/providers/types'
import { McpManager } from '../src/main/tools/mcp'
import { ToolRegistry } from '../src/main/tools/registry'
import { defaultSettings } from '../src/shared/defaults'
import { suggestModelName } from '../src/shared/naming'
import type { ChatEvent, Settings } from '../src/shared/types'
import { type MockServer, type ScriptedTurn, startMockOpenAI } from './helpers/mockOpenAI'

describe('thinkingBody', () => {
  it('sends nothing unless a choice was made', () => {
    expect(thinkingBody({ baseUrl: 'http://127.0.0.1:8080/v1', model: 'm' })).toEqual({})
  })

  it('uses chat_template_kwargs for servers on this machine or network', () => {
    for (const base of ['http://127.0.0.1:8080/v1', 'http://localhost:1234/v1', 'http://192.168.1.20:8000/v1', 'http://[::1]:5001/v1', 'http://box.local:8000/v1']) {
      expect(thinkingBody({ baseUrl: base, model: 'qwen3', thinking: 'off' })).toEqual({ chat_template_kwargs: { enable_thinking: false, thinking: false } })
      expect(thinkingBody({ baseUrl: base, model: 'qwen3', thinking: 'on' })).toEqual({ chat_template_kwargs: { enable_thinking: true, thinking: true } })
    }
  })

  it('asks gpt-oss for the lowest effort, since it cannot be switched off', () => {
    expect(thinkingBody({ baseUrl: 'http://127.0.0.1:8080/v1', model: 'C:\\models\\gpt-oss-20b-Q4_K_M.gguf', thinking: 'off' })).toEqual({
      chat_template_kwargs: { enable_thinking: false, thinking: false, reasoning_effort: 'low' }
    })
  })

  it('speaks Ollama and OpenRouter in their own terms', () => {
    expect(thinkingBody({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3', thinking: 'off' })).toEqual({ reasoning_effort: 'none' })
    expect(thinkingBody({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3', thinking: 'on' })).toEqual({})
    expect(thinkingBody({ baseUrl: 'https://openrouter.ai/api/v1', model: 'x/y', thinking: 'off' })).toEqual({ reasoning: { enabled: false } })
    expect(thinkingBody({ baseUrl: 'https://openrouter.ai/api/v1', model: 'x/y', thinking: 'on' })).toEqual({ reasoning: { enabled: true } })
  })

  it('never adds unknown fields for other cloud servers', () => {
    for (const base of ['https://api.openai.com/v1', 'https://api.x.ai/v1', 'https://api.groq.com/openai/v1', 'https://generativelanguage.googleapis.com/v1beta/openai']) {
      expect(thinkingBody({ baseUrl: base, model: 'm', thinking: 'off' })).toEqual({})
    }
  })

  it('recognises private addresses only', () => {
    expect(isLocalHost('10.0.0.4')).toBe(true)
    expect(isLocalHost('172.20.1.1')).toBe(true)
    expect(isLocalHost('172.32.1.1')).toBe(false)
    expect(isLocalHost('8.8.8.8')).toBe(false)
    expect(isLocalHost('example.com')).toBe(false)
  })
})

describe('OpenAIProvider thinking', () => {
  let server: MockServer | null = null
  afterEach(async () => {
    await server?.close()
    server = null
  })

  const run = async (extra: Partial<Parameters<OpenAIProvider['stream']>[0]>) => {
    server = await startMockOpenAI([{ text: ['ok'] }])
    const p = new OpenAIProvider({ id: 'x', baseUrl: server.url, apiKey: '', headers: {} })
    const events: StreamEvent[] = []
    for await (const e of p.stream({
      model: 'm',
      system: '',
      messages: [{ id: '1', role: 'user', createdAt: 0, content: 'hi' }],
      tools: [],
      params: {},
      signal: new AbortController().signal,
      loadAttachment: async () => null,
      ...extra
    })) events.push(e)
    return server.requests[0]
  }

  it('turns thinking off or on for a server on this machine', async () => {
    expect((await run({ thinking: 'off' })).chat_template_kwargs).toEqual({ enable_thinking: false, thinking: false })
    await server?.close()
    expect((await run({ thinking: 'on' })).chat_template_kwargs).toEqual({ enable_thinking: true, thinking: true })
  })

  it('leaves the request alone when thinking is auto', async () => {
    const body = await run({})
    expect(body).not.toHaveProperty('chat_template_kwargs')
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('judges by the real model name when the model id is a placeholder', async () => {
    const body = await run({ model: 'local', modelHint: '/models/gpt-oss-20b-Q4_K_M.gguf', thinking: 'off' })
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false, thinking: false, reasoning_effort: 'low' })
  })
})

describe('naming downloaded models', () => {
  it('names a model after its repository when the file name says nothing', () => {
    expect(suggestModelName('someone/Grok-4.3-GGUF', 'model.gguf')).toBe('Grok-4.3')
    expect(suggestModelName('someone/Grok-4.3-GGUF', 'model-Q4_K_M.gguf')).toBe('Grok-4.3 Q4_K_M')
    expect(suggestModelName('someone/Grok-4.3-GGUF', 'Q8_0/model-00001-of-00004.gguf')).toBe('Grok-4.3 Q8_0')
    expect(suggestModelName('someone/Grok-4.3_gguf', 'ggml-model-f16.gguf')).toBe('Grok-4.3 F16')
  })

  it('keeps descriptive file names as they are', () => {
    expect(suggestModelName('Qwen/Qwen3-8B-GGUF', 'Qwen3-8B-Q4_K_M.gguf')).toBeUndefined()
    expect(suggestModelName('unsloth/gemma-3-12b-it-GGUF', 'gemma-3-12b-it-Q4_K_M.gguf')).toBeUndefined()
    expect(suggestModelName('a/b', 'modelling-tool-Q4_K_M.gguf')).toBeUndefined()
  })
})

describe('ChatRunner thinking', () => {
  let dir: string
  let server: MockServer | null = null
  let events: ChatEvent[]
  let settings: Settings
  let store: ConversationStore

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-think-'))
    settings = defaultSettings(path.join(dir, 'models'))
    events = []
    store = new ConversationStore(path.join(dir, 'conv'))
    await store.init()
  })
  afterEach(async () => {
    await server?.close()
    server = null
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function ask(script: ScriptedTurn[], params: { thinking?: 'auto' | 'on' | 'off' }, defaultMode: 'auto' | 'on' | 'off') {
    settings.chat.thinking = defaultMode
    settings.chat.autoTitle = false
    server = await startMockOpenAI(script)
    const provider = new OpenAIProvider({ id: 'p', baseUrl: server.url, apiKey: '', headers: {} })
    const mcp = new McpManager(() => settings)
    const deps: RunnerDeps = {
      getSettings: () => settings,
      setToolPermission: () => {},
      conversations: store,
      models: { resolve: async () => ({ option: { ref: 'p::m', providerId: 'p', providerName: 'P', id: 'm', name: 'M', caps: { tools: true } }, provider, contextTokens: 8192 }) },
      tools: new ToolRegistry(() => settings, mcp),
      approvals: new ApprovalManager(),
      images: { available: () => false, generate: async () => [] },
      attachments: { save: async () => { throw new Error('unused') }, load: async () => null },
      emit: (e) => events.push(e)
    }
    const runner = new ChatRunner(deps)
    const conv = store.create({ params })
    await runner.send({ conversationId: conv.id, text: 'hello there' })
    const t0 = Date.now()
    while (!events.some((e) => e.type === 'run-end')) {
      if (Date.now() - t0 > 8000) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 15))
    }
    return server.requests[0]
  }

  it('uses the default from Settings', async () => {
    const body = await ask([{ text: ['ok'] }], {}, 'off')
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false, thinking: false })
  })

  it('lets one chat override the default, including back to auto', async () => {
    const on = await ask([{ text: ['ok'] }], { thinking: 'on' }, 'off')
    expect(on.chat_template_kwargs).toEqual({ enable_thinking: true, thinking: true })
    await server?.close()
    events = []
    const auto = await ask([{ text: ['ok'] }], { thinking: 'auto' }, 'off')
    expect(auto).not.toHaveProperty('chat_template_kwargs')
  })
})

describe('LocalProvider thinking', () => {
  it('asks for the engine to be started with thinking off, only when Off is chosen', async () => {
    const server = await startMockOpenAI([{ text: ['ok'] }, { text: ['ok'] }])
    try {
      const calls: unknown[] = []
      const llama = { acquire: async (_m: string, opts: { noThink?: boolean }) => (calls.push({ noThink: opts.noThink }), { base: server.url.replace(/\/v1$/, ''), release() {} }) }
      const p = new LocalProvider({ getSettings: () => defaultSettings('/m'), modelsDir: () => '/m', llama: llama as never })
      const go = async (thinking?: 'on' | 'off') => {
        for await (const _ of p.stream({ model: '/m/x.gguf', system: '', messages: [{ id: '1', role: 'user', createdAt: 0, content: 'hi' }], tools: [], params: {}, thinking, signal: new AbortController().signal, loadAttachment: async () => null })) void _
      }
      await go('off')
      await go(undefined)
      expect(calls).toEqual([{ noThink: true }, { noThink: false }])
    } finally {
      await server.close()
    }
  })
})

import { guessImageFolder } from '../src/shared/naming'
describe('guessImageFolder', () => {
  it.each([
    ['ae.safetensors', 'black-forest-labs/FLUX.1-schnell', 335_000_000, 'image/vae'],
    ['sdxl_vae.safetensors', 'stabilityai/sdxl-vae', 335_000_000, 'image/vae'],
    ['vae-ft-mse-840000-ema-pruned.safetensors', 'stabilityai/sd-vae-ft-mse-original', 334_000_000, 'image/vae'],
    ['sd_xl_base_1.0_0.9vae.safetensors', 'stabilityai/stable-diffusion-xl-base-1.0', 6_900_000_000, 'image'],
    ['juggernautXL_vae.safetensors', 'x/y', 6_000_000_000, 'image'],
    ['RealESRGAN_x4plus.pth', 'ai-forever/Real-ESRGAN', 67_000_000, 'image/upscale'],
    ['4x-UltraSharp.pth', 'lokCX/4x-Ultrasharp', 67_000_000, 'image/upscale'],
    ['pytorch_lora_weights.safetensors', 'someone/flux-lora-pixel', 100_000_000, 'image/lora'],
    ['add-detail-xl.safetensors', 'someone/detail-lora', 100_000_000, 'image/lora'],
    ['t5xxl_fp8_e4m3fn.safetensors', 'comfyanonymous/flux_text_encoders', 5_000_000_000, 'image/text-encoders'],
    ['clip_l.safetensors', 'comfyanonymous/flux_text_encoders', 246_000_000, 'image/text-encoders'],
    ['Qwen3-4B-Q8_0.gguf', 'unsloth/Qwen3-4B-GGUF', 4_000_000_000, 'image/text-encoders'],
    ['flux1-dev-Q4_K_S.gguf', 'city96/FLUX.1-dev-gguf', 6_000_000_000, 'image'],
    ['z_image_turbo-Q8_0.gguf', 'leejet/Z-Image-Turbo-GGUF', 7_000_000_000, 'image']
  ])('%s -> %s', (file, repo, size, folder) => expect(guessImageFolder(file, repo, size)).toBe(folder))
})
