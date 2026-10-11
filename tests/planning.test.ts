import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApprovalManager } from '../src/main/agent/approvals'
import { messageTokens } from '../src/main/agent/context'
import { toolsForMode } from '../src/main/agent/modes'
import { readNotes } from '../src/main/agent/notes'
import { buildSystemPrompt } from '../src/main/agent/prompt'
import { CodeIndexRegistry } from '../src/main/codeindex/index'
import { ChatRunner, type RunnerDeps } from '../src/main/agent/runner'
import { ConversationStore } from '../src/main/conversations'
import { OpenAIProvider } from '../src/main/providers/openai'
import { McpManager } from '../src/main/tools/mcp'
import { buildToolConfig, planningTools } from '../src/main/tools/planning'
import { ToolRegistry } from '../src/main/tools/registry'
import { COMMANDS, matchCommands, parseCommand } from '../src/shared/commands'
import { defaultSettings } from '../src/shared/defaults'
import { applyPlanUpdate, planProgress, planReminder, planText } from '../src/shared/plan'
import type { ChatEvent, ConversationPlan, CustomToolConfig, Settings } from '../src/shared/types'
import { makeCtx } from './helpers/ctx'
import { type MockServer, type ScriptedTurn, startMockOpenAI } from './helpers/mockOpenAI'

describe('slash commands', () => {
  it('reads a command and its text', () => {
    expect(parseCommand('/plan build a snake game')).toEqual({ id: 'plan', text: 'build a snake game' })
    expect(parseCommand('  /BUILD ')).toEqual({ id: 'build', text: '' })
    expect(parseCommand('/tool a tool that\nconverts csv to json')).toEqual({ id: 'tool', text: 'a tool that\nconverts csv to json' })
  })

  it('leaves everything else as ordinary text', () => {
    expect(parseCommand('please /plan this')).toBeNull()
    expect(parseCommand('/usr/bin/env')).toBeNull()
    expect(parseCommand('/imagine a cat')).toBeNull()
    expect(parseCommand('/planet')).toBeNull()
  })

  it('suggests commands while one is being typed', () => {
    expect(matchCommands('/').length).toBe(COMMANDS.length)
    expect(matchCommands('/pl').map((c) => c.id)).toEqual(['plan'])
    expect(matchCommands('/plan x')).toEqual([])
    expect(matchCommands('hello')).toEqual([])
  })
})

describe('plan updates', () => {
  it('builds a plan from steps, naming them in order', () => {
    const r = applyPlanUpdate(undefined, { goal: 'Add export', steps: [{ text: 'Write src/export.ts', status: 'doing' }, 'Test it', { text: 'Wire up the button', status: 'in progress' }] }, 5)
    if ('error' in r) throw new Error(r.error)
    expect(r.plan.steps.map((s) => [s.id, s.status])).toEqual([['s1', 'doing'], ['s2', 'todo'], ['s3', 'todo']])
    expect(planProgress(r.plan)).toEqual({ done: 0, total: 3 })
  })

  it('keeps the goal and design when only the steps are sent', () => {
    const first = applyPlanUpdate(undefined, { goal: 'G', design: '# D', steps: ['a'] }) as { plan: ConversationPlan }
    const next = applyPlanUpdate(first.plan, { steps: [{ text: 'a', status: 'done' }] }) as { plan: ConversationPlan }
    expect(next.plan.goal).toBe('G')
    expect(next.plan.design).toBe('# D')
    expect(next.plan.steps[0].status).toBe('done')
  })

  it('explains what is wrong instead of saving a bad update', () => {
    expect(applyPlanUpdate(undefined, {})).toHaveProperty('error')
    expect(applyPlanUpdate(undefined, { steps: 'x' })).toHaveProperty('error')
    expect(applyPlanUpdate(undefined, { steps: [{ status: 'done' }] })).toHaveProperty('error')
    expect(applyPlanUpdate(undefined, { steps: Array.from({ length: 41 }, (_, i) => `s${i}`) })).toHaveProperty('error')
  })

  it('allows one step in progress at a time and prints the plan for the model', () => {
    const r = applyPlanUpdate(undefined, { goal: 'G', steps: [{ text: 'a', status: 'doing' }, { text: 'b', status: 'doing' }, { text: 'c', status: 'done' }] }) as { plan: ConversationPlan }
    expect(r.plan.steps.map((s) => s.status)).toEqual(['doing', 'todo', 'done'])
    const text = planText(r.plan)
    expect(text).toContain('Goal: G')
    expect(text).toContain('1. [>] a')
    expect(text).toContain('3. [x] c')
  })
})

describe('plan reminders', () => {
  const plan = (statuses: ('todo' | 'doing' | 'done')[]): ConversationPlan => ({ goal: 'G', steps: statuses.map((status, i) => ({ id: `s${i + 1}`, text: `Step ${i + 1}`, status })), updatedAt: 1 })

  it('names the step in progress', () => {
    expect(planReminder(plan(['done', 'doing', 'todo']))).toContain('step 2 of 3 is in progress: "Step 2"')
  })

  it('asks for a step to be marked when none is', () => {
    expect(planReminder(plan(['done', 'todo', 'todo']))).toContain('none is marked in progress')
  })

  it('says nothing without a plan or once it is finished', () => {
    expect(planReminder(undefined)).toBe('')
    expect(planReminder(plan([]))).toBe('')
    expect(planReminder(plan(['done', 'done']))).toBe('')
  })
})

describe('planning tools', () => {
  let ws: string
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-plan-'))
  })
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }))
  const tool = (name: string) => planningTools().find((t) => t.name === name)!

  it('update_plan saves the plan through the chat', async () => {
    const ctx = makeCtx(ws)
    let saved: ConversationPlan | undefined
    ctx.services.setPlan = (p) => {
      saved = p
    }
    const out = await tool('update_plan').execute({ goal: 'G', steps: [{ text: 'a', status: 'doing' }] }, ctx)
    expect(saved?.steps).toHaveLength(1)
    expect(out.content).toContain('[>] a')
    await expect(tool('update_plan').execute({ steps: 'nope' }, ctx)).rejects.toThrow(/list/)
  })

  it('update_project_notes creates, appends and replaces CAIRN.md', async () => {
    const ctx = makeCtx(ws)
    const t = tool('update_project_notes')
    await t.execute({ content: '# Notes\nfirst' }, ctx)
    expect(fs.readFileSync(path.join(ws, 'CAIRN.md'), 'utf8')).toBe('# Notes\nfirst\n')
    await t.execute({ content: 'second' }, ctx)
    expect(fs.readFileSync(path.join(ws, 'CAIRN.md'), 'utf8')).toBe('# Notes\nfirst\n\nsecond\n')
    await t.execute({ content: 'only this', mode: 'replace' }, ctx)
    expect(fs.readFileSync(path.join(ws, 'CAIRN.md'), 'utf8')).toBe('only this\n')
    const preview = await t.describe!({ content: 'x' }, ctx)
    expect(preview.diff).toContain('+x')
    await expect(t.execute({ content: '  ' }, ctx)).rejects.toThrow(/empty/)
    await expect(t.execute({ content: 'x' }, makeCtx(null))).rejects.toThrow(/workspace/)
  })

  it('update_project_notes writes to an existing AGENTS.md rather than adding a second notes file', async () => {
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'old\n')
    await tool('update_project_notes').execute({ content: 'new' }, makeCtx(ws))
    expect(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8')).toBe('old\n\nnew\n')
    expect(fs.existsSync(path.join(ws, 'CAIRN.md'))).toBe(false)
  })

  it('reads the notes file, shortened when it is long', async () => {
    expect(await readNotes(ws)).toBeNull()
    fs.writeFileSync(path.join(ws, 'CAIRN.md'), `# Project\n${'x'.repeat(9000)}`)
    const n = await readNotes(ws)
    expect(n?.file).toBe('CAIRN.md')
    expect(n?.cut).toBe(true)
    expect(n!.text.length).toBeLessThan(8300)
  })
})

describe('create_tool', () => {
  const base = { name: 'csv_to_json', description: 'Convert CSV text into JSON rows.', kind: 'javascript', code: 'return args.text.split("\\n")', parameters: { type: 'object', properties: { text: { type: 'string' } } } }

  it('turns a description into a custom tool that asks before each run', () => {
    const cfg = buildToolConfig(base, ['read_file'])
    expect(cfg).toMatchObject({ name: 'csv_to_json', enabled: true, permission: 'ask', impl: { type: 'javascript' } })
    expect(JSON.parse(cfg.parameters).properties.text.type).toBe('string')
  })

  it('refuses names in use, bad names, broken code and bad addresses', () => {
    expect(() => buildToolConfig(base, ['csv_to_json'])).toThrow(/already exists/)
    expect(() => buildToolConfig({ ...base, name: '1 bad' }, [])).toThrow(/name/)
    expect(() => buildToolConfig({ ...base, code: 'return (' }, [])).toThrow(/syntax/)
    expect(() => buildToolConfig({ ...base, description: 'short' }, [])).toThrow(/description/)
    expect(() => buildToolConfig({ ...base, kind: 'http', url: 'ftp://x' }, [])).toThrow(/url/)
    expect(() => buildToolConfig({ name: 'ping', description: 'Call the status page.', kind: 'http', url: 'https://example.com/{{id}}' }, [])).not.toThrow()
  })

  it('always asks the user, whatever the tool permission says, and shows the code', async () => {
    const t = planningTools().find((x) => x.name === 'create_tool')!
    const preview = await t.describe!(base, makeCtx(null))
    expect(preview.forceApproval).toBe(true)
    expect(preview.diff).toContain('code:')
    expect(preview.reason).toMatch(/read and write files/)
  })
})

describe('what each command may use', () => {
  const names = (settings: Settings, mode?: Parameters<typeof toolsForMode>[0], allow: string[] = []) =>
    toolsForMode(mode, new ToolRegistry(() => settings, new McpManager(() => settings)).forRun(false, { allow })).map((t) => t.name)

  it('keeps create_tool out unless it is asked for', () => {
    const s = defaultSettings('/tmp/m')
    expect(names(s)).not.toContain('create_tool')
    expect(names(s, undefined, ['create_tool'])).toContain('create_tool')
    expect(names(s)).toContain('update_plan')
  })

  it('lets /plan look and plan but not change files or run commands', () => {
    const list = names(defaultSettings('/tmp/m'), 'plan')
    expect(list).toContain('read_file')
    expect(list).toContain('update_plan')
    for (const n of ['write_file', 'edit_file', 'delete_path', 'move_path', 'run_command']) expect(list).not.toContain(n)
  })

  it('lets /review use commands to read the git history', () => {
    const list = names(defaultSettings('/tmp/m'), 'review')
    expect(list).toContain('run_command')
    expect(list).not.toContain('write_file')
  })
})

describe('system prompt', () => {
  const conv = { id: 'c', title: 't', createdAt: 0, updatedAt: 0, toolsEnabled: true, params: {}, messages: [] as never[] }
  const settings = defaultSettings('/tmp/m')
  const tools = () => new ToolRegistry(() => settings, new McpManager(() => settings)).forRun(false)

  it('tells the model how to work, shows the notes and the plan, and the command', () => {
    const plan: ConversationPlan = { goal: 'Ship export', steps: [{ id: 's1', text: 'Write src/export.ts', status: 'doing' }], design: 'export.ts owns CSV', updatedAt: 1 }
    const p = buildSystemPrompt(settings, { ...conv, plan }, tools(), '/ws', { notes: { file: 'CAIRN.md', abs: '/ws/CAIRN.md', text: 'Use pnpm.', cut: false }, mode: 'build' })
    expect(p).toContain('## How to work')
    expect(p).toContain('never make a second file')
    expect(p).toContain('## Project notes (CAIRN.md)')
    expect(p).toContain('Use pnpm.')
    expect(p).toContain('1. [>] Write src/export.ts')
    expect(p).toContain('export.ts owns CSV')
    expect(p).toContain('BUILD MODE')
  })

  it('stays short when there is nothing to add', () => {
    const p = buildSystemPrompt(settings, conv, tools(), '/ws')
    expect(p).not.toContain('Current plan')
    expect(p).not.toContain('Project notes')
    expect(p).not.toContain('## This message')
  })
})

/* ───────────── through the runner ───────────── */

let dir: string
let ws: string
let server: MockServer | null = null
let events: ChatEvent[]
let settings: Settings
let approvals: ApprovalManager
let store: ConversationStore
let added: CustomToolConfig[]

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-cmd-'))
  ws = path.join(dir, 'ws')
  fs.mkdirSync(ws)
  settings = defaultSettings(path.join(dir, 'models'))
  settings.agent.workspace = ws
  events = []
  added = []
  approvals = new ApprovalManager()
  store = new ConversationStore(path.join(dir, 'conv'))
  await store.init()
})
afterEach(async () => {
  await server?.close()
  server = null
  fs.rmSync(dir, { recursive: true, force: true })
})

async function setup(script: ScriptedTurn[]) {
  server = await startMockOpenAI(script)
  const provider = new OpenAIProvider({ id: 'p', baseUrl: server.url, apiKey: '', headers: {} })
  const deps: RunnerDeps = {
    getSettings: () => settings,
    addCustomTool: (cfg) => {
      added.push(cfg)
      settings.customTools = [...settings.customTools, cfg]
    },
    setToolPermission: () => {},
    codeIndex: new CodeIndexRegistry(),
    conversations: store,
    models: { resolve: async () => ({ option: { ref: 'p::m', providerId: 'p', providerName: 'P', id: 'm', name: 'Mock', caps: { tools: true } }, provider, contextTokens: 16384 }) },
    tools: new ToolRegistry(() => settings, new McpManager(() => settings)),
    approvals,
    images: { available: () => false, generate: async () => [] },
    attachments: { save: async () => { throw new Error('unused') }, load: async () => null },
    emit: (e) => events.push(e)
  }
  const runner = new ChatRunner(deps)
  return { runner, conv: store.create({}) }
}

async function waitEnd(id: string) {
  const t0 = Date.now()
  for (;;) {
    const e = events.find((x) => x.type === 'run-end' && x.conversationId === id)
    if (e) return e
    if (Date.now() - t0 > 8000) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 15))
  }
}
const toolNames = (req: any): string[] => (req.tools ?? []).map((t: any) => t.function.name)
const systemOf = (req: any): string => req.messages[0].content

describe('commands in a chat', () => {
  it('/plan offers only looking and planning tools, stores the request without the command, and saves the plan', async () => {
    const { runner, conv } = await setup([
      { toolCalls: [{ id: 'c1', name: 'update_plan', args: JSON.stringify({ goal: 'Snake game', design: 'game.ts owns state', steps: [{ text: 'Write game.ts', status: 'todo' }] }) }] },
      { text: ['Plan is ready. Say /build to start.'] },
      { text: ['Title'] }
    ])
    await runner.send({ conversationId: conv.id, text: '/plan a snake game' })
    expect(((await waitEnd(conv.id)) as any).outcome).toBe('done')
    const first = server!.requests[0]
    expect(toolNames(first)).toContain('update_plan')
    expect(toolNames(first)).not.toContain('write_file')
    expect(toolNames(first)).not.toContain('create_tool')
    expect(systemOf(first)).toContain('PLANNING MODE')
    const c = store.get(conv.id)!
    expect(c.messages[0]).toMatchObject({ role: 'user', content: 'a snake game', command: 'plan' })
    expect(c.plan?.goal).toBe('Snake game')
    expect(events.some((e) => e.type === 'plan' && e.plan?.steps.length === 1)).toBe(true)
  })

  it('/build then works from the saved plan with all the usual tools', async () => {
    const { runner, conv } = await setup([{ text: ['Starting.'] }, { text: ['T'] }])
    store.get(conv.id)!.plan = { goal: 'Snake game', steps: [{ id: 's1', text: 'Write game.ts', status: 'todo' }], updatedAt: 1 }
    await runner.send({ conversationId: conv.id, text: '/build' })
    await waitEnd(conv.id)
    const first = server!.requests[0]
    expect(toolNames(first)).toContain('write_file')
    expect(systemOf(first)).toContain('BUILD MODE')
    expect(systemOf(first)).toContain('1. [ ] Write game.ts')
    expect(store.get(conv.id)!.messages[0].content).toBe('Go ahead and build it.')
  })

  it('an ordinary message never gets create_tool and the model cannot make one', async () => {
    const { runner, conv } = await setup([
      { toolCalls: [{ id: 'c1', name: 'create_tool', args: JSON.stringify({ name: 'sneaky', description: 'Does things quietly.', kind: 'javascript', code: 'return 1' }) }] },
      { text: ['Could not.'] },
      { text: ['T'] }
    ])
    await runner.send({ conversationId: conv.id, text: 'make yourself a tool' })
    await waitEnd(conv.id)
    expect(toolNames(server!.requests[0])).not.toContain('create_tool')
    expect(added).toHaveLength(0)
    const result = store.get(conv.id)!.messages.find((m) => m.role === 'tool')!
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/Unknown tool/)
  })

  it('/tool offers create_tool, shows the user the tool, and saves it once approved, ready for the next request', async () => {
    const { runner, conv } = await setup([
      { toolCalls: [{ id: 'c1', name: 'create_tool', args: JSON.stringify({ name: 'word_count', description: 'Count the words in some text.', kind: 'javascript', code: 'return String(args.text.split(/\\s+/).length)', parameters: { type: 'object', properties: { text: { type: 'string' } } } }) }] },
      { text: ['Made word_count.'] },
      { text: ['T'] }
    ])
    await runner.send({ conversationId: conv.id, text: '/tool count words in text' })
    const t0 = Date.now()
    let approval: any
    while (!(approval = events.find((e) => e.type === 'approval'))) {
      if (Date.now() - t0 > 5000) throw new Error('no approval')
      await new Promise((r) => setTimeout(r, 15))
    }
    expect(approval.approval.title).toContain('word_count')
    expect(approval.approval.diff).toContain('code:')
    expect(added).toHaveLength(0)
    approvals.resolve(approval.approval.id, 'allow')
    await waitEnd(conv.id)
    expect(toolNames(server!.requests[0])).toContain('create_tool')
    expect(added.map((a) => a.name)).toEqual(['word_count'])
    // The follow-up request already has the new tool.
    expect(toolNames(server!.requests[1])).toContain('word_count')
  })

  it('/tool and /plan need something to work on, and tools to be on', async () => {
    const { runner, conv } = await setup([])
    await expect(runner.send({ conversationId: conv.id, text: '/tool' })).rejects.toThrow(/after \/tool/)
    await expect(runner.send({ conversationId: conv.id, text: '/plan' })).rejects.toThrow(/after \/plan/)
    await expect(runner.send({ conversationId: conv.id, text: '/build', noTools: true })).rejects.toThrow(/tools/)
    store.update(conv.id, { toolsEnabled: false })
    await expect(runner.send({ conversationId: conv.id, text: '/build' })).rejects.toThrow(/Turn tools on/)
    expect(store.get(conv.id)!.messages).toHaveLength(0)
  })

  it('shows the project notes to the model at the start of a chat', async () => {
    fs.writeFileSync(path.join(ws, 'CAIRN.md'), '# Notes\nTests live in tests/.')
    const { runner, conv } = await setup([{ text: ['ok'] }, { text: ['T'] }])
    await runner.send({ conversationId: conv.id, text: 'hello' })
    await waitEnd(conv.id)
    expect(systemOf(server!.requests[0])).toContain('Tests live in tests/.')
  })
})

describe('keeping to the plan', () => {
  it('reminds the model of the step it is on after it changes a file', async () => {
    settings.agent.toolPermissions = { write_file: 'auto' }
    const { runner, conv } = await setup([
      { toolCalls: [{ id: 'c1', name: 'write_file', args: JSON.stringify({ path: 'a.txt', content: 'x' }) }] },
      { text: ['ok'] },
      { text: ['T'] }
    ])
    store.get(conv.id)!.plan = { goal: 'G', steps: [{ id: 's1', text: 'Write a.txt', status: 'doing' }, { id: 's2', text: 'Write b.txt', status: 'todo' }], updatedAt: 1 }
    await runner.send({ conversationId: conv.id, text: 'go' })
    await waitEnd(conv.id)
    const result = store.get(conv.id)!.messages.find((m) => m.role === 'tool')!
    expect(result.content).toContain('Created a.txt')
    expect(result.content).toContain('[Plan: step 1 of 2 is in progress: "Write a.txt"')
    // The model sees it in its next request.
    expect(JSON.stringify(server!.requests[1].messages)).toContain('Stay on that step')
  })

  it('does not add reminders without a plan', async () => {
    settings.agent.toolPermissions = { write_file: 'auto' }
    const { runner, conv } = await setup([{ toolCalls: [{ id: 'c1', name: 'write_file', args: JSON.stringify({ path: 'a.txt', content: 'x' }) }] }, { text: ['ok'] }, { text: ['T'] }])
    await runner.send({ conversationId: conv.id, text: 'go' })
    await waitEnd(conv.id)
    expect(store.get(conv.id)!.messages.find((m) => m.role === 'tool')!.content).not.toContain('[Plan')
  })

  // The token limit cut the reply in the middle of a file. Closing the JSON up would write half a file and call it done.
  it('does not write a file whose call was cut off by the token limit', async () => {
    settings.agent.toolPermissions = { write_file: 'auto' }
    const { runner, conv } = await setup([
      { toolCalls: [{ id: 'c1', name: 'write_file', args: '{"path":"big.html","content":"<html><body>half of the pa' }], finish: 'length' },
      { text: ['I will write it in parts.'] },
      { text: ['T'] }
    ])
    await runner.send({ conversationId: conv.id, text: 'build it' })
    await waitEnd(conv.id)
    expect(fs.existsSync(path.join(ws, 'big.html'))).toBe(false)
    const result = store.get(conv.id)!.messages.find((m) => m.role === 'tool')!
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/cut off/)
    expect(result.content).toMatch(/edit_file/)
  })

  it('still runs a complete call when the reply ended at the limit', async () => {
    settings.agent.toolPermissions = { write_file: 'auto' }
    const { runner, conv } = await setup([
      { toolCalls: [{ id: 'c1', name: 'write_file', args: JSON.stringify({ path: 'ok.txt', content: 'whole' }) }], finish: 'length' },
      { text: ['done'] },
      { text: ['T'] }
    ])
    await runner.send({ conversationId: conv.id, text: 'go' })
    await waitEnd(conv.id)
    expect(fs.readFileSync(path.join(ws, 'ok.txt'), 'utf8')).toBe('whole')
  })

  it('does not count the text of a cut-off call, which is not sent back', () => {
    const base = { id: 'm', role: 'assistant' as const, createdAt: 0, content: '' }
    const cut = messageTokens({ ...base, toolCalls: [{ id: 'c', name: 'write_file', arguments: `{"path":"a","content":"${'x'.repeat(30000)}` }] })
    const whole = messageTokens({ ...base, toolCalls: [{ id: 'c', name: 'write_file', arguments: JSON.stringify({ path: 'a', content: 'x'.repeat(30000) }) }] })
    expect(cut).toBeLessThan(100)
    expect(whole).toBeGreaterThan(5000)
  })

  it('asks for small steps and one at a time', () => {
    const tool = planningTools().find((t) => t.name === 'update_plan')!
    expect(tool.description).toMatch(/SMALL/)
    const p = buildSystemPrompt(defaultSettings('/tmp/m'), { id: 'c', title: 't', createdAt: 0, updatedAt: 0, toolsEnabled: true, params: {}, messages: [], plan: { goal: 'G', steps: [{ id: 's1', text: 'a', status: 'doing' }], updatedAt: 1 } }, new ToolRegistry(() => defaultSettings('/tmp/m'), new McpManager(() => defaultSettings('/tmp/m'))).forRun(false), '/ws', { mode: 'build' })
    expect(p).toContain('ONE step at a time')
    expect(p).toContain('skeleton')
  })
})

describe('the project map in a chat', () => {
  it('shows the model what the project defines, and has the index tools', async () => {
    fs.mkdirSync(path.join(ws, 'src'))
    fs.writeFileSync(path.join(ws, 'src/a.ts'), 'export function alpha() {}\n')
    const { runner, conv } = await setup([{ text: ['ok'] }, { text: ['T'] }])
    await runner.send({ conversationId: conv.id, text: 'hello' })
    await waitEnd(conv.id)
    const first = server!.requests[0]
    expect(systemOf(first)).toContain('## Project map')
    expect(systemOf(first)).toContain('src/a.ts: alpha')
    expect(toolNames(first)).toEqual(expect.arrayContaining(['find_symbol', 'file_outline', 'find_usages']))
  })

  it('shows what the model wrote itself in the very next request', async () => {
    settings.agent.toolPermissions = { write_file: 'auto' }
    fs.mkdirSync(path.join(ws, 'src'))
    fs.writeFileSync(path.join(ws, 'src/a.ts'), 'export function alpha() {}\n')
    const { runner, conv } = await setup([
      { toolCalls: [{ id: 'c1', name: 'write_file', args: JSON.stringify({ path: 'src/b.ts', content: 'export function beta() {}\n' }) }] },
      { toolCalls: [{ id: 'c2', name: 'find_symbol', args: JSON.stringify({ name: 'beta' }) }] },
      { text: ['found it'] },
      { text: ['T'] }
    ])
    await runner.send({ conversationId: conv.id, text: 'add beta' })
    await waitEnd(conv.id)
    expect(systemOf(server!.requests[0])).not.toContain('beta')
    expect(systemOf(server!.requests[1])).toContain('src/b.ts: beta')
    const lookup = store.get(conv.id)!.messages.filter((m) => m.role === 'tool')[1]
    expect(lookup.content).toContain('src/b.ts:1  function beta')
  })

  it('leaves the map out when the index tools are switched off', async () => {
    fs.writeFileSync(path.join(ws, 'a.ts'), 'export function alpha() {}\n')
    settings.agent.toolPermissions = { find_symbol: 'deny' }
    const { runner, conv } = await setup([{ text: ['ok'] }, { text: ['T'] }])
    await runner.send({ conversationId: conv.id, text: 'hello' })
    await waitEnd(conv.id)
    expect(systemOf(server!.requests[0])).not.toContain('## Project map')
  })
})
