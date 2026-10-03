/**
 * Small pixel toolkit for the main process, with no dependency on Electron: read and write PNG files,
 * resize, crop, blur and blend. Used to prepare a starting picture and a mask for an engine and to blend
 * the result back over the original, so everything outside the mask stays exactly as it was.
 */
import zlib from 'node:zlib'

export class PixelError extends Error {}

/** Interleaved 8-bit pixels: 1 channel (gray), 3 (RGB). */
export interface Raster {
  width: number
  height: number
  channels: 1 | 3
  data: Uint8Array
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** More than this many pixels is refused, so a hostile or mistaken file cannot use all the memory. */
export const MAX_PIXELS = 64_000_000

/* ───────────────────────────── PNG ───────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function isPng(d: Uint8Array): boolean {
  return d.length > 8 && SIGNATURE.every((b, i) => d[i] === b)
}

/**
 * Read a PNG into RGB. Transparency is flattened onto `background` (255 = white, 0 = black).
 * Handles 8 and 16 bits per channel in gray, RGB, palette, gray+alpha and RGBA; interlaced files are refused.
 */
export function decodePng(buf: Uint8Array, background = 255): Raster {
  if (!isPng(buf)) throw new PixelError('This is not a PNG picture.')
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = 8
  let ihdr: { w: number; h: number; depth: number; ctype: number; interlace: number } | null = null
  let plte: Uint8Array | null = null
  let trns: Uint8Array | null = null
  const idat: Uint8Array[] = []
  while (pos + 8 <= buf.length) {
    const len = dv.getUint32(pos)
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7])
    const start = pos + 8
    if (len > buf.length - start) throw new PixelError('The PNG file is cut short.')
    const body = buf.subarray(start, start + len)
    if (type === 'IHDR') {
      if (len < 13) throw new PixelError('The PNG header is damaged.')
      ihdr = { w: dv.getUint32(start), h: dv.getUint32(start + 4), depth: buf[start + 8], ctype: buf[start + 9], interlace: buf[start + 12] }
    } else if (type === 'PLTE') plte = body
    else if (type === 'tRNS') trns = body
    else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    pos = start + len + 4
  }
  if (!ihdr) throw new PixelError('The PNG header is missing.')
  const { w, h, depth, ctype, interlace } = ihdr
  if (!(w > 0 && h > 0)) throw new PixelError('The PNG has no size.')
  if (w * h > MAX_PIXELS) throw new PixelError(`The picture is too large to edit (${w} × ${h}).`)
  if (interlace !== 0) throw new PixelError('Interlaced PNG files are not supported. Save the picture again without interlacing.')
  const samples = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype]
  if (!samples) throw new PixelError('This kind of PNG is not supported.')
  if (!(depth === 8 || depth === 16) || (ctype === 3 && depth !== 8)) throw new PixelError(`PNG files with ${depth} bits per channel are not supported.`)
  if (ctype === 3 && !plte) throw new PixelError('The PNG palette is missing.')
  const bps = depth / 8
  const bpp = samples * bps
  const stride = w * bpp
  let raw: Buffer
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * h + 4096 })
  } catch {
    throw new PixelError('The PNG data is damaged.')
  }
  if (raw.length < (stride + 1) * h) throw new PixelError('The PNG data is cut short.')

  // Undo the row filters.
  const px = new Uint8Array(stride * h)
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const up = dst - stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0
      const b = y > 0 ? px[up + x] : 0
      const c = x >= bpp && y > 0 ? px[up + x - bpp] : 0
      let v = raw[src + x]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (ft !== 0) throw new PixelError('The PNG data is damaged.')
      px[dst + x] = v & 0xff
    }
  }

  // To RGB, with any transparency flattened onto the background.
  const out = new Uint8Array(w * h * 3)
  const mix = (c: number, a: number) => (a === 255 ? c : Math.round((c * a + background * (255 - a)) / 255))
  for (let i = 0, n = w * h; i < n; i++) {
    const o = i * 3
    const s = i * bpp
    let r: number, g: number, b: number, a = 255
    if (ctype === 0) r = g = b = px[s]
    else if (ctype === 2) [r, g, b] = [px[s], px[s + bps], px[s + 2 * bps]]
    else if (ctype === 3) {
      const idx = px[s]
      r = plte![idx * 3] ?? 0
      g = plte![idx * 3 + 1] ?? 0
      b = plte![idx * 3 + 2] ?? 0
      if (trns && idx < trns.length) a = trns[idx]
    } else if (ctype === 4) {
      r = g = b = px[s]
      a = px[s + bps]
    } else {
      ;[r, g, b, a] = [px[s], px[s + bps], px[s + 2 * bps], px[s + 3 * bps]]
    }
    out[o] = mix(r, a)
    out[o + 1] = mix(g, a)
    out[o + 2] = mix(b, a)
  }
  return { width: w, height: h, channels: 3, data: out }
}

/** Write a raster as a PNG (gray or RGB, 8 bits). */
export function encodePng(r: Raster): Uint8Array {
  const { width: w, height: h, channels: ch, data } = r
  const stride = w * ch
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1)
    raw[o] = 1 // "Sub" filter: each byte minus the one before it, which compresses smooth pictures better
    const row = y * stride
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = (data[row + x] - (x >= ch ? data[row + x - ch] : 0)) & 0xff
  }
  const idat = zlib.deflateSync(raw, { level: 4 })
  const chunk = (type: string, body: Uint8Array): Buffer => {
    const b = Buffer.alloc(12 + body.length)
    b.writeUInt32BE(body.length, 0)
    b.write(type, 4, 'ascii')
    Buffer.from(body.buffer, body.byteOffset, body.length).copy(b, 8)
    b.writeUInt32BE(crc32(b.subarray(4, 8 + body.length)), 8 + body.length)
    return b
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(w, 0)
  head.writeUInt32BE(h, 4)
  head[8] = 8
  head[9] = ch === 1 ? 0 : 2
  return new Uint8Array(Buffer.concat([Buffer.from(SIGNATURE), chunk('IHDR', head), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]))
}

/* ───────────────────────────── geometry ───────────────────────────── */

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Weights for resampling one axis: a triangle filter that widens when shrinking, so shrinking does not alias. */
function axisWeights(srcLen: number, dstLen: number): { start: Int32Array; weights: Float32Array[] } {
  const scale = srcLen / dstLen
  const support = Math.max(1, scale)
  const start = new Int32Array(dstLen)
  const weights: Float32Array[] = []
  for (let i = 0; i < dstLen; i++) {
    const center = (i + 0.5) * scale
    const lo = Math.max(0, Math.floor(center - support))
    const hi = Math.min(srcLen - 1, Math.ceil(center + support))
    const w = new Float32Array(hi - lo + 1)
    let sum = 0
    for (let j = lo; j <= hi; j++) {
      const v = Math.max(0, 1 - Math.abs((j + 0.5 - center) / support))
      w[j - lo] = v
      sum += v
    }
    if (sum === 0) {
      w[Math.min(w.length - 1, Math.max(0, Math.floor(center) - lo))] = 1
      sum = 1
    }
    for (let k = 0; k < w.length; k++) w[k] /= sum
    start[i] = lo
    weights.push(w)
  }
  return { start, weights }
}

/** Resize (smooth, with edge handling) to an exact size. */
export function resizeRaster(r: Raster, nw: number, nh: number): Raster {
  nw = Math.max(1, Math.round(nw))
  nh = Math.max(1, Math.round(nh))
  if (nw === r.width && nh === r.height) return r
  const ch = r.channels
  const hx = axisWeights(r.width, nw)
  const mid = new Uint8Array(nw * r.height * ch)
  for (let y = 0; y < r.height; y++) {
    const row = y * r.width * ch
    for (let x = 0; x < nw; x++) {
      const w = hx.weights[x]
      const s0 = hx.start[x]
      for (let c = 0; c < ch; c++) {
        let acc = 0
        for (let k = 0; k < w.length; k++) acc += r.data[row + (s0 + k) * ch + c] * w[k]
        mid[(y * nw + x) * ch + c] = Math.round(acc)
      }
    }
  }
  const vy = axisWeights(r.height, nh)
  const out = new Uint8Array(nw * nh * ch)
  for (let y = 0; y < nh; y++) {
    const w = vy.weights[y]
    const s0 = vy.start[y]
    for (let x = 0; x < nw; x++) {
      for (let c = 0; c < ch; c++) {
        let acc = 0
        for (let k = 0; k < w.length; k++) acc += mid[((s0 + k) * nw + x) * ch + c] * w[k]
        out[(y * nw + x) * ch + c] = Math.round(acc)
      }
    }
  }
  return { width: nw, height: nh, channels: ch, data: out }
}

export function cropRaster(r: Raster, b: Box): Raster {
  const ch = r.channels
  const out = new Uint8Array(b.w * b.h * ch)
  for (let y = 0; y < b.h; y++) {
    const s = ((b.y + y) * r.width + b.x) * ch
    out.set(r.data.subarray(s, s + b.w * ch), y * b.w * ch)
  }
  return { width: b.w, height: b.h, channels: ch, data: out }
}

/** Gray from RGB (or the gray itself). */
export function toGray(r: Raster): Raster {
  if (r.channels === 1) return r
  const out = new Uint8Array(r.width * r.height)
  for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * r.data[i * 3] + 0.587 * r.data[i * 3 + 1] + 0.114 * r.data[i * 3 + 2])
  return { width: r.width, height: r.height, channels: 1, data: out }
}

/** Smallest box holding every pixel above `threshold`, or null when there is none. */
export function boundingBox(g: Raster, threshold = 16): Box | null {
  let x0 = g.width
  let y0 = g.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < g.height; y++) {
    const row = y * g.width
    for (let x = 0; x < g.width; x++) {
      if (g.data[row + x] > threshold) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/** Share of pixels above `threshold`, 0 to 1. */
export function coverage(g: Raster, threshold = 127): number {
  let n = 0
  for (let i = 0; i < g.data.length; i++) if (g.data[i] > threshold) n++
  return g.data.length ? n / g.data.length : 0
}

/** Black and white only: everything above `threshold` becomes 255. */
export function binarize(g: Raster, threshold = 127): Raster {
  const out = new Uint8Array(g.data.length)
  for (let i = 0; i < out.length; i++) out[i] = g.data[i] > threshold ? 255 : 0
  return { ...g, data: out }
}

/** Soften a gray picture (three box blurs, close to a Gaussian). `radius` is about the width of the soft edge in pixels. */
export function blurGray(g: Raster, radius: number): Raster {
  if (!(radius >= 1)) return g
  const b = Math.max(1, Math.round(radius / 3))
  const { width: w, height: h } = g
  let a: Float32Array = Float32Array.from(g.data)
  let t: Float32Array = new Float32Array(a.length)
  const pass = (src: Float32Array, dst: Float32Array, horizontal: boolean) => {
    const len = horizontal ? w : h
    const lines = horizontal ? h : w
    const step = horizontal ? 1 : w
    const lineStep = horizontal ? w : 1
    const win = 2 * b + 1
    for (let l = 0; l < lines; l++) {
      const base = l * lineStep
      let sum = 0
      for (let k = -b; k <= b; k++) sum += src[base + Math.min(len - 1, Math.max(0, k)) * step]
      for (let i = 0; i < len; i++) {
        dst[base + i * step] = sum / win
        sum += src[base + Math.min(len - 1, i + b + 1) * step] - src[base + Math.max(0, i - b) * step]
      }
    }
  }
  for (let i = 0; i < 3; i++) {
    pass(a, t, true)
    pass(t, a, false)
  }
  const out = new Uint8Array(a.length)
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(a[i])))
  return { width: w, height: h, channels: 1, data: out }
}

/** Larger of two gray pictures, pixel by pixel. */
export function maxGray(a: Raster, b: Raster): Raster {
  const out = new Uint8Array(a.data.length)
  for (let i = 0; i < out.length; i++) out[i] = Math.max(a.data[i], b.data[i])
  return { ...a, data: out }
}

/**
 * Put `patch` into `base` at (x, y), weighting each pixel by `alpha` (0 keeps the base, 255 takes the patch).
 * Returns a new picture; `base` is not changed.
 */
export function blend(base: Raster, patch: Raster, alpha: Raster, x: number, y: number): Raster {
  if (base.channels !== 3 || patch.channels !== 3) throw new PixelError('Both pictures must be in color.')
  const out = new Uint8Array(base.data)
  for (let py = 0; py < patch.height; py++) {
    const by = y + py
    if (by < 0 || by >= base.height) continue
    for (let px = 0; px < patch.width; px++) {
      const bx = x + px
      if (bx < 0 || bx >= base.width) continue
      const a = alpha.data[py * patch.width + px]
      if (a === 0) continue
      const o = (by * base.width + bx) * 3
      const s = (py * patch.width + px) * 3
      for (let c = 0; c < 3; c++) out[o + c] = a === 255 ? patch.data[s + c] : Math.round((base.data[o + c] * (255 - a) + patch.data[s + c] * a) / 255)
    }
  }
  return { ...base, data: out }
}
