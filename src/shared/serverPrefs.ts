import { defaultServerSettings } from './defaults'
import type { ServerSettings } from './types'

/**
 * Small, pure helpers for the API server settings: cleaning what is stored, the names other programs use for models,
 * and the checks on browser origins and host names. Used by the main process and the interface.
 */

export const MAX_ORIGINS = 20
export const MAX_SHARED_MODELS = 500

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** An origin as browsers send it ("https://example.com:3000"), or "*" for any page. Null when it is not one. */
export function normalizeOrigin(input: string): string | null {
  const t = input.trim()
  if (t === '*') return '*'
  try {
    const u = new URL(t)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.hostname) return null
    return u.origin
  } catch {
    return null
  }
}

/** Why this origin cannot be saved, or null when it is fine. */
export function originProblem(input: string): string | null {
  if (!input.trim()) return 'Type a web address such as https://example.com, or * for any page.'
  return normalizeOrigin(input) ? null : `"${input.trim()}" is not a web address. Use the form https://example.com or http://localhost:3000.`
}

const uniqueStrings = (input: unknown, max: number, maxLen = 1000): string[] => {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  for (const v of input) {
    if (typeof v !== 'string') continue
    const t = v.trim()
    if (!t || t.length > maxLen || out.includes(t)) continue
    out.push(t)
    if (out.length >= max) break
  }
  return out
}

/** Cleans stored server settings so a bad value can never reach the server. */
export function sanitizeServer(input: unknown): ServerSettings {
  const d = defaultServerSettings()
  const r = isRecord(input) ? input : {}
  const access = r.access === 'network' ? 'network' : 'local'
  const port = typeof r.port === 'number' && Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535 ? r.port : d.port
  const origins: string[] = []
  if (Array.isArray(r.allowedOrigins)) {
    for (const o of r.allowedOrigins) {
      const n = typeof o === 'string' ? normalizeOrigin(o) : null
      if (n && !origins.includes(n)) origins.push(n)
      if (origins.length >= MAX_ORIGINS) break
    }
  }
  return {
    enabled: r.enabled === true,
    access,
    port,
    // Open to the network always needs a key; on this computer alone it is the user's choice.
    requireKey: access === 'network' ? true : r.requireKey !== false,
    apiKey: typeof r.apiKey === 'string' ? r.apiKey.trim().slice(0, 200) : '',
    allowedOrigins: origins,
    exposeAll: r.exposeAll !== false,
    chatModels: uniqueStrings(r.chatModels, MAX_SHARED_MODELS),
    imageModels: uniqueStrings(r.imageModels, MAX_SHARED_MODELS, 300)
  }
}

/** A model name that is safe to type in another program: no spaces, no .gguf, only letters, digits and . _ - : */
export function slugModelName(name: string): string {
  const base = name
    .replace(/\.gguf$/i, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w.\-:]+/g, '')
    .replace(/^[-.]+|[-.]+$/g, '')
  return base.slice(0, 80) || 'model'
}

/**
 * Gives every model its own name. The list is sorted by `key` first, so the names do not change when other models are
 * added, removed or hidden; a clash gets -2, -3, … after the name. `taken` holds names already used (for example by chat
 * models when naming image models).
 */
export function assignModelIds(models: { key: string; name: string }[], taken: Set<string> = new Set()): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set([...taken].map((t) => t.toLowerCase()))
  for (const m of [...models].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    const base = slugModelName(m.name)
    let id = base
    for (let n = 2; used.has(id.toLowerCase()); n++) id = `${base}-${n}`
    used.add(id.toLowerCase())
    out.set(m.key, id)
  }
  return out
}

/** The host name inside a Host header, without the port. */
export function hostName(header: string | undefined): string {
  const h = (header ?? '').trim().toLowerCase()
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1)
  const i = h.lastIndexOf(':')
  return i === -1 ? h : h.slice(0, i)
}

/** True when the Host header names this computer itself (used to stop web pages reaching the server by a made-up name). */
export function isLoopbackHost(header: string | undefined): boolean {
  const h = hostName(header)
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost')
}

/** "512x768" → size; anything else (including "auto") → null, meaning the model's own size. */
export function parseSize(size: unknown): { width: number; height: number } | null {
  if (typeof size !== 'string') return null
  const m = /^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/i.exec(size)
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  return width >= 64 && height >= 64 && width <= 4096 && height <= 4096 ? { width, height } : null
}

/** Ready-to-paste examples for the Serve tab. `key` is null when no key is needed. */
export function serveExamples(o: { base: string; key: string | null; chat: string; image?: string }): { curl: string; powershell: string; python: string; images: string } {
  const base = o.base.replace(/\/+$/, '')
  const auth = o.key ? ` \\\n  -H "Authorization: Bearer ${o.key}"` : ''
  const curl = `curl ${base}/chat/completions \\\n  -H "Content-Type: application/json"${auth} \\\n  -d '{"model": "${o.chat}", "messages": [{"role": "user", "content": "Hello!"}]}'`
  // In Windows PowerShell "curl" is another command (Invoke-WebRequest) that does not take these options, so it gets its own example.
  const headers = o.key ? ` -Headers @{ Authorization = "Bearer ${o.key}" }` : ''
  const powershell = `$body = @{\n    model = "${o.chat}"\n    messages = @(@{ role = "user"; content = "Hello!" })\n} | ConvertTo-Json -Depth 5\n\n$reply = Invoke-RestMethod -Uri "${base}/chat/completions" -Method Post -ContentType "application/json"${headers} -Body $body\n$reply.choices[0].message.content`
  const client = `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}", api_key="${o.key ?? 'not-needed'}")\n`
  const python = `${client}\nreply = client.chat.completions.create(\n    model="${o.chat}",\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(reply.choices[0].message.content)`
  const images = `${client}\nresult = client.images.generate(\n    model="${o.image ?? 'your-image-model'}",\n    prompt="a lighthouse on a cliff at dawn",\n    size="768x512",\n)\nprint(result.data[0].url)`
  return { curl, powershell, python, images }
}
