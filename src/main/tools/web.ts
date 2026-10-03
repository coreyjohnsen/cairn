import { BUILTIN_TOOL_DEFAULTS } from '@shared/defaults'
import { decodeEntities, htmlTitle, htmlToText } from '../util/html'
import { outputLimitOf } from '../util/limits'
import { ToolError, type ToolImpl, num, str } from './types'

const FETCH_BYTES = 3 * 1024 * 1024
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Cairn/1.0'

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true
  if (h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) {
    if (h.includes(':')) return true
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
  }
  return false
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
      if (total >= maxBytes) {
        await reader.cancel().catch(() => {})
        break
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
}

function parseUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new ToolError(`Invalid URL: ${raw}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ToolError('Only http and https URLs are supported.')
  return u
}

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

export function parseDuckDuckGo(html: string): SearchHit[] {
  const hits: SearchHit[] = []
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  const snippets: string[] = []
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) snippets.push(decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim())
  let i = 0
  for (let m = linkRe.exec(html); m; m = linkRe.exec(html)) {
    let href = decodeEntities(m[1])
    const uddg = /[?&]uddg=([^&]+)/.exec(href)
    if (uddg) href = decodeURIComponent(uddg[1])
    else if (href.startsWith('//')) href = `https:${href}`
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    if (title && /^https?:/.test(href)) hits.push({ title, url: href, snippet: snippets[i] ?? '' })
    i++
  }
  return hits
}

export function webTools(): ToolImpl[] {
  const fetchUrl: ToolImpl = {
    name: 'fetch_url',
    description: 'Download a web page or API response over HTTP(S) and return its text content (HTML is converted to readable text).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http(s) URL' },
        max_chars: { type: 'integer', description: 'Maximum characters to return (default 12000, or the whole page when the tool output limit is off)' }
      },
      required: ['url']
    },
    source: 'builtin',
    group: 'Web',
    defaultPermission: BUILTIN_TOOL_DEFAULTS.fetch_url,
    describe(args) {
      const u = parseUrl(str(args, 'url'))
      const priv = isPrivateHost(u.hostname)
      return {
        kind: 'network',
        title: `Fetch ${u.hostname}${u.pathname.length > 1 ? u.pathname.slice(0, 40) : ''}`,
        command: u.toString(),
        reason: priv ? 'This address is on your local network' : undefined,
        forceApproval: priv
      }
    },
    async execute(args, ctx) {
      const u = parseUrl(str(args, 'url'))
      // With a limit the page is cut to fit it; with no limit the whole page is returned (up to what can be downloaded here).
      const budget = outputLimitOf(ctx)
      const ceiling = Number.isFinite(budget) ? Math.max(500, budget - 400) : FETCH_BYTES
      const max = Math.max(500, Math.min(ceiling, Math.floor(num(args, 'max_chars', Number.isFinite(budget) ? Math.min(12000, ceiling) : FETCH_BYTES))))
      ctx.progress(`Fetching ${u.hostname}…`)
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(25000)])
      let res: Response
      try {
        res = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8' }, redirect: 'follow', signal })
      } catch (e) {
        throw new ToolError(`Request failed: ${(e as Error).message}`)
      }
      const type = res.headers.get('content-type') ?? ''
      if (/^(image|audio|video)\//i.test(type) || /(zip|octet-stream|pdf|font)/i.test(type)) {
        throw new ToolError(`Unsupported content type: ${type}`)
      }
      const raw = await readLimited(res, FETCH_BYTES)
      let text = raw
      let title = ''
      if (/html|xml/i.test(type) || /^\s*<(!doctype|html)/i.test(raw)) {
        title = htmlTitle(raw)
        text = htmlToText(raw)
      }
      const truncated = text.length > max
      if (truncated) text = text.slice(0, max)
      const head = `URL: ${res.url || u.toString()}\nStatus: ${res.status}${title ? `\nTitle: ${title}` : ''}\n\n`
      return { content: head + text + (truncated ? `\n\n… (truncated to ${max} characters)` : ''), isError: !res.ok }
    }
  }

  const search: ToolImpl = {
    name: 'web_search',
    description: 'Search the web and return a list of results (title, URL, snippet). Follow up with fetch_url to read a result.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: { type: 'integer', description: 'Number of results (default 8)' }
      },
      required: ['query']
    },
    source: 'builtin',
    group: 'Web',
    defaultPermission: BUILTIN_TOOL_DEFAULTS.web_search,
    describe: (args) => ({ kind: 'network', title: `Search the web: ${str(args, 'query').slice(0, 80)}` }),
    async execute(args, ctx) {
      const q = str(args, 'query')
      const max = Math.max(1, Math.min(20, Math.floor(num(args, 'max_results', 8))))
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(20000)])
      ctx.progress('Searching…')
      let hits: SearchHit[] = []
      const searx = ctx.settings.agent.searxngUrl.trim().replace(/\/+$/, '')
      try {
        if (searx) {
          const res = await fetch(`${searx}/search?q=${encodeURIComponent(q)}&format=json`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal })
          if (!res.ok) throw new Error(`SearXNG returned HTTP ${res.status}`)
          const j = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] }
          hits = (j.results ?? []).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' }))
        } else {
          const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal })
          if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`)
          hits = parseDuckDuckGo(await res.text())
        }
      } catch (e) {
        throw new ToolError(`Search failed: ${(e as Error).message}. You can set a SearXNG URL in Settings → Agent.`)
      }
      hits = hits.filter((h) => h.url).slice(0, max)
      if (!hits.length) return { content: 'No results found.' }
      return { content: hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`).join('\n\n') }
    }
  }

  return [fetchUrl, search]
}
