import { runtimeFor } from '@shared/runtimePrefs'
import type { DetectedServer, ModelOption, ProviderConfig, ProviderModel, Settings } from '@shared/types'
import { LOCAL_PROVIDER_ID, PROVIDER_PRESETS } from '@shared/defaults'
import { makeModelRef, parseModelRef } from '@shared/types'
import type { ModelResolver, ResolvedModel } from './agent/runner'
import { AnthropicProvider } from './providers/anthropic'
import { inferCaps, mergeCaps, prettyModelName } from './providers/caps'
import { OpenAIProvider, normalizeOpenAIBase } from './providers/openai'
import type { Provider } from './providers/types'

const TTL_MS = 60_000

interface CacheEntry {
  at: number
  models: ProviderModel[]
  error?: string
}

export class ModelService implements ModelResolver {
  private cache = new Map<string, CacheEntry>()

  constructor(
    private getSettings: () => Settings,
    private local: Provider & { listModels(): Promise<ProviderModel[]> }
  ) {}

  invalidate(providerId?: string): void {
    if (providerId) this.cache.delete(providerId)
    else this.cache.clear()
  }

  providerFor(cfg: ProviderConfig): Provider {
    if (cfg.kind === 'local') return this.local
    if (cfg.kind === 'anthropic') return new AnthropicProvider({ id: cfg.id, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, headers: cfg.headers })
    return new OpenAIProvider({ id: cfg.id, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, headers: cfg.headers })
  }

  private async fetchModels(cfg: ProviderConfig, force: boolean): Promise<CacheEntry> {
    const cached = this.cache.get(cfg.id)
    if (!force && cached && Date.now() - cached.at < TTL_MS) return cached
    let entry: CacheEntry
    try {
      const models = await this.providerFor(cfg).listModels()
      entry = { at: Date.now(), models }
    } catch (e) {
      entry = { at: Date.now(), models: [], error: e instanceof Error ? e.message : String(e) }
    }
    this.cache.set(cfg.id, entry)
    return entry
  }

  private toOptions(cfg: ProviderConfig, models: ProviderModel[]): ModelOption[] {
    const byId = new Map<string, ProviderModel>()
    for (const m of models) byId.set(m.id, m)
    for (const m of cfg.manualModels) byId.set(m.id, { ...(byId.get(m.id) ?? {}), ...m })
    const out: ModelOption[] = []
    for (const m of byId.values()) {
      const base = { vision: m.vision, tools: m.tools, reasoning: m.reasoning }
      const caps = mergeCaps(base, cfg.capOverrides[m.id])
      out.push({
        ref: makeModelRef(cfg.id, m.id),
        providerId: cfg.id,
        providerName: cfg.name,
        id: m.id,
        name: m.name ?? prettyModelName(m.id),
        caps,
        contextLength: m.contextLength
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  async list(force = false): Promise<ModelOption[]> {
    const providers = this.getSettings().providers.filter((p) => p.enabled)
    const lists = await Promise.all(
      providers.map(async (cfg) => {
        const entry = await this.fetchModels(cfg, force)
        return this.toOptions(cfg, entry.models)
      })
    )
    return lists.flat()
  }

  async test(providerId: string): Promise<{ ok: boolean; count: number; error?: string }> {
    const cfg = this.getSettings().providers.find((p) => p.id === providerId)
    if (!cfg) return { ok: false, count: 0, error: 'Connection not found' }
    const entry = await this.fetchModels(cfg, true)
    if (entry.error) return { ok: false, count: 0, error: entry.error }
    return { ok: true, count: entry.models.length }
  }

  async resolve(ref: string | undefined): Promise<ResolvedModel | null> {
    const parsed = parseModelRef(ref)
    if (!parsed) return null
    const settings = this.getSettings()
    const cfg = settings.providers.find((p) => p.id === parsed.providerId)
    if (!cfg || !cfg.enabled) return null
    const entry = await this.fetchModels(cfg, false)
    const options = this.toOptions(cfg, entry.models)
    let option = options.find((o) => o.id === parsed.modelId)
    if (!option) {
      // The server may be unreachable right now; still let the request through so the real error surfaces.
      const caps = mergeCaps(inferCaps(parsed.modelId, cfg.kind === 'anthropic' ? 'anthropic' : 'openai'), cfg.capOverrides[parsed.modelId])
      option = { ref: ref!, providerId: cfg.id, providerName: cfg.name, id: parsed.modelId, name: prettyModelName(parsed.modelId), caps }
    }
    const contextTokens = cfg.id === LOCAL_PROVIDER_ID ? runtimeFor(settings.local, parsed.modelId).contextSize || undefined : undefined
    return { option, provider: this.providerFor(cfg), contextTokens }
  }

  /** Probe common local server ports so the app can offer one-click connections. */
  async detectLocalServers(): Promise<DetectedServer[]> {
    const existing = new Set(this.getSettings().providers.map((p) => normalizeOpenAIBase(p.baseUrl)))
    const probes = PROVIDER_PRESETS.filter((p) => p.local && p.id !== 'custom').map(async (preset): Promise<DetectedServer | null> => {
      if (existing.has(normalizeOpenAIBase(preset.baseUrl))) return null
      try {
        const res = await fetch(`${preset.baseUrl}/models`, { signal: AbortSignal.timeout(1200) })
        if (!res.ok) return null
        const j = (await res.json()) as { data?: unknown[]; models?: unknown[] }
        const count = (Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : []).length
        return { presetId: preset.id, name: preset.name, baseUrl: preset.baseUrl, modelCount: count }
      } catch {
        return null
      }
    })
    return (await Promise.all(probes)).filter((x): x is DetectedServer => x !== null)
  }
}
