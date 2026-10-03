import type { LoraPreset, LoraSelection, PromptAlias, UpscalerFile } from './types'

/**
 * Small, pure helpers for the image preferences the user saves: prompt aliases, LoRA presets, per-model steps and guidance,
 * and the upscaler that is on by default. Used by the main process (to clean what is stored and to expand prompts) and by the
 * interface (to preview and validate).
 */

export const MAX_ALIASES = 200
export const MAX_ALIAS_NAME = 40
export const MAX_ALIAS_TEXT = 4000
export const MAX_LORA_PRESETS = 100
export const MAX_PRESET_LORAS = 8

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/* ───────────────────────────── prompt aliases ───────────────────────────── */

/** The name as it is matched: trimmed, one line, case does not matter. */
export const aliasKey = (name: string): string => name.trim().toLowerCase()

/** Why this alias cannot be saved, or null when it is fine. `ownId` is the alias being edited, so it does not clash with itself. */
export function aliasProblem(name: string, text: string, aliases: PromptAlias[], ownId?: string): string | null {
  const n = name.trim()
  if (!n) return 'Give the alias a name: the word or short phrase you will type.'
  if (n.length > MAX_ALIAS_NAME) return `Keep the name under ${MAX_ALIAS_NAME} characters.`
  if (/[\r\n]/.test(n)) return 'The name has to be on one line.'
  if (!/[\p{L}\p{N}]/u.test(n)) return 'The name needs at least one letter or number.'
  if (!text.trim()) return 'Write what the alias should expand to.'
  if (text.length > MAX_ALIAS_TEXT) return `Keep the expansion under ${MAX_ALIAS_TEXT} characters.`
  if (aliases.some((a) => a.id !== ownId && aliasKey(a.name) === aliasKey(n))) return 'Another alias already has that name.'
  return null
}

/** Cleans what was stored: drops broken entries and repeated names (the first one wins), trims and caps lengths. */
export function sanitizeAliases(input: unknown): PromptAlias[] {
  if (!Array.isArray(input)) return []
  const out: PromptAlias[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.text !== 'string') continue
    const name = raw.name.trim()
    const text = raw.text.trim().slice(0, MAX_ALIAS_TEXT)
    if (!name || name.length > MAX_ALIAS_NAME || /[\r\n]/.test(name) || !/[\p{L}\p{N}]/u.test(name) || !text) continue
    const key = aliasKey(name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id: typeof raw.id === 'string' && raw.id ? raw.id : `alias-${out.length + 1}-${key.replace(/\W+/g, '')}`, name, text })
    if (out.length >= MAX_ALIASES) break
  }
  return out
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Replaces each alias the text contains with what it stands for. An alias is matched as a whole word or phrase, ignoring case
 * ("Cabin" matches an alias called cabin, "cabins" does not), and the longest name wins where two overlap. It is one pass:
 * an expansion is never searched for more aliases, so aliases cannot loop. `used` lists the names that were replaced.
 */
export function expandAliases(text: string, aliases: PromptAlias[] | undefined): { text: string; used: string[] } {
  const list = (aliases ?? []).filter((a) => a.name.trim() && a.text.trim())
  if (!text || list.length === 0) return { text, used: [] }
  const byKey = new Map(list.map((a) => [aliasKey(a.name), a]))
  const names = [...byKey.keys()].sort((a, b) => b.length - a.length)
  const word = '[\\p{L}\\p{N}_]'
  const re = new RegExp(`(?<!${word})(?:${names.map(escapeRe).join('|')})(?!${word})`, 'giu')
  const used: string[] = []
  const out = text.replace(re, (m) => {
    const a = byKey.get(aliasKey(m))
    if (!a) return m
    if (!used.includes(a.name)) used.push(a.name)
    return a.text.trim()
  })
  return { text: out, used }
}

/* ───────────────────────────── LoRA presets ───────────────────────────── */

export function sanitizeLoraSelection(input: unknown): LoraSelection[] {
  if (!Array.isArray(input)) return []
  const out: LoraSelection[] = []
  for (const raw of input) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || out.some((x) => x.id === raw.id)) continue
    const strength = typeof raw.strength === 'number' && Number.isFinite(raw.strength) ? clamp(raw.strength, -2, 2) : 0.8
    const trigger = typeof raw.trigger === 'string' && raw.trigger.trim() ? raw.trigger.trim().slice(0, 300) : undefined
    out.push({ id: raw.id, strength, ...(trigger ? { trigger } : {}) })
    if (out.length >= MAX_PRESET_LORAS) break
  }
  return out
}

/** Cleans stored presets: needs a name and at least one LoRA; repeated names keep the first. */
export function sanitizeLoraPresets(input: unknown): LoraPreset[] {
  if (!Array.isArray(input)) return []
  const out: LoraPreset[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (!isRecord(raw) || typeof raw.name !== 'string') continue
    const name = raw.name.trim().slice(0, 60)
    const loras = sanitizeLoraSelection(raw.loras)
    if (!name || loras.length === 0 || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push({ id: typeof raw.id === 'string' && raw.id ? raw.id : `preset-${out.length + 1}`, name, loras })
    if (out.length >= MAX_LORA_PRESETS) break
  }
  return out
}

/** The LoRAs of a preset that are still in the LoRA folder, and the ids that are not. */
export function applyLoraPreset(preset: LoraPreset, availableIds: string[]): { loras: LoraSelection[]; missing: string[] } {
  const have = new Set(availableIds)
  return { loras: preset.loras.filter((l) => have.has(l.id)).map((l) => ({ ...l })), missing: preset.loras.filter((l) => !have.has(l.id)).map((l) => l.id) }
}

/* ───────────────────────────── steps and guidance ───────────────────────────── */

export interface ModelDefaults {
  steps?: number
  cfg?: number
}

/** Cleans the saved steps and guidance, keyed by `backendId::model`. */
export function sanitizeModelDefaults(input: unknown): Record<string, ModelDefaults> {
  if (!isRecord(input)) return {}
  const out: Record<string, ModelDefaults> = {}
  for (const [key, raw] of Object.entries(input)) {
    if (!key.includes('::') || !isRecord(raw)) continue
    const steps = typeof raw.steps === 'number' && Number.isFinite(raw.steps) ? Math.round(clamp(raw.steps, 1, 150)) : undefined
    const cfg = typeof raw.cfg === 'number' && Number.isFinite(raw.cfg) ? Math.round(clamp(raw.cfg, 0, 30) * 100) / 100 : undefined
    if (steps !== undefined || cfg !== undefined) out[key] = { ...(steps !== undefined ? { steps } : {}), ...(cfg !== undefined ? { cfg } : {}) }
  }
  return out
}

/* ───────────────────────────── default upscaler ───────────────────────────── */

/** The model that is switched on by default: the general-purpose Real-ESRGAN one, once it is installed. */
export function defaultUpscaler(upscalers: UpscalerFile[]): UpscalerFile | undefined {
  return upscalers.find((u) => u.engine === 'esrgan' && /^realesrgan-x4plus$/i.test(u.name))
}
