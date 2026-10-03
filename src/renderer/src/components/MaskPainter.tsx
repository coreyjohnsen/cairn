import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { type ExportedMask, type Op, type Pt, type Tool, type View, exportMask, fitView, maskCoverage, maskToLayer, normRect, paintOp, replay, toPicture, zoomAt } from '@/lib/maskPaint'

export interface PainterApi {
  undo(): void
  redo(): void
  invert(): void
  clear(): void
  /** Show the whole picture again after zooming or moving. */
  fit(): void
  /** Save the mask now instead of a moment after the last stroke. */
  save(): Promise<void>
}

export interface PainterState {
  canUndo: boolean
  canRedo: boolean
  /** Share of the picture that is painted, 0 to 1. */
  coverage: number
}

interface Props {
  /** The size of the picture being painted on, in pixels (the mask is drawn at up to 2048 on the longer side). */
  width: number
  height: number
  /** What to show: the picture itself, or a picture made from it. */
  src: string
  /** Show the paint over it. Hidden while looking at a result, so the change can be seen cleanly. */
  showMask: boolean
  tool: Tool
  size: number
  /** Painting is paused (a picture is being made); zooming and moving still work. */
  paused?: boolean
  /** A mask made earlier, to carry on from. */
  initial?: Uint8Array
  onState(s: PainterState): void
  /** The mask, saved shortly after each change; null when nothing is painted. */
  onSave(m: ExportedMask | null): void
  /** A stroke is starting. */
  onPaint?(): void
}

type Drag =
  | { kind: 'pan'; sx: number; sy: number; tx: number; ty: number }
  | { kind: 'stroke'; op: Extract<Op, { kind: 'stroke' }> }
  | { kind: 'rect'; a: Pt; b: Pt }
  | { kind: 'lasso'; pts: Pt[] }

const typing = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range') || el.isContentEditable)
}

/**
 * The canvas for choosing which part of a picture to change: the picture, with what is painted over it. Paint, erase,
 * draw rectangles or lassos, zoom with the wheel and move with Space held. It keeps its own undo history and saves
 * the mask (white = repaint) through `onSave`.
 */
export const MaskPainter = forwardRef<PainterApi, Props>(function MaskPainter({ width: W, height: H, src, showMask, tool, size, paused, initial, onState, onSave, onPaint }, ref) {
  const viewport = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLCanvasElement>(null)
  const overlay = useRef<HTMLCanvasElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const base = useRef<HTMLCanvasElement | null>(null)
  const ops = useRef<Op[]>([])
  const undone = useRef<Op[]>([])
  const drag = useRef<Drag | null>(null)
  const hover = useRef<Pt | null>(null)
  const space = useRef(false)
  const touched = useRef(false)
  const view = useRef<View>({ s: 1, tx: 0, ty: 0 })
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Props the pointer handlers read at the moment of use.
  const live = useRef({ tool, size, paused, onState, onSave, onPaint })
  live.current = { tool, size, paused, onState, onSave, onPaint }

  const place = useCallback(() => {
    const v = view.current
    if (stage.current) stage.current.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.s})`
  }, [])

  const drawOverlay = useCallback(() => {
    const c = overlay.current
    if (!c) return
    const g = c.getContext('2d')!
    g.clearRect(0, 0, c.width, c.height)
    const px = 1 / view.current.s
    const outline = (path: () => void, dash?: number[]) => {
      for (const [color, w] of [['rgba(0,0,0,0.75)', 3.2], ['#fff', 1.6]] as const) {
        g.beginPath()
        path()
        g.setLineDash(dash ? dash.map((d) => d * px) : [])
        g.strokeStyle = color
        g.lineWidth = w * px
        g.stroke()
      }
    }
    const t = live.current.tool
    const d = drag.current
    if ((t === 'brush' || t === 'eraser') && hover.current && !(d && d.kind === 'pan') && !live.current.paused) {
      const p = hover.current
      outline(() => g.arc(p.x, p.y, live.current.size / 2, 0, Math.PI * 2))
    }
    if (d?.kind === 'rect') {
      const r = normRect(d.a, d.b, W, H)
      outline(() => g.rect(r.x, r.y, r.w, r.h), [6, 4])
    } else if (d?.kind === 'lasso' && d.pts.length > 1) {
      const pts = d.pts
      outline(() => {
        g.moveTo(pts[0].x, pts[0].y)
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y)
        g.lineTo(pts[0].x, pts[0].y)
      }, [6, 4])
    }
  }, [W, H])
  useEffect(drawOverlay, [tool, size, paused, drawOverlay])

  const ctx = () => layer.current!.getContext('2d')!
  const redraw = useCallback(() => replay(layer.current!.getContext('2d')!, base.current, ops.current), [])

  const emit = useCallback(() => {
    const el = layer.current
    live.current.onState({ canUndo: ops.current.length > 0, canRedo: undone.current.length > 0, coverage: el ? maskCoverage(el) : 0 })
  }, [])

  /** Save the mask: soon after a change, or right now when asked. */
  const save = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const el = layer.current
    if (!el) return
    if (maskCoverage(el) < 0.0005) return live.current.onSave(null)
    live.current.onSave(await exportMask(el))
  }, [])
  const changed = useCallback(() => {
    emit()
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void save(), 250)
  }, [emit, save])

  const fit = useCallback(() => {
    const el = viewport.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) {
      view.current = fitView(r.width, r.height, W, H)
      place()
      drawOverlay()
    }
  }, [W, H, place, drawOverlay])

  useLayoutEffect(() => {
    fit()
    const el = viewport.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (!touched.current) fit()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [fit])

  // Carry on from an earlier mask.
  useEffect(() => {
    if (!initial) return
    let alive = true
    maskToLayer(initial, W, H)
      .then((c) => {
        if (!alive) return
        base.current = c
        redraw()
        emit()
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // Only on first showing: later changes come from this canvas itself.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  }, [])

  // A change that has not been saved yet is saved when the canvas goes away.
  useEffect(() => {
    const el = layer.current
    return () => {
      if (!saveTimer.current || !el) return
      clearTimeout(saveTimer.current)
      const onSaveNow = live.current.onSave
      if (maskCoverage(el) < 0.0005) onSaveNow(null)
      else void exportMask(el).then(onSaveNow)
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      undo() {
        const op = ops.current.pop()
        if (!op) return
        undone.current.push(op)
        redraw()
        changed()
      },
      redo() {
        const op = undone.current.pop()
        if (!op) return
        ops.current.push(op)
        paintOp(ctx(), op)
        changed()
      },
      invert() {
        const op: Op = { kind: 'invert' }
        paintOp(ctx(), op)
        ops.current.push(op)
        undone.current = []
        changed()
      },
      clear() {
        const op: Op = { kind: 'clear' }
        paintOp(ctx(), op)
        ops.current.push(op)
        undone.current = []
        changed()
      },
      fit() {
        touched.current = false
        fit()
      },
      save
    }),
    [changed, fit, redraw, save]
  )

  const apply = (op: Op) => {
    paintOp(ctx(), op)
    ops.current.push(op)
    undone.current = []
    changed()
  }

  // Hold Space to move the picture.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === ' ' && !typing(e.target) && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        space.current = true
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') space.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // Scroll to zoom around the pointer. Added by hand because React's wheel handlers cannot stop the page from scrolling.
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      touched.current = true
      const fitted = fitView(r.width, r.height, W, H).s
      view.current = zoomAt(view.current, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top, fitted * 0.5, 24)
      place()
      drawOverlay()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [W, H, place, drawOverlay])

  const local = (e: React.PointerEvent) => {
    const r = viewport.current!.getBoundingClientRect()
    return { sx: e.clientX - r.left, sy: e.clientY - r.top }
  }

  const onDown = (e: React.PointerEvent) => {
    const { sx, sy } = local(e)
    const t = live.current.tool
    const panning = e.button === 1 || space.current || t === 'move'
    if (live.current.paused && !panning) return
    viewport.current!.setPointerCapture(e.pointerId)
    if (panning) {
      touched.current = true
      drag.current = { kind: 'pan', sx, sy, tx: view.current.tx, ty: view.current.ty }
      return
    }
    if (e.button !== 0) return
    live.current.onPaint?.()
    const p = toPicture(view.current, sx, sy)
    if (t === 'brush' || t === 'eraser') {
      const op: Extract<Op, { kind: 'stroke' }> = { kind: 'stroke', erase: t === 'eraser', size: live.current.size, points: [p] }
      paintOp(ctx(), op)
      drag.current = { kind: 'stroke', op }
    } else if (t === 'rect') drag.current = { kind: 'rect', a: p, b: p }
    else if (t === 'lasso') drag.current = { kind: 'lasso', pts: [p] }
    drawOverlay()
  }

  const onMove = (e: React.PointerEvent) => {
    const { sx, sy } = local(e)
    const p = toPicture(view.current, sx, sy)
    hover.current = p
    const d = drag.current
    if (d?.kind === 'pan') {
      view.current = { ...view.current, tx: d.tx + (sx - d.sx), ty: d.ty + (sy - d.sy) }
      place()
      drawOverlay()
      return
    }
    if (d?.kind === 'stroke') {
      const prev = d.op.points[d.op.points.length - 1]
      d.op.points.push(p)
      paintOp(ctx(), { ...d.op, points: [prev, p] })
    } else if (d?.kind === 'rect') d.b = p
    else if (d?.kind === 'lasso') {
      const last = d.pts[d.pts.length - 1]
      if (Math.hypot(p.x - last.x, p.y - last.y) * view.current.s >= 2) d.pts.push(p)
    }
    drawOverlay()
  }

  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (d?.kind === 'stroke') {
      ops.current.push(d.op)
      undone.current = []
      changed()
    } else if (d?.kind === 'rect') {
      const r = normRect(d.a, d.b, W, H)
      if (r.w > 1 && r.h > 1) apply({ kind: 'rect', ...r })
    } else if (d?.kind === 'lasso' && d.pts.length > 2) apply({ kind: 'poly', points: d.pts })
    drawOverlay()
  }

  const onLeave = () => {
    hover.current = null
    drawOverlay()
  }

  const cursor = tool === 'move' ? 'grab' : paused ? 'default' : tool === 'rect' || tool === 'lasso' ? 'crosshair' : 'none'

  return (
    <div ref={viewport} className="paint-viewport" style={{ cursor }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={onLeave} onContextMenu={(e) => e.preventDefault()}>
      <div ref={stage} className="paint-stage" style={{ width: W, height: H }}>
        <img src={src} width={W} height={H} alt="" draggable={false} />
        <canvas ref={layer} className="paint-layer" style={{ opacity: showMask ? 0.55 : 0 }} width={W} height={H} />
        <canvas ref={overlay} className="paint-overlay" style={{ opacity: showMask ? 1 : 0 }} width={W} height={H} />
      </div>
    </div>
  )
})
