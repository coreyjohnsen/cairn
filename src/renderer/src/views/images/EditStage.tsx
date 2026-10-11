import { Brush, Check, Contrast, Eraser, Hand, ImagePlus, Lasso, Maximize2, Redo2, SlidersHorizontal, SquareDashed, Trash2, Undo2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { stepsRun, strengthLabel, fitWithin } from '@shared/img2img'
import type { ImageRecord } from '@shared/types'
import { ImageProgress } from '@/components/ImageProgress'
import { MaskPainter, type PainterApi, type PainterState } from '@/components/MaskPainter'
import { Button, IconButton, Notice, Popover, Segmented, Slider } from '@/components/ui'
import { mediaUrl } from '@/lib/api'
import { cx } from '@/lib/format'
import { type Tool, brushRange } from '@/lib/maskPaint'
import { useImages } from '@/store/images'
import { PromptBox } from './PromptBox'
import { useHub } from './useHub'

const TOOLS: { id: Tool; label: string; key: string; icon: typeof Brush }[] = [
  { id: 'brush', label: 'Brush: paint where the picture should change', key: 'B', icon: Brush },
  { id: 'eraser', label: 'Eraser: take paint away', key: 'E', icon: Eraser },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: SquareDashed },
  { id: 'lasso', label: 'Lasso: draw around an area to fill it', key: 'L', icon: Lasso },
  { id: 'move', label: 'Move the picture (or hold Space)', key: 'H', icon: Hand }
]

/** How the paint is turned into a result: which part the engine sees, how soft the edge is, how much surrounding it sees. */
function MaskOptions() {
  const form = useImages((s) => s.form)
  const setForm = useImages((s) => s.setForm)
  return (
    <div className="edit-opts">
      <div>
        <div className="small dim" style={{ marginBottom: 6 }}>
          Repaint
        </div>
        <Segmented
          size="sm"
          fill
          value={form.inpaintArea}
          onChange={(v) => setForm({ inpaintArea: v })}
          options={[
            { value: 'masked', label: 'Just that area', title: 'The engine sees only the area and a margin, enlarged, so small areas get full detail' },
            { value: 'whole', label: 'Whole picture', title: 'The engine sees the whole picture and only the painted part of its result is used' }
          ]}
        />
        <div className="faint xs" style={{ marginTop: 6 }}>
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
 * The big view while a picture is being edited. Paint the part to change right on it (nothing painted redoes the whole
 * picture), describe the change under it and press Generate: the result appears here, in place, with a switch to the
 * picture it came from. "Keep" makes a result the picture to carry on from.
 */
export function EditStage({ base }: { base: ImageRecord }) {
  const hub = useHub()
  const { form } = hub
  const setForm = useImages((s) => s.setForm)
  const setFocus = useImages((s) => s.setFocus)
  const setMaskFlush = useImages((s) => s.setMaskFlush)
  const cancel = useImages((s) => s.cancel)
  const setEditJob = useImages((s) => s.setEditJob)
  const records = useImages((s) => s.records)
  const jobs = useImages((s) => s.jobs)
  const editJobId = useImages((s) => s.editJobId)

  const painter = useRef<PainterApi>(null)
  const { width: W, height: H } = useMemo(() => fitWithin(base.width, base.height, 2048), [base.width, base.height])
  const range = useMemo(() => brushRange(Math.max(W, H)), [W, H])
  const [tool, setTool] = useState<Tool>('brush')
  const [size, setSize] = useState(range.start)
  const [pstate, setPstate] = useState<PainterState>({ canUndo: false, canRedo: false, coverage: form.mask?.coverage ?? 0 })

  // The pictures made from this one, newest first, and which of them (or the original) is on show.
  const job = editJobId ? jobs[editJobId] : undefined
  const running = job?.status === 'queued' || job?.status === 'running'
  const failed = job?.status === 'error'
  const results = useMemo(() => (job?.status === 'done' ? [...job.resultIds].reverse().map((id) => records.find((r) => r.id === id)).filter((r): r is ImageRecord => !!r) : []), [job, records])
  const [shown, setShown] = useState<'before' | number>('before')
  const resultKey = results.map((r) => r.id).join(',')
  // Show the newest picture when a job finishes, and the original when a new one starts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the job id and the list of pictures are what matter
  useEffect(() => setShown(results.length ? 0 : 'before'), [job?.id, resultKey])
  const shownRec = shown !== 'before' && results[shown] ? results[shown] : base
  const viewingResult = shownRec !== base

  // A different picture starts with nothing painted (the canvas is new, so it has nothing to report).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new picture resets this
  useEffect(() => setPstate({ canUndo: false, canRedo: false, coverage: useImages.getState().form.mask?.coverage ?? 0 }), [base.id])

  // Saving the mask happens a moment after each stroke; Generate asks for it right away.
  useEffect(() => {
    setMaskFlush(() => painter.current?.save() ?? Promise.resolve())
    return () => setMaskFlush(null)
  }, [setMaskFlush])

  const generate = async () => {
    if (hub.blocked || running) return
    setShown('before')
    await hub.submit()
  }
  const generateRef = useRef(generate)
  generateRef.current = generate

  const exit = () => {
    setFocus(viewingResult ? shownRec.id : (results[0]?.id ?? base.id))
    setEditJob(null)
    setForm({ startMode: 'text' })
  }
  const keep = () => {
    if (viewingResult) setForm({ initImageId: shownRec.id, mask: undefined })
  }

  // Keyboard: tools and brush size, undo and redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range') || t.isContentEditable)) return
      if (document.querySelector('.lightbox, .modal-backdrop')) return
      const k = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
        e.preventDefault()
        if (k === 'y' || e.shiftKey) painter.current?.redo()
        else painter.current?.undo()
      } else if (e.ctrlKey || e.metaKey || e.altKey) {
        return
      } else if (k === '[') setSize((s) => Math.max(range.min, Math.round(s * 0.8)))
      else if (k === ']') setSize((s) => Math.min(range.max, Math.round(s * 1.25) + 1))
      else {
        const hit = TOOLS.find((x) => x.key.toLowerCase() === k)
        if (hit) setTool(hit.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [range.min, range.max])

  const painted = pstate.coverage >= 0.0005
  const canPaint = hub.maskOk
  const regenerate = !!job

  return (
    <div className="stage edit-stage">
      <div className="stage-canvas edit-canvas">
        <div className="edit-toolbar" role="toolbar" aria-label="Painting tools">
          <div className="me-group">
            {TOOLS.map((t) => (
              <IconButton key={t.id} label={`${t.label} (${t.key})`} size="sm" active={tool === t.id} onClick={() => setTool(t.id)}>
                <t.icon size={16} />
              </IconButton>
            ))}
          </div>
          {(tool === 'brush' || tool === 'eraser') && (
            <div className="edit-size" title="Brush size ( [ and ] )">
              <Slider value={size} min={range.min} max={range.max} onChange={setSize} format={(v) => `${v}px`} />
            </div>
          )}
          <span className="edit-sep" />
          <div className="me-group">
            <IconButton label="Undo (Ctrl+Z)" size="sm" disabled={!pstate.canUndo} onClick={() => painter.current?.undo()}>
              <Undo2 size={16} />
            </IconButton>
            <IconButton label="Redo (Ctrl+Shift+Z)" size="sm" disabled={!pstate.canRedo} onClick={() => painter.current?.redo()}>
              <Redo2 size={16} />
            </IconButton>
            <IconButton label="Swap painted and unpainted" size="sm" onClick={() => painter.current?.invert()}>
              <Contrast size={16} />
            </IconButton>
            <IconButton label="Clear all paint" size="sm" disabled={!painted} onClick={() => painter.current?.clear()}>
              <Trash2 size={16} />
            </IconButton>
            <IconButton label="Fit the picture in the view" size="sm" onClick={() => painter.current?.fit()}>
              <Maximize2 size={16} />
            </IconButton>
          </div>
          <span className="edit-sep" />
          <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={exit} title="Stop editing and go back to the pictures">
            Done
          </Button>
        </div>

        <div className="paint-wrap">
          <MaskPainter
            key={base.id}
            ref={painter}
            width={W}
            height={H}
            src={mediaUrl('image', shownRec.file)}
            showMask={!viewingResult}
            tool={tool}
            size={size}
            paused={running || !canPaint}
            initial={form.mask?.png}
            onState={setPstate}
            onSave={(m) => {
              // A save that finishes after the picture was swapped belongs to the old one.
              if (useImages.getState().form.initImageId === base.id) setForm({ mask: m ?? undefined })
            }}
            onPaint={() => setShown('before')}
          />

          {running && job && (
            <div className="edit-progress" role="status">
              <ImageProgress queued={job.status === 'queued'} upscale={!!job.request.upscale} stage={job.stage} label={job.label ?? 'Generating…'} progress={job.progress} />
              <IconButton label="Cancel" size="sm" onClick={() => cancel(job.id)}>
                <X size={14} />
              </IconButton>
            </div>
          )}

          {!running && results.length > 0 && (
            <div className="edit-compare" role="group" aria-label="Show">
              <button type="button" className={cx('edit-chip', shown === 'before' && 'on')} onClick={() => setShown('before')}>
                Before
              </button>
              {results.map((r, i) => (
                <button key={r.id} type="button" className={cx('edit-chip', shown === i && 'on')} onClick={() => setShown(i)}>
                  {results.length === 1 ? 'After' : `Result ${results.length - i}`}
                </button>
              ))}
              {viewingResult && (
                <>
                  <span className="edit-sep" />
                  <button type="button" className="edit-chip keep" onClick={keep} title="Make this the picture to edit next. Your paint is cleared so you can mark another part.">
                    <Check size={13} /> Keep and continue
                  </button>
                </>
              )}
            </div>
          )}

          {!running && results.length === 0 && !painted && canPaint && (
            <div className="edit-hint">
              <Brush size={14} />
              Paint the part you want to change. Leave it unpainted to redo the whole picture.
            </div>
          )}
        </div>
      </div>

      <div className="stage-info edit-bar">
        {!canPaint && hub.imageOk && (
          <Notice tone="warn">This model cannot repaint just part of a picture, so the whole picture will be redone. Built-in and AUTOMATIC1111 models can use paint.</Notice>
        )}
        {failed && job && (
          <Notice tone="danger" action={<Button size="sm" variant="ghost" onClick={() => setEditJob(null)}>Dismiss</Button>}>
            {job.error ?? 'Generation failed.'}
          </Notice>
        )}
        <PromptBox rows={2} placeholder={painted ? 'Describe what the painted part should become…' : 'Describe the change, or what the whole picture should become…'} onSubmit={() => void generateRef.current()} />
        <div className="edit-row">
          <div className="edit-strength">
            <div className="small dim edit-strength-label" title={strengthLabel(form.strength)}>
              {painted ? 'Change inside the paint' : 'How far to move away'}
              {hub.stepsDefault ? <span className="faint"> · {stepsRun(form.steps ?? hub.stepsDefault, form.strength)} of {form.steps ?? hub.stepsDefault} steps</span> : null}
            </div>
            <Slider value={form.strength} min={0.05} max={1} step={0.05} onChange={(v) => setForm({ strength: v })} format={(v) => v.toFixed(2)} />
          </div>
          {painted && canPaint && (
            <Popover
              placement="top"
              width={320}
              trigger={({ toggle, ref }) => (
                <Button ref={ref as never} size="sm" icon={<SlidersHorizontal size={14} />} onClick={toggle} title="Soft edge, margin and how much of the picture the engine sees">
                  Paint options
                </Button>
              )}
            >
              {() => <MaskOptions />}
            </Popover>
          )}
          <span className="grow" />
          <div title="How many to make at once">
            <Segmented size="sm" value={String(form.count)} onChange={(v) => setForm({ count: Number(v) })} options={['1', '2', '4'].map((n) => ({ value: n, label: n }))} />
          </div>
          <Button variant="primary" icon={<ImagePlus size={16} />} busy={running} disabled={!!hub.blocked || running} onClick={() => void generate()} title={regenerate ? 'Make it again from the original picture and the same paint' : undefined}>
            {regenerate ? 'Regenerate' : 'Generate'}
          </Button>
        </div>
        <div className="faint xs edit-foot">{hub.blocked ?? (painted ? 'Only the painted part changes; the rest stays exactly as it is. Ctrl+Enter to generate.' : 'Nothing painted, so the whole picture will be redone from this one. Ctrl+Enter to generate.')}</div>
      </div>
    </div>
  )
}
