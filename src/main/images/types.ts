import type { ImageStage, SdArch } from '@shared/types'

export interface GenParams {
  prompt: string
  negative: string
  width: number
  height: number
  steps: number
  cfg: number
  /** Concrete seed (never -1). */
  seed: number
  sampler: string
  count: number
  /** Backend-specific model id (checkpoint name, local model id, …). */
  model: string
  initImage?: Uint8Array
  strength?: number
  /** PNG, the same size as `initImage`: white is repainted, black is kept. Only with a starting picture. */
  mask?: Uint8Array
  /** Built-in engine: LoRAs by id (path inside `loraDir`, no extension) and their strengths. */
  loras?: { id: string; strength: number }[]
  loraDir?: string
  /** Built-in engine: make the result bigger with this upscaler once it is drawn. */
  upscale?: { path: string; repeats: number }
}

export interface BackendImage {
  data: Uint8Array
  seed: number
  /** Something went wrong that did not stop the picture being made (for example an upscaler that was ignored). */
  warning?: string
}

export interface BackendHooks {
  onProgress(fraction: number, label?: string, stage?: ImageStage): void
  signal: AbortSignal
}

export interface BackendModel {
  id: string
  label: string
  defaults?: { width: number; height: number; steps: number; cfg: number; sampler: string }
  /** Built-in engine models only. */
  arch?: SdArch
  vaeTiling?: boolean
}

export interface ImageBackend {
  readonly supportsImg2Img: boolean
  /** Can repaint only the part of a starting picture that a mask marks. */
  readonly supportsInpaint: boolean
  readonly supportsNegative: boolean
  listModels(): Promise<BackendModel[]>
  generate(p: GenParams, hooks: BackendHooks): Promise<BackendImage[]>
  /** Make an existing picture bigger (built-in engine only). */
  upscale?(image: Uint8Array, up: { path: string; repeats: number }, hooks: BackendHooks): Promise<BackendImage[]>
  /** Human-readable connectivity check. Throws with a helpful message when something is wrong. */
  test(): Promise<string>
}

export class BackendError extends Error {}

/** Sniff the image container so files get a sensible extension. */
export function sniffImageExt(data: Uint8Array): 'png' | 'jpg' | 'webp' {
  if (data.length > 3 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png'
  if (data.length > 2 && data[0] === 0xff && data[1] === 0xd8) return 'jpg'
  if (data.length > 12 && data[0] === 0x52 && data[1] === 0x49 && data[8] === 0x57 && data[9] === 0x45) return 'webp'
  return 'png'
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2_147_483_647)
}

export function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

export function trimBase(url: string): string {
  return (url ?? '').trim().replace(/\/+$/, '')
}

export async function httpError(res: Response, what: string): Promise<BackendError> {
  let text = ''
  try {
    text = (await res.text()).slice(0, 400)
  } catch {
    /* ignore */
  }
  try {
    const j = JSON.parse(text)
    text = j?.error?.message ?? j?.detail ?? j?.message ?? j?.error ?? text
    if (typeof text !== 'string') text = JSON.stringify(text)
  } catch {
    /* plain text */
  }
  return new BackendError(`${what} failed: HTTP ${res.status}${text ? ` — ${text}` : ''}`)
}
