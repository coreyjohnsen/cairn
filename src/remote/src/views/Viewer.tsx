import { ChevronLeft, ChevronRight, Download, Info, Pencil, Share2, Star, Trash2, Wand2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui'
import { mediaUrl } from '@/lib/api'
import { cx, errorText, formatDuration } from '@/lib/format'
import { useApp } from '@/store/app'
import { useImages } from '@/store/images'
import type { ImageRecord } from '@shared/types'
import { Sheet } from '../components/Sheet'
import { useNav } from '../store/nav'

/** Saves a picture to the phone: through the share sheet when it can (so "Save Image" reaches Photos), otherwise as a download. */
async function saveToPhone(rec: ImageRecord, shareOnly = false): Promise<void> {
  const url = mediaUrl('image', rec.file)
  const ext = rec.file.split('.').pop() ?? 'png'
  const name = `cairn-${rec.id}.${ext}`
  if (typeof navigator.share === 'function') {
    try {
      const blob = await (await fetch(url)).blob()
      const file = new File([blob], name, { type: blob.type || `image/${ext}` })
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Picture from Cairn' })
        return
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return // the person closed the share sheet
    }
  }
  if (shareOnly) throw new Error('This browser cannot share pictures. Use Download instead.')
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function Detail({ k, v }: { k: string; v: string | number | undefined }) {
  if (v === undefined || v === '') return null
  return (
    <div className="detail">
      <span className="faint xs">{k}</span>
      <span className="mono small">{v}</span>
    </div>
  )
}

/** One picture, full screen: swipe between pictures, save it to the phone, star it, start a new picture from it. */
export function Viewer() {
  const open = useNav((s) => s.layers.includes('viewer'))
  const viewing = useNav((s) => s.viewing)
  const siblings = useNav((s) => s.siblings)
  const view = useNav((s) => s.view)
  const openLayer = useNav((s) => s.open)
  const rec = useImages((s) => s.records.find((r) => r.id === viewing))
  const favorite = useImages((s) => s.favorite)
  const remove = useImages((s) => s.remove)
  const reuse = useImages((s) => s.reuse)
  const toast = useApp((s) => s.toast)
  const [info, setInfo] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const drag = useRef<{ x: number; y: number; t: number } | null>(null)
  const [dx, setDx] = useState(0)

  const idx = viewing ? siblings.indexOf(viewing) : -1
  const go = useCallback(
    (d: number) => {
      const next = siblings[idx + d]
      if (next) view(next, siblings)
    },
    [idx, siblings, view]
  )

  const sheetOpen = useRef(false)
  sheetOpen.current = info || confirm
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // A sheet over the picture takes the key first (Escape closes that, not the picture).
      if (sheetOpen.current) return
      if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'Escape') useNav.getState().close('viewer')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, go])

  // The picture was deleted (here or on the computer): leave the viewer or move to its neighbour.
  useEffect(() => {
    if (open && viewing && !rec) {
      const next = siblings[idx + 1] ?? siblings[idx - 1]
      const left = siblings.filter((s) => s !== viewing)
      if (next && next !== viewing) useNav.setState({ viewing: next, siblings: left })
      else useNav.getState().close('viewer')
    }
  }, [open, viewing, rec, siblings, idx])

  if (!open || !rec) return null

  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, t: Date.now() }
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const mx = e.clientX - d.x
    const my = e.clientY - d.y
    if (Math.abs(mx) > 8 && Math.abs(mx) > Math.abs(my)) setDx(mx)
  }
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    setDx(0)
    if (!d) return
    const mx = e.clientX - d.x
    const my = e.clientY - d.y
    const fast = Date.now() - d.t < 400
    if (Math.abs(mx) > (fast ? 40 : 90) && Math.abs(mx) > Math.abs(my) * 1.4) go(mx < 0 ? 1 : -1)
  }

  const fail = (e: unknown) => toast('error', errorText(e))

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label="Picture">
      <header className="viewer-top">
        <button type="button" className="top-btn icon" aria-label="Close" onClick={() => view(null)}>
          <X size={22} />
        </button>
        <span className="viewer-count faint small">{siblings.length > 1 ? `${idx + 1} of ${siblings.length}` : new Date(rec.createdAt).toLocaleDateString()}</span>
        <button type="button" className={cx('top-btn icon', rec.favorite && 'starred')} aria-label={rec.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={rec.favorite} onClick={() => favorite(rec.id, !rec.favorite)}>
          <Star size={22} fill={rec.favorite ? 'currentColor' : 'none'} />
        </button>
      </header>
      <div className="viewer-stage" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => ((drag.current = null), setDx(0))}>
        <img key={rec.id} className="viewer-img" style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dx ? 'none' : undefined }} src={mediaUrl('image', rec.file)} alt={rec.prompt} draggable={false} />
        {idx > 0 && (
          <button type="button" className="viewer-nav prev" aria-label="Newer picture" onClick={() => go(-1)}>
            <ChevronLeft size={26} />
          </button>
        )}
        {idx >= 0 && idx < siblings.length - 1 && (
          <button type="button" className="viewer-nav next" aria-label="Older picture" onClick={() => go(1)}>
            <ChevronRight size={26} />
          </button>
        )}
      </div>
      <p className="viewer-prompt">{rec.prompt}</p>
      <footer className="viewer-bar">
        <button type="button" onClick={() => saveToPhone(rec).catch(fail)}>
          <Share2 size={21} />
          <span>Save</span>
        </button>
        <button
          type="button"
          onClick={() => {
            reuse(rec, { asInit: true })
            openLayer('create')
          }}
        >
          <Pencil size={21} />
          <span>Edit</span>
        </button>
        <button
          type="button"
          onClick={() => {
            reuse(rec)
            openLayer('create')
          }}
        >
          <Wand2 size={21} />
          <span>Remake</span>
        </button>
        <button type="button" onClick={() => setInfo(true)}>
          <Info size={21} />
          <span>Details</span>
        </button>
        <button type="button" className="danger" onClick={() => setConfirm(true)}>
          <Trash2 size={21} />
          <span>Delete</span>
        </button>
      </footer>

      <Sheet open={info} onClose={() => setInfo(false)} title="Details">
        <p className="detail-prompt selectable">{rec.prompt}</p>
        {rec.negativePrompt && <p className="detail-neg dim selectable">Avoided: {rec.negativePrompt}</p>}
        <div className="details">
          <Detail k="Model" v={rec.model} />
          <Detail k="Size" v={`${rec.width} × ${rec.height}`} />
          <Detail k="Steps" v={rec.steps} />
          <Detail k="Guidance" v={rec.cfgScale} />
          <Detail k="Sampler" v={rec.sampler} />
          <Detail k="Seed" v={rec.imported ? undefined : rec.seed} />
          <Detail k="Took" v={rec.durationMs ? formatDuration(rec.durationMs) : undefined} />
          <Detail k="Made" v={new Date(rec.createdAt).toLocaleString()} />
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <Button
            icon={<Download size={15} />}
            onClick={() => {
              const a = document.createElement('a')
              a.href = mediaUrl('image', rec.file)
              a.download = `cairn-${rec.id}.${rec.file.split('.').pop() ?? 'png'}`
              a.click()
            }}
          >
            Download
          </Button>
        </div>
      </Sheet>
      <Sheet open={confirm} onClose={() => setConfirm(false)} title="Delete this picture?">
        <div className="sheet-form">
          <p className="dim" style={{ margin: 0 }}>
            It is removed from your computer too.
          </p>
          <div className="row">
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(false)
                void remove([rec.id])
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  )
}
