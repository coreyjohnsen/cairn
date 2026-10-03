import { spawn } from 'node:child_process'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { CustomToolConfig } from '@shared/types'
import { parseToolArgs, safeJsonStringify } from '../util/json'
import { OutputCollector, killTree } from './shell'
import { type ToolContext, ToolError, type ToolImpl, type ToolResult } from './types'
import { collectorSizes, outputLimitOf } from '../util/limits'

export const TOOL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/

export function renderTemplate(tpl: string, args: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g, (_m, key: string) => {
    const v = args[key]
    if (v === undefined || v === null) return ''
    return typeof v === 'string' ? v : safeJsonStringify(v)
  })
}

export function parseSchema(text: string): { ok: true; schema: Record<string, unknown> } | { ok: false; error: string } {
  const t = (text ?? '').trim()
  if (!t) return { ok: true, schema: { type: 'object', properties: {} } }
  const r = parseToolArgs(t)
  if (!r.ok) return { ok: false, error: r.error.replace('tool arguments', 'schema') }
  const schema = { ...r.value }
  if (schema.type === undefined) schema.type = 'object'
  if (schema.type !== 'object') return { ok: false, error: 'Parameters schema must have type "object"' }
  if (!schema.properties) schema.properties = {}
  return { ok: true, schema }
}

/* ───────────────────────────── command ───────────────────────────── */

async function runCommandTool(cfg: Extract<CustomToolConfig['impl'], { type: 'command' }>, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const file = renderTemplate(cfg.file, args).trim()
  if (!file) throw new ToolError('This tool has no executable configured.')
  const argv = cfg.args.map((a) => renderTemplate(a, args))
  const cwd = cfg.cwd ? path.resolve(ctx.workspace ?? process.cwd(), renderTemplate(cfg.cwd, args)) : (ctx.workspace ?? process.cwd())
  return new Promise<ToolResult>((resolve, reject) => {
    let child
    try {
      child = spawn(file, argv, {
        cwd,
        env: { ...process.env, CAIRN_ARGS: JSON.stringify(args), CAIRN_WORKSPACE: ctx.workspace ?? '' },
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (e) {
      reject(new ToolError(`Failed to start "${file}": ${(e as Error).message}`))
      return
    }
    const sizes = collectorSizes(outputLimitOf(ctx))
    const out = new OutputCollector(sizes.head, sizes.tail)
    const err = new OutputCollector(2000, 4000)
    let timedOut = false
    let cancelled = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, Math.max(1, cfg.timeoutSec) * 1000)
    const onAbort = () => {
      cancelled = true
      killTree(child.pid)
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => out.push(d))
    child.stderr.on('data', (d: string) => err.push(d))
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(args))
    child.on('error', (e) => {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      const hint = /EINVAL|ENOENT/.test(e.message)
        ? ' (use a real executable such as python, node or a .exe — .bat/.cmd files cannot be run directly)'
        : ''
      reject(new ToolError(`Failed to start "${file}": ${e.message}${hint}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      if (cancelled) return resolve({ content: 'Cancelled.', isError: true })
      if (timedOut) return resolve({ content: `Timed out after ${cfg.timeoutSec}s.\n${out.toString()}`, isError: true })
      const stdout = out.toString()
      const stderr = err.toString()
      if (code !== 0) return resolve({ content: `Exit code ${code}\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim(), isError: true })
      resolve({ content: stdout || stderr || '(no output)' })
    })
  })
}

/* ───────────────────────────── http ───────────────────────────── */

async function runHttpTool(cfg: Extract<CustomToolConfig['impl'], { type: 'http' }>, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const url = renderTemplate(cfg.url, args)
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new ToolError(`Invalid URL after substituting arguments: ${url}`)
  }
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k] = renderTemplate(v, args)
  const hasBody = cfg.method !== 'GET' && cfg.body !== undefined && cfg.body !== ''
  const body = hasBody ? renderTemplate(cfg.body!, args) : undefined
  if (hasBody && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, cfg.timeoutSec) * 1000)])
  let res: Response
  try {
    res = await fetch(u, { method: cfg.method, headers, body, signal })
  } catch (e) {
    throw new ToolError(`Request failed: ${(e as Error).message}`)
  }
  const text = await res.text()
  return { content: `HTTP ${res.status} ${res.statusText}\n${text}`, isError: !res.ok }
}

/* ───────────────────────────── javascript ───────────────────────────── */

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const logs = [];
const fmt = (a) => a.map((x) => { if (typeof x === 'string') return x; try { return JSON.stringify(x) } catch { return String(x) } }).join(' ');
console.log = console.info = console.warn = console.error = console.debug = (...a) => { logs.push(fmt(a)) };
(async () => {
  const fn = new AsyncFunction('args', 'ctx', 'require', workerData.code);
  const result = await fn(workerData.args, workerData.ctx, require);
  parentPort.postMessage({ ok: true, result: result === undefined ? null : result, logs });
})().catch((e) => parentPort.postMessage({ ok: false, error: String((e && e.stack) || e), logs }));
`

async function runJsTool(cfg: Extract<CustomToolConfig['impl'], { type: 'javascript' }>, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: {
        code: cfg.code,
        args,
        ctx: { workspace: ctx.workspace, conversationId: ctx.conversationId }
      }
    })
    let settled = false
    const done = (r: ToolResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      void worker.terminate()
      resolve(r)
    }
    const timer = setTimeout(() => done({ content: `Timed out after ${cfg.timeoutSec}s.`, isError: true }), Math.max(1, cfg.timeoutSec) * 1000)
    const onAbort = () => done({ content: 'Cancelled.', isError: true })
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    worker.on('message', (m: { ok: boolean; result?: unknown; error?: string; logs?: string[] }) => {
      const logText = m.logs?.length ? `\n[log]\n${m.logs.join('\n')}` : ''
      if (!m.ok) return done({ content: `${m.error ?? 'Tool failed'}${logText}`, isError: true })
      const body = typeof m.result === 'string' ? m.result : m.result === null ? '(no return value)' : safeJsonStringify(m.result, 2)
      done({ content: body + logText })
    })
    worker.on('error', (e) => done({ content: `${e.stack ?? e.message}`, isError: true }))
    worker.on('exit', (code) => {
      if (!settled && code !== 0) done({ content: `Worker exited with code ${code}`, isError: true })
    })
  })
}

/* ───────────────────────────── public ───────────────────────────── */

export function runCustomTool(cfg: CustomToolConfig, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  switch (cfg.impl.type) {
    case 'command':
      return runCommandTool(cfg.impl, args, ctx)
    case 'http':
      return runHttpTool(cfg.impl, args, ctx)
    case 'javascript':
      return runJsTool(cfg.impl, args, ctx)
  }
}

export function customToolImpl(cfg: CustomToolConfig): { tool?: ToolImpl; error?: string } {
  if (!TOOL_NAME_RE.test(cfg.name)) return { error: 'Name must start with a letter or underscore and contain only letters, digits, "_" or "-" (max 64).' }
  const schema = parseSchema(cfg.parameters)
  if (!schema.ok) return { error: schema.error }
  const tool: ToolImpl = {
    name: cfg.name,
    description: cfg.description || `Custom tool ${cfg.name}`,
    parameters: schema.schema,
    source: 'custom',
    group: 'Custom',
    defaultPermission: cfg.permission,
    describe(args) {
      const impl = cfg.impl
      if (impl.type === 'command') {
        const argv = impl.args.map((a) => renderTemplate(a, args))
        return { kind: 'command', title: `Custom tool: ${cfg.name}`, command: [renderTemplate(impl.file, args), ...argv].join(' ') }
      }
      if (impl.type === 'http') {
        return { kind: 'network', title: `Custom tool: ${cfg.name}`, command: `${impl.method} ${renderTemplate(impl.url, args)}` }
      }
      return { kind: 'generic', title: `Custom tool: ${cfg.name} (JavaScript)` }
    },
    execute: (args, ctx) => runCustomTool(cfg, args, ctx)
  }
  return { tool }
}
