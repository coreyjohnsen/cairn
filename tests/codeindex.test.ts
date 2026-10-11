import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodeIndex } from '../src/main/codeindex/index'
import { extractSymbols, languageOf } from '../src/main/codeindex/languages'
import { buildSystemPrompt } from '../src/main/agent/prompt'
import { McpManager } from '../src/main/tools/mcp'
import { projectIndexTools } from '../src/main/tools/projectIndex'
import { ToolRegistry } from '../src/main/tools/registry'
import { defaultSettings } from '../src/shared/defaults'
import { makeCtx } from './helpers/ctx'

const names = (code: string, lang: Parameters<typeof extractSymbols>[0]) => extractSymbols(lang, code).symbols.map((s) => `${s.kind}:${s.parent ? `${s.parent}.` : ''}${s.name}${s.exported ? '' : '!'}`)

describe('what a file defines', () => {
  it('knows the languages by extension', () => {
    expect(languageOf('a/b.tsx')).toBe('js')
    expect(languageOf('x.PY')).toBe('py')
    expect(languageOf('page.html')).toBe('html')
    expect(languageOf('notes.md')).toBeNull()
    expect(languageOf('Makefile')).toBeNull()
  })

  it('reads TypeScript: functions, classes with methods, types, arrows, constants and imports', () => {
    const src = `import { a } from './a'
import type { T } from '@shared/types'
const x = require('./legacy')
export interface Options { a: number }
export type Mode = 'x' | 'y'
export enum Color { Red }
export function build(opts: Options): number {
  const inner = () => 1
  return inner()
}
function helper() {}
export const make = async (n: number) => n
export const LIMIT = 10
export class Store {
  private items: string[] = []
  add(item: string) {
    if (item) {
      this.items.push(item)
    }
  }
  async load(): Promise<void> {}
  private secret() {}
}
`
    const r = extractSymbols('js', src)
    expect(r.symbols.map((s) => `${s.kind}:${s.parent ? `${s.parent}.` : ''}${s.name}${s.exported ? '' : '!'}`)).toEqual([
      'interface:Options', 'type:Mode', 'enum:Color', 'function:build', 'function:helper!', 'function:make', 'const:LIMIT', 'class:Store',
      'method:Store.add', 'method:Store.load', 'method:Store.secret!'
    ])
    expect(r.symbols.find((s) => s.name === 'build')?.line).toBe(7)
    expect(r.imports).toEqual(['./a', '@shared/types', './legacy'])
  })

  it('reads object literals and the script inside an HTML page, with the right line numbers', () => {
    const html = `<!doctype html>
<html><body>
<script src="lib/util.js"></script>
<script>
  const SleeperAPI = {
    BASE: 'https://x',
    async get(path) {
      return fetch(path)
    },
    getUser(name) { return this.get(name) }
  }
  function setLoading(t) {}
  const app = {
    data: { a: 1 },
    init() {}
  }
</script>
</body></html>`
    const r = extractSymbols('html', html)
    expect(r.symbols.map((s) => `${s.kind}:${s.parent ? `${s.parent}.` : ''}${s.name}`)).toEqual(['object:SleeperAPI', 'method:SleeperAPI.get', 'method:SleeperAPI.getUser', 'function:setLoading', 'object:app', 'method:app.init'])
    expect(r.symbols[0].line).toBe(5)
    expect(r.imports).toContain('lib/util.js')
  })

  it('reads Python', () => {
    const src = `import os, sys as system
from .util import helper
from pkg.sub import thing

MAX_RETRIES = 3

def load(path):
    def inner():
        pass
    return path

class Reader:
    def __init__(self):
        pass
    def _private(self):
        pass
    async def read(self):
        pass
`
    const r = extractSymbols('py', src)
    expect(names(src, 'py')).toEqual(['const:MAX_RETRIES', 'function:load', 'class:Reader', 'method:Reader.__init__', 'method:Reader._private!', 'method:Reader.read'])
    expect(r.imports).toEqual(['os', 'sys', '.util', 'pkg.sub'])
  })

  it('reads Go, Rust, Java, C and Ruby', () => {
    expect(names('package x\nimport (\n\t"fmt"\n)\ntype Server struct {}\nfunc (s *Server) Start() {}\nfunc helper() {}\nfunc New() *Server { return nil }\n', 'go')).toEqual(['struct:Server', 'method:Server.Start', 'function:helper!', 'function:New'])
    expect(names('pub struct Cfg {}\nimpl Cfg {\n    pub fn new() -> Self { Cfg {} }\n    fn hidden(&self) {}\n}\npub fn run() {}\nmod util;\n', 'rs')).toEqual(['struct:Cfg', 'method:Cfg.new', 'method:Cfg.hidden!', 'function:run', 'module:util!'])
    expect(names('package a;\nimport java.util.List;\npublic class Foo {\n    public static void main(String[] args) {}\n    private int count() { return 1; }\n}\n', 'java')).toEqual(['class:Foo', 'method:Foo.main', 'method:Foo.count!'])
    expect(names('#include "a.h"\nstruct Point { int x; };\nint add(int a, int b) {\n  return a + b;\n}\nstatic void hidden(void) {}\n', 'c')).toEqual(['struct:Point', 'function:add', 'function:hidden!'])
    expect(names('class Greeter\n  def hello\n  end\nend\ndef top\nend\n', 'rb')).toEqual(['class:Greeter', 'method:Greeter.hello', 'function:top'])
  })

  it('does not throw on nonsense', () => {
    expect(() => extractSymbols('js', '}}}{{{ (((\n\u0000\u0001')).not.toThrow()
    expect(extractSymbols('py', '').symbols).toEqual([])
  })
})

describe('the index of a project', () => {
  let ws: string
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true })
    fs.writeFileSync(path.join(ws, rel), content)
  }
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-idx-'))
    write('tsconfig.json', '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@shared/*": ["src/shared/*"], "@/*": ["src/app/*"], }, }, }')
    write('src/shared/plan.ts', 'export function applyPlan() {}\nexport function planText() {}\n')
    write('src/shared/types.ts', 'export interface Plan { a: number }\n')
    write('src/app/store.ts', "import { applyPlan } from '@shared/plan'\nimport type { Plan } from '@shared/types'\nimport { ui } from './ui'\nexport class Store {\n  save() { applyPlan() }\n}\n")
    write('src/app/ui.ts', "import { Store } from './store.js'\nexport const ui = () => new Store()\n")
    write('src/app/index.ts', "export * from './ui'\n")
    write('node_modules/dep/index.js', 'export function ignoredDep() {}\n')
    write('dist/bundle.js', 'export function ignoredBuild() {}\n')
    write('notes.md', '# not code')
  })
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }))

  it('indexes the project and skips dependencies and build output', async () => {
    const idx = new CodeIndex(ws)
    await idx.refresh()
    expect([...idx.files.keys()].sort()).toEqual(['src/app/index.ts', 'src/app/store.ts', 'src/app/ui.ts', 'src/shared/plan.ts', 'src/shared/types.ts'])
    expect(idx.find('ignoredDep')).toEqual([])
  })

  it('follows imports, including path aliases from tsconfig and .js written for .ts', async () => {
    const idx = new CodeIndex(ws)
    await idx.refresh()
    expect(idx.files.get('src/app/store.ts')!.uses.sort()).toEqual(['src/app/ui.ts', 'src/shared/plan.ts', 'src/shared/types.ts'])
    expect(idx.files.get('src/app/ui.ts')!.uses).toEqual(['src/app/store.ts'])
    expect(idx.importers('src/shared/plan.ts')).toEqual(['src/app/store.ts'])
    expect(idx.files.get('src/app/index.ts')!.uses).toEqual(['src/app/ui.ts'])
  })

  it('finds definitions by name, best match first', async () => {
    const idx = new CodeIndex(ws)
    await idx.refresh()
    expect(idx.find('applyPlan')[0]).toMatchObject({ rel: 'src/shared/plan.ts', name: 'applyPlan', line: 1 })
    // An exact match (ignoring case) first, then names that start with it, then names that contain it.
    expect(idx.find('plan').map((m) => m.name)).toEqual(['Plan', 'planText', 'applyPlan'])
    expect(idx.find('Store.save')[0]).toMatchObject({ kind: 'method', parent: 'Store' })
    expect(idx.find('Store', { kind: 'class' })).toHaveLength(1)
    expect(idx.find('nothingLikeThis')).toEqual([])
  })

  it('finds where a name is used, as a whole word', async () => {
    write('src/app/other.ts', 'const applyPlanner = 1\napplyPlan()\n')
    const idx = new CodeIndex(ws)
    await idx.refresh()
    const { usages } = await idx.usages('applyPlan')
    expect(usages.map((u) => `${u.rel}:${u.line}${u.def ? '*' : ''}`).sort()).toEqual(['src/app/other.ts:2', 'src/app/store.ts:1', 'src/app/store.ts:5', 'src/shared/plan.ts:1*'])
  })

  it('notices new, changed and deleted files', async () => {
    const idx = new CodeIndex(ws)
    await idx.refresh()
    write('src/app/new.ts', 'export function brandNew() {}\n')
    write('src/shared/plan.ts', 'export function renamed() {}\n')
    fs.rmSync(path.join(ws, 'src/shared/types.ts'))
    await idx.refresh()
    expect(idx.find('brandNew')).toHaveLength(1)
    expect(idx.find('applyPlan')).toEqual([])
    expect(idx.find('renamed')).toHaveLength(1)
    expect(idx.files.has('src/shared/types.ts')).toBe(false)
    expect(idx.files.get('src/app/store.ts')!.uses).not.toContain('src/shared/types.ts')
  })

  it('makes a map that fits its budget, most-used files first', async () => {
    const idx = new CodeIndex(ws)
    await idx.refresh()
    const big = idx.repoMap(4000)
    expect(big).toContain('5 source files indexed')
    expect(big).toContain('src/shared/plan.ts: applyPlan, planText')
    expect(big).not.toContain('Folders')
    expect(big).toContain('Store(1 methods)')
    const small = idx.repoMap(160)
    expect(small.length).toBeLessThan(260)
    expect(small).toMatch(/more files with definitions not shown/)
    expect(new CodeIndex(ws).repoMap(1000)).toBe('')
  })

  it('lists the biggest folders when there are several, so the whole layout shows', async () => {
    for (const d of ['a', 'b', 'c', 'd']) write(`lib/${d}/x.ts`, `export function ${d}x() {}\n`)
    write('lib/a/y.ts', 'export function ay() {}\n')
    const idx = new CodeIndex(ws)
    await idx.refresh()
    const map = idx.repoMap(3000)
    expect(map).toMatch(/Folders \(files\): .*lib\/a 2/)
    expect(map).toContain('src/app 3')
    expect(idx.repoMap(300)).not.toContain('Folders')
  })

  it('finds a file by the path as the model wrote it', async () => {
    const idx = new CodeIndex(ws)
    await idx.refresh()
    expect(idx.entry('./src/app/ui.ts')?.rel).toBe('src/app/ui.ts')
    expect(idx.entry('plan.ts')?.rel).toBe('src/shared/plan.ts')
    expect(idx.entry(path.join(ws, 'src/app/ui.ts'))?.rel).toBe('src/app/ui.ts')
    expect(idx.entry('missing.ts')).toBeUndefined()
  })
})

describe('the index tools', () => {
  let ws: string
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-idxt-'))
    fs.mkdirSync(path.join(ws, 'src'))
    fs.writeFileSync(path.join(ws, 'src/math.ts'), 'export function add(a: number, b: number) {\n  return a + b\n}\n')
    fs.writeFileSync(path.join(ws, 'src/main.ts'), "import { add } from './math'\nconsole.log(add(1, 2))\n")
  })
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }))
  const tool = (n: string) => projectIndexTools().find((t) => t.name === n)!

  it('find_symbol answers with file, line and the definition', async () => {
    const r = await tool('find_symbol').execute({ name: 'add' }, makeCtx(ws))
    expect(r.content).toContain('src/math.ts:1  function add')
    expect(r.content).toContain('export function add(a: number, b: number)')
    expect((await tool('find_symbol').execute({ name: 'zzz' }, makeCtx(ws))).content).toMatch(/No definition matches "zzz" among 2 indexed/)
    await expect(tool('find_symbol').execute({ name: 'add', kind: 'nope' }, makeCtx(ws))).rejects.toThrow(/kind must be/)
    await expect(tool('find_symbol').execute({ name: 'add' }, makeCtx(null))).rejects.toThrow(/workspace/)
  })

  it('file_outline lists definitions and both directions of imports', async () => {
    const r = await tool('file_outline').execute({ path: 'src/math.ts' }, makeCtx(ws))
    expect(r.content).toContain('src/math.ts  (TypeScript/JavaScript, 4 lines)')
    expect(r.content).toContain('Imported by 1 file: src/main.ts')
    expect(r.content).toContain('1: function add')
    const main = await tool('file_outline').execute({ path: 'src/main.ts' }, makeCtx(ws))
    expect(main.content).toContain('Imports (project files): src/math.ts')
    await expect(tool('file_outline').execute({ path: 'src/none.ts' }, makeCtx(ws))).rejects.toThrow(/not in the project index/)
  })

  it('find_usages marks the definition and counts', async () => {
    const r = await tool('find_usages').execute({ name: 'add' }, makeCtx(ws))
    expect(r.content).toContain('src/math.ts:1  [definition]')
    expect(r.content).toContain('src/main.ts:2')
    expect(r.content).toMatch(/\d lines in 2 files/)
    expect((await tool('find_usages').execute({ name: 'ghost' }, makeCtx(ws))).content).toMatch(/does not appear/)
  })

  it('are offered with the others and shown in the system prompt as a map', async () => {
    const settings = defaultSettings('/tmp/m')
    const tools = new ToolRegistry(() => settings, new McpManager(() => settings)).forRun(false)
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['find_symbol', 'file_outline', 'find_usages']))
    const conv = { id: 'c', title: 't', createdAt: 0, updatedAt: 0, toolsEnabled: true, params: {}, messages: [] as never[] }
    const withMap = buildSystemPrompt(settings, conv, tools, ws, { projectMap: '2 source files indexed.\nsrc/math.ts: add' })
    expect(withMap).toContain('## Project map')
    expect(withMap).toContain('src/math.ts: add')
    expect(buildSystemPrompt(settings, conv, tools, ws)).not.toContain('## Project map')
    const noIndex = tools.filter((t) => t.name !== 'find_symbol')
    expect(buildSystemPrompt(settings, conv, noIndex, ws, { projectMap: 'x: y' })).not.toContain('## Project map')
  })
})
