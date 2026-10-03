import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { InpaintError, growBox, prepareInpaint } from '../src/main/images/inpaint'
import { type Raster, PixelError, binarize, blend, blurGray, boundingBox, coverage, cropRaster, decodePng, encodePng, isPng, resizeRaster, toGray } from '../src/main/images/pixels'

const rgb = (w: number, h: number, f: (x: number, y: number) => [number, number, number]): Raster => {
  const data = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 3)
  return { width: w, height: h, channels: 3, data }
}
const gray = (w: number, h: number, f: (x: number, y: number) => number): Raster => {
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x, y)
  return { width: w, height: h, channels: 1, data }
}
const px = (r: Raster, x: number, y: number) => [...r.data.subarray((y * r.width + x) * r.channels, (y * r.width + x + 1) * r.channels)]

/** A PNG built by hand so the decoder is tested against more than its own encoder. `rows` hold raw sample bytes. */
function craft(opts: { w: number; h: number; ctype: number; depth?: number; rows: number[][]; filter?: number; plte?: number[]; trns?: number[]; interlace?: number }): Uint8Array {
  const { w, h, ctype, depth = 8, rows, filter = 0 } = opts
  const bpp = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype] * (depth / 8)
  const raw: number[] = []
  rows.forEach((row, y) => {
    raw.push(filter)
    row.forEach((v, x) => {
      const a = x >= bpp ? row[x - bpp] : 0
      const b = y > 0 ? rows[y - 1][x] : 0
      const c = x >= bpp && y > 0 ? rows[y - 1][x - bpp] : 0
      let pred = 0
      if (filter === 1) pred = a
      else if (filter === 2) pred = b
      else if (filter === 3) pred = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      raw.push((v - pred) & 0xff)
    })
  })
  const chunk = (type: string, body: Buffer) => {
    const b = Buffer.alloc(12 + body.length)
    b.writeUInt32BE(body.length, 0)
    b.write(type, 4, 'ascii')
    body.copy(b, 8)
    return b // the CRC is left at zero: the decoder does not check it
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(w, 0)
  head.writeUInt32BE(h, 4)
  head[8] = depth
  head[9] = ctype
  head[12] = opts.interlace ?? 0
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head)]
  if (opts.plte) parts.push(chunk('PLTE', Buffer.from(opts.plte)))
  if (opts.trns) parts.push(chunk('tRNS', Buffer.from(opts.trns)))
  parts.push(chunk('IDAT', zlib.deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0)))
  return new Uint8Array(Buffer.concat(parts))
}

describe('PNG reading and writing', () => {
  it('writes pictures that read back exactly, in color and in gray', () => {
    const a = rgb(37, 21, (x, y) => [x * 6, y * 11, (x * y) % 256])
    const back = decodePng(encodePng(a))
    expect(back).toMatchObject({ width: 37, height: 21, channels: 3 })
    expect([...back.data]).toEqual([...a.data])
    const g = gray(16, 9, (x, y) => x * 15 + y)
    const gb = toGray(decodePng(encodePng(g)))
    expect([...gb.data]).toEqual([...g.data])
    expect(isPng(encodePng(a))).toBe(true)
    expect(isPng(new Uint8Array(20))).toBe(false)
  })

  it('reads every row filter', () => {
    const rows = [
      [10, 20, 30, 40, 50, 60],
      [15, 25, 35, 45, 55, 65],
      [200, 100, 50, 25, 12, 6]
    ]
    for (const filter of [0, 1, 2, 3, 4]) {
      const r = decodePng(craft({ w: 2, h: 3, ctype: 2, rows, filter }))
      expect(r.data[0]).toBe(10)
      expect([...r.data]).toEqual(rows.flat())
    }
  })

  it('reads gray, gray with alpha, RGBA, palette with transparency and 16-bit, flattening transparency onto the background', () => {
    expect(px(decodePng(craft({ w: 1, h: 1, ctype: 0, rows: [[77]] })), 0, 0)).toEqual([77, 77, 77])
    // gray + alpha: half transparent black over white is mid gray, and over black stays black
    expect(px(decodePng(craft({ w: 1, h: 1, ctype: 4, rows: [[0, 128]] }), 255), 0, 0)).toEqual([127, 127, 127])
    expect(px(decodePng(craft({ w: 1, h: 1, ctype: 4, rows: [[0, 128]] }), 0), 0, 0)).toEqual([0, 0, 0])
    // RGBA: fully transparent shows the background, opaque shows the color
    const rgba = decodePng(craft({ w: 2, h: 1, ctype: 6, rows: [[9, 8, 7, 0, 90, 80, 70, 255]] }), 255)
    expect(px(rgba, 0, 0)).toEqual([255, 255, 255])
    expect(px(rgba, 1, 0)).toEqual([90, 80, 70])
    // palette: index 1 is transparent
    const pal = decodePng(craft({ w: 2, h: 1, ctype: 3, rows: [[0, 1]], plte: [10, 20, 30, 1, 2, 3], trns: [255, 0] }), 255)
    expect(px(pal, 0, 0)).toEqual([10, 20, 30])
    expect(px(pal, 1, 0)).toEqual([255, 255, 255])
    // 16-bit RGB keeps the high byte
    expect(px(decodePng(craft({ w: 1, h: 1, ctype: 2, depth: 16, rows: [[200, 1, 100, 2, 50, 3]] })), 0, 0)).toEqual([200, 100, 50])
  })

  it('refuses what it cannot read, with plain messages', () => {
    expect(() => decodePng(new Uint8Array(40))).toThrow(PixelError)
    expect(() => decodePng(craft({ w: 1, h: 1, ctype: 2, rows: [[1, 2, 3]], interlace: 1 }))).toThrow(/Interlaced/)
    expect(() => decodePng(craft({ w: 1, h: 1, ctype: 0, depth: 4 as never, rows: [[1]] }))).toThrow(/bits per channel/)
    const cut = encodePng(rgb(8, 8, () => [1, 2, 3]))
    expect(() => decodePng(cut.subarray(0, cut.length - 30))).toThrow(PixelError)
    const huge = craft({ w: 20000, h: 20000, ctype: 2, rows: [[0, 0, 0]] })
    expect(() => decodePng(huge)).toThrow(/too large/)
  })
})

describe('resizing and shaping gray pictures', () => {
  it('keeps flat colors flat and returns the same picture when the size does not change', () => {
    const flat = rgb(30, 20, () => [10, 120, 250])
    for (const [w, h] of [[60, 40], [7, 5], [30, 40]]) {
      const r = resizeRaster(flat, w, h)
      expect(r).toMatchObject({ width: w, height: h })
      expect(new Set([...r.data].map((v, i) => `${i % 3}:${v}`)).size).toBe(3)
      expect(px(r, 0, 0)).toEqual([10, 120, 250])
      expect(px(r, w - 1, h - 1)).toEqual([10, 120, 250])
    }
    expect(resizeRaster(flat, 30, 20)).toBe(flat)
  })
  it('averages when shrinking instead of skipping pixels', () => {
    const checker = gray(64, 64, (x, y) => ((x + y) % 2 ? 255 : 0))
    const small = resizeRaster(checker, 16, 16)
    for (const v of small.data) expect(Math.abs(v - 127.5)).toBeLessThan(8)
  })
  it('enlarges smoothly and in order', () => {
    const ramp = resizeRaster(gray(4, 1, (x) => x * 80), 16, 1)
    for (let i = 1; i < 16; i++) expect(ramp.data[i]).toBeGreaterThanOrEqual(ramp.data[i - 1])
    expect(ramp.data[0]).toBe(0)
    expect(ramp.data[15]).toBe(240)
  })
  it('crops, finds the box around a shape, counts coverage and makes hard masks', () => {
    const m = gray(20, 10, (x, y) => (x >= 5 && x < 9 && y >= 2 && y < 7 ? 200 : 0))
    expect(boundingBox(m)).toEqual({ x: 5, y: 2, w: 4, h: 5 })
    expect(boundingBox(gray(5, 5, () => 0))).toBeNull()
    expect(coverage(m)).toBeCloseTo(20 / 200)
    expect(new Set(binarize(m).data)).toEqual(new Set([0, 255]))
    const c = cropRaster(m, { x: 5, y: 2, w: 4, h: 5 })
    expect(c.width).toBe(4)
    expect([...c.data].every((v) => v === 200)).toBe(true)
  })
  it('blurs without changing flat areas and spreads a spot evenly', () => {
    expect(blurGray(gray(10, 10, () => 90), 6).data.every((v) => v === 90)).toBe(true)
    const spot = gray(41, 41, (x, y) => (x === 20 && y === 20 ? 255 : 0))
    const b = blurGray(spot, 9)
    expect(b.data[20 * 41 + 20]).toBeLessThan(255)
    expect(b.data[20 * 41 + 20]).toBeGreaterThan(0)
    expect(b.data[20 * 41 + 17]).toBe(b.data[20 * 41 + 23]) // symmetric
    expect(blurGray(spot, 0)).toBe(spot)
  })
  it('blends a patch over a picture by weight and leaves the rest alone', () => {
    const base = rgb(4, 4, () => [0, 0, 0])
    const patch = rgb(2, 2, () => [200, 200, 200])
    const alpha = gray(2, 2, (x) => (x === 0 ? 255 : 128))
    const out = blend(base, patch, alpha, 1, 1)
    expect(px(out, 1, 1)).toEqual([200, 200, 200])
    expect(px(out, 2, 1)).toEqual([100, 100, 100])
    expect(px(out, 0, 0)).toEqual([0, 0, 0])
    expect(px(base, 1, 1)).toEqual([0, 0, 0]) // the original is not changed
  })
})

describe('preparing and blending an inpaint', () => {
  const W = 800
  const H = 600
  const orig = rgb(W, H, () => [100, 150, 200])
  const init = encodePng(orig)
  const rect = (x0: number, y0: number, x1: number, y1: number, w = W, h = H) => encodePng(gray(w, h, (x, y) => (x >= x0 && x < x1 && y >= y0 && y < y1 ? 255 : 0)))
  const solid = (w: number, h: number, c: [number, number, number]) => encodePng(rgb(w, h, () => c))
  const base = { init, area: 'whole' as const, feather: 8, padding: 32, width: 512, height: 384, multiple: 8 }

  it('refuses an empty mask, and a starting picture that is not a PNG', () => {
    expect(() => prepareInpaint({ ...base, mask: rect(0, 0, 0, 0) })).toThrow(/mask is empty/)
    expect(() => prepareInpaint({ ...base, mask: rect(10, 10, 50, 50), init: new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0]) })).toThrow(InpaintError)
    expect(() => prepareInpaint({ ...base, mask: rect(10, 10, 50, 50), init: new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0]) })).toThrow(/PNG/)
  })

  it('whole picture: gives the engine exactly the size asked for, a hard mask, and keeps everything outside the mask exact', () => {
    const p = prepareInpaint({ ...base, mask: rect(300, 200, 500, 400) })
    expect(p).toMatchObject({ width: 512, height: 384, region: { x: 0, y: 0, w: W, h: H } })
    const sentInit = decodePng(p.init)
    const sentMask = toGray(decodePng(p.mask))
    expect(sentInit).toMatchObject({ width: 512, height: 384 })
    expect(sentMask).toMatchObject({ width: 512, height: 384 })
    expect(new Set(sentMask.data)).toEqual(new Set([0, 255]))
    expect(sentMask.data[192 * 512 + 256]).toBe(255)
    expect(sentMask.data[5 * 512 + 5]).toBe(0)

    const out = decodePng(p.finish(solid(512, 384, [250, 10, 10])))
    expect(out).toMatchObject({ width: W, height: H })
    expect(px(out, 5, 5)).toEqual([100, 150, 200]) // outside: untouched
    expect(px(out, 790, 590)).toEqual([100, 150, 200])
    expect(px(out, 400, 300)).toEqual([250, 10, 10]) // inside: the new picture
    // The edge fades out past the mask, over about `feather` pixels.
    const just = px(out, 297, 300)
    expect(just[0]).toBeGreaterThan(100)
    expect(just[0]).toBeLessThan(250)
    expect(px(out, 280, 300)).toEqual([100, 150, 200])
  })

  it('a mask given at a different size is stretched to the picture', () => {
    const p = prepareInpaint({ ...base, mask: rect(150, 100, 250, 200, 400, 300) })
    const out = decodePng(p.finish(solid(512, 384, [0, 255, 0])))
    expect(px(out, 400, 300)).toEqual([0, 255, 0])
    expect(px(out, 100, 100)).toEqual([100, 150, 200])
  })

  it('only the masked area: sends just the area plus margin, enlarged to the model size, and pastes it back in place', () => {
    const p = prepareInpaint({ ...base, area: 'masked', width: 512, height: 512, mask: rect(600, 300, 640, 340) })
    // 40 px of mask + margin is smaller than the minimum, so the area grows to 384 px and stays inside the picture.
    expect(p.region.w).toBe(384)
    expect(p.region.h).toBe(384)
    expect(p.region.x + p.region.w).toBeLessThanOrEqual(W)
    expect(p.region.x).toBeLessThanOrEqual(600)
    expect(p.region.x + p.region.w).toBeGreaterThanOrEqual(640)
    expect(p).toMatchObject({ width: 512, height: 512 })
    const sentMask = toGray(decodePng(p.mask))
    expect(sentMask.data[256 * 512 + 256 + Math.round(((620 - (p.region.x + 192)) * 512) / 384)]).toBe(255)
    expect(sentMask.data[3 * 512 + 3]).toBe(0)

    const out = decodePng(p.finish(solid(512, 512, [255, 0, 255])))
    expect(out).toMatchObject({ width: W, height: H })
    expect(px(out, 620, 320)).toEqual([255, 0, 255])
    expect(px(out, 10, 10)).toEqual([100, 150, 200])
    expect(px(out, p.region.x + 2, p.region.y + 2)).toEqual([100, 150, 200]) // inside the area but outside the mask
  })

  it('only the masked area: the shape of what is sent follows the area, at the pixel count asked for', () => {
    const p = prepareInpaint({ ...base, area: 'masked', width: 512, height: 512, padding: 0, feather: 0, mask: rect(100, 100, 700, 300) })
    // 200 px tall is below the 384 px minimum, so the area grows to 384, centered on the mask.
    expect(p.region).toEqual({ x: 100, y: 8, w: 600, h: 384 })
    expect(p.width / p.height).toBeCloseTo(600 / 384, 1)
    expect(Math.abs(p.width * p.height - 512 * 512) / (512 * 512)).toBeLessThan(0.06)
  })

  it('only the masked area sends the whole picture when the mask covers nearly all of it', () => {
    const p = prepareInpaint({ ...base, area: 'masked', mask: rect(10, 10, 790, 590) })
    expect(p.region).toEqual({ x: 0, y: 0, w: W, h: H })
    expect(p.width / p.height).toBeCloseTo(W / H, 1)
  })

  it('keeps the original picture when the engine returns something that is not a PNG', () => {
    const p = prepareInpaint({ ...base, mask: rect(300, 200, 500, 400) })
    expect(() => p.finish(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(/blended/)
  })
})

describe('growing the area around a mask', () => {
  it('adds the margin, stays inside the picture and reaches the minimum size', () => {
    expect(growBox({ x: 100, y: 100, w: 200, h: 200 }, 50, 1000, 1000, 100)).toEqual({ x: 50, y: 50, w: 300, h: 300 })
    expect(growBox({ x: 0, y: 0, w: 50, h: 50 }, 50, 1000, 1000, 100)).toEqual({ x: 0, y: 0, w: 100, h: 100 })
    const g = growBox({ x: 990, y: 500, w: 5, h: 5 }, 0, 1000, 1000, 300)
    expect(g.x + g.w).toBeLessThanOrEqual(1000)
    expect(g.w).toBe(300)
    expect(g.h).toBe(300)
    expect(growBox({ x: 10, y: 10, w: 20, h: 20 }, 0, 100, 80, 400)).toEqual({ x: 0, y: 0, w: 100, h: 80 })
  })
})
