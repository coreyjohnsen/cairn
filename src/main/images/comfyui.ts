import type { ImageBackendConfig } from '@shared/types'
import { type BackendHooks, type BackendImage, BackendError, type BackendModel, type GenParams, type ImageBackend, authHeaders, httpError, trimBase } from './types'

export const DEFAULT_COMFY_WORKFLOW = {
  '3': {
    class_type: 'KSampler',
    inputs: { seed: '{{seed}}', steps: '{{steps}}', cfg: '{{cfg}}', sampler_name: '{{sampler}}', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] }
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{model}}' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{count}}' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}', clip: ['4', 1] } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'Cairn', images: ['8', 0] } }
}

const SAMPLER_MAP: Record<string, string> = {
  euler_a: 'euler_ancestral',
  euler: 'euler',
  heun: 'heun',
  dpm2: 'dpm_2',
  'dpm++2s_a': 'dpmpp_2s_ancestral',
  'dpm++2m': 'dpmpp_2m',
  'dpm++2mv2': 'dpmpp_2m_sde',
  lcm: 'lcm'
}

export function comfySampler(name: string): string {
  return SAMPLER_MAP[name] ?? name
}

/** Substitute {{placeholders}} in a parsed workflow. A value that is exactly "{{name}}" keeps its numeric type. */
export function fillWorkflow(workflow: unknown, vars: Record<string, string | number>): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const exact = /^\{\{\s*(\w+)\s*\}\}$/.exec(v)
      if (exact && exact[1] in vars) return vars[exact[1]]
      return v.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(workflow)
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new BackendError('Cancelled'))
    }, { once: true })
  })

export class ComfyBackend implements ImageBackend {
  readonly supportsImg2Img = false
  readonly supportsInpaint = false
  readonly supportsNegative = true
  private base: string

  constructor(private cfg: ImageBackendConfig) {
    this.base = trimBase(cfg.baseUrl)
  }

  private headers(): Record<string, string> {
    return { ...authHeaders(this.cfg.apiKey) }
  }

  private async get(path: string, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(`${this.base}${path}`, { headers: this.headers(), signal: signal ?? AbortSignal.timeout(15000) })
    } catch (e) {
      throw new BackendError(`Cannot reach ComfyUI at ${this.base}. Is it running? (${(e as Error).message})`)
    }
  }

  async listModels(): Promise<BackendModel[]> {
    const res = await this.get('/object_info/CheckpointLoaderSimple')
    if (!res.ok) throw await httpError(res, 'Listing ComfyUI checkpoints')
    const j = (await res.json()) as any
    const names: unknown = j?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]
    const list = Array.isArray(names) ? (names as string[]) : []
    if (this.cfg.comfyWorkflow.trim() && !list.length) return [{ id: this.cfg.defaultModel || 'workflow', label: this.cfg.defaultModel || '(custom workflow)' }]
    return list.map((n) => ({ id: n, label: n }))
  }

  async test(): Promise<string> {
    const res = await this.get('/system_stats')
    if (!res.ok) throw await httpError(res, 'ComfyUI')
    const j = (await res.json()) as any
    const dev = j?.devices?.[0]
    const models = await this.listModels().catch(() => [])
    return `Connected to ComfyUI${j?.system?.comfyui_version ? ` ${j.system.comfyui_version}` : ''}${dev?.name ? ` on ${dev.name}` : ''}. ${models.length} checkpoint${models.length === 1 ? '' : 's'} found.`
  }

  private buildWorkflow(p: GenParams): Record<string, unknown> {
    let template: unknown = DEFAULT_COMFY_WORKFLOW
    if (this.cfg.comfyWorkflow.trim()) {
      try {
        template = JSON.parse(this.cfg.comfyWorkflow)
      } catch (e) {
        throw new BackendError(`The custom ComfyUI workflow is not valid JSON: ${(e as Error).message}`)
      }
    }
    return fillWorkflow(template, {
      prompt: p.prompt,
      negative: p.negative,
      seed: p.seed,
      steps: p.steps,
      cfg: p.cfg,
      width: p.width,
      height: p.height,
      sampler: comfySampler(p.sampler),
      model: p.model,
      count: p.count
    }) as Record<string, unknown>
  }

  async generate(p: GenParams, hooks: BackendHooks): Promise<BackendImage[]> {
    const workflow = this.buildWorkflow(p)
    const clientId = `cairn-${Math.random().toString(36).slice(2)}`
    let promptId = ''
    const submit = await fetch(`${this.base}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers() },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      signal: hooks.signal
    }).catch((e) => {
      if (hooks.signal.aborted) throw new BackendError('Cancelled')
      throw new BackendError(`Cannot reach ComfyUI at ${this.base}. Is it running? (${(e as Error).message})`)
    })
    if (!submit.ok) {
      let detail = ''
      try {
        const j = (await submit.json()) as any
        const nodeErrs = j?.node_errors ? Object.values(j.node_errors as Record<string, any>).map((n: any) => `${n.class_type}: ${(n.errors ?? []).map((e: any) => e.message).join('; ')}`).join(' | ') : ''
        detail = `${j?.error?.message ?? ''} ${nodeErrs}`.trim()
      } catch {
        /* ignore */
      }
      throw new BackendError(`ComfyUI rejected the workflow (HTTP ${submit.status}). ${detail || 'Check that the selected checkpoint exists.'}`)
    }
    promptId = ((await submit.json()) as any).prompt_id
    if (!promptId) throw new BackendError('ComfyUI did not return a prompt id.')

    const onAbort = () => {
      void fetch(`${this.base}/interrupt`, { method: 'POST', headers: this.headers() }).catch(() => {})
    }
    hooks.signal.addEventListener('abort', onAbort, { once: true })

    // Live step progress over WebSocket when available; completion is always confirmed through /history.
    let ws: WebSocket | null = null
    try {
      const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
      if (WS) {
        const u = new URL(this.base)
        ws = new WS(`${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/ws?clientId=${clientId}`)
        ws.onmessage = (ev: MessageEvent) => {
          if (typeof ev.data !== 'string') return
          try {
            const m = JSON.parse(ev.data)
            if (m.type === 'progress' && m.data?.max) hooks.onProgress(Math.min(0.97, 0.05 + 0.9 * (m.data.value / m.data.max)), `Sampling step ${m.data.value}/${m.data.max}`)
            else if (m.type === 'execution_start') hooks.onProgress(0.03, 'Starting…')
          } catch {
            /* ignore */
          }
        }
        ws.onerror = () => {}
      }
    } catch {
      ws = null
    }

    try {
      const deadline = Date.now() + 30 * 60 * 1000
      hooks.onProgress(0.02, 'Queued in ComfyUI…')
      for (;;) {
        if (hooks.signal.aborted) throw new BackendError('Cancelled')
        if (Date.now() > deadline) throw new BackendError('Timed out waiting for ComfyUI.')
        const res = await this.get(`/history/${promptId}`, hooks.signal)
        if (res.ok) {
          const hist = (await res.json()) as any
          const entry = hist?.[promptId]
          if (entry?.status?.status_str === 'error') {
            const msgs = (entry.status.messages ?? []).filter((m: any[]) => m[0] === 'execution_error').map((m: any[]) => m[1]?.exception_message).filter(Boolean)
            throw new BackendError(`ComfyUI reported an error: ${msgs.join('; ') || 'execution failed'}`)
          }
          if (entry?.outputs) {
            const images: { filename: string; subfolder: string; type: string }[] = []
            for (const out of Object.values(entry.outputs as Record<string, any>)) {
              for (const im of out.images ?? []) if (im.type !== 'temp') images.push(im)
            }
            if (images.length) {
              const results: BackendImage[] = []
              for (let i = 0; i < images.length; i++) {
                const im = images[i]
                const r = await this.get(`/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder ?? '')}&type=${encodeURIComponent(im.type ?? 'output')}`, hooks.signal)
                if (!r.ok) throw await httpError(r, 'Downloading the image from ComfyUI')
                results.push({ data: new Uint8Array(await r.arrayBuffer()), seed: p.seed + i })
              }
              hooks.onProgress(1, 'Done')
              return results
            }
          }
        }
        await sleep(700, hooks.signal)
      }
    } finally {
      hooks.signal.removeEventListener('abort', onAbort)
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
    }
  }
}
