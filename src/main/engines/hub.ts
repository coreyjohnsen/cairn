import type { CivitaiHit, HfFile, HfModelHit, Settings } from '@shared/types'

export function hfBase(settings: Settings): string {
  return (settings.paths.hfEndpoint || 'https://huggingface.co').replace(/\/+$/, '')
}

function hfHeaders(settings: Settings): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': 'Cairn/1.0', Accept: 'application/json' }
  if (settings.paths.hfToken) h.Authorization = `Bearer ${settings.paths.hfToken}`
  return h
}

export function parseHfSearch(json: unknown): HfModelHit[] {
  if (!Array.isArray(json)) return []
  return json
    .map((m: any): HfModelHit | null => {
      const id = m?.id ?? m?.modelId
      if (typeof id !== 'string') return null
      return { id, downloads: Number(m.downloads) || 0, likes: Number(m.likes) || 0, tags: Array.isArray(m.tags) ? m.tags.slice(0, 8) : [], updated: m.lastModified }
    })
    .filter((x): x is HfModelHit => x !== null)
}

const WEIGHT_EXT = /\.(gguf|safetensors|ckpt|sft)$/i

export function parseHfTree(json: unknown, base: string, repo: string): HfFile[] {
  if (!Array.isArray(json)) return []
  const out: HfFile[] = []
  for (const it of json as any[]) {
    if (it?.type !== 'file' || typeof it.path !== 'string' || !WEIGHT_EXT.test(it.path)) continue
    const size = Number(it.lfs?.size ?? it.size) || 0
    out.push({ path: it.path, size, url: `${base}/${repo}/resolve/main/${it.path.split('/').map(encodeURIComponent).join('/')}` })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export async function hfSearch(settings: Settings, query: string, kind: 'llm' | 'image' = 'llm'): Promise<HfModelHit[]> {
  const q = query.trim()
  if (/^[\w.-]+\/[\w.-]+$/.test(q)) return [{ id: q, downloads: 0, likes: 0, tags: [] }]
  const filter = kind === 'llm' ? 'gguf' : 'text-to-image'
  const url = `${hfBase(settings)}/api/models?search=${encodeURIComponent(q)}&filter=${filter}&sort=downloads&direction=-1&limit=24`
  const res = await fetch(url, { headers: hfHeaders(settings), signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`Hugging Face search failed (HTTP ${res.status}).`)
  return parseHfSearch(await res.json())
}

export async function hfFiles(settings: Settings, repo: string): Promise<HfFile[]> {
  const base = hfBase(settings)
  const res = await fetch(`${base}/api/models/${repo}/tree/main?recursive=true`, { headers: hfHeaders(settings), signal: AbortSignal.timeout(20000) })
  if (res.status === 401 || res.status === 403) throw new Error('This repository is gated or private. Accept its licence on huggingface.co and add an access token in Settings → Storage.')
  if (!res.ok) throw new Error(`Could not list files for ${repo} (HTTP ${res.status}).`)
  return parseHfTree(await res.json(), base, repo)
}

export function parseCivitai(json: unknown): CivitaiHit[] {
  const items = (json as any)?.items
  if (!Array.isArray(items)) return []
  const out: CivitaiHit[] = []
  for (const it of items) {
    if (typeof it?.id !== 'number') continue
    const versions = (Array.isArray(it.modelVersions) ? it.modelVersions : []).slice(0, 4).map((v: any) => ({
      id: Number(v.id),
      name: String(v.name ?? ''),
      baseModel: v.baseModel,
      files: (Array.isArray(v.files) ? v.files : [])
        .filter((f: any) => f?.type === 'Model' || f?.type === undefined)
        .map((f: any) => ({
          id: Number(f.id),
          name: String(f.name),
          sizeKB: Number(f.sizeKB) || 0,
          downloadUrl: String(f.downloadUrl ?? `https://civitai.com/api/download/models/${v.id}`),
          format: f.metadata?.format,
          primary: Boolean(f.primary)
        }))
    }))
    out.push({ id: it.id, name: String(it.name), type: String(it.type), creator: it.creator?.username, downloads: it.stats?.downloadCount, versions })
  }
  return out
}

export async function civitaiSearch(settings: Settings, query: string, type: string): Promise<CivitaiHit[]> {
  const params = new URLSearchParams({ query, limit: '20', sort: 'Most Downloaded' })
  if (type) params.set('types', type)
  const headers: Record<string, string> = { 'User-Agent': 'Cairn/1.0', Accept: 'application/json' }
  if (settings.paths.civitaiToken) headers.Authorization = `Bearer ${settings.paths.civitaiToken}`
  const res = await fetch(`https://civitai.com/api/v1/models?${params}`, { headers, signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`Civitai search failed (HTTP ${res.status}).`)
  return parseCivitai(await res.json())
}
