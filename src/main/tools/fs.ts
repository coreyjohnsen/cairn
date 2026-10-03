import fsp from 'node:fs/promises'
import path from 'node:path'
import { BUILTIN_TOOL_DEFAULTS } from '@shared/defaults'
import { makeDiff, previewNewFile } from '../util/diff'
import { matchGlob } from '../util/glob'
import { outputLimitOf } from '../util/limits'
import { displayPath, resolvePath } from './sandbox'
import { type ApprovalPreview, type ToolContext, ToolError, type ToolImpl, bool, num, str } from './types'

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', '.svn', '.hg'])
const MAX_READ_BYTES = 2 * 1024 * 1024

function resolve(ctx: ToolContext, p: string) {
  return resolvePath(ctx.workspace, p, ctx.settings.agent.allowOutsideWorkspace)
}

function outsideReason(inside: boolean, ctx: ToolContext): string | undefined {
  return inside ? undefined : `Path is outside the workspace${ctx.workspace ? ` (${ctx.workspace})` : ''}`
}

function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

async function* walk(root: string, recursive: boolean, maxDepth = 12): AsyncGenerator<{ abs: string; rel: string; dir: boolean; size: number }> {
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.pop()!
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (e.isDirectory()) {
        yield { abs, rel, dir: true, size: 0 }
        if (recursive && depth < maxDepth && !SKIP_DIRS.has(e.name) && !e.isSymbolicLink()) stack.push({ dir: abs, depth: depth + 1 })
      } else {
        let size = 0
        try {
          size = (await fsp.stat(abs)).size
        } catch {
          /* broken link */
        }
        yield { abs, rel, dir: false, size }
      }
    }
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/* ──────────────── edit planning (shared by describe + execute) ──────────────── */

export interface EditPlan {
  abs: string
  inside: boolean
  before: string
  after: string
  count: number
}

export async function planEdit(args: Record<string, unknown>, ctx: ToolContext): Promise<EditPlan> {
  const p = str(args, 'path')
  const oldStr = str(args, 'old_string')
  const newStr = str(args, 'new_string', false)
  const replaceAll = bool(args, 'replace_all')
  if (oldStr === '') throw new ToolError('old_string must not be empty. To create a file use write_file.')
  if (oldStr === newStr) throw new ToolError('old_string and new_string are identical; nothing to change.')
  const { abs, inside } = resolve(ctx, p)
  let before: string
  try {
    const buf = await fsp.readFile(abs)
    if (isBinary(buf)) throw new ToolError(`${p} looks like a binary file; refusing to edit it as text.`)
    before = buf.toString('utf8')
  } catch (e) {
    if (e instanceof ToolError) throw e
    throw new ToolError(`Cannot read ${p}: ${(e as Error).message}`)
  }
  const crlf = before.includes('\r\n')
  const norm = (s: string) => (crlf && !s.includes('\r\n') ? s.replace(/\n/g, '\r\n') : s)
  const needle = norm(oldStr)
  const replacement = norm(newStr)
  let count = 0
  for (let i = before.indexOf(needle); i >= 0; i = before.indexOf(needle, i + needle.length)) count++
  if (count === 0) {
    throw new ToolError(
      `old_string was not found in ${p}. It must match the file exactly, including whitespace and indentation. Re-read the file and copy the text precisely.`
    )
  }
  if (count > 1 && !replaceAll) {
    throw new ToolError(`old_string appears ${count} times in ${p}. Add more surrounding context to make it unique, or set replace_all to true.`)
  }
  const after = replaceAll ? before.split(needle).join(replacement) : before.replace(needle, () => replacement)
  return { abs, inside, before, after, count: replaceAll ? count : 1 }
}

/* ──────────────── tools ──────────────── */

export function fsTools(): ToolImpl[] {
  const D = BUILTIN_TOOL_DEFAULTS
  const tools: ToolImpl[] = []

  tools.push({
    name: 'list_directory',
    description:
      'List the files and folders in a directory of the workspace. Use "." for the workspace root. Set recursive to true to see nested files (skips .git and node_modules).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to the workspace (default ".")' },
        recursive: { type: 'boolean', description: 'List subdirectories too' },
        max_depth: { type: 'integer', description: 'Maximum recursion depth (default 4)' }
      }
    },
    source: 'builtin',
    group: 'Files',
    defaultPermission: D.list_directory,
    describe: (args, ctx) => {
      const { abs, inside } = resolve(ctx, str(args, 'path', false) || '.')
      return { kind: 'generic', title: `List ${displayPath(ctx.workspace, abs)}`, path: abs, reason: outsideReason(inside, ctx), forceApproval: !inside }
    },
    async execute(args, ctx) {
      const { abs } = resolve(ctx, str(args, 'path', false) || '.')
      const recursive = bool(args, 'recursive')
      const depth = Math.max(1, Math.min(12, num(args, 'max_depth', 4)))
      let st
      try {
        st = await fsp.stat(abs)
      } catch {
        throw new ToolError(`Directory not found: ${displayPath(ctx.workspace, abs)}`)
      }
      if (!st.isDirectory()) throw new ToolError(`Not a directory: ${displayPath(ctx.workspace, abs)}`)
      const lines: string[] = []
      let count = 0
      for await (const e of walk(abs, recursive, depth - 1)) {
        count++
        if (count > 400) {
          lines.push('… (listing truncated at 400 entries)')
          break
        }
        lines.push(e.dir ? `${e.rel}/` : `${e.rel}  (${fmtSize(e.size)})`)
      }
      return { content: lines.length ? lines.join('\n') : '(empty directory)' }
    }
  })

  tools.push({
    name: 'read_file',
    description:
      'Read a text file from the workspace. Output has line numbers (format "  12<tab>text"); do not include the numbers when editing. Use offset/limit to read large files in pieces.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace' },
        offset: { type: 'integer', description: 'First line to read, 1-based (default 1)' },
        limit: { type: 'integer', description: 'Maximum number of lines (default: as many as fit)' }
      },
      required: ['path']
    },
    source: 'builtin',
    group: 'Files',
    defaultPermission: D.read_file,
    describe: (args, ctx) => {
      const { abs, inside } = resolve(ctx, str(args, 'path'))
      return { kind: 'generic', title: `Read ${displayPath(ctx.workspace, abs)}`, path: abs, reason: outsideReason(inside, ctx), forceApproval: !inside }
    },
    async execute(args, ctx) {
      const p = str(args, 'path')
      const { abs } = resolve(ctx, p)
      let st
      try {
        st = await fsp.stat(abs)
      } catch {
        throw new ToolError(`File not found: ${p}`)
      }
      if (st.isDirectory()) throw new ToolError(`${p} is a directory; use list_directory.`)
      const fh = await fsp.open(abs, 'r')
      let buf: Buffer
      try {
        const len = Math.min(st.size, MAX_READ_BYTES)
        buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, 0)
      } finally {
        await fh.close()
      }
      if (isBinary(buf)) throw new ToolError(`${p} appears to be a binary file (${fmtSize(st.size)}); it cannot be read as text.`)
      const lines = buf.toString('utf8').split('\n')
      const offset = Math.max(1, Math.floor(num(args, 'offset', 1)))
      const asked = num(args, 'limit', 0)
      const limit = asked >= 1 ? Math.floor(asked) : Infinity
      const budget = outputLimitOf(ctx)
      // Only as many whole lines as fit the tool output limit are returned, so the reply is never cut in the middle and the
      // "read again from line N" note at the end is always seen. With no limit the whole file comes back.
      const room = Number.isFinite(budget) ? Math.max(200, budget - 160) : Infinity
      const shown: string[] = []
      let used = 0
      let cutLine = false
      for (let i = offset - 1; i < lines.length && shown.length < limit; i++) {
        let text = `${String(i + 1).padStart(6)}\t${lines[i].replace(/\r$/, '')}`
        if (used + text.length + 1 > room) {
          if (shown.length > 0) break
          text = `${text.slice(0, room)} … [this line is longer than the tool output limit and was cut]`
          cutLine = true
        }
        shown.push(text)
        used += text.length + 1
      }
      let out = shown.join('\n')
      const next = offset + shown.length
      const remaining = lines.length - (offset - 1 + shown.length)
      if (remaining > 0) out += `\n… ${remaining} more line(s). Call read_file again with offset=${next} to continue.`
      if (st.size > MAX_READ_BYTES) out += `\n… file is ${fmtSize(st.size)}; only the first ${fmtSize(MAX_READ_BYTES)} were read.`
      return { content: out || '(empty file)' }
    }
  })

  tools.push({
    name: 'write_file',
    description: 'Create a new file or completely overwrite an existing one in the workspace. Parent folders are created automatically. For small changes to an existing file prefer edit_file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace' },
        content: { type: 'string', description: 'Full file contents' }
      },
      required: ['path', 'content']
    },
    source: 'builtin',
    group: 'Files',
    defaultPermission: D.write_file,
    async describe(args, ctx): Promise<ApprovalPreview> {
      const p = str(args, 'path')
      const content = str(args, 'content', false)
      const { abs, inside } = resolve(ctx, p)
      let diff: string
      let existing: string | null = null
      try {
        existing = await fsp.readFile(abs, 'utf8')
      } catch {
        existing = null
      }
      diff = existing === null ? previewNewFile(content) : makeDiff(existing, content)
      return {
        kind: 'write',
        title: `${existing === null ? 'Create' : 'Overwrite'} ${displayPath(ctx.workspace, abs)}`,
        path: abs,
        diff,
        reason: outsideReason(inside, ctx),
        forceApproval: !inside
      }
    },
    async execute(args, ctx) {
      const p = str(args, 'path')
      const content = str(args, 'content', false)
      const { abs } = resolve(ctx, p)
      let existed = true
      try {
        await fsp.access(abs)
      } catch {
        existed = false
      }
      await fsp.mkdir(path.dirname(abs), { recursive: true })
      await fsp.writeFile(abs, content, 'utf8')
      const lines = content === '' ? 0 : content.split('\n').length
      return { content: `${existed ? 'Overwrote' : 'Created'} ${displayPath(ctx.workspace, abs)} (${lines} lines, ${Buffer.byteLength(content)} bytes).` }
    }
  })

  tools.push({
    name: 'edit_file',
    description:
      'Edit an existing file by replacing an exact piece of text. old_string must match the file exactly (whitespace included) and be unique unless replace_all is true. Read the file first so you can copy the text precisely.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace' },
        old_string: { type: 'string', description: 'Exact text to replace' },
        new_string: { type: 'string', description: 'Replacement text (may be empty to delete)' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' }
      },
      required: ['path', 'old_string', 'new_string']
    },
    source: 'builtin',
    group: 'Files',
    defaultPermission: D.edit_file,
    async describe(args, ctx): Promise<ApprovalPreview> {
      const plan = await planEdit(args, ctx)
      return {
        kind: 'edit',
        title: `Edit ${displayPath(ctx.workspace, plan.abs)}${plan.count > 1 ? ` (${plan.count} places)` : ''}`,
        path: plan.abs,
        diff: makeDiff(plan.before, plan.after),
        reason: outsideReason(plan.inside, ctx),
        forceApproval: !plan.inside
      }
    },
    async execute(args, ctx) {
      const plan = await planEdit(args, ctx)
      await fsp.writeFile(plan.abs, plan.after, 'utf8')
      return { content: `Edited ${displayPath(ctx.workspace, plan.abs)} (${plan.count} replacement${plan.count === 1 ? '' : 's'}).` }
    }
  })

  tools.push({
    name: 'search_files',
    description:
      'Search file contents in the workspace with a regular expression (like grep). Returns "path:line: text" matches. Skips binary files, .git and node_modules.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for' },
        path: { type: 'string', description: 'Directory to search (default workspace root)' },
        glob: { type: 'string', description: 'Only search files matching this glob, e.g. "**/*.ts" or "*.md"' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive search' },
        max_results: { type: 'integer', description: 'Maximum matches to return (default 100)' }
      },
      required: ['pattern']
    },
    source: 'builtin',
    group: 'Files',
    defaultPermission: D.search_files,
    describe: (args, ctx) => {
      const { abs, inside } = resolve(ctx, str(args, 'path', false) || '.')
      return { kind: 'generic', title: `Search ${displayPath(ctx.workspace, abs)}`, path: abs, reason: outsideReason(inside, ctx), forceApproval: !inside }
    },
    async execute(args, ctx) {
      const pattern = str(args, 'pattern')
      let re: RegExp
      try {
        re = new RegExp(pattern, bool(args, 'ignore_case') ? 'i' : '')
      } catch (e) {
        throw new ToolError(`Invalid regular expression: ${(e as Error).message}`)
      }
      const { abs } = resolve(ctx, str(args, 'path', false) || '.')
      const glob = str(args, 'glob', false)
      const max = Math.max(1, Math.min(500, Math.floor(num(args, 'max_results', 100))))
      const results: string[] = []
      let filesScanned = 0
      outer: for await (const e of walk(abs, true, 16)) {
        if (ctx.signal.aborted) throw new ToolError('Cancelled')
        if (e.dir || e.size > MAX_READ_BYTES) continue
        if (glob && !matchGlob(glob, e.rel)) continue
        let buf: Buffer
        try {
          buf = await fsp.readFile(e.abs)
        } catch {
          continue
        }
        if (isBinary(buf)) continue
        filesScanned++
        const lines = buf.toString('utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            const text = lines[i].replace(/\r$/, '')
            results.push(`${e.rel}:${i + 1}: ${text.length > 300 ? text.slice(0, 300) + '…' : text}`)
            if (results.length >= max) {
              results.push(`… (stopped at ${max} matches)`)
              break outer
            }
          }
        }
      }
      return { content: results.length ? results.join('\n') : `No matches (${filesScanned} files searched).` }
    }
  })

  tools.push({
    name: 'find_files',
    description: 'Find files in the workspace by name using a glob pattern such as "**/*.py", "src/**/*.{ts,tsx}" or "README*". Patterns without a slash match file names anywhere.',
    parameters: {
      type: 'object',
      properties: {
        glob: { type: 'string', description: 'Glob pattern' },
        path: { type: 'string', description: 'Directory to search (default workspace root)' }
      },
      required: ['glob']
    },
    source: 'builtin',
    group: 'Files',
    defaultPermission: D.find_files,
    describe: (args, ctx) => {
      const { abs, inside } = resolve(ctx, str(args, 'path', false) || '.')
      return { kind: 'generic', title: `Find ${str(args, 'glob')}`, path: abs, reason: outsideReason(inside, ctx), forceApproval: !inside }
    },
    async execute(args, ctx) {
      const glob = str(args, 'glob')
      const { abs } = resolve(ctx, str(args, 'path', false) || '.')
      const out: string[] = []
      for await (const e of walk(abs, true, 16)) {
        if (ctx.signal.aborted) throw new ToolError('Cancelled')
        if (matchGlob(glob, e.rel)) out.push(e.dir ? `${e.rel}/` : e.rel)
        if (out.length >= 300) {
          out.push('… (truncated at 300 results)')
          break
        }
      }
      return { content: out.length ? out.join('\n') : 'No files matched.' }
    }
  })

  tools.push({
    name: 'move_path',
    description: 'Move or rename a file or folder inside the workspace.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Existing path' },
        to: { type: 'string', description: 'New path' }
      },
      required: ['from', 'to']
    },
    source: 'builtin',
    group: 'Files',
    defaultPermission: D.move_path,
    describe: (args, ctx) => {
      const a = resolve(ctx, str(args, 'from'))
      const b = resolve(ctx, str(args, 'to'))
      const inside = a.inside && b.inside
      return {
        kind: 'move',
        title: `Move ${displayPath(ctx.workspace, a.abs)} → ${displayPath(ctx.workspace, b.abs)}`,
        path: a.abs,
        reason: outsideReason(inside, ctx),
        forceApproval: !inside
      }
    },
    async execute(args, ctx) {
      const a = resolve(ctx, str(args, 'from'))
      const b = resolve(ctx, str(args, 'to'))
      try {
        await fsp.access(a.abs)
      } catch {
        throw new ToolError(`Source not found: ${str(args, 'from')}`)
      }
      try {
        await fsp.access(b.abs)
        throw new ToolError(`Destination already exists: ${str(args, 'to')}`)
      } catch (e) {
        if (e instanceof ToolError) throw e
      }
      await fsp.mkdir(path.dirname(b.abs), { recursive: true })
      await fsp.rename(a.abs, b.abs)
      return { content: `Moved ${displayPath(ctx.workspace, a.abs)} to ${displayPath(ctx.workspace, b.abs)}.` }
    }
  })

  tools.push({
    name: 'delete_path',
    description: 'Delete a file or folder in the workspace. Folders require recursive=true. This cannot be undone.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to delete' },
        recursive: { type: 'boolean', description: 'Required to delete a non-empty folder' }
      },
      required: ['path']
    },
    source: 'builtin',
    group: 'Files',
    defaultPermission: D.delete_path,
    describe: (args, ctx) => {
      const { abs, inside } = resolve(ctx, str(args, 'path'))
      return {
        kind: 'delete',
        title: `Delete ${displayPath(ctx.workspace, abs)}`,
        path: abs,
        reason: outsideReason(inside, ctx),
        forceApproval: !inside
      }
    },
    async execute(args, ctx) {
      const { abs } = resolve(ctx, str(args, 'path'))
      if (ctx.workspace && path.resolve(ctx.workspace) === abs) throw new ToolError('Refusing to delete the workspace root.')
      let st
      try {
        st = await fsp.lstat(abs)
      } catch {
        throw new ToolError(`Not found: ${str(args, 'path')}`)
      }
      if (st.isDirectory() && !bool(args, 'recursive')) {
        throw new ToolError(`${str(args, 'path')} is a folder. Set recursive to true to delete it and everything inside.`)
      }
      await fsp.rm(abs, { recursive: true, force: false })
      return { content: `Deleted ${displayPath(ctx.workspace, abs)}.` }
    }
  })

  return tools
}
