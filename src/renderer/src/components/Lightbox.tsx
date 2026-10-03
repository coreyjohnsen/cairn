import { ChevronLeft, ChevronRight, Copy, Download, FolderOpen, MessageSquarePlus, RefreshCw, Star, Trash2, Wand2, X, ZoomIn } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { invoke, mediaUrl } from '@/lib/api'
import { errorText, formatDuration } from '@/lib/format'
import { useApp } from '@/store/app'
import { useComposerBus } from '@/store/composer'
import { useImages } from '@/store/images'
import { Button, IconButton, MenuItem, MenuLabel, Popover } from './ui'

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
  const favorite = useImages((s) => s.favorite)
  const remove = useImages((s) => s.remove)
  const reuse = useImages((s) => s.reuse)
  const generate = useImages((s) => s.generate)
  const upscalers = useImages((s) => s.upscalers)
  const refreshAssets = useImages((s) => s.refreshAssets)
  const builtinReady = useImages((s) => s.targets.some((t) => t.supportsLora && t.available))
  const canUpscale = builtinReady || upscalers.some((u) => u.engine === 'esrgan')
  const toast = useApp((s) => s.toast)
  const setView = useApp((s) => s.setView)
  const push = useComposerBus((s) => s.push)
  const [confirm, setConfirm] = useState(false)

  const idx = viewing ? siblings.indexOf(viewing) : -1
  const go = useCallback(
    (d: number) => {
      const next = siblings[idx + d]
      if (next) view(next, siblings)
    },
    [idx, siblings, view]
  )

  useEffect(() => setConfirm(false), [viewing])

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

  const run = (p: Promise<unknown>, ok?: string) => p.then(() => ok && toast('ok', ok)).catch((e) => toast('error', errorText(e)))

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Image viewer">
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
        <div className="lb-actions">
          <div className="row">
            <Button className="grow" variant="primary" icon={<RefreshCw size={15} />} onClick={() => reuse(rec)}>
              Reuse settings
            </Button>
            <IconButton label={rec.favorite ? 'Unfavorite' : 'Favorite'} active={rec.favorite} onClick={() => favorite(rec.id, !rec.favorite)}>
              <Star size={17} fill={rec.favorite ? 'currentColor' : 'none'} />
            </IconButton>
          </div>
          <div className="lb-grid">
            <Button size="sm" icon={<Wand2 size={14} />} onClick={() => reuse(rec, { asInit: true })}>
              Start from this
            </Button>
            <Popover
              placement="top"
              width={260}
              trigger={({ toggle, ref }) => (
                <Button
                  ref={ref as never}
                  size="sm"
                  icon={<ZoomIn size={14} />}
                  disabled={!canUpscale}
                  title={canUpscale ? 'Make this picture bigger with an upscaler model' : 'Install the upscaler under Models, Image models, Upscalers to make pictures bigger'}
                  onClick={() => {
                    void refreshAssets()
                    toggle()
                  }}
                >
                  Upscale
                </Button>
              )}
            >
              {(close) => (
                <div>
                  <MenuLabel>Upscale with</MenuLabel>
                  {upscalers.length === 0 && <div className="small faint" style={{ padding: '6px 12px 10px' }}>No upscalers yet. Install one under Models, Image models, Upscalers.</div>}
                  {upscalers.filter((u) => builtinReady || u.engine === 'esrgan').map((u) => (
                    <MenuItem
                      key={u.path}
                      hint={`${u.scale}×${u.style === 'anime' ? ' · anime' : ''}`}
                      onClick={() => {
                        close()
                        void generate({ prompt: rec.prompt, width: rec.width, height: rec.height, seed: rec.seed, count: 1, target: { backendId: rec.backendId, model: rec.model }, upscaleOf: rec.id, upscale: { path: u.path, repeats: 1 } }).then((id) => id && toast('ok', 'Upscaling started. The result appears in the gallery.'))
                      }}
                    >
                      {u.name}
                    </MenuItem>
                  ))}
                </div>
              )}
            </Popover>
            <Button
              size="sm"
              icon={<MessageSquarePlus size={14} />}
              onClick={() =>
                void invoke('images:toAttachment', rec.id)
                  .then((a) => {
                    if (!a) return toast('error', 'That image file is missing.')
                    view(null)
                    setView('chat')
                    push({ files: [a], mode: 'chat' })
                  })
                  .catch((e) => toast('error', errorText(e)))
              }
            >
              Use in chat
            </Button>
            <Button size="sm" icon={<Copy size={14} />} onClick={() => run(navigator.clipboard.writeText(rec.prompt), 'Prompt copied')}>
              Copy prompt
            </Button>
            <Button size="sm" icon={<Download size={14} />} onClick={() => run(invoke('images:saveAs', rec.id).then((p) => p && toast('ok', `Saved to ${p}`)))}>
              Save as…
            </Button>
            <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => run(invoke('images:reveal', rec.id))}>
              Show in folder
            </Button>
            {confirm ? (
              <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => void remove([rec.id])}>
                Really delete?
              </Button>
            ) : (
              <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setConfirm(true)}>
                Delete
              </Button>
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}
