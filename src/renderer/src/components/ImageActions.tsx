import { Copy, Download, FolderOpen, Maximize2, MessageSquarePlus, MoreHorizontal, PaintBucket, RefreshCw, Star, Trash2, Wand2, ZoomIn } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ImageRecord, UpscalerFile } from '@shared/types'
import { invoke } from '@/lib/api'
import { errorText } from '@/lib/format'
import { useApp } from '@/store/app'
import { useComposerBus } from '@/store/composer'
import { useImages } from '@/store/images'
import { Button, IconButton, MenuItem, MenuLabel, MenuSeparator, Popover } from './ui'

/** Everything that can be done with a finished picture, shared by the full-screen viewer and the Image Hub's big view. */
function useActions(rec: ImageRecord, onGone?: () => void) {
  const toast = useApp((s) => s.toast)
  const setView = useApp((s) => s.setView)
  const push = useComposerBus((s) => s.push)
  const view = useImages((s) => s.view)
  const favorite = useImages((s) => s.favorite)
  const remove = useImages((s) => s.remove)
  const reuse = useImages((s) => s.reuse)
  const generate = useImages((s) => s.generate)
  const upscalers = useImages((s) => s.upscalers)
  const refreshAssets = useImages((s) => s.refreshAssets)
  const builtinReady = useImages((s) => s.targets.some((t) => t.supportsLora && t.available))
  const canUpscale = builtinReady || upscalers.some((u) => u.engine === 'esrgan')
  const run = (p: Promise<unknown>, ok?: string) => p.then(() => ok && toast('ok', ok)).catch((e) => toast('error', errorText(e)))

  return {
    canUpscale,
    builtinReady,
    upscalers,
    refreshAssets,
    reuse: () => reuse(rec),
    startFrom: () => reuse(rec, { asInit: true }),
    changePart: () => {
      reuse(rec, { asInit: true, mask: true })
      useImages.getState().openMaskEditor(true)
    },
    upscaleWith: (u: UpscalerFile) =>
      void generate({ prompt: rec.prompt, width: rec.width, height: rec.height, seed: rec.seed, count: 1, target: { backendId: rec.backendId, model: rec.model }, upscaleOf: rec.id, upscale: { path: u.path, repeats: 1 } }).then((id) => id && toast('ok', 'Upscaling started. The result appears in the gallery.')),
    useInChat: () =>
      void invoke('images:toAttachment', rec.id)
        .then((a) => {
          if (!a) return toast('error', 'That image file is missing.')
          view(null)
          setView('chat')
          push({ files: [a], mode: 'chat' })
        })
        .catch((e) => toast('error', errorText(e))),
    copyPrompt: () => run(navigator.clipboard.writeText(rec.prompt), 'Prompt copied'),
    saveAs: () => run(invoke('images:saveAs', rec.id).then((p) => p && toast('ok', `Saved to ${p}`))),
    reveal: () => run(invoke('images:reveal', rec.id)),
    toggleFavorite: () => favorite(rec.id, !rec.favorite),
    remove: () => {
      onGone?.()
      void remove([rec.id])
    }
  }
}

type Actions = ReturnType<typeof useActions>

function UpscaleMenu({ rec, a, size, placement }: { rec: ImageRecord; a: Actions; size: 'sm' | 'md'; placement: 'top' | 'bottom' }) {
  return (
    <Popover
      placement={placement}
      width={260}
      trigger={({ toggle, ref }) => (
        <Button
          ref={ref as never}
          size={size}
          icon={<ZoomIn size={14} />}
          disabled={!a.canUpscale}
          title={a.canUpscale ? 'Make this picture bigger with an upscaler model' : 'Install the upscaler under Models, Image models, Upscalers to make pictures bigger'}
          onClick={() => {
            void a.refreshAssets()
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
          {a.upscalers.length === 0 && (
            <div className="small faint" style={{ padding: '6px 12px 10px' }}>
              No upscalers yet. Install one under Models, Image models, Upscalers.
            </div>
          )}
          {a.upscalers
            .filter((u) => a.builtinReady || u.engine === 'esrgan')
            .map((u) => (
              <MenuItem
                key={u.path}
                hint={`${u.scale}×${u.style === 'anime' ? ' · anime' : ''}`}
                onClick={() => {
                  close()
                  a.upscaleWith(u)
                }}
              >
                {u.name}
              </MenuItem>
            ))}
        </div>
      )}
    </Popover>
  )
}

/** Delete asks twice: the first press arms the button for a few seconds. */
function useArmed(): [boolean, (v: boolean) => void] {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  return [armed, setArmed]
}

interface Props {
  rec: ImageRecord
  /** `panel` is the stacked list beside the full-screen picture; `bar` is the single row under the Image Hub's big picture. */
  layout: 'panel' | 'bar'
  /** Open the full-screen viewer (bar only). */
  onOpen?: () => void
  /** The picture is about to be deleted; lets the caller move on to a neighbour first. */
  onGone?: () => void
}

export function ImageActions({ rec, layout, onOpen, onGone }: Props) {
  const a = useActions(rec, onGone)
  const [armed, setArmed] = useArmed()
  // A different picture should never inherit an armed delete.
  useEffect(() => setArmed(false), [rec.id, setArmed])

  if (layout === 'panel') {
    return (
      <div className="lb-actions">
        <div className="row">
          <Button className="grow" variant="primary" icon={<RefreshCw size={15} />} onClick={a.reuse}>
            Reuse settings
          </Button>
          <IconButton label={rec.favorite ? 'Unfavorite' : 'Favorite'} active={rec.favorite} onClick={a.toggleFavorite}>
            <Star size={17} fill={rec.favorite ? 'currentColor' : 'none'} />
          </IconButton>
        </div>
        <div className="lb-grid">
          <Button size="sm" icon={<Wand2 size={14} />} onClick={a.startFrom}>
            Start from this
          </Button>
          <Button size="sm" icon={<PaintBucket size={14} />} onClick={a.changePart} title="Choose a part of this picture to change; the rest stays as it is">
            Change part of it
          </Button>
          <UpscaleMenu rec={rec} a={a} size="sm" placement="top" />
          <Button size="sm" icon={<MessageSquarePlus size={14} />} onClick={a.useInChat}>
            Use in chat
          </Button>
          <Button size="sm" icon={<Copy size={14} />} onClick={a.copyPrompt}>
            Copy prompt
          </Button>
          <Button size="sm" icon={<Download size={14} />} onClick={a.saveAs}>
            Save as…
          </Button>
          <Button size="sm" icon={<FolderOpen size={14} />} onClick={a.reveal}>
            Show in folder
          </Button>
          {armed ? (
            <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={a.remove}>
              Really delete?
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setArmed(true)}>
              Delete
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="stage-actions">
      <Button variant="primary" size="sm" icon={<RefreshCw size={14} />} onClick={a.reuse} title="Put this picture's prompt and settings back in the Create panel">
        Reuse settings
      </Button>
      <Button size="sm" icon={<Wand2 size={14} />} onClick={a.startFrom} title="Make a new picture that starts from this one">
        Start from this
      </Button>
      <Button size="sm" icon={<PaintBucket size={14} />} onClick={a.changePart} title="Choose a part of this picture to change; the rest stays as it is">
        Change part
      </Button>
      <UpscaleMenu rec={rec} a={a} size="sm" placement="top" />
      <span className="grow" />
      {armed && (
        <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={a.remove}>
          Really delete?
        </Button>
      )}
      <IconButton label={rec.favorite ? 'Remove from favorites' : 'Add to favorites'} active={rec.favorite} onClick={a.toggleFavorite}>
        <Star size={17} fill={rec.favorite ? 'currentColor' : 'none'} />
      </IconButton>
      {onOpen && (
        <IconButton label="Full screen" onClick={onOpen}>
          <Maximize2 size={17} />
        </IconButton>
      )}
      <Popover
        align="end"
        placement="top"
        width={210}
        trigger={({ toggle, ref }) => (
          <IconButton ref={ref} label="More" onClick={toggle}>
            <MoreHorizontal size={18} />
          </IconButton>
        )}
      >
        {(close) => (
          <div>
            <MenuItem icon={<MessageSquarePlus size={14} />} onClick={() => { close(); a.useInChat() }}>
              Use in chat
            </MenuItem>
            <MenuItem icon={<Copy size={14} />} onClick={() => { close(); a.copyPrompt() }}>
              Copy prompt
            </MenuItem>
            <MenuItem icon={<Download size={14} />} onClick={() => { close(); a.saveAs() }}>
              Save as…
            </MenuItem>
            <MenuItem icon={<FolderOpen size={14} />} onClick={() => { close(); a.reveal() }}>
              Show in folder
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger icon={<Trash2 size={14} />} onClick={() => { close(); setArmed(true) }}>
              Delete…
            </MenuItem>
          </div>
        )}
      </Popover>
    </div>
  )
}
