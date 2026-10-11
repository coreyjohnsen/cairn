import type { LocalRuntimeSettings, ModelRuntimeOverride } from './types'

/** Settings for the built-in engine: what is stored per model, and what a given model actually runs with. */

export const KV_TYPES = ['f16', 'q8_0', 'q4_0'] as const
export const MAX_MODEL_OVERRIDES = 200

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const int = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined)

/** Cleans one model's saved settings; anything out of range is dropped (so the general setting applies instead). */
export function sanitizeOverride(input: unknown): ModelRuntimeOverride | null {
  if (!isRecord(input)) return null
  const out: ModelRuntimeOverride = {}
  const ctx = int(input.contextSize, 512, 4_194_304)
  if (ctx !== undefined) out.contextSize = ctx
  const ngl = int(input.gpuLayers, -1, 999)
  if (ngl !== undefined) out.gpuLayers = ngl
  if (typeof input.kvCache === 'string' && (KV_TYPES as readonly string[]).includes(input.kvCache)) out.kvCache = input.kvCache as ModelRuntimeOverride['kvCache']
  const moe = int(input.nCpuMoe, 0, 999)
  if (moe !== undefined) out.nCpuMoe = moe
  if (typeof input.kvInRam === 'boolean') out.kvInRam = input.kvInRam
  return Object.keys(out).length ? out : null
}

export function sanitizeOverrides(input: unknown): Record<string, ModelRuntimeOverride> {
  const out: Record<string, ModelRuntimeOverride> = {}
  if (!isRecord(input)) return out
  for (const [file, value] of Object.entries(input)) {
    if (!file || file.length > 1000) continue
    const o = sanitizeOverride(value)
    if (o) out[file] = o
    if (Object.keys(out).length >= MAX_MODEL_OVERRIDES) break
  }
  return out
}

/** The settings one model runs with: its own saved ones over the general ones. */
export function runtimeFor(local: LocalRuntimeSettings, modelPath: string | undefined): LocalRuntimeSettings {
  const o = modelPath ? local.modelOverrides?.[modelPath] : undefined
  return o ? { ...local, ...o } : local
}
