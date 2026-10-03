import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fitHistory, historyFor } from '../src/main/agent/context'
import { contextOutputLimit, outputLimitOf } from '../src/main/util/limits'
import { detectImageRequest } from '../src/main/agent/intent'
import { runCustomTool, customToolImpl, renderTemplate } from '../src/main/tools/custom'
import { fsTools, planEdit } from '../src/main/tools/fs'
import { resolvePath } from '../src/main/tools/sandbox'
import { resolveShell, shellTools, OutputCollector } from '../src/main/tools/shell'
import { UNLIMITED_BUFFER_CHARS, collectorSizes, maxAgentSteps, toolOutputLimit } from '../src/main/util/limits'
import { isPrivateHost, parseDuckDuckGo } from '../src/main/tools/web'
import { makeDiff } from '../src/main/util/diff'
import { globToRegExp, matchGlob } from '../src/main/util/glob'
import { htmlToText } from '../src/main/util/html'
import { parseToolArgs } from '../src/main/util/json'
import type { ChatMessage, CustomToolConfig } from '../src/shared/types'
import { makeCtx } from './helpers/ctx'

let ws: string
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-ws-'))
})
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true })
})

const tool = (name: string) => [...fsTools(), ...shellTools()].find((t) => t.name === name)!

describe('sandbox', () => {
  it('keeps paths inside the workspace', () => {
    expect(resolvePath(ws, 'a/b.txt', false).inside).toBe(true)
    expect(() => resolvePath(ws, '../escape.txt', false)).toThrow(/outside the workspace/)
    expect(() => resolvePath(ws, '/etc/passwd', false)).toThrow(/outside the workspace/)
    expect(resolvePath(ws, '/etc/passwd', true).inside).toBe(false)
  })
  it('blocks symlink escapes', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-out-'))
    fs.symlinkSync(outside, path.join(ws, 'link'))
    expect(() => resolvePath(ws, 'link/secret.txt', false)).toThrow(/outside the workspace/)
    fs.rmSync(outside, { recursive: true, force: true })
  })
  it('requires a workspace for relative paths', () => {
    expect(() => resolvePath(null, 'a.txt', false)).toThrow(/No workspace/)
  })
})

describe('file tools', () => {
  it('write → read → edit → search → find → move → delete', async () => {
    const ctx = makeCtx(ws)
    await tool('write_file').execute({ path: 'src/app.ts', content: 'const a = 1\nconst b = 2\nconsole.log(a + b)\n' }, ctx)
    const read = await tool('read_file').execute({ path: 'src/app.ts' }, ctx)
    expect(read.content).toContain('     2\tconst b = 2')

    const edit = await tool('edit_file').execute({ path: 'src/app.ts', old_string: 'const b = 2', new_string: 'const b = 40' }, ctx)
    expect(edit.content).toMatch(/1 replacement/)
    expect(fs.readFileSync(path.join(ws, 'src/app.ts'), 'utf8')).toContain('const b = 40')

    const found = await tool('search_files').execute({ pattern: 'const \\w = \\d+', glob: '*.ts' }, ctx)
    expect(found.content).toContain('src/app.ts:1:')
    expect(found.content).toContain('src/app.ts:2:')

    const files = await tool('find_files').execute({ glob: '**/*.ts' }, ctx)
    expect(files.content.trim()).toBe('src/app.ts')

    await tool('move_path').execute({ from: 'src/app.ts', to: 'lib/app.ts' }, ctx)
    expect(fs.existsSync(path.join(ws, 'lib/app.ts'))).toBe(true)

    await expect(tool('delete_path').execute({ path: 'lib' }, ctx)).rejects.toThrow(/recursive/)
    await tool('delete_path').execute({ path: 'lib', recursive: true }, ctx)
    expect(fs.existsSync(path.join(ws, 'lib'))).toBe(false)
  })

  it('edit_file rejects ambiguous and missing matches, and handles CRLF', async () => {
    const ctx = makeCtx(ws)
    fs.writeFileSync(path.join(ws, 'x.txt'), 'foo\nfoo\n')
    await expect(planEdit({ path: 'x.txt', old_string: 'foo', new_string: 'bar' }, ctx)).rejects.toThrow(/2 times/)
    await expect(planEdit({ path: 'x.txt', old_string: 'nope', new_string: 'bar' }, ctx)).rejects.toThrow(/not found/)
    const plan = await planEdit({ path: 'x.txt', old_string: 'foo', new_string: 'bar', replace_all: true }, ctx)
    expect(plan.after).toBe('bar\nbar\n')
    fs.writeFileSync(path.join(ws, 'crlf.txt'), 'a\r\nb\r\nc\r\n')
    const crlf = await planEdit({ path: 'crlf.txt', old_string: 'a\nb', new_string: 'a\nB' }, ctx)
    expect(crlf.after).toBe('a\r\nB\r\nc\r\n')
  })

  it('refuses to read binary files and paths outside the workspace', async () => {
    const ctx = makeCtx(ws)
    fs.writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([1, 2, 0, 3]))
    await expect(tool('read_file').execute({ path: 'bin.dat' }, ctx)).rejects.toThrow(/binary/)
    await expect(tool('read_file').execute({ path: '../../etc/hostname' }, ctx)).rejects.toThrow(/outside/)
  })

  it('forces approval for outside-workspace access when allowed', async () => {
    const ctx = makeCtx(ws, (s) => (s.agent.allowOutsideWorkspace = true))
    const p = await tool('write_file').describe!({ path: '/tmp/cairn-outside.txt', content: 'x' }, ctx)
    expect(p.forceApproval).toBe(true)
    const q = await tool('write_file').describe!({ path: 'inside.txt', content: 'x' }, ctx)
    expect(q.forceApproval).toBeFalsy()
    expect(q.diff).toContain('+x')
  })
})

describe('run_command', () => {
  it('captures output and exit code', async () => {
    const ctx = makeCtx(ws)
    const ok = await tool('run_command').execute({ command: 'echo hello && pwd' }, ctx)
    expect(ok.content).toContain('Exit code: 0')
    expect(ok.content).toContain('hello')
    expect(ok.content).toContain(fs.realpathSync(ws))
    const bad = await tool('run_command').execute({ command: 'echo oops >&2; exit 3' }, ctx)
    expect(bad.isError).toBe(true)
    expect(bad.content).toContain('Exit code: 3')
    expect(bad.content).toContain('oops')
  })
  it('kills long-running commands on timeout', async () => {
    const ctx = makeCtx(ws)
    const r = await tool('run_command').execute({ command: 'sleep 5', timeout_sec: 1 }, ctx)
    expect(r.content).toMatch(/timed out/)
  }, 10000)
  it('picks sensible shells per platform', () => {
    expect(resolveShell('auto', 'win32').name).toBe('PowerShell')
    expect(resolveShell('cmd', 'win32').file).toBe('cmd.exe')
  })
  it('OutputCollector keeps head and tail of huge output', () => {
    const c = new OutputCollector(10, 10)
    c.push('A'.repeat(50))
    c.push('B'.repeat(50))
    expect(c.toString()).toMatch(/^A{10}[\s\S]*omitted[\s\S]*B{10}$/)
  })
})

describe('tool output limit', () => {
  const write = (n: number) => fs.writeFileSync(path.join(ws, 'big.txt'), Array.from({ length: n }, (_, i) => `line ${i + 1} ${'x'.repeat(30)}`).join('\n'))
  const lineNumbers = (content: string) => [...content.matchAll(/^\s*(\d+)\t/gm)].map((m) => Number(m[1]))

  it('read_file gives whole lines that fit the limit and says where to continue, so paging reads every line once', async () => {
    write(600)
    const ctx = makeCtx(ws, (s) => (s.chat.toolOutputLimit = 4000))
    const seen: number[] = []
    let offset = 1
    for (let guard = 0; guard < 100; guard++) {
      const r = await tool('read_file').execute({ path: 'big.txt', offset }, ctx)
      expect(r.content.length).toBeLessThanOrEqual(4000)
      seen.push(...lineNumbers(r.content))
      const next = /offset=(\d+) to continue/.exec(r.content)
      if (!next) break
      expect(Number(next[1])).toBe(lineNumbers(r.content).at(-1)! + 1)
      offset = Number(next[1])
    }
    expect(seen).toEqual(Array.from({ length: 600 }, (_, i) => i + 1))
  })

  it('read_file returns the whole file, past 2000 lines, when there is no limit', async () => {
    write(6000)
    const ctx = makeCtx(ws, (s) => (s.chat.toolOutputLimit = 0))
    const r = await tool('read_file').execute({ path: 'big.txt' }, ctx)
    expect(lineNumbers(r.content)).toHaveLength(6000)
    expect(r.content).not.toMatch(/more line/)
    // A limit the model asks for still works.
    const part = await tool('read_file').execute({ path: 'big.txt', offset: 10, limit: 3 }, ctx)
    expect(lineNumbers(part.content)).toEqual([10, 11, 12])
    expect(part.content).toMatch(/offset=13 to continue/)
  })

  it('read_file moves past a single line that is longer than the limit instead of repeating it', async () => {
    fs.writeFileSync(path.join(ws, 'wide.txt'), `${'y'.repeat(5000)}\nsecond\n`)
    const ctx = makeCtx(ws, (s) => (s.chat.toolOutputLimit = 1000))
    const r = await tool('read_file').execute({ path: 'wide.txt' }, ctx)
    expect(r.content).toMatch(/longer than the tool output limit/)
    expect(r.content).toMatch(/offset=2 to continue/)
    const next = await tool('read_file').execute({ path: 'wide.txt', offset: 2 }, ctx)
    expect(next.content).toContain('second')
  })

  it('works out the limits: 0 or anything else that is not a positive number means no limit', () => {
    const lim = (v: unknown) => toolOutputLimit({ chat: { toolOutputLimit: v } } as never)
    const steps = (v: unknown) => maxAgentSteps({ chat: { maxAgentSteps: v } } as never)
    expect(lim(20000)).toBe(20000)
    expect(lim(1234567890)).toBe(1234567890)
    for (const v of [0, -5, NaN, undefined, 'x']) {
      expect(lim(v)).toBe(Infinity)
      expect(steps(v)).toBe(Infinity)
    }
    expect(steps(3.9)).toBe(3)
    expect(steps(1000)).toBe(1000)
  })

  it('keeps program output to the limit, and a large safe amount when there is none', () => {
    const small = collectorSizes(10000)
    expect(small.head + small.tail).toBeLessThan(10000)
    expect(small.head).toBeLessThan(small.tail)
    const none = collectorSizes(Infinity)
    expect(none.head + none.tail).toBe(UNLIMITED_BUFFER_CHARS)
    const c = new OutputCollector(none.head, none.tail)
    c.push('z'.repeat(1_000_000))
    expect(c.toString()).toHaveLength(1_000_000) // nothing is cut below the buffer
  })
})

describe('custom tools', () => {
  const base = { id: '1', name: 'my_tool', description: 'd', enabled: true, parameters: '{"type":"object","properties":{"who":{"type":"string"}}}', permission: 'ask' as const }
  it('renders templates', () => {
    expect(renderTemplate('hi {{ who }} {{n}} {{missing}}!', { who: 'you', n: 3 })).toBe('hi you 3 !')
  })
  it('runs a command without a shell, passing args on stdin and as env', async () => {
    const cfg: CustomToolConfig = {
      ...base,
      impl: { type: 'command', file: process.execPath, args: ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("stdin="+s+" env="+process.env.CAIRN_ARGS+" argv="+process.argv[1]))', '{{who}}'], timeoutSec: 10 }
    }
    const r = await runCustomTool(cfg, { who: 'world; rm -rf /' }, makeCtx(ws))
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('stdin={"who":"world; rm -rf /"}')
    expect(r.content).toContain('argv=world; rm -rf /')
  })
  it('runs JavaScript tools in a worker with timeout', async () => {
    const cfg: CustomToolConfig = { ...base, impl: { type: 'javascript', code: 'console.log("hi"); return { sum: args.a + args.b }', timeoutSec: 5 } }
    const r = await runCustomTool(cfg, { a: 2, b: 3 }, makeCtx(ws))
    expect(r.content).toContain('"sum": 5')
    expect(r.content).toContain('hi')
    const slow: CustomToolConfig = { ...base, impl: { type: 'javascript', code: 'while(true){}', timeoutSec: 1 } }
    expect((await runCustomTool(slow, {}, makeCtx(ws))).content).toMatch(/Timed out/)
    const bad: CustomToolConfig = { ...base, impl: { type: 'javascript', code: 'throw new Error("boom")', timeoutSec: 5 } }
    const e = await runCustomTool(bad, {}, makeCtx(ws))
    expect(e.isError).toBe(true)
    expect(e.content).toContain('boom')
  })
  it('calls HTTP tools', async () => {
    let seen = ''
    const srv = http.createServer((req, res) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => {
        seen = `${req.method} ${req.url} ${req.headers['x-token']} ${b}`
        res.end('pong')
      })
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as AddressInfo).port
    const cfg: CustomToolConfig = { ...base, impl: { type: 'http', method: 'POST', url: `http://127.0.0.1:${port}/echo?q={{who}}`, headers: { 'X-Token': 'abc' }, body: '{"who":"{{who}}"}', timeoutSec: 5 } }
    const r = await runCustomTool(cfg, { who: 'me' }, makeCtx(ws))
    srv.close()
    expect(r.content).toContain('HTTP 200')
    expect(r.content).toContain('pong')
    expect(seen).toBe('POST /echo?q=me abc {"who":"me"}')
  })
  it('validates names and schemas', () => {
    expect(customToolImpl({ ...base, name: 'bad name', impl: { type: 'javascript', code: '', timeoutSec: 5 } }).error).toMatch(/Name/)
    expect(customToolImpl({ ...base, parameters: '{nope', impl: { type: 'javascript', code: '', timeoutSec: 5 } }).error).toBeTruthy()
    expect(customToolImpl({ ...base, impl: { type: 'javascript', code: '', timeoutSec: 5 } }).tool?.name).toBe('my_tool')
  })
})

describe('utilities', () => {
  it('globs', () => {
    expect(globToRegExp('**/*.{ts,tsx}').test('src/a/b.tsx')).toBe(true)
    expect(globToRegExp('**/*.ts').test('a.ts')).toBe(true)
    expect(matchGlob('*.md', 'docs/readme.md')).toBe(true)
    expect(matchGlob('src/*.ts', 'src/a/b.ts')).toBe(false)
    expect(matchGlob('README?', 'readme1')).toBe(true)
  })
  it('diffs', () => {
    const d = makeDiff('a\nb\nc\nd\ne\nf\ng\nh\ni\nj', 'a\nb\nc\nd\nE\nf\ng\nh\ni\nj', 2)
    expect(d).toContain('-e')
    expect(d).toContain('+E')
    expect(d).not.toContain(' a')
    expect(makeDiff('same', 'same')).toBe('(no changes)')
  })
  it('converts html to text', () => {
    const t = htmlToText('<html><head><title>x</title><style>p{}</style></head><body><h1>Hi &amp; bye</h1><p>One<br>Two</p><ul><li>a</li><li>b</li></ul><a href="https://e.com">link</a><script>evil()</script></body></html>')
    expect(t).toContain('# Hi & bye')
    expect(t).toContain('- a')
    expect(t).toContain('link (https://e.com)')
    expect(t).not.toContain('evil')
  })
  it('repairs sloppy tool-call JSON', () => {
    expect(parseToolArgs('{"a":1,}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseToolArgs('```json\n{"a":"b"}\n```')).toEqual({ ok: true, value: { a: 'b' } })
    expect(parseToolArgs('{"a":{"b":[1,2')).toEqual({ ok: true, value: { a: { b: [1, 2] } } })
    expect(parseToolArgs('')).toEqual({ ok: true, value: {} })
    expect(parseToolArgs('not json').ok).toBe(false)
  })
  it('detects private hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '192.168.1.5', '10.0.0.2', '172.20.1.1', '169.254.1.1', 'nas.local', '[::1]']) expect(isPrivateHost(h)).toBe(true)
    for (const h of ['example.com', '8.8.8.8', 'fcbarcelona.com', '172.32.0.1']) expect(isPrivateHost(h)).toBe(false)
  })
  it('parses DuckDuckGo results', () => {
    const html = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=zz">Example <b>A</b></a><a class="result__snippet" href="#">Snippet &amp; text</a>'
    expect(parseDuckDuckGo(html)).toEqual([{ title: 'Example A', url: 'https://example.com/a?x=1', snippet: 'Snippet & text' }])
  })
  it('detects image requests', () => {
    expect(detectImageRequest('Generate an image of a snowy peak at dawn')).toBe('a snowy peak at dawn')
    expect(detectImageRequest('can you draw me a fox in a forest?')).toBe('a fox in a forest')
    expect(detectImageRequest('/imagine neon city')).toBe('neon city')
    expect(detectImageRequest('create a picture of a dog')).toBe('a dog')
    expect(detectImageRequest('how do I generate an image in python?')).toBeNull()
    expect(detectImageRequest('What is the capital of France?')).toBeNull()
  })
})

describe('context fitting', () => {
  const m = (role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: Math.random().toString(), role, createdAt: 0, content, ...extra })
  it('drops oldest turns but keeps the latest and pairs tool calls', () => {
    const big = 'x'.repeat(3600) // ~1000 tokens
    const msgs = [
      m('user', big), m('assistant', big),
      m('user', big), m('assistant', '', { toolCalls: [{ id: 'c', name: 't', arguments: '{}' }] }), m('tool', big, { toolCallId: 'c' }), m('assistant', big),
      m('user', 'latest question')
    ]
    const out = fitHistory(msgs, 1500, 2)
    expect(out[out.length - 1].content).toBe('latest question')
    expect(out[0].role).toBe('user')
    expect(out.length).toBeLessThan(msgs.length)
  })
  it('never shrinks the tool result the model is about to read, even when the budget is tiny', () => {
    const file = 'y'.repeat(3600)
    const msgs = [
      m('user', 'read it'),
      m('assistant', '', { toolCalls: [{ id: 'a', name: 'read_file', arguments: '{}' }] }), m('tool', file, { toolCallId: 'a' }),
      m('assistant', '', { toolCalls: [{ id: 'b', name: 'read_file', arguments: '{}' }] }), m('tool', file, { toolCallId: 'b' })
    ]
    const out = fitHistory(msgs, 300, 1)
    const tools = out.filter((x) => x.role === 'tool')
    expect(tools[tools.length - 1].content).toBe(file)
    expect(tools[0].content).toContain('truncated')
  })
  it('sizes a tool result by the model memory', () => {
    expect(contextOutputLimit(undefined)).toBe(Infinity)
    expect(contextOutputLimit(3000)).toBe(4320)
    expect(contextOutputLimit(100)).toBe(1500)
    expect(outputLimitOf({ settings: { chat: { toolOutputLimit: 0 } } as never, outputLimit: 4000 })).toBe(4000)
    expect(outputLimitOf({ settings: { chat: { toolOutputLimit: 2000 } } as never, outputLimit: 4000 })).toBe(2000)
  })
  it('flattens tool traffic when tools are off', () => {
    const msgs = [m('user', 'hi'), m('assistant', 'sure', { toolCalls: [{ id: 'c', name: 't', arguments: '{}' }] }), m('tool', 'out', { toolCallId: 'c' }), m('assistant', '', { toolCalls: [{ id: 'd', name: 't', arguments: '{}' }] })]
    const out = historyFor(msgs, false)
    expect(out.map((x) => x.role)).toEqual(['user', 'assistant'])
    expect(out[1].toolCalls).toBeUndefined()
  })
})
