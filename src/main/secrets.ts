import type { Settings } from '@shared/types'

/**
 * API keys and tokens are encrypted at rest with the OS keychain (DPAPI on Windows,
 * libsecret/kwallet on Linux) through Electron's safeStorage. If it is unavailable
 * (e.g. a headless Linux box) values are stored as-is.
 */
export interface Cipher {
  available(): boolean
  encrypt(plain: string): Uint8Array
  decrypt(data: Uint8Array): string
}

const PREFIX = 'enc1:'
let cipher: Cipher | null = null

export function setCipher(c: Cipher | null): void {
  cipher = c
}

export function seal(value: string): string {
  if (!value) return ''
  if (value.startsWith(PREFIX)) return value
  if (cipher?.available()) {
    try {
      return PREFIX + Buffer.from(cipher.encrypt(value)).toString('base64')
    } catch {
      return value
    }
  }
  return value
}

export function unseal(value: string): string {
  if (!value) return ''
  if (!value.startsWith(PREFIX)) return value
  if (!cipher?.available()) return ''
  try {
    return cipher.decrypt(Buffer.from(value.slice(PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

function mapRecord(rec: Record<string, string> | undefined, fn: (v: string) => string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(rec ?? {})) out[k] = fn(v)
  return out
}

/** Returns a deep-ish copy of settings with every secret field passed through `fn`. */
export function mapSecrets(s: Settings, fn: (v: string) => string): Settings {
  const copy: Settings = JSON.parse(JSON.stringify(s))
  for (const p of copy.providers) {
    p.apiKey = fn(p.apiKey ?? '')
    p.headers = mapRecord(p.headers, fn)
  }
  for (const b of copy.image.backends) b.apiKey = fn(b.apiKey ?? '')
  if (copy.server) copy.server.apiKey = fn(copy.server.apiKey ?? '')
  copy.paths.hfToken = fn(copy.paths.hfToken ?? '')
  copy.paths.civitaiToken = fn(copy.paths.civitaiToken ?? '')
  for (const m of copy.mcpServers) {
    m.env = mapRecord(m.env, fn)
    m.headers = mapRecord(m.headers, fn)
  }
  for (const t of copy.customTools) {
    if (t.impl.type === 'http') t.impl.headers = mapRecord(t.impl.headers, fn)
  }
  for (const k of ['llama', 'sd', 'esrgan'] as const) copy.engines[k].env = mapRecord(copy.engines[k].env, fn)
  return copy
}
