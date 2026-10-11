import { Plus, Star, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ImageProgress } from '@/components/ImageProgress'
import { type GridItem, JustifiedGrid } from '@/components/JustifiedGrid'
import { Logo } from '@/components/Logo'
import { Button, Segmented } from '@/components/ui'
import { mediaUrl } from '@/lib/api'
import { cx } from '@/lib/format'
import { useImages } from '@/store/images'
import type { ImageJob, ImageRecord } from '@shared/types'
import { useNav } from '../store/nav'

function JobTile({ job }: { job: ImageJob }) {
  const cancel = useImages((s) => s.cancel)
  const dismiss = useImages((s) => s.dismissJob)
  const generate = useImages((s) => s.generate)
  const failed = job.status === 'error'
  return (
    <div className={cx('tile job', failed && 'failed')}>
      {!failed && <div className="gen-shimmer" />}
      <div className="job-body">
        {failed ? (
          <>
            <div className="small job-err">{job.error ?? 'Generation failed.'}</div>
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
            <div className="job-prompt small dim">{job.request.prompt}</div>
            <div className="job-foot">
              <ImageProgress compact queued={job.status === 'queued'} upscale={!!job.request.upscale} upscaleOnly={!!job.request.upscaleOf} stage={job.stage} label={job.label ?? 'Generating…'} progress={job.progress} />
            </div>
            <button type="button" className="job-x" aria-label="Cancel" onClick={() => cancel(job.id)}>
              <X size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function Tile({ rec, ids }: { rec: ImageRecord; ids: string[] }) {
  const view = useNav((s) => s.view)
  return (
    <button type="button" className="tile" onClick={() => view(rec.id, ids)} aria-label={`Open: ${rec.prompt}`}>
      <img src={mediaUrl('thumb', rec.thumb)} alt={rec.prompt} loading="lazy" draggable={false} />
      {rec.favorite && (
        <span className="tile-star" aria-label="Favorite">
          <Star size={12} fill="currentColor" />
        </span>
      )}
    </button>
  )
}

export function PicturesScreen() {
  const records = useImages((s) => s.records)
  const jobs = useImages((s) => s.jobs)
  const dismissed = useImages((s) => s.dismissed)
  const open = useNav((s) => s.open)
  const [filter, setFilter] = useState<'all' | 'favorites'>('all')

  const shown = useMemo(() => records.filter((r) => (filter === 'favorites' ? r.favorite : true)), [records, filter])
  const ids = useMemo(() => shown.map((r) => r.id), [shown])
  const live = Object.values(jobs)
    .filter((j) => (j.status === 'queued' || j.status === 'running' || j.status === 'error') && !dismissed[j.id] && j.request.source === 'hub')
    .sort((a, b) => b.createdAt - a.createdAt)

  const items: GridItem[] = [
    ...live.map((j) => ({ key: `job:${j.id}`, aspect: j.request.width && j.request.height ? j.request.width / j.request.height : 1, render: () => <JobTile job={j} /> })),
    ...shown.map((r) => ({ key: r.id, aspect: r.width / r.height, render: () => <Tile rec={r} ids={ids} /> }))
  ]
  const none = records.length === 0 && live.length === 0

  return (
    <section className="pictures" aria-label="Pictures">
      <header className="top">
        <div className="top-titles">
          <h1>Pictures</h1>
          <p className="faint xs">{records.length === 0 ? 'Everything you make lands here.' : `${records.length} picture${records.length === 1 ? '' : 's'} on your computer`}</p>
        </div>
        <button type="button" className="top-btn accent" onClick={() => open('create')}>
          <Plus size={18} />
          <span>Create</span>
        </button>
      </header>
      {!none && (
        <div className="filter">
          <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'favorites', label: 'Favorites' }]} />
        </div>
      )}
      <div className="scroll">
        {none ? (
          <div className="blank">
            <Logo size={40} />
            <h2>No pictures yet</h2>
            <p className="dim">Describe something and your computer paints it. It shows up here, and on the computer too.</p>
            <button type="button" className="btn btn-primary" onClick={() => open('create')}>
              Make a picture
            </button>
          </div>
        ) : items.length ? (
          <JustifiedGrid items={items} target={150} gap={4} />
        ) : (
          <div className="blank">
            <h2>Nothing starred yet</h2>
            <p className="dim">Open a picture and tap the star to keep it here.</p>
          </div>
        )}
      </div>
    </section>
  )
}
