import jsQR from 'jsqr'
import { describe, expect, it } from 'vitest'
import { qrModules, qrSvgPath } from '../src/shared/qr'

/** Draws the squares as pixels, the way a screen would, then reads them back with an independent decoder. */
function decode(modules: boolean[][], scale = 6, margin = 4): string | null {
  const n = modules.length + margin * 2
  const w = n * scale
  const data = new Uint8ClampedArray(w * w * 4).fill(255)
  for (let y = 0; y < modules.length; y++) {
    for (let x = 0; x < modules.length; x++) {
      if (!modules[y][x]) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + margin) * scale + dy) * w + (x + margin) * scale + dx) * 4
          data[i] = data[i + 1] = data[i + 2] = 0
        }
      }
    }
  }
  return jsQR(data, w, w)?.data ?? null
}

describe('QR codes for pairing links', () => {
  it('reads back exactly what was put in', () => {
    for (const text of [
      'http://192.168.1.20:8742/#pair=K7QM4TXD',
      'http://100.101.102.103:8742/#pair=ABCDEFGH',
      'https://my-desktop.tail1a2b3c.ts.net/#pair=Z9Y8X7W6',
      'https://pc.example.com:8443/#pair=23456789'
    ]) {
      expect(decode(qrModules(text)), text).toBe(text)
    }
  })

  it('stays readable with a little damage', () => {
    const text = 'http://192.168.1.20:8742/#pair=K7QM4TXD'
    const m = qrModules(text, 'M').map((r) => [...r])
    // Scratch a few squares away from the three corner markers.
    for (let i = 0; i < 6; i++) m[m.length - 9][12 + i] = !m[m.length - 9][12 + i]
    expect(decode(m)).toBe(text)
  })

  it('draws a compact path that covers every dark square', () => {
    const m = qrModules('http://192.168.1.20:8742/#pair=K7QM4TXD')
    const { path, size } = qrSvgPath(m)
    expect(size).toBe(m.length + 8)
    const dark = m.flat().filter(Boolean).length
    // Each run is "M x y h w v1 h-w z"; the widths add up to the dark squares.
    const widths = [...path.matchAll(/h(\d+)v1/g)].map((x) => Number(x[1]))
    expect(widths.reduce((a, b) => a + b, 0)).toBe(dark)
    expect(path.length).toBeLessThan(6000)
  })
})
