import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig, McpStatus, Settings } from '@shared/types'
import { emit } from '../events'
import type { ToolImpl } from './types'

interface Conn {
  cfg: McpServerConfig
  sig: string
  state: McpStatus['state']
  error?: string
  client?: Client
  tools: ToolImpl[]
  rawTools: { name: string; description: string }[]
}

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function mcpToolName(server: string, tool: string): string {
  const base = `${sanitizeName(server)}__${sanitizeName(tool)}`
  return base.length <= 64 ? base : base.slice(0, 64)
}

function cleanSchema(schema: unknown): Record<string, unknown> {
  const s: Record<string, unknown> = schema && typeof schema === 'object' ? { ...(schema as Record<string, unknown>) } : {}
  delete s.$schema
  if (s.type !== 'object') s.type = 'object'
  if (!s.properties) s.properties = {}
  return s
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

function formatContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : JSON.stringify(content)
  const parts: string[] = []
  for (const c of content as Record<string, any>[]) {
    if (c.type === 'text') parts.push(String(c.text ?? ''))
    else if (c.type === 'image') parts.push(`[image: ${c.mimeType ?? 'image'}, ${Math.round(((c.data?.length ?? 0) * 3) / 4 / 1024)} KB — not displayed]`)
    else if (c.type === 'audio') parts.push(`[audio: ${c.mimeType ?? 'audio'}]`)
    else if (c.type === 'resource' && c.resource) parts.push(c.resource.text ? `[resource ${c.resource.uri}]\n${c.resource.text}` : `[resource ${c.resource.uri}]`)
    else if (c.type === 'resource_link') parts.push(`[resource link: ${c.uri}]`)
    else parts.push(JSON.stringify(c))
  }
  return parts.join('\n')
}

export class McpManager {
  private conns = new Map<string, Conn>()

  constructor(private getSettings: () => Settings) {}

  private signature(cfg: McpServerConfig): string {
    return JSON.stringify([cfg.transport, cfg.command, cfg.args, cfg.env, cfg.cwd, cfg.url, cfg.headers, cfg.enabled, cfg.name, cfg.permission])
  }

  /** Reconcile live connections with the current settings. */
  async sync(): Promise<void> {
    const want = this.getSettings().mcpServers
    const wantIds = new Set(want.map((s) => s.id))
    for (const [id, conn] of [...this.conns]) {
      if (!wantIds.has(id)) {
        await this.close(conn)
        this.conns.delete(id)
      }
    }
    const jobs: Promise<void>[] = []
    for (const cfg of want) {
      const existing = this.conns.get(cfg.id)
      const sig = this.signature(cfg)
      if (existing && existing.sig === sig) continue
      if (existing) await this.close(existing)
      const conn: Conn = { cfg, sig, state: cfg.enabled ? 'connecting' : 'disabled', tools: [], rawTools: [] }
      this.conns.set(cfg.id, conn)
      if (cfg.enabled) jobs.push(this.connect(conn))
    }
    this.publish()
    await Promise.allSettled(jobs)
    this.publish()
  }

  async reconnect(id: string): Promise<void> {
    const conn = this.conns.get(id)
    if (!conn) return
    await this.close(conn)
    conn.state = conn.cfg.enabled ? 'connecting' : 'disabled'
    conn.error = undefined
    this.publish()
    if (conn.cfg.enabled) await this.connect(conn)
    this.publish()
  }

  status(): McpStatus[] {
    return [...this.conns.values()].map((c) => ({
      id: c.cfg.id,
      state: c.state,
      error: c.error,
      tools: c.rawTools
    }))
  }

  tools(): ToolImpl[] {
    return [...this.conns.values()].filter((c) => c.state === 'connected').flatMap((c) => c.tools)
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.conns.values()].map((c) => this.close(c)))
    this.conns.clear()
  }

  private publish(): void {
    emit('mcp:status', this.status())
  }

  private async close(conn: Conn): Promise<void> {
    const c = conn.client
    conn.client = undefined
    conn.tools = []
    conn.rawTools = []
    if (c) {
      try {
        await withTimeout(c.close(), 4000, 'close')
      } catch {
        /* ignore */
      }
    }
  }

  private async connect(conn: Conn): Promise<void> {
    const { cfg } = conn
    try {
      const client = new Client({ name: 'cairn', version: '1.0.0' }, { capabilities: {} })
      client.onclose = () => {
        if (conn.client === client && conn.state === 'connected') {
          conn.state = 'error'
          conn.error = 'Connection closed'
          conn.tools = []
          this.publish()
        }
      }
      if (cfg.transport === 'stdio') {
        if (!cfg.command.trim()) throw new Error('No command configured')
        const transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          env: { ...getDefaultEnvironment(), ...cfg.env },
          cwd: cfg.cwd || undefined,
          stderr: 'ignore'
        })
        await withTimeout(client.connect(transport), 30000, 'Connecting')
      } else {
        if (!cfg.url.trim()) throw new Error('No URL configured')
        const url = new URL(cfg.url)
        const requestInit = { headers: cfg.headers }
        try {
          await withTimeout(client.connect(new StreamableHTTPClientTransport(url, { requestInit })), 20000, 'Connecting')
        } catch (first) {
          // Older servers only speak the legacy SSE transport.
          try {
            const legacy = new Client({ name: 'cairn', version: '1.0.0' }, { capabilities: {} })
            await withTimeout(legacy.connect(new SSEClientTransport(url, { requestInit })), 20000, 'Connecting (SSE)')
            conn.client = legacy
            await this.loadTools(conn, legacy)
            return
          } catch {
            throw first
          }
        }
      }
      conn.client = client
      await this.loadTools(conn, client)
    } catch (e) {
      conn.state = 'error'
      conn.error = e instanceof Error ? e.message : String(e)
      conn.tools = []
      conn.rawTools = []
    }
  }

  private async loadTools(conn: Conn, client: Client): Promise<void> {
    const { cfg } = conn
    const listed = await withTimeout(client.listTools(), 20000, 'Listing tools')
    conn.rawTools = listed.tools.map((t) => ({ name: t.name, description: t.description ?? '' }))
    conn.tools = listed.tools.map((t): ToolImpl => ({
      name: mcpToolName(cfg.name, t.name),
      description: `[${cfg.name}] ${t.description ?? t.title ?? t.name}`,
      parameters: cleanSchema(t.inputSchema),
      source: 'mcp',
      group: cfg.name,
      defaultPermission: cfg.permission,
      describe: () => ({ kind: 'generic', title: `${cfg.name}: ${t.name}` }),
      execute: async (args, ctx) => {
        ctx.progress(`${cfg.name}: ${t.name}…`)
        const res = await client.callTool({ name: t.name, arguments: args }, undefined, { signal: ctx.signal, timeout: 120000 })
        let text = formatContent((res as { content?: unknown }).content)
        if (!text && (res as { structuredContent?: unknown }).structuredContent) text = JSON.stringify((res as { structuredContent?: unknown }).structuredContent, null, 2)
        return { content: text || '(no output)', isError: Boolean((res as { isError?: boolean }).isError) }
      }
    }))
    conn.state = 'connected'
    conn.error = undefined
  }
}
