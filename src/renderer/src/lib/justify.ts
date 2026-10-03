export interface JustifiedRow {
  height: number
  /** Index into the input, and the width it gets. */
  items: { index: number; width: number }[]
}

/**
 * Lay pictures out in rows that read left to right, newest first, then continue on the next row.
 * Each row is scaled so it fills the width exactly; the last row keeps the target height instead of
 * stretching a single picture across the whole page.
 */
export function justify(aspects: number[], width: number, target = 230, gap = 14): JustifiedRow[] {
  if (!(width > 0) || aspects.length === 0) return []
  const rows: JustifiedRow[] = []
  let cur: number[] = []
  let sum = 0
  const heightFor = (n: number, s: number) => (width - gap * (n - 1)) / s
  const close = (stretch: boolean) => {
    if (!cur.length) return
    const fit = heightFor(cur.length, sum)
    const height = stretch ? fit : Math.min(target, fit)
    rows.push({ height, items: cur.map((index) => ({ index, width: aspects[index] * height })) })
    cur = []
    sum = 0
  }
  aspects.forEach((a, i) => {
    const aspect = a > 0 && Number.isFinite(a) ? a : 1
    aspects[i] = aspect
    cur.push(i)
    sum += aspect
    if (heightFor(cur.length, sum) <= target) close(true)
  })
  close(false)
  return rows
}
