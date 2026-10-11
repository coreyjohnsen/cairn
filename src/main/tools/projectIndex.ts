import { BUILTIN_TOOL_DEFAULTS } from '@shared/defaults'
import type { CodeIndex } from '../codeindex/index'
import { LANG_NAME, type SymbolKind } from '../codeindex/languages'
import { ToolError, type ToolContext, type ToolImpl, num, str } from './types'

const D = BUILTIN_TOOL_DEFAULTS
const KINDS: SymbolKind[] = ['function', 'method', 'class', 'interface', 'type', 'enum', 'struct', 'trait', 'module', 'object', 'const']

async function ready(ctx: ToolContext): Promise<CodeIndex> {
  if (!ctx.workspace) throw new ToolError('There is no workspace folder, so there is no project to look through. Ask the user to choose one.')
  const idx = ctx.services.codeIndex(ctx.workspace)
  await idx.refresh()
  if (ctx.signal.aborted) throw new ToolError('Cancelled')
  return idx
}

const label = (parent: string | undefined, name: string): string => (parent ? `${parent}.${name}` : name)

/**
 * Tools that look things up in the project's index (what is defined where, what a file contains, who uses a name) instead of
 * searching text blindly. They answer in a few lines, so they cost far less of the model's memory than reading files.
 */
export function projectIndexTools(): ToolImpl[] {
  const tools: ToolImpl[] = []

  tools.push({
    name: 'find_symbol',
    description:
      'Look up where a function, class, type, constant or method is DEFINED in the project, by name (a part of a name works too; "Class.method" narrows it). Answers in a few lines with file and line number. Use it BEFORE writing something new, to see whether the project already has it, and before changing something, to find it. For where a name is USED, call find_usages.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name, or part of it' },
        kind: { type: 'string', enum: KINDS, description: 'Only this kind of definition' },
        max_results: { type: 'integer', description: 'Default 25' }
      },
      required: ['name']
    },
    source: 'builtin',
    group: 'Project index',
    defaultPermission: D.find_symbol,
    async execute(args, ctx) {
      const name = str(args, 'name')
      const kind = str(args, 'kind', false)
      if (kind && !KINDS.includes(kind as SymbolKind)) throw new ToolError(`kind must be one of ${KINDS.join(', ')}.`)
      const idx = await ready(ctx)
      const limit = Math.max(1, Math.min(100, Math.floor(num(args, 'max_results', 25))))
      const found = idx.find(name, { kind: (kind || undefined) as SymbolKind | undefined, limit: limit + 1 })
      const { files } = idx.stats()
      if (found.length === 0) {
        return { content: `No definition matches "${name}" among ${files} indexed source files. It may be named differently: try a shorter part of the name, or search_files for the text. The index understands ${Object.values(LANG_NAME).join(', ')}.` }
      }
      const shown = found.slice(0, limit)
      const lines = shown.map((m) => `${m.rel}:${m.line}  ${m.kind} ${label(m.parent, m.name)}${m.exported ? '' : ' (not exported)'}\n    ${m.sig}`)
      if (found.length > limit) lines.push(`… more matches; narrow the name or set kind.`)
      return { content: lines.join('\n') }
    }
  })

  tools.push({
    name: 'file_outline',
    description:
      'Show what one file defines (functions, classes, methods with line numbers), which project files it imports and which import it. Much cheaper than reading the whole file: use it to see what a file is for and to find the line to read.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path relative to the workspace' } },
      required: ['path']
    },
    source: 'builtin',
    group: 'Project index',
    defaultPermission: D.file_outline,
    async execute(args, ctx) {
      const p = str(args, 'path')
      const idx = await ready(ctx)
      const f = idx.entry(p)
      if (!f) throw new ToolError(`"${p}" is not in the project index. It may not exist, be a type of file the index does not read, be too large, or be inside a skipped folder (node_modules, dist, build …). Use find_files or read_file.`)
      const out: string[] = [`${f.rel}  (${LANG_NAME[f.lang]}, ${f.lines} lines)`]
      if (f.uses.length) out.push(`Imports (project files): ${f.uses.join(', ')}`)
      const external = f.imports.filter((i) => !/^[./]/.test(i)).slice(0, 8)
      if (external.length) out.push(`Other imports: ${external.join(', ')}`)
      const by = idx.importers(f.rel)
      out.push(by.length ? `Imported by ${by.length} file${by.length === 1 ? '' : 's'}: ${by.slice(0, 15).join(', ')}${by.length > 15 ? ', …' : ''}` : 'Not imported by any other indexed file.')
      if (f.symbols.length === 0) out.push('No definitions found (the file may only contain statements, or be written in a way the index does not read). Use read_file.')
      else {
        out.push('Defines:')
        for (const s of f.symbols) out.push(`  ${s.line}: ${s.parent ? '  ' : ''}${s.kind} ${label(undefined, s.name)}${s.exported ? '' : ' (not exported)'} — ${s.sig}`)
      }
      return { content: out.join('\n') }
    }
  })

  tools.push({
    name: 'find_usages',
    description:
      'Find the lines that use a name (a function, class, variable …) anywhere in the project, as a whole word, with the definition marked. Use it before renaming, moving or deleting something, to find everything that must change with it.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact name' },
        max_results: { type: 'integer', description: 'Default 40' }
      },
      required: ['name']
    },
    source: 'builtin',
    group: 'Project index',
    defaultPermission: D.find_usages,
    async execute(args, ctx) {
      const name = str(args, 'name').trim()
      if (!name) throw new ToolError('name must not be empty.')
      const idx = await ready(ctx)
      const max = Math.max(1, Math.min(200, Math.floor(num(args, 'max_results', 40))))
      const { usages, filesRead, capped } = await idx.usages(name, max)
      if (usages.length === 0) return { content: `"${name}" does not appear as a whole word in the ${filesRead} indexed source files.` }
      const lines = usages.map((u) => `${u.rel}:${u.line}${u.def ? '  [definition]' : ''}  ${u.text}`)
      const files = new Set(usages.map((u) => u.rel)).size
      lines.push(capped ? `… stopped at ${usages.length} lines in ${files} files; there may be more.` : `${usages.length} lines in ${files} files.`)
      return { content: lines.join('\n') }
    }
  })

  return tools
}
