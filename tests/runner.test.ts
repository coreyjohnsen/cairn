import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApprovalManager } from '../src/main/agent/approvals'
import { ChatRunner, type RunnerDeps } from '../src/main/agent/runner'
import { ConversationStore } from '../src/main/conversations'
import { OpenAIProvider } from '../src/main/providers/openai'
import { McpManager } from '../src/main/tools/mcp'
import { ToolRegistry } from '../src/main/tools/registry'
import { defaultSettings } from '../src/shared/defaults'
import type { ChatEvent, ImageRef, Settings } from '../src/shared/types'
import { type MockServer, type ScriptedTurn, startMockOpenAI } from './helpers/mockOpenAI'

let dir: string
let ws: string
let server: MockServer | null = null
let events: ChatEvent[]
let settings: Settings
let approvals: ApprovalManager
let store: ConversationStore
let imageCalls: any[]

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-run-'))
  ws = path.join(dir, 'ws')
  fs.mkdirSync(ws)
  settings = defaultSettings(path.join(dir, 'models'))
  settings.agent.workspace = ws
  events = []
  imageCalls = []
  approvals = new ApprovalManager()
  store = new ConversationStore(path.join(dir, 'conv'))
  await store.init()
})
afterEach(async () => {
  await server?.close()
  server = null
  fs.rmSync(dir, { recursive: true, force: true })
})

async function setup(script: ScriptedTurn[], opts: { tools?: boolean; image?: boolean; contextTokens?: number } = {}) {
  server = await startMockOpenAI(script)
  const provider = new OpenAIProvider({ id: 'p', baseUrl: server.url, apiKey: '', headers: {} })
  const mcp = new McpManager(() => settings)
  const deps: RunnerDeps = {
    getSettings: () => settings,
    setToolPermission: (name, perm) => {
      settings.agent.toolPermissions = { ...settings.agent.toolPermissions, [name]: perm }
    },
    conversations: store,
    models: {
      resolve: async () => ({
        option: { ref: 'p::mock-model', providerId: 'p', providerName: 'P', id: 'mock-model', name: 'Mock', caps: { tools: opts.tools ?? true } },
        provider,
        contextTokens: opts.contextTokens ?? 8192
      })
    },
    tools: new ToolRegistry(() => settings, mcp),
    approvals,
    images: {
      available: () => opts.image ?? false,
      generate: async (req, hooks) => {
        imageCalls.push(req)
        hooks.onProgress(0.5, 'half')
        const ref: ImageRef = { id: 'img1', file: 'img1.png', thumb: 'img1.jpg', prompt: req.prompt, width: 512, height: 512 }
        return [ref]
      }
    },
    attachments: { save: async () => { throw new Error('unused') }, load: async () => null },
    emit: (e) => events.push(e)
  }
  const runner = new ChatRunner(deps)
  const conv = store.create({})
  return { runner, conv }
}

async function waitEnd(conversationId: string, ms = 8000): Promise<Extract<ChatEvent, { type: 'run-end' }>> {
  const t0 = Date.now()
  for (;;) {
    const e = events.find((x) => x.type === 'run-end' && x.conversationId === conversationId)
    if (e) return e as Extract<ChatEvent, { type: 'run-end' }>
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for run-end; events=' + JSON.stringify(events.map((e) => e.type)))
    await new Promise((r) => setTimeout(r, 15))
  }
}
async function waitApproval() {
  const t0 = Date.now()
  for (;;) {
    const e = events.find((x) => x.type === 'approval')
    if (e) return (e as Extract<ChatEvent, { type: 'approval' }>).approval
    if (Date.now() - t0 > 5000) throw new Error('no approval requested')
    await new Promise((r) => setTimeout(r, 15))
  }
}

describe('ChatRunner', () => {
  it('plain chat streams, saves the transcript and sets a title', async () => {
    const { runner, conv } = await setup([{ text: ['Hello ', 'there'] }, { text: ['Greeting'] }])
    await runner.send({ conversationId: conv.id, text: 'Say hi to me please' })
    const end = await waitEnd(conv.id)
    expect(end.outcome).toBe('done')
    const c = store.get(conv.id)!
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(c.messages[1].content).toBe('Hello there')
    expect(c.messages[1].usage).toMatchObject({ promptTokens: 11, completionTokens: 7 })
    expect(events.some((e) => e.type === 'delta')).toBe(true)
    // auto-title request is the second scripted turn
    await new Promise((r) => setTimeout(r, 200))
    expect(store.get(conv.id)!.title).toBe('Greeting')
  })

  it('runs a tool call end-to-end (auto permission) and feeds the result back', async () => {
    settings.agent.toolPermissions = { write_file: 'auto' }
    const { runner, conv } = await setup([
      { toolCalls: [{ id: 'call_a', name: 'write_file', args: '{"path":"notes/hello.txt","content":"hi from the model"}' }] },
      { text: ['Done — I created the file.'] }
    ])
    await runner.send({ conversationId: conv.id, text: 'create notes/hello.txt' })
    expect((await waitEnd(conv.id)).outcome).toBe('done')
    expect(fs.readFileSync(path.join(ws, 'notes/hello.txt'), 'utf8')).toBe('hi from the model')
    const c = store.get(conv.id)!
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(c.messages[1].toolCalls?.[0].name).toBe('write_file')
    expect(c.messages[2].content).toMatch(/Created/)
    expect(c.messages[3].content).toContain('Done')
    // the second request included the tool result and the tool definitions
    const second = server!.requests[1].messages
    expect(second.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call_a')).toBe(true)
    expect(server!.requests[0].tools.map((t: any) => t.function.name)).toContain('edit_file')
    expect(server!.requests[0].messages[0].content).toContain(ws)
  })

  it('asks for approval, and a denial reaches the model without running the tool', async () => {
    const { runner, conv } = await setup([
      { toolCalls: [{ id: 'c1', name: 'write_file', args: '{"path":"danger.txt","content":"x"}' }] },
      { text: ['Understood, I will not write it.'] }
    ])
    await runner.send({ conversationId: conv.id, text: 'write danger.txt' })
    const approval = await waitApproval()
    expect(approval).toMatchObject({ toolName: 'write_file', kind: 'write', title: 'Create danger.txt' })
    expect(approval.diff).toContain('+x')
    approvals.resolve(approval.id, 'deny')
    expect((await waitEnd(conv.id)).outcome).toBe('done')
    expect(fs.existsSync(path.join(ws, 'danger.txt'))).toBe(false)
    const tool = store.get(conv.id)!.messages.find((m) => m.role === 'tool')!
    expect(tool.denied).toBe(true)
    expect(server!.requests[1].messages.find((m: any) => m.role === 'tool').content).toMatch(/declined/)
  })

  it('"always allow" upgrades the permission and "allow for chat" skips later prompts', async () => {
    const { runner, conv } = await setup([
      { toolCalls: [{ id: 'c1', name: 'write_file', args: '{"path":"a.txt","content":"1"}' }] },
      { toolCalls: [{ id: 'c2', name: 'write_file', args: '{"path":"b.txt","content":"2"}' }] },
      { text: ['ok'] }
    ])
    await runner.send({ conversationId: conv.id, text: 'two files' })
    const first = await waitApproval()
    approvals.resolve(first.id, 'allow-chat')
    expect((await waitEnd(conv.id)).outcome).toBe('done')
    expect(events.filter((e) => e.type === 'approval')).toHaveLength(1)
    expect(fs.existsSync(path.join(ws, 'b.txt'))).toBe(true)
  })

  it('aborting while an approval is pending ends the run as aborted', async () => {
    const { runner, conv } = await setup([{ toolCalls: [{ id: 'c1', name: 'run_command', args: '{"command":"echo hi"}' }] }, { text: ['x'] }])
    await runner.send({ conversationId: conv.id, text: 'run it' })
    await waitApproval()
    runner.abort(conv.id)
    expect((await waitEnd(conv.id)).outcome).toBe('aborted')
    expect(runner.isRunning(conv.id)).toBe(false)
  })

  it('reports unknown tools and bad JSON back to the model instead of crashing', async () => {
    const { runner, conv } = await setup([
      { toolCalls: [{ id: 'u1', name: 'does_not_exist', args: '{}' }, { id: 'u2', name: 'read_file', args: 'garbage' }] },
      { text: ['sorry'] }
    ])
    await runner.send({ conversationId: conv.id, text: 'hi' })
    expect((await waitEnd(conv.id)).outcome).toBe('done')
    const tools = store.get(conv.id)!.messages.filter((m) => m.role === 'tool')
    expect(tools[0].content).toMatch(/Unknown tool/)
    expect(tools[1].content).toMatch(/Could not parse/)
    expect(tools.every((t) => t.isError)).toBe(true)
  })

  it('surfaces provider errors in the transcript', async () => {
    const { runner, conv } = await setup([{ error: { status: 500, body: { error: { message: 'model exploded' } } } }])
    await runner.send({ conversationId: conv.id, text: 'hi' })
    const end = await waitEnd(conv.id)
    expect(end.outcome).toBe('error')
    expect(end.error).toMatch(/model exploded/)
    const last = store.get(conv.id)!.messages.at(-1)!
    expect(last.status).toBe('error')
  })

  it('stops after the configured number of agent steps', async () => {
    settings.chat.maxAgentSteps = 3
    settings.agent.toolPermissions = { list_directory: 'auto' }
    const { runner, conv } = await setup([{ toolCalls: [{ id: 'l', name: 'list_directory', args: '{}' }] }])
    await runner.send({ conversationId: conv.id, text: 'loop' })
    await waitEnd(conv.id)
    const notice = store.get(conv.id)!.messages.at(-1)!
    expect(notice.notice).toMatch(/Stopped after 3/)
  })

  it('keeps going past 25 tool calls when steps are set to 0, and stops again when set to a number', async () => {
    settings.chat.maxAgentSteps = 0
    settings.agent.toolPermissions = { list_directory: 'auto' }
    const turns: ScriptedTurn[] = Array.from({ length: 30 }, () => ({ toolCalls: [{ id: 'l', name: 'list_directory', args: '{}' }] }))
    turns.push({ text: ['all done'] })
    const { runner, conv } = await setup(turns)
    await runner.send({ conversationId: conv.id, text: 'keep going' })
    const end = await waitEnd(conv.id, 20000)
    expect(end.outcome).toBe('done')
    const msgs = store.get(conv.id)!.messages
    expect(msgs.filter((m) => m.role === 'tool')).toHaveLength(30)
    expect(msgs.at(-1)!.content).toBe('all done')
    expect(msgs.some((m) => m.notice)).toBe(false)
  }, 30000)

  it('sends a long tool result whole when the limit is 0, and cuts the middle only when a limit is set', async () => {
    fs.writeFileSync(path.join(ws, 'long.txt'), 'abcdefghij'.repeat(5000)) // 50000 characters on one line
    settings.agent.toolPermissions = { read_file: 'auto' }
    settings.chat.toolOutputLimit = 0
    const a = await setup([{ toolCalls: [{ id: 'r', name: 'read_file', args: '{"path":"long.txt"}' }] }, { text: ['ok'] }], { contextTokens: 200000 })
    await a.runner.send({ conversationId: a.conv.id, text: 'read it' })
    await waitEnd(a.conv.id)
    const whole = store.get(a.conv.id)!.messages.find((m) => m.role === 'tool')!
    expect(whole.content).not.toMatch(/omitted/)
    expect(whole.content.length).toBeGreaterThan(50000)
    await server?.close()

    events = []
    settings.chat.toolOutputLimit = 3000
    const b = await setup([{ toolCalls: [{ id: 'r', name: 'read_file', args: '{"path":"long.txt"}' }] }, { text: ['ok'] }])
    await b.runner.send({ conversationId: b.conv.id, text: 'read it' })
    await waitEnd(b.conv.id)
    const cut = store.get(b.conv.id)!.messages.find((m) => m.role === 'tool')!
    expect(cut.content.length).toBeLessThanOrEqual(3000)
    expect(cut.content).toMatch(/longer than the tool output limit/)
  })

  it('with a small context, a file read comes back in pieces the model can actually see, instead of being trimmed to a stub', async () => {
    fs.writeFileSync(path.join(ws, 'big.txt'), Array.from({ length: 444 }, (_, i) => `line ${i + 1} ${'x'.repeat(45)}`).join('\n')) // about 23,000 characters
    settings.agent.toolPermissions = { read_file: 'auto' }
    settings.chat.toolOutputLimit = 0
    const { runner, conv } = await setup([{ toolCalls: [{ id: 'r', name: 'read_file', args: '{"path":"big.txt"}' }] }, { text: ['ok'] }], { contextTokens: 8192 })
    await runner.send({ conversationId: conv.id, text: 'read big.txt' })
    await waitEnd(conv.id)
    // What the model was actually sent on its second request.
    const sent = server!.requests[1].messages.find((m: { role: string }) => m.role === 'tool')
    expect(sent.content).toContain('line 1 ')
    expect(sent.content).toMatch(/offset=\d+ to continue/)
    expect(sent.content).not.toMatch(/truncated/)
    expect(sent.content.length).toBeGreaterThan(1500)
    // The next piece starts exactly where this one stopped.
    const next = Number(/offset=(\d+) to continue/.exec(sent.content)![1])
    const lastShown = [...sent.content.matchAll(/^\s*(\d+)\t/gm)].map((m) => Number(m[1])).at(-1)
    expect(next).toBe((lastShown ?? 0) + 1)
  })

  it('routes /imagine and image requests for tool-less models straight to the image generator', async () => {
    const { runner, conv } = await setup([{ text: ['unused'] }], { image: true, tools: false })
    await runner.send({ conversationId: conv.id, text: 'Generate an image of a glacier at dusk' })
    await waitEnd(conv.id)
    expect(imageCalls[0].prompt).toBe('a glacier at dusk')
    expect(server!.requests.length).toBe(0)
    const c = store.get(conv.id)!
    const tool = c.messages.find((m) => m.role === 'tool')!
    expect(tool.images?.[0].id).toBe('img1')
  })

  it('lets tool-capable models call generate_image', async () => {
    settings.agent.toolPermissions = { generate_image: 'auto' }
    const { runner, conv } = await setup(
      [{ toolCalls: [{ id: 'g1', name: 'generate_image', args: '{"prompt":"a red barn in snow","count":2}' }] }, { text: ['Here you go!'] }],
      { image: true }
    )
    await runner.send({ conversationId: conv.id, text: 'show me a red barn in snow' })
    await waitEnd(conv.id)
    expect(imageCalls[0]).toMatchObject({ prompt: 'a red barn in snow', count: 2, source: 'chat', conversationId: conv.id })
    expect(store.get(conv.id)!.messages.find((m) => m.role === 'tool')?.images).toHaveLength(1)
    expect(server!.requests[0].tools.map((t: any) => t.function.name)).toContain('generate_image')
  })

  it('regenerate replays from the last user message', async () => {
    const { runner, conv } = await setup([{ text: ['first'] }, { text: ['t'] }, { text: ['second'] }, { text: ['t'] }])
    await runner.send({ conversationId: conv.id, text: 'question' })
    await waitEnd(conv.id)
    events.length = 0
    await runner.regenerate(conv.id)
    await waitEnd(conv.id)
    const c = store.get(conv.id)!
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(c.messages[1].content).toBe('second')
  })
})
