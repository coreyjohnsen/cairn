/** The largest box of the given shape (width divided by height) that fits inside a `w` by `h` area. */
export function containBox(aspect: number, w: number, h: number): { width: number; height: number } {
  if (!(aspect > 0) || !(w > 0) || !(h > 0)) return { width: 0, height: 0 }
  const height = w / aspect
  if (height <= h) return { width: Math.floor(w), height: Math.floor(height) }
  return { width: Math.floor(h * aspect), height: Math.floor(h) }
}
