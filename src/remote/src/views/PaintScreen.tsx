import { Brush, Contrast, Eraser, Hand, Lasso, Maximize2, Redo2, SlidersHorizontal, SquareDashed, Trash2, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fitWithin } from '@shared/img2img'
import { InpaintModelPicker } from '@/components/InpaintModelPicker'
import { MaskPainter, type PainterApi, type PainterState } from '@/components/MaskPainter'
import { Segmented, Slider } from '@/components/ui'
import { mediaUrl } from '@/lib/api'
import { cx } from '@/lib/format'
import { type Tool, brushRange } from '@/lib/maskPaint'
import { useImages } from '@/store/images'
import { useHub } from '@/views/images/useHub'
import { useNav } from '../store/nav'

const TOOLS: { id: Tool; label: string; icon: typeof Brush }[] = [
  { id: 'brush', label: 'Brush', icon: Brush },
  { id: 'eraser', label: 'Eraser', icon: Eraser },
  { id: 'rect', label: 'Box', icon: SquareDashed },
  { id: 'lasso', label: 'Lasso', icon: Lasso },
  { id: 'move', label: 'Move', icon: Hand }
]

/** How the paint is turned into a result: which part the engine sees, how soft the edge is, how much surrounding it sees. */
function PaintOptions() {
  const form = useImages((s) => s.form)
  const setForm = useImages((s) => s.setForm)
  const hub = useHub()
  return (
    <div className="paint-opts">
      <InpaintModelPicker form={form} setForm={setForm} target={hub.target} choices={hub.inpaintTargets} />
      <div>
        <div className="small dim paint-opt-label">Repaint</div>
        <Segmented
          size="sm"
          fill
          value={form.inpaintArea}
          onChange={(v) => setForm({ inpaintArea: v })}
          options={[
            { value: 'masked', label: 'Just that area' },
            { value: 'whole', label: 'Whole picture' }
          ]}
        />
        <div className="faint xs paint-opt-label">
          {form.inpaintArea === 'masked' ? 'Best for small areas such as a face or an object: they get as much detail as a whole picture.' : 'Best for large areas, or when the change must fit the whole scene.'}
        </div>
      </div>
      <div>
        <div className="small dim">Soft edge</div>
        <Slider value={form.feather} min={0} max={64} step={1} onChange={(v) => setForm({ feather: v })} format={(v) => (v === 0 ? 'off' : `${v}px`)} />
      </div>
      {form.inpaintArea === 'masked' && (
        <div>
          <div className="small dim">Margin around it</div>
          <Slider value={form.padding} min={0} max={256} step={8} onChange={(v) => setForm({ padding: v })} format={(v) => `${v}px`} />
          <div className="faint xs">How much of the surroundings the engine can see. More helps it match the scene.</div>
        </div>
      )}
    </div>
  )
}

/**
 * Full-screen painting on the picture being changed: brush, eraser, box and lasso, with two fingers to zoom and move.
 * Whatever is painted is what changes; nothing painted redoes the whole picture. Fills in the same form the computer uses.
 */
export function PaintScreen() {
  const open = useNav((s) => s.layers.includes('paint'))
  const close = useNav((s) => s.close)
  const form = useImages((s) => s.form)
  const setForm = useImages((s) => s.setForm)
  const setMaskFlush = useImages((s) => s.setMaskFlush)
  const base = useImages((s) => s.records.find((r) => r.id === s.form.initImageId))
  const painter = useRef<PainterApi>(null)
  const [tool, setTool] = useState<Tool>('brush')
  const [opts, setOpts] = useState(false)
  const [pstate, setPstate] = useState<PainterState>({ canUndo: false, canRedo: false, coverage: form.mask?.coverage ?? 0 })
  const { width: W, height: H } = useMemo(() => fitWithin(base?.width ?? 1, base?.height ?? 1, 2048), [base?.width, base?.height])
  const range = useMemo(() => brushRange(Math.max(W, H)), [W, H])
  const [size, setSize] = useState(range.start)
  useEffect(() => setSize(range.start), [range.start])

  // Generate asks for the mask right away instead of waiting for the last stroke to be saved.
  useEffect(() => {
    if (!open) return
    setMaskFlush(() => painter.current?.save() ?? Promise.resolve())
    return () => setMaskFlush(null)
  }, [open, setMaskFlush])

  if (!open || !base) return null
  const painted = pstate.coverage >= 0.0005

  const done = async () => {
    await painter.current?.save()
    close('paint')
  }

  return createPortal(
    <div className="paint-screen" role="dialog" aria-modal="true" aria-label="Paint the part to change">
      <header className="paint-top">
        <button type="button" className="top-btn accent" onClick={() => void done()}>
          Done
        </button>
        <span className="paint-title small">{painted ? `${Math.round(pstate.coverage * 100)}% painted` : 'Paint what should change'}</span>
        <div className="paint-undo">
          <button type="button" className="top-btn icon" aria-label="Undo" disabled={!pstate.canUndo} onClick={() => painter.current?.undo()}>
            <Undo2 size={21} />
          </button>
          <button type="button" className="top-btn icon" aria-label="Redo" disabled={!pstate.canRedo} onClick={() => painter.current?.redo()}>
            <Redo2 size={21} />
          </button>
        </div>
      </header>

      <div className="paint-wrap">
        <MaskPainter
          key={base.id}
          ref={painter}
          width={W}
          height={H}
          src={mediaUrl('image', base.file)}
          showMask
          tool={tool}
          size={size}
          initial={form.mask?.png}
          onState={setPstate}
          onSave={(m) => {
            // A save that finishes after the picture was swapped belongs to the old one.
            if (useImages.getState().form.initImageId === base.id) setForm({ mask: m ?? undefined })
          }}
        />
        {!painted && (
          <div className="paint-hint">Draw over the part to change. Pinch to zoom, two fingers to move. Leave it blank to redo the whole picture.</div>
        )}
      </div>

      <footer className="paint-bar">
        {opts && <PaintOptions />}
        {(tool === 'brush' || tool === 'eraser') && (
          <div className="paint-size">
            <span className="small dim">Size</span>
            <Slider value={size} min={range.min} max={range.max} onChange={setSize} format={(v) => `${v}`} />
          </div>
        )}
        <div className="paint-tools" role="toolbar" aria-label="Painting tools">
          {TOOLS.map((t) => (
            <button key={t.id} type="button" className={cx('paint-tool', tool === t.id && 'on')} aria-pressed={tool === t.id} onClick={() => setTool(t.id)}>
              <t.icon size={21} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <div className="paint-tools secondary">
          <button type="button" className="paint-tool" onClick={() => painter.current?.invert()}>
            <Contrast size={20} />
            <span>Swap</span>
          </button>
          <button type="button" className="paint-tool" disabled={!painted} onClick={() => painter.current?.clear()}>
            <Trash2 size={20} />
            <span>Clear</span>
          </button>
          <button type="button" className="paint-tool" onClick={() => painter.current?.fit()}>
            <Maximize2 size={20} />
            <span>Fit</span>
          </button>
          <button type="button" className={cx('paint-tool', opts && 'on')} aria-pressed={opts} onClick={() => setOpts((o) => !o)}>
            <SlidersHorizontal size={20} />
            <span>Options</span>
          </button>
        </div>
      </footer>
    </div>,
    document.body
  )
}
