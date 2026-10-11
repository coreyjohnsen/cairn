import fsp from 'node:fs/promises'
import path from 'node:path'
import { BUILTIN_TOOL_DEFAULTS, newId } from '@shared/defaults'
import { MAX_PLAN_STEPS, applyPlanUpdate, planText } from '@shared/plan'
import type { CustomToolConfig } from '@shared/types'
import { makeDiff, previewNewFile } from '../util/diff'
import { notesTarget } from '../agent/notes'
import { TOOL_NAME_RE, customToolImpl } from './custom'
import { type ApprovalPreview, ToolError, type ToolImpl, num, str } from './types'

const D = BUILTIN_TOOL_DEFAULTS
const NOTES_MAX_WRITE = 20000

/** Tools for working in an organised way: the plan, the project notes, and (only after /tool) making a new tool. */
export function planningTools(): ToolImpl[] {
  const tools: ToolImpl[] = []

  tools.push({
    name: 'update_plan',
    description:
      'Write down or update the plan for the current job. Use it BEFORE writing code for anything that touches more than one or two files, and keep it current: mark a step "doing" when you start it and "done" when it is finished. Send the complete list of steps every time. Each step must be SMALL: one file, or one section of a larger file, finished in one or two tool calls, and it names that file or area. Never put a whole app in one step. The "design" says which file is responsible for what, how the parts interact, and how it will be tested. The plan is shown to you on every request, even after the conversation is summarized.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'One or two sentences: what the job is and what done looks like.' },
        design: { type: 'string', description: 'Markdown: files and what each is responsible for, how they interact, what is reused from what already exists, and the test cases.' },
        steps: {
          type: 'array',
          description: `The full list of steps, in order (at most ${MAX_PLAN_STEPS}).`,
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The step, naming the file or area.' },
              status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'] }
            },
            required: ['text']
          }
        }
      }
    },
    source: 'builtin',
    group: 'Planning',
    defaultPermission: D.update_plan,
    async execute(args, ctx) {
      const out = applyPlanUpdate(ctx.conversation.plan, { goal: args.goal, design: args.design, steps: args.steps })
      if ('error' in out) throw new ToolError(out.error)
      ctx.services.setPlan(out.plan)
      return { content: `Plan saved.\n${planText(out.plan, false)}` }
    }
  })

  tools.push({
    name: 'update_project_notes',
    description:
      'Add to or rewrite the project notes file (CAIRN.md in the workspace), which every chat in this folder starts from. Keep it short and factual: what the project is, how to build and test it, where things live (which file is responsible for what), conventions, and decisions that should not be undone. Use "append" to add a section and "replace" to rewrite the whole file. Update it when you add a module or settle a convention, so later work reuses it instead of building a second one.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Markdown to add, or the whole new file.' },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'Default "append".' }
      },
      required: ['content']
    },
    source: 'builtin',
    group: 'Planning',
    defaultPermission: D.update_project_notes,
    async describe(args, ctx): Promise<ApprovalPreview> {
      if (!ctx.workspace) throw new ToolError('There is no workspace folder to keep notes in. Ask the user to choose one.')
      const { file, existing } = await notesTarget(ctx.workspace)
      const next = nextNotes(existing, args)
      return { kind: 'write', title: `${existing === null ? 'Create' : 'Update'} ${file}`, path: path.join(ctx.workspace, file), diff: existing === null ? previewNewFile(next) : makeDiff(existing, next) }
    },
    async execute(args, ctx) {
      if (!ctx.workspace) throw new ToolError('There is no workspace folder to keep notes in. Ask the user to choose one.')
      const { file, abs, existing } = await notesTarget(ctx.workspace)
      const next = nextNotes(existing, args)
      await fsp.writeFile(abs, next, 'utf8')
      return { content: `${existing === null ? 'Created' : 'Updated'} ${file} (${next.split('\n').length} lines).` }
    }
  })

  tools.push({
    name: 'create_tool',
    description:
      'Make a new tool for yourself. Only available when the user started their message with /tool. The tool is saved with the user\'s other custom tools and used from then on. Kinds: "javascript" (code that is the body of an async function with `args` and `require`, and returns the result), "command" (runs a program; {{name}} in file and args is replaced by arguments), "http" (calls a URL; {{name}} is replaced in the url, headers and body). The user sees the whole definition and must approve it. Keep tools small and single-purpose, and check that the name and the purpose are not already covered by an existing tool.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Letters, digits, "_" or "-", starting with a letter or "_".' },
        description: { type: 'string', description: 'What the tool does and when to use it. This is what you will read later when choosing it.' },
        parameters: { type: 'object', description: 'JSON Schema (type "object") of the arguments the tool takes.' },
        kind: { type: 'string', enum: ['javascript', 'command', 'http'] },
        code: { type: 'string', description: 'kind javascript: the function body.' },
        file: { type: 'string', description: 'kind command: the program to run.' },
        args: { type: 'array', items: { type: 'string' }, description: 'kind command: its arguments.' },
        cwd: { type: 'string', description: 'kind command: working folder, relative to the workspace.' },
        url: { type: 'string', description: 'kind http: the address.' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        headers: { type: 'object', description: 'kind http: headers.' },
        body: { type: 'string', description: 'kind http: request body.' },
        timeout_sec: { type: 'integer', description: 'Seconds before it is stopped (default 30).' }
      },
      required: ['name', 'description', 'kind']
    },
    source: 'builtin',
    group: 'Planning',
    defaultPermission: D.create_tool,
    describe(args, ctx): ApprovalPreview {
      const cfg = buildToolConfig(args, ctx.services.toolNames())
      return { kind: 'generic', title: `Create a new tool: ${cfg.name}`, diff: toolPreview(cfg), reason: toolRisk(cfg), forceApproval: true }
    },
    execute(args, ctx) {
      const cfg = buildToolConfig(args, ctx.services.toolNames())
      ctx.services.addCustomTool(cfg)
      return Promise.resolve({ content: `Created the tool "${cfg.name}". It asks the user before each run. You can use it from now on.` })
    }
  })

  return tools
}

function nextNotes(existing: string | null, args: Record<string, unknown>): string {
  const content = str(args, 'content').replace(/\r\n/g, '\n').trim()
  if (!content) throw new ToolError('content must not be empty.')
  if (content.length > NOTES_MAX_WRITE) throw new ToolError(`content is too long (${content.length} characters). Keep the notes short.`)
  const mode = str(args, 'mode', false) === 'replace' ? 'replace' : 'append'
  if (mode === 'replace' || !existing?.trim()) return `${content}\n`
  return `${existing.trimEnd()}\n\n${content}\n`
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

/** The tool the assistant described, checked. Throws in words the assistant can act on. */
export function buildToolConfig(args: Record<string, unknown>, taken: string[]): CustomToolConfig {
  const name = str(args, 'name').trim()
  if (!TOOL_NAME_RE.test(name)) throw new ToolError('name must start with a letter or underscore and contain only letters, digits, "_" or "-" (at most 64).')
  if (taken.includes(name)) throw new ToolError(`A tool called "${name}" already exists. Use it, or choose a different name.`)
  const description = str(args, 'description').trim()
  if (description.length < 10) throw new ToolError('description must say what the tool does and when to use it.')
  const params = args.parameters
  const parameters = params === undefined || params === null || params === '' ? '' : typeof params === 'string' ? params : JSON.stringify(params, null, 2)
  const timeoutSec = Math.max(1, Math.min(300, Math.round(num(args, 'timeout_sec', 30))))
  const kind = str(args, 'kind')
  let impl: CustomToolConfig['impl']
  if (kind === 'javascript') {
    const code = str(args, 'code')
    if (!code.trim()) throw new ToolError('code is required for a javascript tool.')
    try {
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => unknown
      new AsyncFunction('args', 'ctx', 'require', code)
    } catch (e) {
      throw new ToolError(`The code has a syntax error: ${(e as Error).message}`)
    }
    impl = { type: 'javascript', code, timeoutSec }
  } else if (kind === 'command') {
    const file = str(args, 'file').trim()
    if (!file) throw new ToolError('file is required for a command tool.')
    const a = args.args
    if (a !== undefined && (!Array.isArray(a) || a.some((x) => typeof x !== 'string'))) throw new ToolError('args must be a list of strings.')
    impl = { type: 'command', file, args: (a as string[] | undefined) ?? [], cwd: str(args, 'cwd', false) || undefined, timeoutSec }
  } else if (kind === 'http') {
    const url = str(args, 'url').trim()
    if (!/^https?:\/\//i.test(url)) throw new ToolError('url must start with http:// or https://.')
    const method = (str(args, 'method', false) || 'GET').toUpperCase()
    if (!METHODS.includes(method as (typeof METHODS)[number])) throw new ToolError(`method must be one of ${METHODS.join(', ')}.`)
    const headers: Record<string, string> = {}
    if (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) for (const [k, v] of Object.entries(args.headers)) headers[k] = String(v)
    impl = { type: 'http', url, method: method as (typeof METHODS)[number], headers, body: str(args, 'body', false) || undefined, timeoutSec }
  } else throw new ToolError('kind must be "javascript", "command" or "http".')
  const cfg: CustomToolConfig = { id: newId('tool_'), name, description, enabled: true, parameters, permission: 'ask', impl }
  const check = customToolImpl(cfg)
  if (!check.tool) throw new ToolError(check.error ?? 'The tool definition is not valid.')
  return cfg
}

function toolPreview(cfg: CustomToolConfig): string {
  const lines = [`name: ${cfg.name}`, `description: ${cfg.description}`, `kind: ${cfg.impl.type}`]
  if (cfg.parameters) lines.push('parameters:', ...cfg.parameters.split('\n').map((l) => `  ${l}`))
  const i = cfg.impl
  if (i.type === 'javascript') lines.push('code:', ...i.code.split('\n').map((l) => `  ${l}`))
  else if (i.type === 'command') lines.push(`run: ${[i.file, ...i.args].join(' ')}`, ...(i.cwd ? [`in: ${i.cwd}`] : []))
  else lines.push(`call: ${i.method} ${i.url}`, ...(i.body ? ['body:', ...i.body.split('\n').map((l) => `  ${l}`)] : []))
  lines.push(`stops after: ${i.timeoutSec}s`, 'asks you before each run')
  return lines.map((l) => `+ ${l}`).join('\n')
}

function toolRisk(cfg: CustomToolConfig): string {
  if (cfg.impl.type === 'javascript') return 'This code can read and write files and run programs on this computer whenever the tool is used. Read it before allowing.'
  if (cfg.impl.type === 'command') return 'This tool runs a program on this computer whenever it is used.'
  return 'This tool sends requests over the network whenever it is used.'
}
