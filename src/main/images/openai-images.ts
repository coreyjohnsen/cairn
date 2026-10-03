import type { ImageBackendConfig } from '@shared/types'
import { type BackendHooks, type BackendImage, BackendError, type BackendModel, type GenParams, type ImageBackend, authHeaders, httpError, trimBase } from './types'

const DEFAULT_MODELS = ['gpt-image-1', 'dall-e-3']

/** OpenAI only accepts a few fixed sizes; other compatible servers take any WxH. */
export function openAiSize(model: string, w: number, h: number, official: boolean): string {
  if (!official) return `${w}x${h}`
  if (/^dall-e-2/.test(model)) return w >= 1024 || h >= 1024 ? '1024x1024' : w >= 512 ? '512x512' : '256x256'
  if (/^dall-e-3/.test(model)) return w > h ? '1792x1024' : h > w ? '1024x1792' : '1024x1024'
  return w > h ? '1536x1024' : h > w ? '1024x1536' : '1024x1024'
}

export class OpenAIImagesBackend implements ImageBackend {
  readonly supportsImg2Img = false
  readonly supportsInpaint = false
  readonly supportsNegative = false
  private base: string

  constructor(private cfg: ImageBackendConfig) {
    this.base = trimBase(cfg.baseUrl) || 'https://api.openai.com/v1'
  }

  private get official(): boolean {
    return /api\.openai\.com/.test(this.base)
  }

  async listModels(): Promise<BackendModel[]> {
    const ids = new Set<string>()
    if (this.cfg.defaultModel) ids.add(this.cfg.defaultModel)
    if (this.official) for (const m of DEFAULT_MODELS) ids.add(m)
    else {
      try {
        const res = await fetch(`${this.base}/models`, { headers: authHeaders(this.cfg.apiKey), signal: AbortSignal.timeout(8000) })
        if (res.ok) {
          const j = (await res.json()) as { data?: { id: string }[] }
          for (const m of j.data ?? []) if (/image|dall|flux|sd|diffusion|imagen/i.test(m.id)) ids.add(m.id)
        }
      } catch {
        /* fall through to whatever is configured */
      }
    }
    return [...ids].map((id) => ({ id, label: id, defaults: { width: 1024, height: 1024, steps: 0, cfg: 0, sampler: '' } }))
  }

  async test(): Promise<string> {
    if (!this.cfg.apiKey && this.official) throw new BackendError('Add your OpenAI API key for this image connection.')
    const res = await fetch(`${this.base}/models`, { headers: authHeaders(this.cfg.apiKey), signal: AbortSignal.timeout(10000) }).catch((e) => {
      throw new BackendError(`Cannot reach ${this.base}: ${(e as Error).message}`)
    })
    if (!res.ok) throw await httpError(res, 'Connecting')
    return 'Connected. The API key was accepted.'
  }

  async generate(p: GenParams, hooks: BackendHooks): Promise<BackendImage[]> {
    const model = p.model || this.cfg.defaultModel || DEFAULT_MODELS[0]
    const out: BackendImage[] = []
    // dall-e-3 only allows n=1, so request images one by one for every model for consistent progress.
    for (let i = 0; i < p.count; i++) {
      if (hooks.signal.aborted) throw new BackendError('Cancelled')
      hooks.onProgress(i / p.count + 0.02, p.count > 1 ? `Generating image ${i + 1}/${p.count}…` : 'Generating…')
      const body: Record<string, unknown> = { model, prompt: p.prompt, n: 1, size: openAiSize(model, p.width, p.height, this.official) }
      if (/^dall-e/.test(model)) body.response_format = 'b64_json'
      const res = await fetch(`${this.base}/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(this.cfg.apiKey) },
        body: JSON.stringify(body),
        signal: hooks.signal
      }).catch((e) => {
        if (hooks.signal.aborted) throw new BackendError('Cancelled')
        throw new BackendError(`Cannot reach ${this.base}: ${(e as Error).message}`)
      })
      if (!res.ok) throw await httpError(res, 'Image generation')
      const j = (await res.json()) as { data?: { b64_json?: string; url?: string }[] }
      for (const item of j.data ?? []) {
        if (item.b64_json) out.push({ data: new Uint8Array(Buffer.from(item.b64_json, 'base64')), seed: p.seed + i })
        else if (item.url) {
          const img = await fetch(item.url, { signal: hooks.signal })
          if (!img.ok) throw await httpError(img, 'Downloading the generated image')
          out.push({ data: new Uint8Array(await img.arrayBuffer()), seed: p.seed + i })
        }
      }
    }
    if (!out.length) throw new BackendError('The server returned no images.')
    hooks.onProgress(1, 'Done')
    return out
  }
}
