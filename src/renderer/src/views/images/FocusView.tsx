import { ChevronLeft, ChevronRight, MountainSnow, Star, X } from 'lucide-react'
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ImageActions } from '@/components/ImageActions'
import { ImageProgress } from '@/components/ImageProgress'
import { Resizer } from '@/components/Resizer'
import { Button, IconButton, Spinner } from '@/components/ui'
import { mediaUrl } from '@/lib/api'
import { containBox } from '@/lib/fit'
import { cx, formatDuration } from '@/lib/format'
import { useImages } from '@/store/images'
import { usePanel } from '@/store/layout'
import type { ImageJob, ImageRecord } from '@shared/types'

type FocusItem = { kind: 'record'; rec: ImageRecord } | { kind: 'job'; job: ImageJob }

const jobKey = (id: string) => `job:${id}`

/**
 * What the big view should show: the thing the person picked, or failing that the newest. A job that has finished
 * turns into its first picture by itself, so starting a picture ends with it filling the stage.
 */
export function resolveFocus(focus: string | null, records: ImageRecord[], jobs: Record<string, ImageJob>, fallbackKey: string | undefined): FocusItem | null {
  const tryKey = (key: string | null | undefined): FocusItem | null => {
    if (!key) return null
    if (key.startsWith('job:')) {
      const job = jobs[key.slice(4)]
      if (!job || job.status === 'cancelled') return null
      if (job.status === 'done') {
        // The newest picture of a batch sits first in the history, so that is the one to land on.
        const rec = [...job.resultIds].reverse().map((id) => records.find((r) => r.id === id)).find(Boolean)
        // The job report can arrive a moment before the picture itself.
        return rec ? { kind: 'record', rec } : { kind: 'job', job }
      }
      return { kind: 'job', job }
    }
    const rec = records.find((r) => r.id === key)
    return rec ? { kind: 'record', rec } : null
  }
  return tryKey(focus) ?? tryKey(fallbackKey)
}

/** Size of an element, kept up to date as the window or a divider moves. */
function useBox(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [box, setBox] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return box
}

const PAD = 28

function JobStage({ job }: { job: ImageJob }) {
  const cancel = useImages((s) => s.cancel)
  const dismiss = useImages((s) => s.dismissJob)
  const generate = useImages((s) => s.generate)
  const canvas = useRef<HTMLDivElement>(null)
  const box = useBox(canvas)
  const { width: rw, height: rh } = job.request
  const fit = containBox(rw && rh ? rw / rh : 1, box.w - PAD * 2, box.h - PAD * 2)
  const failed = job.status === 'error'
  const queued = job.status === 'queued'
  const count = job.request.count ?? 1

  return (
    <div className="stage">
      <div ref={canvas} className="stage-canvas">
        <div className={cx('stage-job', failed && 'failed')} style={{ width: fit.width || undefined, height: fit.height || undefined }}>
          {!failed && <div className="gen-shimmer" />}
          {!failed && <MountainSnow className="stage-job-icon" size={56} strokeWidth={1.2} aria-hidden />}
          <div className="stage-job-body">
            {failed ? (
              <>
                <div className="small selectable job-err">{job.error ?? 'Generation failed.'}</div>
                <div className="row">
                  <Button
                    size="sm"
                    onClick={() => {
                      const { source: _s, ...rest } = job.request
                      void generate(rest)
                      dismiss(job.id)
                    }}
                  >
                    Retry
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => dismiss(job.id)}>
                    Dismiss
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="stage-job-prompt dim">{job.request.prompt}</div>
                <ImageProgress queued={queued} upscale={!!job.request.upscale} upscaleOnly={!!job.request.upscaleOf} stage={job.stage} label={job.label ?? 'Generating…'} progress={job.progress} />
                <IconButton label="Cancel" size="sm" className="job-x" onClick={() => cancel(job.id)}>
                  <X size={14} />
                </IconButton>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="stage-info">
        <p className="stage-prompt selectable">{job.request.prompt}</p>
        <div className="stage-chips">
          <span className="chip">{queued ? 'Waiting in the queue' : failed ? 'Did not finish' : 'Making it now'}</span>
          {count > 1 && <span className="chip">{count} pictures</span>}
          {rw > 0 && rh > 0 && (
            <span className="chip">
              {rw} × {rh}
            </span>
          )}
          {job.request.initImageId && <span className="chip">{job.request.inpaint ? 'repainting part of a picture' : 'from a picture'}</span>}
        </div>
      </div>
    </div>
  )
}

function RecordStage({ rec, ids, onStep, onGone }: { rec: ImageRecord; ids: string[]; onStep: (d: number) => void; onGone: () => void }) {
  const view = useImages((s) => s.view)
  const idx = ids.indexOf(rec.id)
  const chips = [
    rec.model,
    `${rec.width} × ${rec.height}`,
    rec.steps ? `${rec.steps} steps` : '',
    rec.cfgScale !== undefined ? `guidance ${rec.cfgScale}` : '',
    rec.sampler ?? '',
    rec.imported ? '' : `seed ${rec.seed}`,
    rec.durationMs ? formatDuration(rec.durationMs) : '',
    rec.upscaler ? `upscaled · ${rec.upscaler}` : '',
    rec.initImageId ? 'from a picture' : '',
    rec.source === 'chat' ? 'from a chat' : '',
    rec.imported ? 'imported' : ''
  ].filter(Boolean)

  return (
    <div className="stage">
      <div className="stage-canvas">
        <img key={rec.id} className="stage-img" src={mediaUrl('image', rec.file)} alt={rec.prompt} draggable={false} onClick={() => view(rec.id, ids)} />
        {idx > 0 && (
          <button type="button" className="stage-nav prev" aria-label="Newer picture" onClick={() => onStep(-1)}>
            <ChevronLeft size={22} />
          </button>
        )}
        {idx >= 0 && idx < ids.length - 1 && (
          <button type="button" className="stage-nav next" aria-label="Older picture" onClick={() => onStep(1)}>
            <ChevronRight size={22} />
          </button>
        )}
      </div>
      <div className="stage-info">
        <p className="stage-prompt selectable" title={rec.prompt}>
          {rec.prompt}
        </p>
        <div className="stage-chips">
          {chips.map((c) => (
            <span key={c} className="chip">
              {c}
            </span>
          ))}
        </div>
        <ImageActions rec={rec} layout="bar" onOpen={() => view(rec.id, ids)} onGone={onGone} />
      </div>
    </div>
  )
}

function HistoryRail({ order, jobs, records, current, onPick }: { order: string[]; jobs: Record<string, ImageJob>; records: Record<string, ImageRecord>; current: string | undefined; onPick: (key: string) => void }) {
  const favorite = useImages((s) => s.favorite)
  const scroller = useRef<HTMLDivElement>(null)

  // Keep the picture being shown in view when arrow keys or a new picture move it.
  useEffect(() => {
    scroller.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [current])

  return (
    <aside className="history" aria-label="Previous pictures">
      <Resizer panel="history" side="left" />
      <div className="history-head">
        <span>History</span>
        <span className="faint xs">{order.filter((k) => !k.startsWith('job:')).length}</span>
      </div>
      <div ref={scroller} className="history-scroll">
        <div className="history-grid">
          {order.map((key) => {
            if (key.startsWith('job:')) {
              const job = jobs[key.slice(4)]
              if (!job) return null
              const failed = job.status === 'error'
              return (
                <button key={key} type="button" className={cx('hist hist-job', failed && 'failed')} aria-current={current === key} title={job.request.prompt} onClick={() => onPick(key)}>
                  {!failed && <span className="gen-shimmer" />}
                  <span className="hist-state">{failed ? 'Failed' : job.status === 'queued' ? 'Queued' : job.progress > 0 && job.progress < 1 ? `${Math.round(job.progress * 100)}%` : <Spinner size={14} />}</span>
                </button>
              )
            }
            const rec = records[key]
            if (!rec) return null
            return (
              <button key={key} type="button" className="hist" aria-current={current === key} title={rec.prompt} onClick={() => onPick(key)}>
                <img src={mediaUrl('thumb', rec.thumb)} alt={rec.prompt} loading="lazy" draggable={false} />
                {rec.favorite && (
                  <span
                    className="hist-fav"
                    role="img"
                    aria-label="Favorite"
                    onClick={(e) => {
                      e.stopPropagation()
                      favorite(rec.id, false)
                    }}
                  >
                    <Star size={11} fill="currentColor" />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </aside>
  )
}

/** The Image Hub's focus mode: the picture being made or looked at fills the stage, the earlier ones wait in a side list. */
export function FocusView({ liveJobs, shown }: { liveJobs: ImageJob[]; shown: ImageRecord[] }) {
  const focus = useImages((s) => s.focus)
  const setFocus = useImages((s) => s.setFocus)
  const records = useImages((s) => s.records)
  const jobs = useImages((s) => s.jobs)
  const { width } = usePanel('history')

  const ids = shown.map((r) => r.id)
  const order = [...liveJobs.map((j) => jobKey(j.id)), ...ids]
  const item = resolveFocus(focus, records, jobs, order[0])
  const currentKey = item ? (item.kind === 'job' ? jobKey(item.job.id) : item.rec.id) : undefined

  const byId = Object.fromEntries(records.map((r) => [r.id, r]))
  const move = (d: number) => {
    const i = currentKey ? order.indexOf(currentKey) : -1
    const next = order[Math.max(0, Math.min(order.length - 1, i + d))]
    if (next) setFocus(next)
  }
  // Deleting moves on to the neighbour instead of jumping to the newest.
  const onGone = () => {
    const i = currentKey ? order.indexOf(currentKey) : -1
    const next = order[i + 1] ?? order[i - 1]
    setFocus(next ?? null)
  }

  const latest = useRef({ move, item })
  latest.current = { move, item }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (document.querySelector('.lightbox, .mask-editor, .modal-backdrop')) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        latest.current.move(-1)
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        latest.current.move(1)
      } else if (e.key === 'Enter' && latest.current.item?.kind === 'record') {
        useImages.getState().view(latest.current.item.rec.id, ids)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="focus" style={{ ['--hist-w' as string]: `${width}px` }}>
      {item?.kind === 'job' && <JobStage key={item.job.id} job={item.job} />}
      {item?.kind === 'record' && <RecordStage rec={item.rec} ids={ids} onStep={move} onGone={onGone} />}
      {!item && <div className="stage stage-none faint">Nothing to show with this filter.</div>}
      <HistoryRail order={order} jobs={jobs} records={byId} current={currentKey} onPick={setFocus} />
    </div>
  )
}
