/**
 * Carries the app's messages over plain JSON between the computer and a phone. JSON has no bytes, so every
 * Uint8Array (pictures, attachments) travels as {"__b64": "…"} and comes back as a Uint8Array on the other side.
 * Works the same in Node and in browsers.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i
  // The URL-safe alphabet is accepted too.
  t['-'.charCodeAt(0)] = 62
  t['_'.charCodeAt(0)] = 63
  return t
})()

export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  const n = bytes.length
  // Built in slices so a 25 MB picture does not make one giant intermediate string array.
  const SLICE = 3 * 8192
  for (let start = 0; start < n; start += SLICE) {
    const end = Math.min(n, start + SLICE)
    let out = ''
    let i = start
    for (; i + 2 < end; i += 3) {
      const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
      out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63]
    }
    if (i < end) {
      const rest = end - i
      const v = (bytes[i] << 16) | ((rest > 1 ? bytes[i + 1] : 0) << 8)
      out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + (rest > 1 ? B64[(v >> 6) & 63] : '=') + '='
    }
    parts.push(out)
  }
  return parts.join('')
}

export function fromBase64(text: string): Uint8Array {
  let len = text.length
  while (len > 0 && text.charCodeAt(len - 1) === 61) len--
  const out = new Uint8Array(Math.floor((len * 3) / 4))
  let o = 0
  let acc = 0
  let bits = 0
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i)
    const v = c < 128 ? LOOKUP[c] : -1
    if (v < 0) {
      // Line breaks and spaces are ignored; anything else is not base64.
      if (c === 10 || c === 13 || c === 32) continue
      throw new Error('Not valid base64 data.')
    }
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 255
    }
  }
  return o === out.length ? out : out.subarray(0, o)
}

interface Encoded {
  __b64: string
}

const isEncoded = (v: unknown): v is Encoded => {
  if (!v || typeof v !== 'object') return false
  const keys = Object.keys(v)
  return keys.length === 1 && keys[0] === '__b64' && typeof (v as Encoded).__b64 === 'string'
}

/** JSON text for any value the app sends, with bytes turned into text. */
export function encodeJson(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key: string, v: unknown) {
    // `this[key]` is the value before JSON's own conversion (a Buffer would already have become an object by `v`).
    const raw = this[key]
    if (raw instanceof Uint8Array) return { __b64: toBase64(raw) }
    return v
  })
}

/** The reverse of {@link encodeJson}. */
export function decodeJson<T = unknown>(text: string): T {
  return JSON.parse(text, (_k, v) => (isEncoded(v) ? fromBase64(v.__b64) : v)) as T
}
