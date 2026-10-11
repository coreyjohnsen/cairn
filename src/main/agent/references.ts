import fsp from 'node:fs/promises'
import path from 'node:path'
import { missingPageFiles } from './checks'

/** A source file as text. */
export interface SourceFile {
  rel: string
  text: string
}

export interface RefProblem {
  rel: string
  line: number
  message: string
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', '__pycache__', 'venv', '.git', '.next', '.cache'])
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.html', '.htm'])
const MAX_FILES = 600
const MAX_BYTES = 400 * 1024
const MAX_DEPTH = 8
const MAX_PROBLEMS = 40

/** Members every object or function has, which are not the project's to define. */
const BUILTIN_MEMBERS = new Set([
  'prototype', 'constructor', 'call', 'apply', 'bind', 'length', 'name', 'toString', 'valueOf', 'hasOwnProperty',
  'then', 'catch', 'finally', 'toJSON', 'toLocaleString', 'isPrototypeOf'
])
/** Names that are the language's, not a project module's. */
const GLOBAL_NAMES = new Set([
  'Object', 'Array', 'Math', 'JSON', 'Promise', 'Date', 'Number', 'String', 'Boolean', 'Symbol', 'Map', 'Set', 'WeakMap',
  'Reflect', 'Intl', 'console', 'window', 'document', 'process', 'Error', 'RegExp', 'URL', 'Buffer', 'location', 'navigator'
])

export async function loadSources(root: string): Promise<SourceFile[]> {
  const out: SourceFile[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return
      if (e.name.startsWith('.') && e.name !== '.') continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(abs, depth + 1)
      } else if (SOURCE_EXT.has(path.extname(e.name).toLowerCase()) && !/\.(?:min|bundle)\.|\.d\.ts$/i.test(e.name)) {
        try {
          const st = await fsp.stat(abs)
          if (st.size > MAX_BYTES) continue
          out.push({ rel: path.relative(root, abs).split(path.sep).join('/'), text: await fsp.readFile(abs, 'utf8') })
        } catch {
          /* unreadable: skip */
        }
      }
    }
  }
  await walk(root, 0)
  return out
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length

/** Structural characters inside a string, made harmless so a brace or comma in text is not taken for code. */
const defuse = (s: string): string => s.replace(/[{}()[\],;]/g, '_')

/**

 * The code of a file without its comments, and with the insides of ordinary strings blanked, or with `keepWords` defused (their words
 * stay, so a quoted key is still readable, but a brace or comma in them cannot upset the reading of the code around them). Template
 * literals are kept as written, and so is a string that holds an inline handler (`onclick="Mod.fn()"`), because those are real calls.
 * Line breaks stay, so line numbers are right.
 */
export function blankNonCode(text: string, keepWords = false): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (c === '/' && n === '/' && text[i - 1] !== ':') {
      while (i < text.length && text[i] !== '\n') {
        out += ' '
        i++
      }
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? text.length : end + 2
      out += text.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else if (c === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== '`') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '"' || c === "'") {
      let j = i + 1
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      const inner = text.slice(i + 1, j)
      out += c + (/\bon[a-z]+\s*=/i.test(inner) ? inner : keepWords ? defuse(inner) : inner.replace(/[^\n]/g, ' ')) + (text[j] === c ? c : '')
      i = j + (text[j] === c ? 1 : 0)
    } else {
      out += c
      i++
    }
  }
  return out
}

/** The text between the brace at `open` and its partner. */
function braceBody(text: string, open: number): string | null {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i)
  }
  return null
}

/** The top-level keys of an object literal body: `a, b: 1, c() {}, ...d` gives a, b, c (and flags a spread, whose keys are unknown). */
function objectKeys(body: string): { keys: Set<string>; open: boolean } {
  const keys = new Set<string>()
  let open = false
  let depth = 0
  let piece = ''
  const flush = () => {
    const p = piece.trim()
    piece = ''
    if (!p) return
    if (p.startsWith('...')) {
      open = true
      return
    }
    const m = /^(?:async\s+|get\s+|set\s+|\*\s*)?(?:\[[^\]]*\]|([A-Za-z_$][\w$]*)|["']([^"']+)["'])/.exec(p)
    if (m && (m[1] || m[2])) keys.add(m[1] ?? m[2])
    else open = true
  }
  for (const ch of body) {
    if ('({['.includes(ch)) depth++
    else if (')}]'.includes(ch)) depth--
    if (ch === ',' && depth === 0) flush()
    else piece += ch
  }
  flush()
  return { keys, open }
}

/**
 * Modules written as a global name that holds an object: `const Utils = (() => { …; return { a, b } })()`,
 * `const Utils = { a() {}, b }` and `window.Utils = { … }`. Returns each name with the members it offers.
 */
export function findNamespaces(files: SourceFile[]): Map<string, { keys: Set<string>; rel: string }> {
  const found = new Map<string, { keys: Set<string>; rel: string }>()
  const add = (name: string, body: string | null, rel: string) => {
    if (body === null || GLOBAL_NAMES.has(name)) return
    const { keys, open } = objectKeys(body)
    if (open || keys.size === 0) return
    const prior = found.get(name)
    if (prior) {
      // Two files define the same global: both lists are accepted rather than guessing which one is meant.
      for (const k of keys) prior.keys.add(k)
    } else found.set(name, { keys, rel })
  }
  for (const f of files) {
    if (!/\.(?:js|mjs|cjs|jsx|ts|tsx)$/i.test(f.rel)) continue
    const code = blankNonCode(f.text, true)
    // const Name = { … }
    for (const m of code.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Z][\w$]*)\s*=\s*\{/gm)) {
      add(m[1], braceBody(code, m.index + m[0].length - 1), f.rel)
    }
    // window.Name = { … }
    for (const m of code.matchAll(/^(?:window|globalThis)\.([A-Z][\w$]*)\s*=\s*\{/gm)) {
      add(m[1], braceBody(code, m.index + m[0].length - 1), f.rel)
    }
    // const Name = (() => { … return { … } })()  and  (function () { … })()
    for (const m of code.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Z][\w$]*)\s*=\s*\(\s*(?:async\s*)?(?:\(\s*\)\s*=>|function\s*\w*\s*\(\s*\))\s*\{/gm)) {
      const open = m.index + m[0].length - 1
      const body = braceBody(code, open)
      if (body === null) continue
      // The object returned last, at the top level of the function.
      let depth = 0
      let lastReturn = -1
      for (let i = 0; i < body.length; i++) {
        const ch = body[i]
        if ('({['.includes(ch)) depth++
        else if (')}]'.includes(ch)) depth--
        else if (depth === 0 && body.startsWith('return', i) && !/[\w$]/.test(body[i - 1] ?? ' ') && /\s*\{/.test(body.slice(i + 6, i + 40))) lastReturn = i
      }
      if (lastReturn < 0) continue
      const brace = body.indexOf('{', lastReturn)
      add(m[1], braceBody(body, brace), f.rel)
    }
  }
  return found
}

function nearest(name: string, keys: Iterable<string>): string | null {
  const lower = name.toLowerCase()
  let best: string | null = null
  let score = 0
  for (const k of keys) {
    const kl = k.toLowerCase()
    let s = 0
    if (kl === lower) s = 100
    else if (kl.includes(lower) || lower.includes(kl)) s = 60
    else {
      const a = new Set(lower.match(/[a-z]+/g) ?? [])
      const b = new Set(kl.match(/[a-z]+/g) ?? [])
      s = [...a].filter((x) => b.has(x)).length * 20
    }
    if (s > score) {
      score = s
      best = k
    }
  }
  return score >= 20 ? best : null
}

/** Calls and reads of `Module.member` where the module is the project's and offers no such member. */
export function findMissingMembers(files: SourceFile[], namespaces = findNamespaces(files)): RefProblem[] {
  const problems: RefProblem[] = []
  if (namespaces.size === 0) return problems
  const names = [...namespaces.keys()].map((n) => n.replace(/\$/g, '\\$'))
  const re = new RegExp(`(?<![\\w$.])(${names.join('|')})\\.([A-Za-z_$][\\w$]*)`, 'g')
  for (const f of files) {
    const isScript = /\.(?:js|mjs|cjs|jsx|ts|tsx)$/i.test(f.rel)
    let code = f.text
    if (!isScript) {
      // A page: only its inline scripts and handler attributes are code.
      const parts: string[] = []
      for (const m of f.text.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) parts.push(f.text.slice(0, m.index + m[0].indexOf('>') + 1).replace(/[^\n]/g, ' ') + m[1])
      for (const m of f.text.matchAll(/\bon\w+\s*=\s*"([^"]*)"/gi)) parts.push(f.text.slice(0, m.index + m[0].indexOf('"') + 1).replace(/[^\n]/g, ' ') + m[1])
      code = parts.join('\n')
      if (!code.trim()) continue
    }
    code = blankNonCode(code)
    re.lastIndex = 0
    let m: RegExpExecArray | null
    const reported = new Set<string>()
    while ((m = re.exec(code))) {
      const [, mod, member] = m
      const ns = namespaces.get(mod)
      if (!ns || ns.keys.has(member) || BUILTIN_MEMBERS.has(member)) continue
      // Assigning a new member on purpose (Mod.x = …) is the project's own business.
      if (/^\s*=(?!=)/.test(code.slice(m.index + m[0].length, m.index + m[0].length + 4))) continue
      const key = `${f.rel}:${mod}.${member}`
      if (reported.has(key)) continue
      reported.add(key)
      const near = nearest(member, ns.keys)
      problems.push({
        rel: f.rel,
        line: lineOf(code, m.index),
        message: `${mod}.${member} is used, but ${ns.rel} defines no "${member}" for ${mod}.${near ? ` Did you mean ${mod}.${near}?` : ''} It offers: ${[...ns.keys].sort().join(', ')}.`
      })
    }
  }
  return problems
}

/** Ids a script or page refers to, and ids that exist (written in a page, or built by a script). */
export function findMissingIds(files: SourceFile[]): RefProblem[] {
  const defined = new Set<string>()
  for (const f of files) {
    for (const m of f.text.matchAll(/\bid\s*=\s*(?:\\?["'`])([^"'`\\$\s]+)/g)) defined.add(m[1])
    for (const m of f.text.matchAll(/\bid\s*:\s*["']([^"'\s]+)["']/g)) defined.add(m[1])
    for (const m of f.text.matchAll(/\.id\s*=\s*["']([^"'\s]+)["']/g)) defined.add(m[1])
    for (const m of f.text.matchAll(/setAttribute\(\s*["']id["']\s*,\s*["']([^"'\s]+)["']/g)) defined.add(m[1])
  }
  if (!files.some((f) => /\.html?$/i.test(f.rel))) return []
  const problems: RefProblem[] = []
  const usage: { re: RegExp; group: number }[] = [
    { re: /getElementById\(\s*(["'])([^"'$`]+)\1/g, group: 2 },
    { re: /(?:querySelector(?:All)?|\$\$?|closest|matches)\(\s*(["'])#([A-Za-z][\w-]*)(?:[\s.#[:>+~,]|\1)/g, group: 2 },
    { re: /\b(?:setHTML|setText|setValue|showElement|hideElement|toggleElement|clearElement|appendTo)\(\s*(["'])([A-Za-z][\w-]*)\1/g, group: 2 }
  ]
  for (const f of files) {
    if (!/\.(?:js|mjs|jsx|ts|tsx)$/i.test(f.rel)) continue
    const code = f.text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/[^\n]*/g, (c, p1: string) => p1 + ' '.repeat(c.length - p1.length))
    const reported = new Set<string>()
    for (const { re, group } of usage) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(code))) {
        const id = m[group]
        if (defined.has(id) || reported.has(id)) continue
        reported.add(id)
        problems.push({ rel: f.rel, line: lineOf(code, m.index), message: `looks for the element "${id}", but no page or script defines an element with that id.` })
      }
    }
  }
  return problems
}

/** Pages that name a script, stylesheet or image that is not there. */
export async function findMissingFiles(files: SourceFile[], root: string): Promise<RefProblem[]> {
  const problems: RefProblem[] = []
  for (const f of files) {
    if (!/\.html?$/i.test(f.rel)) continue
    for (const ref of await missingPageFiles(f.text, path.join(root, f.rel))) {
      problems.push({ rel: f.rel, line: Math.max(1, lineOf(f.text, Math.max(0, f.text.indexOf(ref)))), message: `refers to "${ref}", which does not exist.` })
    }
  }
  return problems
}

export interface ReferenceReport {
  files: number
  problems: RefProblem[]
}

/** Look across the project for names that point at nothing. Heuristic: it finds likely mistakes, it does not prove a project correct. */
export async function checkReferences(root: string): Promise<ReferenceReport> {
  const files = await loadSources(root)
  const problems = [...findMissingMembers(files), ...findMissingIds(files), ...(await findMissingFiles(files, root))]
  return { files: files.length, problems }
}

export function referenceText(r: ReferenceReport): string {
  if (r.problems.length === 0) return `Checked ${r.files} source files: every Module.member call, element id and page file reference that could be checked points at something that exists.`
  const shown = r.problems.slice(0, MAX_PROBLEMS)
  const lines = shown.map((p) => `- ${p.rel}:${p.line} ${p.message}`)
  const more = r.problems.length - shown.length
  return [
    `Found ${r.problems.length} reference${r.problems.length === 1 ? '' : 's'} to something that does not exist (checked ${r.files} files):`,
    ...lines,
    ...(more > 0 ? [`… and ${more} more.`] : []),
    'Fix each: either add the missing function, id or file, or change the call to the name that exists (use file_outline on the module to see what it offers).'
  ].join('\n')
}
