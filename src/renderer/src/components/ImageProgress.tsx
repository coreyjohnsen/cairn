import { useEffect, useRef, useState } from 'react'
import type { ImageStage } from '@shared/types'
import { cx } from '@/lib/format'
import { Progress } from './ui'

const TRAIL: { id: ImageStage; label: string }[] = [
  { id: 'loading', label: 'Load' },
  { id: 'encoding', label: 'Prompt' },
  { id: 'sampling', label: 'Draw' },
  { id: 'decoding', label: 'Decode' }
]
const UPSCALE_STEP = { id: 'upscaling' as ImageStage, label: 'Upscale' }

/** What is going on during the parts that give no step count, and why they can take a while. */
const HINT: Partial<Record<ImageStage, string>> = {
  loading: 'Reading the model into video memory. This is the slow part of the first image after the engine starts.',
  encoding: 'Turning your prompt into something the model understands.',
  decoding: 'Turning the finished result into pixels. There is no step counter for this part, and larger sizes take longer.',
  upscaling: 'Making the picture bigger. There is no step counter for this part, and it takes longer the bigger the picture is.'
}

/** Seconds since `key` last changed; ticks once a second. */
function useElapsed(key: string | undefined, active: boolean): number {
  const since = useRef(Date.now())
  const last = useRef(key)
  const [, tick] = useState(0)
  if (last.current !== key) {
    last.current = key
    since.current = Date.now()
  }
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [active])
  return Math.floor((Date.now() - since.current) / 1000)
}

const clock = (s: number): string => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`)

interface Props {
  stage?: ImageStage
  label?: string
  /** 0 to 1; only drawn as a bar while the engine is counting steps. */
  progress?: number
  queued?: boolean
  /** The job makes the picture bigger at the end, so the trail gets one more step. */
  upscale?: boolean
  /** An existing picture is being made bigger; nothing is drawn. */
  upscaleOnly?: boolean
  /** The small version used inside a chat reply. */
  compact?: boolean
}

/**
 * Says which part of making an image is happening. Only the drawing part has a step count, so the
 * other parts get a moving bar and a running clock instead of a number that would seem stuck.
 */
export function ImageProgress({ stage, label, progress, queued, compact, upscale, upscaleOnly }: Props) {
  const trail = upscaleOnly ? [UPSCALE_STEP] : upscale || stage === 'upscaling' ? [...TRAIL, UPSCALE_STEP] : TRAIL
  const idx = stage ? (stage === 'saving' ? trail.length : trail.findIndex((t) => t.id === stage)) : -1
  const counting = !queued && (stage === undefined || stage === 'sampling') && (progress ?? 0) > 0
  const elapsed = useElapsed(stage, !queued && !!stage && stage !== 'sampling')
  const showClock = !queued && !!stage && stage !== 'sampling' && elapsed >= 3
  const hint = !queued && stage ? HINT[stage] : undefined
  const text = queued ? 'Waiting in queue' : (label ?? 'Working…')

  return (
    <div className={cx('imgprog', compact && 'compact')} data-stage={stage ?? ''}>
      {!queued && stage && (
        <ol className="imgprog-trail" aria-label="Progress">
          {trail.map((t, i) => (
            <li key={t.id} className={cx(i < idx && 'done', i === idx && 'now')} aria-current={i === idx ? 'step' : undefined}>
              <span className="imgprog-dot" />
              <span className="imgprog-name">{t.label}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="imgprog-line">
        <span className={cx('imgprog-label', compact ? 'small dim' : 'xs faint')}>{text}</span>
        {showClock && <span className="imgprog-clock mono xs faint">{clock(elapsed)}</span>}
      </div>
      <Progress value={progress} indeterminate={!counting} height={4} />
      {hint && !compact && elapsed >= 4 && <div className="imgprog-hint xs faint">{hint}</div>}
    </div>
  )
}
