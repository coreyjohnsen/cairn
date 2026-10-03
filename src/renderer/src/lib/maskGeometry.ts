/**
 * The parts of the mask editor that need no canvas: tools and operations, rectangles, brush sizes, and how the
 * picture is fitted, zoomed and moved. Kept apart so it can be tested without a browser.
 */

export type Tool = 'brush' | 'eraser' | 'rect' | 'lasso' | 'move'

export interface Pt {
  x: number
  y: number
}

export type Op =
  | { kind: 'stroke'; erase: boolean; size: number; points: Pt[] }
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'poly'; points: Pt[] }
  | { kind: 'invert' }
  | { kind: 'clear' }

/** The paint color on the mask layer. Only its alpha matters; it shows red over the picture. */
export const MASK_COLOR = '#ff3b3b'

/** A rectangle between two corners, in either order, kept inside a w × h picture. */
export function normRect(a: Pt, b: Pt, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const x0 = Math.max(0, Math.min(w, Math.min(a.x, b.x)))
  const y0 = Math.max(0, Math.min(h, Math.min(a.y, b.y)))
  const x1 = Math.max(0, Math.min(w, Math.max(a.x, b.x)))
  const y1 = Math.max(0, Math.min(h, Math.max(a.y, b.y)))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Smallest, largest and starting brush size (in picture pixels) for a picture whose longer side is `longSide`. */
export function brushRange(longSide: number): { min: number; max: number; start: number } {
  const L = Math.max(64, longSide)
  return { min: 2, max: Math.max(24, Math.round(L / 3)), start: Math.max(8, Math.round(L / 24)) }
}

export interface View {
  /** Screen pixels per picture pixel. */
  s: number
  /** Where the picture's top-left corner is, in screen pixels inside the viewport. */
  tx: number
  ty: number
}

/** Fit the whole picture inside the viewport with a margin, centered. */
export function fitView(vw: number, vh: number, w: number, h: number, margin = 0.94): View {
  const s = Math.max(0.01, Math.min(vw / w, vh / h) * margin)
  return { s, tx: (vw - w * s) / 2, ty: (vh - h * s) / 2 }
}

/** Zoom by `factor` keeping the point (cx, cy) of the viewport where it is, within [min, max]. */
export function zoomAt(v: View, factor: number, cx: number, cy: number, min: number, max: number): View {
  const s = Math.min(max, Math.max(min, v.s * factor))
  const k = s / v.s
  return { s, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k }
}

/** Viewport position to picture position. */
export function toPicture(v: View, x: number, y: number): Pt {
  return { x: (x - v.tx) / v.s, y: (y - v.ty) / v.s }
}
