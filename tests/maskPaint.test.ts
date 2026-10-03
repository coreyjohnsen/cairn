import { describe, expect, it } from 'vitest'
import { brushRange, fitView, normRect, toPicture, zoomAt } from '../src/renderer/src/lib/maskGeometry'

describe('mask editor geometry', () => {
  it('makes a rectangle from two corners in any order, inside the picture', () => {
    expect(normRect({ x: 50, y: 40 }, { x: 10, y: 80 }, 100, 100)).toEqual({ x: 10, y: 40, w: 40, h: 40 })
    expect(normRect({ x: -20, y: -5 }, { x: 150, y: 120 }, 100, 100)).toEqual({ x: 0, y: 0, w: 100, h: 100 })
    expect(normRect({ x: 30, y: 30 }, { x: 30, y: 30 }, 100, 100)).toEqual({ x: 30, y: 30, w: 0, h: 0 })
  })
  it('gives a brush range that scales with the picture', () => {
    const small = brushRange(512)
    const big = brushRange(2048)
    expect(small.min).toBe(2)
    expect(big.max).toBeGreaterThan(small.max)
    expect(small.start).toBeGreaterThanOrEqual(small.min)
    expect(small.start).toBeLessThanOrEqual(small.max)
    expect(brushRange(10).max).toBeGreaterThanOrEqual(24)
  })
  it('fits and centers the picture, and zooming keeps the point under the cursor still', () => {
    const v = fitView(1000, 600, 2000, 1000)
    expect(v.s).toBeCloseTo(0.47)
    expect(v.tx).toBeCloseTo((1000 - 2000 * v.s) / 2)
    expect(v.ty).toBeCloseTo((600 - 1000 * v.s) / 2)
    const before = toPicture(v, 400, 300)
    const z = zoomAt(v, 2, 400, 300, 0.1, 16)
    const after = toPicture(z, 400, 300)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(z.s).toBeCloseTo(v.s * 2)
  })
  it('keeps the zoom within its limits', () => {
    const v = { s: 1, tx: 0, ty: 0 }
    expect(zoomAt(v, 100, 0, 0, 0.5, 16).s).toBe(16)
    expect(zoomAt(v, 0.001, 0, 0, 0.5, 16).s).toBe(0.5)
  })
})
