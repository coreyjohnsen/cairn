import { Brush, Contrast, Eraser, Hand, Lasso, Maximize2, Redo2, SquareDashed, Trash2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { fitWithin } from '@shared/img2img'
import type { ImageRecord } from '@shared/types'
import { mediaUrl } from '@/lib/api'
import { errorText } from '@/lib/format'
import { type ExportedMask, type Op, type Pt, type Tool, type View, brushRange, exportMask, fitView, maskToLayer, normRect, paintOp, replay, toPicture, zoomAt } from '@/lib/maskPaint'
import { useApp } from '@/store/app'
import { Button, IconButton, Slider } from './ui'

interface Props {
  picture: ImageRecord
  /** A mask made earlier, to carry on from. */
  initial?: Uint8Array
  onDone(mask: ExportedMask): void
  onCancel(): void
}

type Drag =
  | { kind: 'pan'; sx: number; sy: number; tx: number; ty: number }
  | { kind: 'stroke'; op: Extract<Op, { kind: 'stroke' }> }
  | { kind: 'rect'; a: Pt; b: Pt }
  | { kind: 'lasso'; pts: Pt[] }

const TOOLS: { id: Tool; label: string; key: string; icon: typeof Brush }[] = [
  { id: 'brush', label: 'Brush: paint where the picture should change', key: 'B', icon: Brush },
  { id: 'eraser', label: 'Eraser: take paint away', key: 'E', icon: Eraser },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: SquareDashed },
  { id: 'lasso', label: 'Lasso: draw around an area to fill it', key: 'L', icon: Lasso },
  { id: 'move', label: 'Move the picture (or hold Space)', key: 'H', icon: Hand }
]

/**
 * Full-screen editor for choosing which part of a picture to repaint: paint, erase, draw rectangles or lassos,
 * zoom and move, undo and redo. The result is a black-and-white picture (white = repaint).
 */
export function MaskEditor({ picture, initial, onDone, onCancel }: Props) {
  const toast = useApp((s) => s.toast)
  // The mask is drawn at the picture's own size, up to 2048 pixels on the longer side.
  const { width: W, height: H } = useMemo(() => fitWithin(picture.width, picture.height, 2048), [picture])
  const range = useMemo(() => brushRange(Math.max(W, H)), [W, H])
  const [tool, setTool] = useState<Tool>('brush')
  const [size, setSize] = useState(range.start)
  const [view, setView] = useState<View>({ s: 1, tx: 0, ty: 0 })
  const [busy, setBusy] = useState(false)
  const [, bump] = useReducer((n: number) => n + 1, 0)

  const viewport = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLCanvasElement>(null)
  const overlay = useRef<HTMLCanvasElement>(null)
  const base = useRef<HTMLCanvasElement | null>(null)
  const ops = useRef<Op[]>([])
  const undone = useRef<Op[]>([])
  const drag = useRef<Drag | null>(null)
  const hover = useRef<Pt | null>(null)
  const space = useRef(false)
  const touched = useRef(false)
  const toolRef = useRef(tool)
  const sizeRef = useRef(size)
  const viewRef = useRef(view)
  toolRef.current = tool
  sizeRef.current = size
  viewRef.current = view

  const ctx = () => layer.current!.getContext('2d')!
  const redraw = useCallback(() => replay(layer.current!.getContext('2d')!, base.current, ops.current), [])

  const drawOverlay = useCallback(() => {
    const c = overlay.current
    if (!c) return
    const g = c.getContext('2d')!
    g.clearRect(0, 0, c.width, c.height)
    const px = 1 / viewRef.current.s
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
    const t = toolRef.current
    const d = drag.current
    if ((t === 'brush' || t === 'eraser') && hover.current && !(d && d.kind === 'pan')) {
      const p = hover.current
      outline(() => g.arc(p.x, p.y, sizeRef.current / 2, 0, Math.PI * 2))
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

  // Start with the whole picture in view, and keep it fitted until the person zooms or moves.
  const fit = useCallback(() => {
    const el = viewport.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) setView(fitView(r.width, r.height, W, H))
  }, [W, H])
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
    let live = true
    maskToLayer(initial, W, H)
      .then((c) => {
        if (!live) return
        base.current = c
        redraw()
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [initial, W, H, redraw])

  useEffect(drawOverlay, [view, tool, size, drawOverlay])

  const apply = (op: Op) => {
    paintOp(ctx(), op)
    ops.current.push(op)
    undone.current = []
    bump()
  }
  const undo = () => {
    const op = ops.current.pop()
    if (!op) return
    undone.current.push(op)
    redraw()
    bump()
  }
  const redo = () => {
    const op = undone.current.pop()
    if (!op) return
    ops.current.push(op)
    paintOp(ctx(), op)
    bump()
  }

  const finish = async () => {
    setBusy(true)
    try {
      const m = await exportMask(layer.current!)
      if (m.coverage < 0.0005) {
        toast('error', 'Paint over the part of the picture you want to change first.')
        return
      }
      onDone(m)
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setBusy(false)
    }
  }

  // Keyboard shortcuts.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {})
  keys.current = (e) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range'))) return
    const k = e.key.toLowerCase()
    if ((e.ctrlKey || e.metaKey) && k === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    } else if ((e.ctrlKey || e.metaKey) && k === 'y') {
      e.preventDefault()
      redo()
    } else if (e.ctrlKey || e.metaKey || e.altKey) {
      return
    } else if (k === ' ') {
      e.preventDefault()
      space.current = true
    } else if (k === '[') setSize((s) => Math.max(range.min, Math.round(s * 0.8)))
    else if (k === ']') setSize((s) => Math.min(range.max, Math.round(s * 1.25) + 1))
    else if (k === 'escape') {
      if (ops.current.length === 0) onCancel()
    } else {
      const hit = TOOLS.find((x) => x.key.toLowerCase() === k)
      if (hit) setTool(hit.id)
    }
  }
  useEffect(() => {
    const down = (e: KeyboardEvent) => keys.current(e)
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
      setView((v) => zoomAt(v, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top, fitted * 0.5, 24))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [W, H])

  const local = (e: React.PointerEvent) => {
    const r = viewport.current!.getBoundingClientRect()
    return { sx: e.clientX - r.left, sy: e.clientY - r.top }
  }

  const onDown = (e: React.PointerEvent) => {
    if (busy) return
    const { sx, sy } = local(e)
    viewport.current!.setPointerCapture(e.pointerId)
    if (e.button === 1 || space.current || toolRef.current === 'move') {
      touched.current = true
      drag.current = { kind: 'pan', sx, sy, tx: viewRef.current.tx, ty: viewRef.current.ty }
      return
    }
    if (e.button !== 0) return
    const p = toPicture(viewRef.current, sx, sy)
    const t = toolRef.current
    if (t === 'brush' || t === 'eraser') {
      const op: Extract<Op, { kind: 'stroke' }> = { kind: 'stroke', erase: t === 'eraser', size: sizeRef.current, points: [p] }
      paintOp(ctx(), op)
      drag.current = { kind: 'stroke', op }
    } else if (t === 'rect') drag.current = { kind: 'rect', a: p, b: p }
    else if (t === 'lasso') drag.current = { kind: 'lasso', pts: [p] }
    drawOverlay()
  }

  const onMove = (e: React.PointerEvent) => {
    const { sx, sy } = local(e)
    const p = toPicture(viewRef.current, sx, sy)
    hover.current = p
    const d = drag.current
    if (d?.kind === 'pan') {
      setView({ ...viewRef.current, tx: d.tx + (sx - d.sx), ty: d.ty + (sy - d.sy) })
      return
    }
    if (d?.kind === 'stroke') {
      const prev = d.op.points[d.op.points.length - 1]
      d.op.points.push(p)
      paintOp(ctx(), { ...d.op, points: [prev, p] })
    } else if (d?.kind === 'rect') d.b = p
    else if (d?.kind === 'lasso') {
      const last = d.pts[d.pts.length - 1]
      if (Math.hypot(p.x - last.x, p.y - last.y) * viewRef.current.s >= 2) d.pts.push(p)
    }
    drawOverlay()
  }

  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (d?.kind === 'stroke') {
      ops.current.push(d.op)
      undone.current = []
      bump()
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

  const cursor = tool === 'move' ? 'grab' : tool === 'rect' || tool === 'lasso' ? 'crosshair' : 'none'

  return (
    <div className="mask-editor" role="dialog" aria-modal="true" aria-label="Paint a mask">
      <div className="me-bar">
        <div className="me-group" role="group" aria-label="Tools">
          {TOOLS.map((t) => (
            <IconButton key={t.id} label={`${t.label} (${t.key})`} active={tool === t.id} onClick={() => setTool(t.id)}>
              <t.icon size={17} />
            </IconButton>
          ))}
        </div>
        {(tool === 'brush' || tool === 'eraser') && (
          <div className="me-size">
            <span className="small dim">Size</span>
            <Slider value={size} min={range.min} max={range.max} onChange={setSize} format={(v) => `${v}px`} />
          </div>
        )}
        <div className="me-group" role="group" aria-label="Edit">
          <IconButton label="Undo (Ctrl+Z)" disabled={ops.current.length === 0} onClick={undo}>
            <Undo2 size={17} />
          </IconButton>
          <IconButton label="Redo (Ctrl+Shift+Z)" disabled={undone.current.length === 0} onClick={redo}>
            <Redo2 size={17} />
          </IconButton>
          <IconButton label="Swap painted and unpainted" onClick={() => apply({ kind: 'invert' })}>
            <Contrast size={17} />
          </IconButton>
          <IconButton label="Clear everything" onClick={() => apply({ kind: 'clear' })}>
            <Trash2 size={17} />
          </IconButton>
          <IconButton
            label="Fit the picture in the window"
            onClick={() => {
              touched.current = false
              fit()
            }}
          >
            <Maximize2 size={17} />
          </IconButton>
        </div>
        <div className="grow" />
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" busy={busy} onClick={() => void finish()}>
          Done
        </Button>
      </div>

      <div ref={viewport} className="me-viewport" style={{ cursor }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={onLeave} onContextMenu={(e) => e.preventDefault()}>
        <div className="me-stage" style={{ width: W, height: H, transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})` }}>
          <img src={mediaUrl('image', picture.file)} width={W} height={H} alt="" draggable={false} />
          <canvas ref={layer} className="me-layer" width={W} height={H} />
          <canvas ref={overlay} className="me-overlay" width={W} height={H} />
        </div>
      </div>

      <div className="me-hint">
        Paint over the part you want to change. Scroll to zoom, hold Space to move. B brush, E eraser, R rectangle, L lasso, [ and ] change the brush size.
      </div>
    </div>
  )
}
