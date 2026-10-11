import fsp from 'node:fs/promises'
import path from 'node:path'
import { LANG_NAME, type Lang, type Sym, type SymbolKind, extractSymbols, languageOf } from './languages'

/** Folders that hold other people's code or build output, never the project's own. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', '__pycache__', 'venv', 'site-packages', 'Pods', 'DerivedData'])
const MAX_FILES = 4000
const MAX_FILE_BYTES = 400 * 1024
const MAX_DEPTH = 14
const SKIP_FILE = /\.(?:min|bundle)\.[a-z]+$|\.d\.ts$|\.map$|-lock\./i
/** Most text read for one search for usages. */
const MAX_USAGE_BYTES = 24 * 1024 * 1024

export interface FileEntry {
  rel: string
  mtimeMs: number
  size: number
  lang: Lang
  lines: number
  symbols: Sym[]
  imports: string[]
  /** Project files this one imports, once resolved. */
  uses: string[]
}

export interface SymbolMatch extends Sym {
  rel: string
}

export interface Usage {
  rel: string
  line: number
  text: string
  /** The line that defines it. */
  def: boolean
}

const EXTS_JS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json']

const withoutExt = (p: string): string => p.replace(/\.[A-Za-z0-9]+$/, '')

/** `compilerOptions.paths` (and baseUrl) of the project's tsconfig files, so `@/x` and `@shared/x` resolve. */
async function loadAliases(root: string): Promise<{ prefix: string; targets: string[] }[]> {
  const out: { prefix: string; targets: string[] }[] = []
  let names: string[] = []
  try {
    names = (await fsp.readdir(root)).filter((n) => /^(?:ts|js)config(?:\.[\w-]+)?\.json$/.test(n))
  } catch {
    return out
  }
  for (const n of names) {
    try {
      const raw = await fsp.readFile(path.join(root, n), 'utf8')
      const json = JSON.parse(raw.replace(/\/\*[\s\S]*?\*\/|(^|[^:"'])\/\/.*$/gm, '$1').replace(/,\s*([}\]])/g, '$1'))
      const co = json.compilerOptions ?? {}
      const baseUrl: string = co.baseUrl ?? '.'
      for (const [k, v] of Object.entries(co.paths ?? {})) {
        if (!Array.isArray(v)) continue
        const prefix = k.replace(/\*$/, '')
        const targets = (v as string[]).map((t) => path.posix.normalize(path.posix.join(baseUrl, t.replace(/\*$/, ''))).replace(/^\.\//, ''))
        if (!out.some((a) => a.prefix === prefix)) out.push({ prefix, targets })
      }
    } catch {
      /* a config that is not plain JSON: skip it */
    }
  }
  // Longest prefix first, so "@shared/" is tried before "@/".
  return out.sort((a, b) => b.prefix.length - a.prefix.length)
}

export class CodeIndex {
  readonly files = new Map<string, FileEntry>()
  private importedBy = new Map<string, string[]>()
  private aliases: { prefix: string; targets: string[] }[] = []
  private aliasesLoaded = false
  private inflight: Promise<void> | null = null
  /** More files than the index keeps were found. */
  truncated = false

  constructor(readonly root: string) {}

  /**
   * Bring the index up to date with the files on disk: new and changed files are read, deleted ones dropped. Cheap when nothing
   * changed (one pass of file dates), so it is done before every answer rather than trusting an earlier one: the model's own
   * edits a moment ago must show.
   */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async scan(): Promise<{ rel: string; abs: string; mtimeMs: number; size: number; lang: Lang }[]> {
    const found: { rel: string; abs: string; mtimeMs: number; size: number; lang: Lang }[] = []
    const stack: { dir: string; depth: number }[] = [{ dir: this.root, depth: 0 }]
    this.truncated = false
    while (stack.length) {
      const { dir, depth } = stack.pop()!
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      const files: { name: string; abs: string; lang: Lang }[] = []
      for (const e of entries) {
        if (e.isSymbolicLink()) continue
        if (e.isDirectory()) {
          if (depth < MAX_DEPTH && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) stack.push({ dir: path.join(dir, e.name), depth: depth + 1 })
        } else if (e.isFile()) {
          const lang = languageOf(e.name)
          if (lang && !SKIP_FILE.test(e.name)) files.push({ name: e.name, abs: path.join(dir, e.name), lang })
        }
      }
      for (let i = 0; i < files.length; i += 64) {
        const batch = await Promise.all(
          files.slice(i, i + 64).map(async (f) => {
            try {
              const st = await fsp.stat(f.abs)
              return st.size <= MAX_FILE_BYTES ? { rel: path.relative(this.root, f.abs).split(path.sep).join('/'), abs: f.abs, mtimeMs: st.mtimeMs, size: st.size, lang: f.lang } : null
            } catch {
              return null
            }
          })
        )
        for (const b of batch) if (b) found.push(b)
        if (found.length >= MAX_FILES) {
          this.truncated = true
          return found.slice(0, MAX_FILES)
        }
      }
    }
    return found
  }

  private async doRefresh(): Promise<void> {
    if (!this.aliasesLoaded) {
      this.aliases = await loadAliases(this.root)
      this.aliasesLoaded = true
    }
    const found = await this.scan()
    const seen = new Set(found.map((f) => f.rel))
    let changed = false
    for (const rel of [...this.files.keys()]) {
      if (!seen.has(rel)) {
        this.files.delete(rel)
        changed = true
      }
    }
    const stale = found.filter((f) => {
      const old = this.files.get(f.rel)
      return !old || old.mtimeMs !== f.mtimeMs || old.size !== f.size
    })
    for (let i = 0; i < stale.length; i += 32) {
      await Promise.all(
        stale.slice(i, i + 32).map(async (f) => {
          let text: string
          try {
            text = await fsp.readFile(f.abs, 'utf8')
          } catch {
            return
          }
          if (text.includes('\0')) return
          const { symbols, imports } = extractSymbols(f.lang, text)
          this.files.set(f.rel, { rel: f.rel, mtimeMs: f.mtimeMs, size: f.size, lang: f.lang, lines: text.split('\n').length, symbols, imports, uses: [] })
          changed = true
        })
      )
    }
    if (changed || this.importedBy.size === 0) this.linkImports()
  }

  /* ───────────── imports between the project's own files ───────────── */

  private linkImports(): void {
    const rels = new Set(this.files.keys())
    const byNoExt = new Map<string, string[]>()
    for (const rel of rels) {
      const k = withoutExt(rel)
      byNoExt.set(k, [...(byNoExt.get(k) ?? []), rel])
    }
    const pick = (cands: string[] | undefined, prefer: string[]): string | undefined => {
      if (!cands?.length) return undefined
      for (const ext of prefer) {
        const hit = cands.find((c) => c.endsWith(ext))
        if (hit) return hit
      }
      return cands[0]
    }
    const importedBy = new Map<string, string[]>()
    for (const f of this.files.values()) {
      const uses = new Set<string>()
      const dir = path.posix.dirname(f.rel)
      for (const spec of f.imports) {
        const target = this.resolve(f, dir, spec, rels, byNoExt, pick)
        if (target && target !== f.rel) uses.add(target)
      }
      f.uses = [...uses]
      for (const u of f.uses) importedBy.set(u, [...(importedBy.get(u) ?? []), f.rel])
    }
    this.importedBy = importedBy
  }

  private resolve(f: FileEntry, dir: string, spec: string, rels: Set<string>, byNoExt: Map<string, string[]>, pick: (c: string[] | undefined, prefer: string[]) => string | undefined): string | undefined {
    const join = (...p: string[]) => path.posix.normalize(path.posix.join(...p)).replace(/^\.\//, '')
    const tryPath = (base: string): string | undefined => {
      if (rels.has(base)) return base
      // "./x.js" written for a file that is really x.ts.
      const bare = withoutExt(base)
      return pick(byNoExt.get(base), EXTS_JS) ?? pick(byNoExt.get(bare), EXTS_JS) ?? pick(byNoExt.get(`${base}/index`), EXTS_JS) ?? pick(byNoExt.get(`${base}/__init__`), ['.py'])
    }
    switch (f.lang) {
      case 'js':
      case 'html': {
        if (spec.startsWith('.') || spec.startsWith('/')) return tryPath(spec.startsWith('/') ? join(spec.slice(1)) : join(dir, spec))
        for (const a of this.aliases) {
          if (!a.prefix || !spec.startsWith(a.prefix)) continue
          const rest = spec.slice(a.prefix.length)
          for (const t of a.targets) {
            const hit = tryPath(join(t, rest))
            if (hit) return hit
          }
        }
        return undefined
      }
      case 'py': {
        const dots = /^\.*/.exec(spec)![0].length
        const name = spec.slice(dots).replace(/\./g, '/')
        if (dots > 0) {
          let base = dir
          for (let i = 1; i < dots; i++) base = path.posix.dirname(base)
          return tryPath(name ? join(base, name) : join(base, '__init__'))
        }
        return tryPath(name) ?? tryPath(join(dir, name)) ?? tryPath(join('src', name))
      }
      case 'c':
      case 'rb':
      case 'php': {
        if (spec.startsWith('.') || f.lang === 'c' || f.lang === 'rb') return tryPath(join(dir, spec)) ?? tryPath(join(spec)) ?? (f.lang === 'rb' ? tryPath(join('lib', spec)) : undefined)
        return tryPath(join(dir, spec))
      }
      case 'rs': {
        if (spec.startsWith('mod:')) {
          const n = spec.slice(4)
          return tryPath(join(dir, n)) ?? tryPath(join(dir, n, 'mod'))
        }
        if (spec.startsWith('crate::')) {
          const parts = spec.split('::').slice(1)
          const srcDir = f.rel.includes('/src/') ? f.rel.slice(0, f.rel.indexOf('/src/') + 4) : 'src'
          for (let n = parts.length; n >= 1; n--) {
            const hit = tryPath(join(srcDir, ...parts.slice(0, n))) ?? tryPath(join(srcDir, ...parts.slice(0, n), 'mod'))
            if (hit) return hit
          }
        }
        return undefined
      }
      case 'java':
      case 'kt': {
        const p = spec.replace(/\.\*$/, '').replace(/\./g, '/')
        for (const rel of rels) if (withoutExt(rel).endsWith(`/${p}`) || withoutExt(rel) === p) return rel
        return undefined
      }
      case 'go': {
        const tail = spec.split('/').slice(-2).join('/')
        for (const rel of rels) if (rel.endsWith('.go') && path.posix.dirname(rel).endsWith(tail)) return rel
        return undefined
      }
      default:
        return undefined
    }
  }

  /* ───────────── asking it things ───────────── */

  stats(): { files: number; symbols: number } {
    let symbols = 0
    for (const f of this.files.values()) symbols += f.symbols.length
    return { files: this.files.size, symbols }
  }

  /** A file by the path the model wrote: exact, or the only file that ends with it. */
  entry(input: string): FileEntry | undefined {
    const rel = input.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
    const exact = this.files.get(rel)
    if (exact) return exact
    const absRel = path.isAbsolute(input) ? path.relative(this.root, input).split(path.sep).join('/') : ''
    if (absRel && this.files.get(absRel)) return this.files.get(absRel)
    const ends = [...this.files.values()].filter((f) => f.rel.endsWith(`/${rel}`))
    return ends.length === 1 ? ends[0] : undefined
  }

  importers(rel: string): string[] {
    return this.importedBy.get(rel) ?? []
  }

  /** Definitions matching a name, best matches first: exact, same but for case, starts with, contains. */
  find(query: string, opts: { kind?: SymbolKind; limit?: number } = {}): SymbolMatch[] {
    const q = query.trim()
    if (!q) return []
    const dot = q.includes('.') ? q.split('.') : null
    const name = dot ? dot[dot.length - 1] : q
    const parent = dot ? dot[dot.length - 2] : undefined
    const lower = name.toLowerCase()
    const scored: { m: SymbolMatch; score: number }[] = []
    for (const f of this.files.values()) {
      for (const s of f.symbols) {
        if (opts.kind && s.kind !== opts.kind) continue
        if (parent && s.parent !== parent) continue
        const l = s.name.toLowerCase()
        let score = -1
        if (s.name === name) score = 4
        else if (l === lower) score = 3
        else if (l.startsWith(lower)) score = 2
        else if (l.includes(lower)) score = 1
        if (score < 0) continue
        if (s.exported) score += 0.5
        if (s.kind === 'method' || s.kind === 'const') score -= 0.2
        scored.push({ m: { ...s, rel: f.rel }, score })
      }
    }
    scored.sort((a, b) => b.score - a.score || a.m.rel.localeCompare(b.m.rel) || a.m.line - b.m.line)
    return scored.slice(0, opts.limit ?? 30).map((s) => s.m)
  }

  /** Lines that use a name (as a whole word), read from the project's files. Stops at `max` lines. */
  async usages(name: string, max = 40): Promise<{ usages: Usage[]; filesRead: number; capped: boolean }> {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?<![\\w$])${esc}(?![\\w$])`)
    const defs = new Set<string>()
    for (const f of this.files.values()) for (const s of f.symbols) if (s.name === name) defs.add(`${f.rel}:${s.line}`)
    // Files that define it or import something first: they are the likeliest users.
    const order = [...this.files.values()].sort((a, b) => b.uses.length + this.importers(b.rel).length - (a.uses.length + this.importers(a.rel).length))
    const usages: Usage[] = []
    let bytes = 0
    let filesRead = 0
    let capped = false
    for (const f of order) {
      if (bytes > MAX_USAGE_BYTES) {
        capped = true
        break
      }
      let text: string
      try {
        text = await fsp.readFile(path.join(this.root, f.rel), 'utf8')
      } catch {
        continue
      }
      bytes += text.length
      filesRead++
      if (!re.test(text)) continue
      const lines = text.split('\n')
      let perFile = 0
      for (let i = 0; i < lines.length && perFile < 6; i++) {
        if (!re.test(lines[i])) continue
        const t = lines[i].replace(/\r$/, '').trim()
        usages.push({ rel: f.rel, line: i + 1, text: t.length > 200 ? `${t.slice(0, 199)}…` : t, def: defs.has(`${f.rel}:${i + 1}`) })
        perFile++
        if (usages.length >= max) return { usages, filesRead, capped: true }
      }
    }
    return { usages, filesRead, capped }
  }

  /**
   * A short map of the project for the model's prompt: the most-used files first, each with what it defines. Fits `maxChars`;
   * files that do not fit are left out and counted.
   */
  repoMap(maxChars: number): string {
    const files = [...this.files.values()].filter((f) => f.symbols.some((s) => s.kind !== 'method'))
    if (files.length === 0) return ''
    const score = (f: FileEntry) => this.importers(f.rel).length * 3 + f.symbols.filter((s) => s.exported && s.kind !== 'method').length
    const ranked = files.sort((a, b) => score(b) - score(a) || a.rel.localeCompare(b.rel))
    const lineOf = (f: FileEntry): string => {
      const top = f.symbols.filter((s) => s.kind !== 'method')
      const methodsOf = new Map<string, number>()
      for (const s of f.symbols) if (s.kind === 'method' && s.parent) methodsOf.set(s.parent, (methodsOf.get(s.parent) ?? 0) + 1)
      const shown = [...top.filter((s) => s.exported), ...top.filter((s) => !s.exported)].slice(0, 9)
      const parts = shown.map((s) => {
        const m = methodsOf.get(s.name)
        return s.kind === 'class' || s.kind === 'object' || s.kind === 'struct' || s.kind === 'interface' || s.kind === 'trait' ? `${s.kind === 'class' ? '' : `${s.kind} `}${s.name}${m ? `(${m} methods)` : ''}` : s.name
      })
      const more = top.length > shown.length ? `, +${top.length - shown.length} more` : ''
      const line = `${f.rel}: ${parts.join(', ')}${more}`
      return line.length > 230 ? `${line.slice(0, 229)}…` : line
    }
    // The folders with the most files, so the layout of the whole project is visible even where the files below are not.
    const perDir = new Map<string, number>()
    for (const f of this.files.values()) {
      const d = path.posix.dirname(f.rel)
      perDir.set(d, (perDir.get(d) ?? 0) + 1)
    }
    let folders = ''
    if (perDir.size >= 4) {
      const top = [...perDir.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 18)
      folders = `Folders (files): ${top.map(([d, n]) => `${d === '.' ? '(root)' : d} ${n}`).join(', ')}`
      if (folders.length > Math.min(560, maxChars * 0.3)) folders = `${folders.slice(0, Math.floor(Math.min(560, maxChars * 0.3)) - 1).replace(/,[^,]*$/, '')}, …`
    }
    const header = [`${this.files.size} source files indexed${this.truncated ? ' (more exist)' : ''}. Most-used files first.`, folders && maxChars >= 600 ? folders : ''].filter(Boolean).join('\n')
    const chosen: { f: FileEntry; line: string }[] = []
    let used = header.length + 80
    for (const f of ranked) {
      const line = lineOf(f)
      if (used + line.length + 1 > maxChars) break
      chosen.push({ f, line })
      used += line.length + 1
    }
    const left = files.length - chosen.length
    return [header, ...chosen.map((c) => c.line), left > 0 ? `(${left} more files with definitions not shown; use find_symbol or file_outline)` : ''].filter(Boolean).join('\n')
  }

  describeLang(lang: Lang): string {
    return LANG_NAME[lang]
  }
}

/** One index per workspace folder, kept for the life of the app (the few most recent). */
export class CodeIndexRegistry {
  private map = new Map<string, CodeIndex>()

  get(root: string): CodeIndex {
    const key = path.resolve(root)
    let idx = this.map.get(key)
    if (idx) {
      this.map.delete(key)
    } else idx = new CodeIndex(key)
    this.map.set(key, idx)
    while (this.map.size > 4) this.map.delete(this.map.keys().next().value as string)
    return idx
  }
}
