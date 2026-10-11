import type { LocalModelFile, ProviderModel, Settings } from '@shared/types'
import { LOCAL_PROVIDER_ID } from '@shared/defaults'
import { runtimeFor } from '@shared/runtimePrefs'
import { OpenAIProvider } from '../providers/openai'
import type { Provider, ProviderRequest, StreamEvent } from '../providers/types'
import { scanGguf } from './library'
import type { LlamaManager } from './llama-server'

export interface LocalDeps {
  getSettings(): Settings
  modelsDir(): string
  llama: LlamaManager
}

export function llmRoots(modelsDir: string, extra: string[]): string[] {
  return [modelsDir, ...extra].filter(Boolean)
}

/**
 * The "This computer" provider: model ids are absolute GGUF paths. Sending a message loads the
 * model into the managed llama-server (starting/restarting it as needed) and talks to it over
 * the OpenAI-compatible API.
 */
export class LocalProvider implements Provider {
  readonly id = LOCAL_PROVIDER_ID
  private scanCache: { at: number; files: LocalModelFile[] } | null = null

  constructor(private d: LocalDeps) {}

  invalidate(): void {
    this.scanCache = null
  }

  /** Attach the names the user chose; done on every read so a rename never waits for a rescan. */
  private named(files: LocalModelFile[]): LocalModelFile[] {
    const names = this.d.getSettings().local.modelNames ?? {}
    return files.map((f) => {
      const label = names[f.path]?.trim()
      return label ? { ...f, label } : f
    })
  }

  async scan(force = false): Promise<LocalModelFile[]> {
    if (!force && this.scanCache && Date.now() - this.scanCache.at < 10_000) return this.named(this.scanCache.files)
    const s = this.d.getSettings()
    const files = await scanGguf(llmRoots(this.d.modelsDir(), s.paths.extraModelDirs))
    this.scanCache = { at: Date.now(), files }
    return this.named(files)
  }

  async listModels(): Promise<ProviderModel[]> {
    const local = this.d.getSettings().local
    const files = await this.scan(true)
    return files.map((f) => {
      // A model the memory planner has set up may have a different context length than the general setting.
      const ctx = runtimeFor(local, f.path).contextSize
      return {
        id: f.path,
        name: f.label ?? f.name,
        vision: Boolean(f.mmprojPath),
        tools: true,
        // Judge by the file name and the chosen name, since either may be the descriptive one.
        reasoning: /think|reason|r1|qwq|qwen3|gpt-oss/i.test(`${f.name} ${f.label ?? ''}`),
        contextLength: ctx > 0 ? ctx : undefined
      }
    })
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    // Models differ in whether they honour the per-request switch, so Off is also set when the server starts.
    // The lease keeps another program's request from swapping the model while this answer is written.
    const lease = await this.d.llama.acquire(req.model, { noThink: req.thinking === 'off', signal: req.signal })
    const inner = new OpenAIProvider({ id: this.id, baseUrl: `${lease.base}/v1`, apiKey: '', headers: {} })
    try {
      for await (const ev of inner.stream({ ...req, model: 'local', modelHint: req.model })) {
        // The engine times each answer; keep the latest so the memory planner can show how the settings really perform.
        if (ev.type === 'usage') this.d.llama.noteSpeed({ generation: ev.tokensPerSecond, prompt: ev.promptTokensPerSecond })
        yield ev
      }
    } finally {
      lease.release()
    }
  }
}
