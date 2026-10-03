import type { ImageBackendConfig } from '@shared/types'
import { type BackendHooks, type BackendImage, BackendError, type BackendModel, type GenParams, type ImageBackend, authHeaders, httpError, trimBase } from './types'

const SAMPLER_MAP: Record<string, string> = {
  euler_a: 'Euler a',
  euler: 'Euler',
  heun: 'Heun',
  dpm2: 'DPM2',
  'dpm++2s_a': 'DPM++ 2S a',
  'dpm++2m': 'DPM++ 2M',
  'dpm++2mv2': 'DPM++ 2M SDE',
  lcm: 'LCM'
}

export function a1111Sampler(name: string): string {
  return SAMPLER_MAP[name] ?? name
}

export class A1111Backend implements ImageBackend {
  readonly supportsImg2Img = true
  readonly supportsInpaint = true
  readonly supportsNegative = true
  private base: string

  constructor(private cfg: ImageBackendConfig) {
    this.base = trimBase(cfg.baseUrl)
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...authHeaders(this.cfg.apiKey) }
  }

  private async req(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(`${this.base}${path}`, { ...init, headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) } })
    } catch (e) {
      if (init.signal?.aborted) throw new BackendError('Cancelled')
      throw new BackendError(`Cannot reach the AUTOMATIC1111/Forge API at ${this.base}. Start it with the --api flag. (${(e as Error).message})`)
    }
  }

  async listModels(): Promise<BackendModel[]> {
    const res = await this.req('/sdapi/v1/sd-models', { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw await httpError(res, 'Listing checkpoints')
    const j = (await res.json()) as { title: string; model_name?: string }[]
    return j.map((m) => ({ id: m.title, label: m.model_name ?? m.title }))
  }

  async test(): Promise<string> {
    const models = await this.listModels()
    return `Connected to AUTOMATIC1111/Forge. ${models.length} checkpoint${models.length === 1 ? '' : 's'} found.`
  }

  async generate(p: GenParams, hooks: BackendHooks): Promise<BackendImage[]> {
    const body: Record<string, unknown> = {
      prompt: p.prompt,
      negative_prompt: p.negative,
      width: p.width,
      height: p.height,
      steps: p.steps,
      cfg_scale: p.cfg,
      seed: p.seed,
      sampler_name: a1111Sampler(p.sampler),
      batch_size: p.count,
      n_iter: 1,
      send_images: true,
      save_images: false
    }
    if (p.model && p.model !== 'default') body.override_settings = { sd_model_checkpoint: p.model }
    let endpoint = '/sdapi/v1/txt2img'
    if (p.initImage) {
      endpoint = '/sdapi/v1/img2img'
      body.init_images = [Buffer.from(p.initImage).toString('base64')]
      body.denoising_strength = p.strength ?? 0.6
      if (p.mask) {
        // The picture and mask are already cut to size and blended back by Cairn, so A1111 only repaints what is white.
        body.mask = Buffer.from(p.mask).toString('base64')
        body.mask_blur = 0
        body.inpainting_fill = 1
        body.inpainting_mask_invert = 0
        body.inpaint_full_res = false
        body.resize_mode = 0
      }
    }

    // Poll progress while the (blocking) generation request is running.
    let polling = true
    const poll = (async () => {
      while (polling && !hooks.signal.aborted) {
        await new Promise((r) => setTimeout(r, 700))
        if (!polling) break
        try {
          const r = await this.req('/sdapi/v1/progress?skip_current_image=true', { signal: AbortSignal.timeout(4000) })
          if (r.ok) {
            const j = (await r.json()) as { progress?: number; state?: { sampling_step?: number; sampling_steps?: number } }
            const st = j.state
            hooks.onProgress(Math.min(0.97, Math.max(0.03, j.progress ?? 0)), st?.sampling_steps ? `Sampling step ${st.sampling_step ?? 0}/${st.sampling_steps}` : 'Generating…')
          }
        } catch {
          /* ignore transient poll errors */
        }
      }
    })()

    const onAbort = () => {
      void this.req('/sdapi/v1/interrupt', { method: 'POST' }).catch(() => {})
    }
    hooks.signal.addEventListener('abort', onAbort, { once: true })
    hooks.onProgress(0.02, 'Sending to AUTOMATIC1111…')
    try {
      const res = await this.req(endpoint, { method: 'POST', body: JSON.stringify(body), signal: hooks.signal })
      if (!res.ok) throw await httpError(res, 'Image generation')
      const j = (await res.json()) as { images?: string[]; info?: string }
      let seeds: number[] = []
      try {
        seeds = (JSON.parse(j.info ?? '{}') as { all_seeds?: number[] }).all_seeds ?? []
      } catch {
        seeds = []
      }
      const images = j.images ?? []
      if (!images.length) throw new BackendError('The server returned no images.')
      hooks.onProgress(1, 'Done')
      return images.map((b64, i) => ({ data: new Uint8Array(Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64')), seed: seeds[i] ?? p.seed + i }))
    } finally {
      polling = false
      hooks.signal.removeEventListener('abort', onAbort)
      await poll.catch(() => {})
    }
  }
}
