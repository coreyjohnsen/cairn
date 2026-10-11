import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'

/** What a quick look at one file found. `problems` is empty when the file is fine. */
export interface FileCheck {
  /** What was checked, e.g. "JavaScript syntax". */
  kind: string
  problems: string[]
}

const MAX_BYTES = 1024 * 1024
const CHECK_TIMEOUT_MS = 15000

const firstLines = (text: string, n: number): string =>
  text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(0, n)
    .join('\n')

/** Run a program, give back its exit code and output; null when it could not start. */
function run(file: string, args: string[], signal?: AbortSignal): Promise<{ code: number | null; output: string } | null> {
  return new Promise((resolve) => {
    let child
    try {
      // ELECTRON_RUN_AS_NODE makes the app's own executable behave as plain node, so no separate install is needed.
      child = spawn(file, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve(null)
      return
    }
    let output = ''
    const add = (d: string) => {
      if (output.length < 8000) output += d
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    const timer = setTimeout(() => child.kill(), CHECK_TIMEOUT_MS)
    const onAbort = () => child.kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code, output })
    })
  })
}

/** Syntax problems of JavaScript, found by node itself (it reads modules and scripts alike). */
async function checkJs(abs: string, signal?: AbortSignal): Promise<FileCheck | null> {
  const r = await run(process.execPath, ['--check', abs], signal)
  if (!r) return null
  if (r.code === 0) return { kind: 'JavaScript syntax', problems: [] }
  return { kind: 'JavaScript syntax', problems: [firstLines(r.output, 6).replace(new RegExp(abs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), path.basename(abs))] }
}

const tsCache = new Map<string, unknown>()

interface TsLike {
  transpileModule(
    text: string,
    opts: { fileName: string; reportDiagnostics: boolean; compilerOptions: Record<string, unknown> }
  ): { diagnostics?: { messageText: unknown; start?: number; file?: { getLineAndCharacterOfPosition(p: number): { line: number; character: number } } }[] }
  flattenDiagnosticMessageText(t: unknown, nl: string): string
}

/** The project's own TypeScript, when it has one; the syntax of .ts and .tsx files is checked with it. */
function projectTypescript(workspace: string | null): TsLike | null {
  if (!workspace) return null
  if (tsCache.has(workspace)) return tsCache.get(workspace) as TsLike | null
  let ts: TsLike | null = null
  try {
    ts = createRequire(path.join(workspace, 'package.json'))('typescript') as TsLike
  } catch {
    ts = null
  }
  tsCache.set(workspace, ts)
  return ts
}

function checkTs(text: string, abs: string, workspace: string | null): FileCheck | null {
  const ts = projectTypescript(workspace)
  if (!ts) return null
  const out = ts.transpileModule(text, { fileName: abs, reportDiagnostics: true, compilerOptions: { jsx: 1, target: 99, module: 99 } })
  const problems = (out.diagnostics ?? []).slice(0, 5).map((d) => {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ')
    if (d.file && d.start !== undefined) {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start)
      return `line ${line + 1}, column ${character + 1}: ${msg}`
    }
    return msg
  })
  return { kind: 'TypeScript syntax', problems }
}

async function checkPython(abs: string, signal?: AbortSignal): Promise<FileCheck | null> {
  const code = 'import ast,sys\nast.parse(open(sys.argv[1],encoding="utf-8").read(),sys.argv[1])'
  for (const py of ['python3', 'python']) {
    const r = await run(py, ['-c', code, abs], signal)
    if (!r) continue
    if (r.code === 0) return { kind: 'Python syntax', problems: [] }
    return { kind: 'Python syntax', problems: [firstLines(r.output, 5)] }
  }
  return null
}

function checkJson(text: string): FileCheck {
  try {
    JSON.parse(text)
    return { kind: 'JSON', problems: [] }
  } catch (e) {
    return { kind: 'JSON', problems: [(e as Error).message] }
  }
}

/** Unbalanced braces in a stylesheet (comments and strings are ignored). */
function checkCss(text: string): FileCheck {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '""')
  let depth = 0
  let line = 1
  let firstExtra = 0
  for (const ch of stripped) {
    if (ch === '\n') line++
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth < 0 && !firstExtra) firstExtra = line
    }
  }
  const problems: string[] = []
  if (firstExtra) problems.push(`a "}" at line ${firstExtra} closes nothing`)
  else if (depth > 0) problems.push(`${depth} "{" never closed`)
  return { kind: 'CSS braces', problems }
}

const isLocalRef = (ref: string): boolean => !!ref && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(ref)

/** Every script, stylesheet and image the page refers to by a relative path, and whether the file exists. */
export async function missingPageFiles(html: string, abs: string): Promise<string[]> {
  const refs = new Set<string>()
  for (const m of html.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.add(m[1])
  for (const m of html.matchAll(/<link\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) refs.add(m[1])
  for (const m of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.add(m[1])
  const missing: string[] = []
  for (const ref of refs) {
    if (!isLocalRef(ref)) continue
    const clean = ref.split(/[?#]/)[0]
    try {
      await fsp.access(path.resolve(path.dirname(abs), decodeURIComponent(clean)))
    } catch {
      missing.push(ref)
    }
  }
  return missing
}

async function checkHtml(text: string, abs: string): Promise<FileCheck> {
  const problems: string[] = []
  for (const ref of await missingPageFiles(text, abs)) problems.push(`refers to "${ref}", which does not exist next to the page`)
  // Inline scripts: a syntax error in one stops the whole script.
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  let n = 0
  while ((m = re.exec(text))) {
    const attrs = m[1]
    if (/\bsrc\s*=/.test(attrs)) continue
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase()
    if (type && !/^(?:text\/javascript|application\/javascript|module)$/.test(type)) continue
    n++
    const code = m[2]
    if (!code.trim()) continue
    try {
      new vm.Script(code)
    } catch (e) {
      const msg = (e as Error).message
      if (type === 'module' && /import|export|top-level await/i.test(msg)) continue
      problems.push(`inline script #${n}: ${msg}`)
    }
  }
  // The same id twice: getElementById finds only the first.
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const idm of text.matchAll(/<[a-z][^>]*?\sid\s*=\s*["']([^"']+)["']/gi)) {
    if (seen.has(idm[1])) dup.add(idm[1])
    seen.add(idm[1])
  }
  if (dup.size) problems.push(`the id ${[...dup].map((d) => `"${d}"`).join(', ')} is used more than once`)
  return { kind: 'HTML page', problems }
}

/**
 * A quick look at a file the assistant just wrote: does it parse, and (for pages) do the files it names exist.
 * Returns null when this kind of file has no check or the checker is not available, so nothing is claimed.
 */
export async function checkFile(abs: string, workspace: string | null, signal?: AbortSignal): Promise<FileCheck | null> {
  const ext = path.extname(abs).toLowerCase()
  if (!['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.json', '.py', '.css', '.html', '.htm'].includes(ext)) return null
  let text: string
  try {
    const st = await fsp.stat(abs)
    if (!st.isFile() || st.size > MAX_BYTES) return null
    text = await fsp.readFile(abs, 'utf8')
  } catch {
    return null
  }
  switch (ext) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return checkJs(abs, signal)
    case '.jsx':
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return checkTs(text, abs, workspace)
    case '.json':
      return checkJson(text)
    case '.py':
      return checkPython(abs, signal)
    case '.css':
      return checkCss(text)
    default:
      return checkHtml(text, abs)
  }
}

/** The line added to a write or edit result when the check found something. Empty when all is well. */
export function checkNotice(rel: string, c: FileCheck | null): string {
  if (!c || c.problems.length === 0) return ''
  return `[Check failed: ${c.kind} of ${rel}\n${c.problems.map((p) => `  ${p}`).join('\n')}\nFix this before going on: read the file around the problem and correct it.]`
}
