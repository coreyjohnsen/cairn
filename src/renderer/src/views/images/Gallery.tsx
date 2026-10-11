import { LayoutGrid, MountainSnow, PanelLeftOpen, PictureInPicture2, Search, Star, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { type GridItem, JustifiedGrid } from '@/components/JustifiedGrid'
import { ImageProgress } from '@/components/ImageProgress'
import { Ridgeline } from '@/components/Ridgeline'
import { Button, EmptyState, IconButton, Segmented } from '@/components/ui'
import { mediaUrl } from '@/lib/api'
import { cx } from '@/lib/format'
import { useApp } from '@/store/app'
import { useImages } from '@/store/images'
import { type HubMode, useLayout, usePanel } from '@/store/layout'
import type { ImageJob, ImageRecord } from '@shared/types'
import { FocusView } from './FocusView'

type Filter = 'all' | 'favorites' | 'chat'

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
            <div className="small selectable job-err">{job.error ?? 'Generation failed.'}</div>
            <div className="row">
              <Button size="sm" onClick={() => { const { source: _s, ...rest } = job.request; void generate(rest); dismiss(job.id) }}>Retry</Button>
              <Button size="sm" variant="ghost" onClick={() => dismiss(job.id)}>Dismiss</Button>
            </div>
          </>
        ) : (
          <>
            <div className="job-prompt small dim">{job.request.prompt}</div>
            <div className="job-foot">
              <ImageProgress queued={job.status === 'queued'} upscale={!!job.request.upscale} upscaleOnly={!!job.request.upscaleOf} stage={job.stage} label={job.label ?? 'Generating…'} progress={job.progress} />
            </div>
            <IconButton label="Cancel" size="sm" className="job-x" onClick={() => cancel(job.id)}>
              <X size={14} />
            </IconButton>
          </>
        )}
      </div>
    </div>
  )
}

function Tile({ rec, ids }: { rec: ImageRecord; ids: string[] }) {
  const view = useImages((s) => s.view)
  const favorite = useImages((s) => s.favorite)
  const remove = useImages((s) => s.remove)
  // Deleting is permanent, so the trash button asks for a second click.
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <div className="tile" onMouseLeave={() => setArmed(false)}>
      <button type="button" className="tile-img" onClick={() => view(rec.id, ids)} aria-label={`Open: ${rec.prompt}`}>
        <img src={mediaUrl('thumb', rec.thumb)} alt={rec.prompt} loading="lazy" draggable={false} />
      </button>
      <div className="tile-over">
        <span className="tile-prompt">{rec.prompt}</span>
      </div>
      <button
        type="button"
        className={cx('tile-del', armed && 'armed')}
        aria-label={armed ? 'Click again to delete this image' : 'Delete this image'}
        title={armed ? 'Click again to delete' : 'Delete'}
        onClick={() => (armed ? void remove([rec.id]) : setArmed(true))}
      >
        <Trash2 size={14} />
        {armed && <span>Delete?</span>}
      </button>
      <button type="button" className={cx('tile-fav', rec.favorite && 'on')} aria-label={rec.favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={() => favorite(rec.id, !rec.favorite)}>
        <Star size={15} fill={rec.favorite ? 'currentColor' : 'none'} />
      </button>
    </div>
  )
}

/** Image Hub right-hand side: every picture made, as one big focused picture with a history list, or as a grid. */
export function Gallery() {
  const records = useImages((s) => s.records)
  const jobs = useImages((s) => s.jobs)
  const dismissed = useImages((s) => s.dismissed)
  const hasTargets = useImages((s) => s.targets.some((t) => t.available))
  const setView = useApp((s) => s.setView)
  const mode = useLayout((s) => s.hubMode)
  const setMode = useLayout((s) => s.setHubMode)
  const toggle = useLayout((s) => s.toggle)
  const { collapsed: createFolded } = usePanel('create')
  // Searching and filtering are about browsing; while a picture is being edited the header keeps only the view switch.
  const editing = useImages((s) => s.form.startMode === 'edit' && !!s.form.initImageId && mode === 'focus')
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return records.filter((r) => (filter === 'favorites' ? r.favorite : filter === 'chat' ? r.source === 'chat' : true) && (!q || r.prompt.toLowerCase().includes(q) || r.model.toLowerCase().includes(q)))
  }, [records, filter, query])
  const ids = useMemo(() => shown.map((r) => r.id), [shown])
  const live = Object.values(jobs)
    .filter((j) => (j.status === 'queued' || j.status === 'running' || j.status === 'error') && !dismissed[j.id] && j.request.source === 'hub')
    .sort((a, b) => b.createdAt - a.createdAt)

  // Newest first, left to right, then down.
  const items: GridItem[] = [
    ...live.map((j) => ({ key: `job:${j.id}`, aspect: j.request.width && j.request.height ? j.request.width / j.request.height : 1, render: () => <JobTile job={j} /> })),
    ...shown.map((r) => ({ key: r.id, aspect: r.width / r.height, render: () => <Tile rec={r} ids={ids} /> }))
  ]

  const nothingYet = records.length === 0 && live.length === 0
  const nothingMatches = !nothingYet && shown.length === 0 && live.length === 0

  return (
    <section className="gallery-wrap">
      <div className="gallery-head">
        {createFolded && (
          <IconButton label="Show the create panel (Ctrl+B)" onClick={() => toggle('create')}>
            <PanelLeftOpen size={18} />
          </IconButton>
        )}
        <div className="gallery-title">
          <h1>Image Hub</h1>
          <p className="faint small">{records.length === 0 ? 'Everything you make lands here.' : `${records.length} image${records.length === 1 ? '' : 's'}`}</p>
        </div>
        <div className="grow" />
        <div className="row gallery-tools">
          {!editing && (
            <>
              <div className="conv-search gallery-search">
                <Search size={14} />
                <input placeholder="Search prompts" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
              </div>
              <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'favorites', label: 'Favorites' }, { value: 'chat', label: 'From chats' }]} />
            </>
          )}
          <Segmented
            size="sm"
            value={mode}
            onChange={(m: HubMode) => setMode(m)}
            options={[
              { value: 'focus', label: <><PictureInPicture2 size={14} /> Focus</>, title: 'One big picture with the earlier ones in a list beside it' },
              { value: 'grid', label: <><LayoutGrid size={14} /> Grid</>, title: 'All pictures at once' }
            ]}
          />
        </div>
      </div>
      <div className={cx('gallery-body', mode === 'grid' && 'gallery-scroll')}>
        {nothingYet ? (
          <div className="gallery-empty">
            <div className="chat-empty-ridge">
              <Ridgeline seed={23} layers={4} />
            </div>
            <EmptyState
              icon={<MountainSnow size={26} />}
              title="No pictures yet"
              action={!hasTargets ? <Button variant="primary" onClick={() => setView('models', 'image')}>Set up an image model</Button> : undefined}
            >
              {hasTargets ? 'Describe a scene on the left and press Generate. You can also ask for images in any chat.' : 'Add an image model first, then describe a scene and watch it appear here.'}
            </EmptyState>
          </div>
        ) : nothingMatches ? (
          <EmptyState icon={<Search size={24} />} title="Nothing matches">
            Try another word, or switch the filter.
          </EmptyState>
        ) : mode === 'grid' ? (
          <JustifiedGrid items={items} />
        ) : (
          <FocusView liveJobs={live} shown={shown} />
        )}
      </div>
    </section>
  )
}
