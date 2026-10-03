/**
 * Drawing a mask on a canvas: what each tool leaves behind, replaying the operations (for undo), reading an earlier
 * mask back in and saving the result. The geometry lives in maskGeometry.ts.
 */
import { type Op, MASK_COLOR } from './maskGeometry'

export * from './maskGeometry'

/** Draw one operation onto the mask layer (an alpha mask: painted where opaque). */
export function paintOp(ctx: CanvasRenderingContext2D, op: Op): void {
  const { width: w, height: h } = ctx.canvas
  ctx.save()
  ctx.fillStyle = MASK_COLOR
  ctx.strokeStyle = MASK_COLOR
  if (op.kind === 'stroke') {
    ctx.globalCompositeOperation = op.erase ? 'destination-out' : 'source-over'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = op.size
    if (op.points.length === 1) {
      ctx.beginPath()
      ctx.arc(op.points[0].x, op.points[0].y, op.size / 2, 0, Math.PI * 2)
      ctx.fill()
    } else if (op.points.length > 1) {
      ctx.beginPath()
      ctx.moveTo(op.points[0].x, op.points[0].y)
      for (let i = 1; i < op.points.length; i++) ctx.lineTo(op.points[i].x, op.points[i].y)
      ctx.stroke()
    }
  } else if (op.kind === 'rect') {
    ctx.fillRect(op.x, op.y, op.w, op.h)
  } else if (op.kind === 'poly') {
    if (op.points.length > 2) {
      ctx.beginPath()
      ctx.moveTo(op.points[0].x, op.points[0].y)
      for (let i = 1; i < op.points.length; i++) ctx.lineTo(op.points[i].x, op.points[i].y)
      ctx.closePath()
      ctx.fill()
    }
  } else if (op.kind === 'invert') {
    const t = document.createElement('canvas')
    t.width = w
    t.height = h
    const tc = t.getContext('2d')!
    tc.fillStyle = MASK_COLOR
    tc.fillRect(0, 0, w, h)
    tc.globalCompositeOperation = 'destination-out'
    tc.drawImage(ctx.canvas, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(t, 0, 0)
  } else {
    ctx.clearRect(0, 0, w, h)
  }
  ctx.restore()
}

/** Redraw the whole mask layer: first what was there before the editor opened, then every operation. */
export function replay(ctx: CanvasRenderingContext2D, base: CanvasImageSource | null, ops: Op[]): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  if (base) ctx.drawImage(base, 0, 0)
  for (const op of ops) paintOp(ctx, op)
}

/** An existing mask PNG (white = repaint) as a red alpha layer of the given size, so it can be edited again. */
export async function maskToLayer(png: Uint8Array, w: number, h: number): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }))
  try {
    const layer = document.createElement('canvas')
    layer.width = w
    layer.height = h
    const ctx = layer.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0, w, h)
    const img = ctx.getImageData(0, 0, w, h)
    const d = img.data
    for (let i = 0; i < d.length; i += 4) {
      const a = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])
      d[i] = 255
      d[i + 1] = 59
      d[i + 2] = 59
      d[i + 3] = a
    }
    ctx.putImageData(img, 0, 0)
    return layer
  } finally {
    bitmap.close()
  }
}

export interface ExportedMask {
  /** White where the picture is repainted, black elsewhere, as a PNG. */
  png: Uint8Array
  /** A small picture of the mask, as a data URL. */
  preview: string
  /** Share of the picture that is masked, 0 to 1. */
  coverage: number
}

export async function exportMask(layer: HTMLCanvasElement): Promise<ExportedMask> {
  const { width: w, height: h } = layer
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')!
  ctx.drawImage(layer, 0, 0)
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.globalCompositeOperation = 'destination-over'
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('Could not save the mask.')
  const k = Math.min(1, 160 / Math.max(w, h))
  const small = document.createElement('canvas')
  small.width = Math.max(1, Math.round(w * k))
  small.height = Math.max(1, Math.round(h * k))
  const sctx = small.getContext('2d', { willReadFrequently: true })!
  sctx.drawImage(out, 0, 0, small.width, small.height)
  const px = sctx.getImageData(0, 0, small.width, small.height).data
  let on = 0
  for (let i = 0; i < px.length; i += 4) if (px[i] > 127) on++
  return { png: new Uint8Array(await blob.arrayBuffer()), preview: small.toDataURL('image/png'), coverage: on / (small.width * small.height) }
}

/** Share of the mask layer that is painted, 0 to 1. Measured on a small copy, so it is quick enough to ask after every stroke. */
export function maskCoverage(layer: HTMLCanvasElement): number {
  const k = Math.min(1, 160 / Math.max(layer.width, layer.height, 1))
  const small = document.createElement('canvas')
  small.width = Math.max(1, Math.round(layer.width * k))
  small.height = Math.max(1, Math.round(layer.height * k))
  const ctx = small.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(layer, 0, 0, small.width, small.height)
  const px = ctx.getImageData(0, 0, small.width, small.height).data
  let on = 0
  for (let i = 3; i < px.length; i += 4) if (px[i] > 127) on++
  return on / (small.width * small.height)
}
