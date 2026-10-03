import { describe, expect, it } from 'vitest'
import { justify } from '../src/renderer/src/lib/justify'

describe('justified rows', () => {
  it('fills each full row to the exact width, in the given order', () => {
    const aspects = [1, 1.5, 0.75, 1, 1.78, 1, 1, 0.66, 1.33, 1]
    const W = 1000
    const rows = justify([...aspects], W, 200, 10)
    expect(rows.flatMap((r) => r.items.map((i) => i.index))).toEqual(aspects.map((_, i) => i))
    for (const r of rows.slice(0, -1)) {
      const total = r.items.reduce((s, i) => s + i.width, 0) + 10 * (r.items.length - 1)
      expect(total).toBeCloseTo(W, 4)
      expect(r.height).toBeLessThanOrEqual(200 + 1e-6)
    }
  })

  it('does not stretch the last row', () => {
    const rows = justify([1, 1, 1, 1, 1], 1000, 300, 0)
    expect(rows.at(-1)!.height).toBe(300)
    expect(rows.at(-1)!.items).toHaveLength(1)
  })

  it('keeps tall pictures in order across rows, newest first', () => {
    const rows = justify([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 600, 250, 10)
    expect(rows[0].items.map((i) => i.index)).toEqual([0, 1, 2, 3, 4])
    expect(rows[1].items.map((i) => i.index)).toEqual([5])
  })

  it('copes with nothing, no width and bad aspects', () => {
    expect(justify([], 500)).toEqual([])
    expect(justify([1], 0)).toEqual([])
    const rows = justify([0, Number.NaN, -3], 600, 200, 10)
    expect(rows.flatMap((r) => r.items).every((i) => i.width > 0)).toBe(true)
  })
})
