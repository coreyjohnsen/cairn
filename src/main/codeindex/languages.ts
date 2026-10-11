/**
 * Finding what a source file defines and imports, without a parser: line patterns plus indentation. It is meant for
 * well-formatted code and gives up quietly on anything odd, so a missed symbol costs a search, never a wrong answer.
 */

export type SymbolKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'struct' | 'trait' | 'module' | 'object' | 'const'

export interface Sym {
  name: string
  kind: SymbolKind
  /** 1-based line of the definition. */
  line: number
  /** The class, object or type a method belongs to. */
  parent?: string
  /** Visible to other files (exported, public, capitalised in Go …). */
  exported: boolean
  /** The definition line, trimmed and shortened. */
  sig: string
}

export interface Extracted {
  symbols: Sym[]
  /** Module names or paths as written in the file. */
  imports: string[]
}

export type Lang = 'js' | 'py' | 'go' | 'rs' | 'java' | 'kt' | 'cs' | 'c' | 'rb' | 'php' | 'html'

export const LANG_NAME: Record<Lang, string> = { js: 'TypeScript/JavaScript', py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', cs: 'C#', c: 'C/C++', rb: 'Ruby', php: 'PHP', html: 'HTML (script blocks)' }

const EXT: Record<string, Lang> = {
  ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', mts: 'js', cts: 'js',
  py: 'py', go: 'go', rs: 'rs', java: 'java', kt: 'kt', kts: 'kt', cs: 'cs',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c',
  rb: 'rb', php: 'php', html: 'html', htm: 'html', vue: 'html', svelte: 'html'
}

export function languageOf(file: string): Lang | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(file)
  return m ? (EXT[m[1].toLowerCase()] ?? null) : null
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with', 'super', 'new', 'typeof', 'await', 'yield', 'throw', 'delete', 'void', 'import', 'export', 'constructor'])

const sigOf = (line: string): string => {
  const t = line.trim().replace(/\s*\{\s*$/, '').replace(/\s+/g, ' ')
  return t.length > 140 ? `${t.slice(0, 139)}…` : t
}

const indentOf = (line: string): number => {
  let n = 0
  for (const ch of line) {
    if (ch === ' ') n++
    else if (ch === '\t') n += 4
    else break
  }
  return n
}

interface Container {
  name: string
  indent: number
  /** Indentation of its members, learnt from the first one. */
  child?: number
}

/** Walks the lines keeping a stack of the classes (or objects) a line sits inside, by indentation. */
function walk(lines: string[], visit: (line: string, i: number, indent: number, stack: Container[]) => Container | undefined | void): void {
  const stack: Container[] = []
  let inBlock = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()
    if (inBlock) {
      if (t.includes('*/')) inBlock = false
      continue
    }
    if (t === '') continue
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true
      continue
    }
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('#!') || (t.startsWith('#') && !/^#\s*include/.test(t))) continue
    const indent = indentOf(line)
    // A line at or left of a container's own line ends it.
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop()
    const top = stack[stack.length - 1]
    if (top && top.child === undefined && indent > top.indent) top.child = indent
    const opened = visit(line, i, indent, stack)
    if (opened) stack.push(opened)
  }
}

const sym = (name: string, kind: SymbolKind, i: number, line: string, exported: boolean, parent?: string): Sym => ({ name, kind, line: i + 1, parent, exported, sig: sigOf(line) })

/* ───────────── JavaScript and TypeScript ───────────── */

const JS_FUNC = /^\s*(export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/
const JS_CLASS = /^\s*(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/
const JS_IFACE = /^\s*(export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/
const JS_TYPE = /^\s*(export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/
const JS_ENUM = /^\s*(export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/
const JS_NS = /^\s*(export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$.]*)\s*\{/
const JS_ARROW = /^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>|\([^)]*$)/
const JS_OBJECT = /^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:Object\.freeze\(\s*)?\{\s*$/
const JS_CONST = /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/
const JS_METHOD = /^\s*(?:(?:public|private|protected|static|readonly|override|abstract|get|set|async)\s+)*\*?\s*([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\s*\(/
const JS_PROP_FN = /^\s*(?:(?:public|private|protected|static|readonly)\s+)*([A-Za-z_$#][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/

function extractJs(lines: string[]): Extracted {
  // Top-level declarations sit at the smallest indentation among them (code inside a <script> is indented).
  let base = Infinity
  for (const l of lines) {
    if ((JS_FUNC.test(l) || JS_CLASS.test(l) || JS_IFACE.test(l) || JS_TYPE.test(l) || JS_ENUM.test(l) || JS_ARROW.test(l) || JS_OBJECT.test(l)) && l.trim() !== '') base = Math.min(base, indentOf(l))
  }
  if (!Number.isFinite(base)) base = 0
  const symbols: Sym[] = []
  walk(lines, (line, i, indent, stack) => {
    const top = stack[stack.length - 1]
    if (top && indent > top.indent) {
      // A member of a class or object: only lines at the members' own indentation count.
      if (top.child !== undefined && indent !== top.child) return
      const m = JS_PROP_FN.exec(line) ?? JS_METHOD.exec(line)
      const name = m?.[1]
      if (name && !KEYWORDS.has(name)) symbols.push(sym(name, 'method', i, line, !/^\s*(private|#)/.test(line) && !name.startsWith('#'), top.name))
      return
    }
    if (indent !== base) return
    let m: RegExpExecArray | null
    if ((m = JS_CLASS.exec(line))) {
      symbols.push(sym(m[2], 'class', i, line, !!m[1] || /export\s+default/.test(line)))
      return { name: m[2], indent }
    }
    if ((m = JS_FUNC.exec(line))) return void symbols.push(sym(m[2], 'function', i, line, !!m[1]))
    if ((m = JS_IFACE.exec(line))) {
      symbols.push(sym(m[2], 'interface', i, line, !!m[1]))
      return
    }
    if ((m = JS_TYPE.exec(line))) return void symbols.push(sym(m[2], 'type', i, line, !!m[1]))
    if ((m = JS_ENUM.exec(line))) return void symbols.push(sym(m[2], 'enum', i, line, !!m[1]))
    if ((m = JS_NS.exec(line))) {
      symbols.push(sym(m[2], 'module', i, line, !!m[1]))
      return
    }
    if ((m = JS_OBJECT.exec(line))) {
      symbols.push(sym(m[2], 'object', i, line, !!m[1]))
      return { name: m[2], indent }
    }
    if ((m = JS_ARROW.exec(line))) return void symbols.push(sym(m[2], 'function', i, line, !!m[1]))
    if ((m = JS_CONST.exec(line))) return void symbols.push(sym(m[1], 'const', i, line, true))
  })
  const text = lines.join('\n')
  const imports: string[] = []
  for (const re of [/\b(?:import|export)\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?['"]([^'"\n]+)['"]/g, /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g, /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g]) {
    for (const m of text.matchAll(re)) imports.push(m[1])
  }
  return { symbols, imports: [...new Set(imports)] }
}

/* ───────────── HTML, Vue and Svelte: the script blocks ───────────── */

function extractHtml(lines: string[]): Extracted {
  const kept: string[] = []
  const imports: string[] = []
  let inScript = false
  for (const line of lines) {
    let out = ''
    if (!inScript) {
      const open = /<script\b([^>]*)>/i.exec(line)
      for (const m of line.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) imports.push(m[1])
      if (open && !/\bsrc=/.test(open[1]) && !/type=["'](?:application\/(?:ld\+)?json|text\/template)/i.test(open[1])) {
        inScript = true
        const rest = line.slice(open.index + open[0].length)
        const close = rest.search(/<\/script>/i)
        if (close >= 0) {
          out = rest.slice(0, close)
          inScript = false
        } else out = rest
      }
    } else {
      const close = line.search(/<\/script>/i)
      if (close >= 0) {
        out = line.slice(0, close)
        inScript = false
      } else out = line
    }
    // Keep the line numbers: lines that are not script become empty lines.
    kept.push(out)
  }
  const r = extractJs(kept)
  return { symbols: r.symbols, imports: [...new Set([...imports, ...r.imports])] }
}

/* ───────────── Python ───────────── */

function extractPy(lines: string[]): Extracted {
  const symbols: Sym[] = []
  const imports: string[] = []
  walk(lines, (line, i, indent, stack) => {
    const top = stack[stack.length - 1]
    let m: RegExpExecArray | null
    if ((m = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/.exec(line))) {
      if (indent === 0) symbols.push(sym(m[1], 'function', i, line, !m[1].startsWith('_')))
      else if (top && indent === (top.child ?? indent)) symbols.push(sym(m[1], 'method', i, line, !m[1].startsWith('_') || /^__\w+__$/.test(m[1]), top.name))
      return
    }
    if ((m = /^class\s+(\w+)/.exec(line))) {
      symbols.push(sym(m[1], 'class', i, line, !m[1].startsWith('_')))
      return { name: m[1], indent }
    }
    if (indent === 0 && (m = /^([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/.exec(line))) symbols.push(sym(m[1], 'const', i, line, true))
    if ((m = /^\s*import\s+(.+)$/.exec(line))) for (const part of m[1].split(',')) imports.push(part.trim().split(/\s+as\s+/)[0])
    else if ((m = /^\s*from\s+(\.*[\w.]*)\s+import\b/.exec(line))) imports.push(m[1])
  })
  return { symbols, imports: [...new Set(imports.filter(Boolean))] }
}

/* ───────────── Go ───────────── */

function extractGo(lines: string[]): Extracted {
  const symbols: Sym[] = []
  const imports: string[] = []
  let block = false
  lines.forEach((line, i) => {
    let m: RegExpExecArray | null
    if (block) {
      if (/^\)/.test(line)) block = false
      else if ((m = /^\s*(?:[\w.]+\s+)?"([^"]+)"/.exec(line))) imports.push(m[1])
      return
    }
    if (/^import\s*\(/.test(line)) return void (block = true)
    if ((m = /^import\s+(?:[\w.]+\s+)?"([^"]+)"/.exec(line))) return void imports.push(m[1])
    if ((m = /^func\s*\(\s*\w*\s*\*?\s*(\w+)[^)]*\)\s*(\w+)/.exec(line))) return void symbols.push(sym(m[2], 'method', i, line, /^[A-Z]/.test(m[2]), m[1]))
    if ((m = /^func\s+(\w+)/.exec(line))) return void symbols.push(sym(m[1], 'function', i, line, /^[A-Z]/.test(m[1])))
    if ((m = /^type\s+(\w+)\s+(struct|interface)\b/.exec(line))) return void symbols.push(sym(m[1], m[2] === 'struct' ? 'struct' : 'interface', i, line, /^[A-Z]/.test(m[1])))
    if ((m = /^type\s+(\w+)\s/.exec(line))) return void symbols.push(sym(m[1], 'type', i, line, /^[A-Z]/.test(m[1])))
    if ((m = /^(?:const|var)\s+(\w+)/.exec(line))) symbols.push(sym(m[1], 'const', i, line, /^[A-Z]/.test(m[1])))
  })
  return { symbols, imports: [...new Set(imports)] }
}

/* ───────────── Rust ───────────── */

function extractRs(lines: string[]): Extracted {
  const symbols: Sym[] = []
  const imports: string[] = []
  walk(lines, (line, i, indent, stack) => {
    const top = stack[stack.length - 1]
    const pub = /^\s*pub\b/.test(line)
    let m: RegExpExecArray | null
    if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?impl\b(?:\s*<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([\w:]+)/.exec(line))) return { name: m[1].split('::').pop() ?? m[1], indent }
    if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+|const\s+|extern\s+"[^"]*"\s+)*fn\s+(\w+)/.exec(line))) {
      if (top && indent > top.indent) symbols.push(sym(m[1], 'method', i, line, pub, top.name))
      else if (indent === 0 || !top) symbols.push(sym(m[1], 'function', i, line, pub))
      return
    }
    if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|union)\s+(\w+)/.exec(line))) {
      symbols.push(sym(m[2], m[1] === 'trait' ? 'trait' : m[1] === 'enum' ? 'enum' : 'struct', i, line, pub))
      return m[1] === 'trait' ? { name: m[2], indent } : undefined
    }
    if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+(\w+)/.exec(line))) return void symbols.push(sym(m[1], 'type', i, line, pub))
    if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/.exec(line))) {
      symbols.push(sym(m[1], 'module', i, line, pub))
      imports.push(`mod:${m[1]}`)
      return
    }
    if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(\w+)\s*:/.exec(line))) return void symbols.push(sym(m[1], 'const', i, line, pub))
    if ((m = /^\s*(?:pub\s+)?use\s+([\w:]+)/.exec(line))) imports.push(m[1])
  })
  return { symbols, imports: [...new Set(imports)] }
}

/* ───────────── Java, Kotlin, C# ───────────── */

const JVM_TYPE = /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|partial|enum|annotation|inner|value)\s+)*(class|interface|enum|record|object|trait|struct)\s+(\w+)/
const JVM_MODS = '(?:public|private|protected|internal|static|final|abstract|synchronized|override|virtual|async|open|suspend|sealed|extern|unsafe|new)'

function extractJvm(lines: string[], lang: 'java' | 'kt' | 'cs'): Extracted {
  const symbols: Sym[] = []
  const imports: string[] = []
  const method = new RegExp(`^\\s+(?:${JVM_MODS}\\s+)+[\\w<>\\[\\],.?\\s]+?\\s+(\\w+)\\s*\\(`)
  const funKt = /^\s*(?:(?:public|private|protected|internal|override|open|suspend|inline|abstract|operator|infix)\s+)*fun\s+(?:<[^>]+>\s*)?(?:[\w.<>?]+\.)?(\w+)\s*\(/
  walk(lines, (line, i, indent, stack) => {
    const top = stack[stack.length - 1]
    const exported = !/^\s*private\b/.test(line)
    let m: RegExpExecArray | null
    if ((m = /^\s*import\s+(?:static\s+)?([\w.*]+)/.exec(line)) && lang !== 'cs') return void imports.push(m[1])
    if ((m = /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/.exec(line)) && lang === 'cs') return void imports.push(m[1])
    if ((m = JVM_TYPE.exec(line))) {
      const kind: SymbolKind = m[1] === 'interface' ? 'interface' : m[1] === 'enum' ? 'enum' : m[1] === 'struct' ? 'struct' : m[1] === 'trait' ? 'trait' : m[1] === 'object' ? 'object' : 'class'
      symbols.push(sym(m[2], kind, i, line, exported, top?.name))
      return { name: m[2], indent }
    }
    if (lang === 'kt' && (m = funKt.exec(line))) return void symbols.push(sym(m[1], top ? 'method' : 'function', i, line, exported, top?.name))
    if (lang !== 'kt' && top && (m = method.exec(line)) && !KEYWORDS.has(m[1])) symbols.push(sym(m[1], 'method', i, line, exported, top.name))
  })
  return { symbols, imports: [...new Set(imports)] }
}

/* ───────────── C and C++ ───────────── */

function extractC(lines: string[]): Extracted {
  const symbols: Sym[] = []
  const imports: string[] = []
  const fn = /^(?:[\w:<>,*&~]+\s+)+([\w:~]+)\s*\([^;{]*\)?\s*(?:const\s*)?(?:noexcept\s*)?(?:\{|$)/
  walk(lines, (line, i, indent) => {
    let m: RegExpExecArray | null
    if ((m = /^\s*#\s*include\s+"([^"]+)"/.exec(line))) return void imports.push(m[1])
    if ((m = /^\s*(?:typedef\s+)?(class|struct|enum|union|namespace)\s+(\w+)/.exec(line)) && !/^\s*(?:class|struct|union|enum)\s+\w+\s*;/.test(line)) {
      const kind: SymbolKind = m[1] === 'class' ? 'class' : m[1] === 'enum' ? 'enum' : m[1] === 'namespace' ? 'module' : 'struct'
      symbols.push(sym(m[2], kind, i, line, true))
      return
    }
    if (indent === 0 && (m = fn.exec(line)) && !KEYWORDS.has(m[1]) && !/^(?:static\s+)?(?:else|return|define)\b/.test(line)) symbols.push(sym(m[1], 'function', i, line, !/^static\b/.test(line)))
  })
  return { symbols, imports: [...new Set(imports)] }
}

/* ───────────── Ruby ───────────── */

function extractRb(lines: string[]): Extracted {
  const symbols: Sym[] = []
  const imports: string[] = []
  walk(lines, (line, i, indent, stack) => {
    const top = stack[stack.length - 1]
    let m: RegExpExecArray | null
    if ((m = /^\s*(class|module)\s+([\w:]+)/.exec(line))) {
      symbols.push(sym(m[2], m[1] === 'module' ? 'module' : 'class', i, line, true, top?.name))
      return { name: m[2], indent }
    }
    if ((m = /^\s*def\s+(?:self\.)?([\w]+[?!=]?)/.exec(line))) return void symbols.push(sym(m[1], top ? 'method' : 'function', i, line, true, top?.name))
    if ((m = /^\s*require_relative\s+['"]([^'"]+)['"]/.exec(line))) imports.push(`./${m[1]}`)
    else if ((m = /^\s*require\s+['"]([^'"]+)['"]/.exec(line))) imports.push(m[1])
  })
  return { symbols, imports: [...new Set(imports)] }
}

/* ───────────── PHP ───────────── */

function extractPhp(lines: string[]): Extracted {
  const symbols: Sym[] = []
  const imports: string[] = []
  walk(lines, (line, i, indent, stack) => {
    const top = stack[stack.length - 1]
    let m: RegExpExecArray | null
    if ((m = /^\s*(?:abstract\s+|final\s+)?(class|interface|trait|enum)\s+(\w+)/.exec(line))) {
      symbols.push(sym(m[2], m[1] === 'interface' ? 'interface' : m[1] === 'trait' ? 'trait' : m[1] === 'enum' ? 'enum' : 'class', i, line, true))
      return { name: m[2], indent }
    }
    if ((m = /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?(\w+)\s*\(/.exec(line))) return void symbols.push(sym(m[1], top ? 'method' : 'function', i, line, !/^\s*private\b/.test(line), top?.name))
    if ((m = /^\s*use\s+([\w\\]+)\s*(?:as\s+\w+)?;/.exec(line))) imports.push(m[1])
    else if ((m = /^\s*(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/.exec(line))) imports.push(m[1])
  })
  return { symbols, imports: [...new Set(imports)] }
}

/** What a file defines and imports. Never throws: an odd file simply yields less. */
export function extractSymbols(lang: Lang, text: string): Extracted {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  try {
    switch (lang) {
      case 'js':
        return extractJs(lines)
      case 'html':
        return extractHtml(lines)
      case 'py':
        return extractPy(lines)
      case 'go':
        return extractGo(lines)
      case 'rs':
        return extractRs(lines)
      case 'java':
      case 'kt':
      case 'cs':
        return extractJvm(lines, lang)
      case 'c':
        return extractC(lines)
      case 'rb':
        return extractRb(lines)
      case 'php':
        return extractPhp(lines)
    }
  } catch {
    return { symbols: [], imports: [] }
  }
}
