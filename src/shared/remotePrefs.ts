import { defaultRemoteSettings } from './defaults'
import type { RemoteSettings } from './types'

/**
 * Small, pure helpers for the companion (phone and tablet) feature: cleaning what is stored, the one-time pairing code
 * people type or scan, and friendly names for devices. Used by the main process, the interface and the companion web app.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** An address to show in the QR code, as an origin ("https://my-pc.tailnet.ts.net"). Null when it is not a web address. */
export function normalizePublicUrl(input: string): string | null {
  const t = input.trim()
  if (!t) return null
  // People paste "my-pc.tailnet.ts.net:8742" without a scheme; assume plain http for those.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.hostname) return null
    return u.origin
  } catch {
    return null
  }
}

/** Why this address cannot be saved, or null when it is fine (an empty one is fine: it means "detect it"). */
export function publicUrlProblem(input: string): string | null {
  if (!input.trim()) return null
  return normalizePublicUrl(input) ? null : `"${input.trim()}" is not a web address. Use the form https://my-pc.example.com or http://192.168.1.20:8742.`
}

/** Cleans stored companion settings so a bad value can never reach the server. */
export function sanitizeRemote(input: unknown): RemoteSettings {
  const d = defaultRemoteSettings()
  const r = isRecord(input) ? input : {}
  const port = typeof r.port === 'number' && Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535 ? r.port : d.port
  return {
    enabled: r.enabled === true,
    port,
    publicUrl: typeof r.publicUrl === 'string' ? (normalizePublicUrl(r.publicUrl) ?? '') : '',
    keepAwake: r.keepAwake === true
  }
}

/* ───────────────────────────── Pairing code ───────────────────────────── */

/** No 0/O, 1/I/L: a code read off a screen cannot be mistyped. 31 symbols over 8 places is about 8.5 × 10¹¹ codes. */
export const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const PAIR_CODE_LENGTH = 8

/** The code as people read it: "K7QM-4TXD". */
export function formatPairCode(code: string): string {
  return code.length === PAIR_CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code
}

/** What was typed or scanned → the bare code, or null when it cannot be one. Case, spaces and dashes do not matter. */
export function normalizePairCode(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const t = input.toUpperCase().replace(/[\s\-_.]/g, '')
  if (t.length !== PAIR_CODE_LENGTH) return null
  for (const ch of t) if (!PAIR_ALPHABET.includes(ch)) return null
  return t
}

/** Pulls a pairing code out of a link ("http://pc:8742/#pair=K7QM4TXD"), or out of whatever was pasted. */
export function pairCodeFromText(text: string): string | null {
  const m = /[#?&]pair=([A-Za-z0-9\-]+)/.exec(text)
  return normalizePairCode(m ? m[1] : text)
}

/* ───────────────────────────── Device names ───────────────────────────── */

export const MAX_DEVICE_NAME = 40

export function cleanDeviceName(input: unknown, fallback = 'Phone'): string {
  const t = typeof input === 'string' ? input.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim() : ''
  return (t || fallback).slice(0, MAX_DEVICE_NAME)
}

/** "iPhone · Safari", "Android phone · Chrome": a name people recognise in the list of paired devices. */
export function deviceNameFromUserAgent(ua: string | undefined): string {
  const s = ua ?? ''
  let device = 'Phone'
  if (/iPad/i.test(s) || (/Macintosh/i.test(s) && /Mobile/i.test(s))) device = 'iPad'
  else if (/iPhone|iPod/i.test(s)) device = 'iPhone'
  else if (/Android/i.test(s)) device = /Mobile/i.test(s) ? 'Android phone' : 'Android tablet'
  else if (/Windows/i.test(s)) device = 'Windows PC'
  else if (/Macintosh|Mac OS/i.test(s)) device = 'Mac'
  else if (/Linux|X11|CrOS/i.test(s)) device = 'Linux PC'
  let browser = ''
  if (/EdgiOS|EdgA|Edg\//i.test(s)) browser = 'Edge'
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera'
  else if (/SamsungBrowser/i.test(s)) browser = 'Samsung Internet'
  else if (/Firefox|FxiOS/i.test(s)) browser = 'Firefox'
  else if (/Chrome|CriOS/i.test(s)) browser = 'Chrome'
  else if (/Safari/i.test(s)) browser = 'Safari'
  return browser ? `${device} · ${browser}` : device
}
