import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { type CSSProperties, useCallback, useEffect } from 'react'
import { mediaUrl } from '@/lib/api'
import { formatDuration } from '@/lib/format'
import { useImages } from '@/store/images'
import { usePanel } from '@/store/layout'
import { Resizer } from './Resizer'
import { ImageActions } from './ImageActions'
import { IconButton } from './ui'

function Meta({ label, value }: { label: string; value: string | number | undefined }) {
  if (value === undefined || value === '') return null
  return (
    <div className="meta-item">
      <span className="meta-k">{label}</span>
      <span className="meta-v mono selectable">{value}</span>
    </div>
  )
}

export function Lightbox() {
  const viewing = useImages((s) => s.viewing)
  const siblings = useImages((s) => s.siblings)
  const rec = useImages((s) => s.records.find((r) => r.id === s.viewing))
  const view = useImages((s) => s.view)
  const { width: sideWidth } = usePanel('lightbox')

  const idx = viewing ? siblings.indexOf(viewing) : -1
  const go = useCallback(
    (d: number) => {
      const next = siblings[idx + d]
      if (next) view(next, siblings)
    },
    [idx, siblings, view]
  )

  useEffect(() => {
    if (!viewing) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      if (e.key === 'Escape') view(null)
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewing, go, view])

  if (!viewing || !rec) return null

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Image viewer" style={{ '--lb-w': `${sideWidth}px` } as CSSProperties}>
      <div className="lb-backdrop" onMouseDown={() => view(null)} />
      <div className="lb-stage" onMouseDown={(e) => e.target === e.currentTarget && view(null)}>
        <img key={rec.id} className="lb-img" src={mediaUrl('image', rec.file)} alt={rec.prompt} draggable={false} />
        {idx > 0 && (
          <button type="button" className="lb-nav prev" aria-label="Previous image" onClick={() => go(-1)}>
            <ChevronLeft size={26} />
          </button>
        )}
        {idx >= 0 && idx < siblings.length - 1 && (
          <button type="button" className="lb-nav next" aria-label="Next image" onClick={() => go(1)}>
            <ChevronRight size={26} />
          </button>
        )}
      </div>
      <aside className="lb-side">
        <Resizer panel="lightbox" side="left" />
        <div className="lb-side-head">
          <span className="faint small">{siblings.length > 1 ? `${idx + 1} of ${siblings.length}` : new Date(rec.createdAt).toLocaleString()}</span>
          <IconButton label="Close" onClick={() => view(null)}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="lb-scroll">
          <div className="lb-label">Prompt</div>
          <p className="lb-prompt selectable">{rec.prompt}</p>
          {rec.negativePrompt && (
            <>
              <div className="lb-label">Avoided</div>
              <p className="lb-neg selectable">{rec.negativePrompt}</p>
            </>
          )}
          <div className="meta-grid">
            <Meta label="Model" value={rec.model} />
            <Meta label="Engine" value={rec.backendName} />
            <Meta label="Size" value={`${rec.width} × ${rec.height}`} />
            <Meta label="Steps" value={rec.steps} />
            <Meta label="Guidance" value={rec.cfgScale} />
            <Meta label="Sampler" value={rec.sampler} />
            <Meta label="Seed" value={rec.seed} />
            {rec.loras?.length ? <Meta label="LoRAs" value={rec.loras.map((l) => `${l.id} (${l.strength})`).join(', ')} /> : null}
            <Meta label="Upscaled with" value={rec.upscaler} />
            <Meta label="Took" value={rec.durationMs ? formatDuration(rec.durationMs) : undefined} />
            <Meta label="Made" value={new Date(rec.createdAt).toLocaleString()} />
          </div>
        </div>
        <ImageActions rec={rec} layout="panel" />
      </aside>
    </div>
  )
}
