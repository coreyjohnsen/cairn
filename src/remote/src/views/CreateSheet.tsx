import { ChevronDown, Dices, ImagePlus, Sparkles, Upload, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button, Segmented, Spinner, Switch } from '@/components/ui'
import { invoke, mediaUrl } from '@/lib/api'
import { cx, errorText } from '@/lib/format'
import { RATIOS, SAMPLERS } from '@/lib/imageSize'
import { useApp } from '@/store/app'
import { useImages } from '@/store/images'
import { useHub } from '@/views/images/useHub'
import { Sheet } from '../components/Sheet'
import { shrinkPhoto } from '../lib/photo'
import { useNav } from '../store/nav'
import { targetKeyOf } from '@/store/images'

function PicturePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const records = useImages((s) => s.records)
  const setForm = useImages((s) => s.setForm)
  const importPicture = useImages((s) => s.importPicture)
  const file = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  return (
    <Sheet open={open} onClose={onClose} title="Start from a picture" tall>
      <input
        ref={file}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          setBusy(true)
          const rec = await importPicture(await shrinkPhoto(f))
          setBusy(false)
          if (rec) onClose()
        }}
      />
      <button type="button" className="btn btn-secondary picker-upload" onClick={() => file.current?.click()} disabled={busy}>
        {busy ? <Spinner size={16} /> : <Upload size={16} />}
        <span>From this phone</span>
      </button>
      {records.length > 0 && <div className="group-label">Or one of yours</div>}
      <div className="picker-grid">
        {records.slice(0, 60).map((r) => (
          <button
            key={r.id}
            type="button"
            className="picker-cell"
            onClick={() => {
              setForm({ initImageId: r.id, startMode: 'edit' })
              onClose()
            }}
          >
            <img src={mediaUrl('thumb', r.thumb)} alt={r.prompt} loading="lazy" draggable={false} />
          </button>
        ))}
      </div>
    </Sheet>
  )
}

/** Makes a picture: describe it, optionally start from another one, choose the shape, press Generate. */
export function CreateSheet() {
  const open = useNav((s) => s.layers.includes('create'))
  const go = useNav((s) => s.go)
  const close = useNav((s) => s.close)
  const toast = useApp((s) => s.toast)
  const targets = useImages((s) => s.targets)
  const setForm = useImages((s) => s.setForm)
  const hub = useHub()
  const { form, target, ready, editing, pic, imageOk, unsupportedHint, size0, negative, stepsDefault, cfgDefault, blocked, busyJobs, submit } = hub
  const [picking, setPicking] = useState(false)
  const [more, setMore] = useState(false)
  const [sending, setSending] = useState(false)
  const [enhancing, setEnhancing] = useState(false)

  const enhance = async () => {
    if (!form.prompt.trim()) return
    setEnhancing(true)
    try {
      setForm({ prompt: await invoke('chat:enhance', form.prompt) })
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setEnhancing(false)
    }
  }

  const generate = async () => {
    setSending(true)
    const id = await submit()
    setSending(false)
    if (id) go('pictures')
  }

  return (
    <>
      <Sheet
        open={open}
        onClose={() => close('create')}
        title={editing ? 'Change this picture' : 'Make a picture'}
        tall
        className="create"
        footer={
          <div className="create-foot">
            {blocked && <p className="faint small create-why">{blocked}</p>}
            {!blocked && busyJobs > 0 && <p className="faint small create-why">{busyJobs} already in the queue. This one waits its turn.</p>}
            <Button variant="primary" size="lg" className="create-go" disabled={!!blocked || sending} busy={sending} onClick={() => void generate()}>
              {editing ? 'Change it' : 'Generate'}
            </Button>
          </div>
        }
      >
        <div className="field-group">
          <label className="fld-label" htmlFor="create-prompt">
            {editing ? 'What should it become?' : 'What should it look like?'}
          </label>
          <textarea id="create-prompt" className="fld" rows={4} value={form.prompt} onChange={(e) => setForm({ prompt: e.target.value })} placeholder={editing ? 'Make the sky stormy and the lighthouse glow' : 'A lighthouse on a cliff at dawn, soft pink clouds'} />
          <button type="button" className="link-btn enhance" onClick={() => void enhance()} disabled={!form.prompt.trim() || enhancing}>
            {enhancing ? <Spinner size={13} /> : <Sparkles size={13} />} Improve my wording
          </button>
        </div>

        <div className="field-group">
          <div className="fld-label">Starting point</div>
          {editing && pic ? (
            <div className="start-card">
              <img src={mediaUrl('thumb', pic.thumb)} alt="" />
              <div className="start-meta">
                <div className="small">Starting from this picture</div>
                <button type="button" className="link-btn" onClick={() => setPicking(true)}>
                  Choose another
                </button>
              </div>
              <button type="button" className="icon-x" aria-label="Start from words only" onClick={() => setForm({ startMode: 'text' })}>
                <X size={16} />
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-secondary start-pick" onClick={() => setPicking(true)}>
              <ImagePlus size={17} /> <span>Start from a picture</span>
            </button>
          )}
          {editing && pic && (
            <div className="strength">
              <div className="row between small">
                <span>How much to change</span>
                <span className="mono dim">{Math.round(form.strength * 100)}%</span>
              </div>
              <input type="range" min={0.1} max={1} step={0.05} value={form.strength} onChange={(e) => setForm({ strength: Number(e.target.value) })} aria-label="How much to change" />
              <div className="row between faint xs">
                <span>Keep the look</span>
                <span>Repaint it</span>
              </div>
            </div>
          )}
          {editing && !imageOk && unsupportedHint && <p className="small warn-text">{unsupportedHint}</p>}
        </div>

        <div className="field-group">
          <label className="fld-label" htmlFor="create-model">
            Model
          </label>
          <div className="select-wrap">
            <select id="create-model" className="fld" value={target ? targetKeyOf(target) : ''} onChange={(e) => setForm({ targetKey: e.target.value })}>
              {targets.map((t) => (
                <option key={targetKeyOf(t)} value={targetKeyOf(t)} disabled={!t.available}>
                  {t.backendName} · {t.model}
                  {t.available ? '' : ' (not ready)'}
                </option>
              ))}
              {!targets.length && <option value="">No image models found</option>}
            </select>
            <ChevronDown size={16} />
          </div>
          {!ready && targets.length > 0 && <p className="small warn-text">That model is not ready on your computer. Pick another, or open Cairn there.</p>}
        </div>

        {!(editing && pic) && (
          <div className="field-group">
            <div className="fld-label">
              Shape <span className="faint xs">· {size0.width} × {size0.height}</span>
            </div>
            <Segmented
              fill
              value={form.ratio}
              onChange={(ratio) => setForm({ ratio })}
              options={RATIOS.filter((r) => r.id !== 'custom').map((r) => ({ value: r.id, label: r.id === 'auto' ? 'Auto' : r.label }))}
            />
          </div>
        )}

        <div className="field-group">
          <div className="fld-label">How many</div>
          <Segmented fill value={String(form.count)} onChange={(v) => setForm({ count: Number(v) })} options={['1', '2', '3', '4'].map((n) => ({ value: n, label: n }))} />
        </div>

        <button type="button" className={cx('more-toggle', more && 'open')} onClick={() => setMore((m) => !m)} aria-expanded={more}>
          <span>More options</span>
          <ChevronDown size={16} />
        </button>
        {more && (
          <div className="more">
            {target?.supportsNegative && (
              <div className="field-group">
                <label className="fld-label" htmlFor="create-neg">
                  Leave out
                </label>
                <textarea id="create-neg" className="fld" rows={2} value={negative} onChange={(e) => setForm({ negative: e.target.value })} placeholder="blurry, low quality" />
              </div>
            )}
            <div className="two">
              <div className="field-group">
                <label className="fld-label" htmlFor="create-steps">
                  Steps
                </label>
                <input id="create-steps" className="fld" type="number" inputMode="numeric" min={1} max={150} placeholder={stepsDefault ? String(stepsDefault) : 'auto'} value={form.steps ?? ''} onChange={(e) => setForm({ steps: e.target.value ? Number(e.target.value) : undefined })} />
              </div>
              <div className="field-group">
                <label className="fld-label" htmlFor="create-cfg">
                  Guidance
                </label>
                <input id="create-cfg" className="fld" type="number" inputMode="decimal" step={0.5} min={0} max={30} placeholder={cfgDefault !== undefined ? String(cfgDefault) : 'auto'} value={form.cfg ?? ''} onChange={(e) => setForm({ cfg: e.target.value ? Number(e.target.value) : undefined })} />
              </div>
            </div>
            <div className="two">
              <div className="field-group">
                <label className="fld-label" htmlFor="create-sampler">
                  Sampler
                </label>
                <div className="select-wrap">
                  <select id="create-sampler" className="fld" value={form.sampler ?? ''} onChange={(e) => setForm({ sampler: e.target.value || undefined })}>
                    <option value="">Model default</option>
                    {SAMPLERS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={16} />
                </div>
              </div>
              <div className="field-group">
                <label className="fld-label" htmlFor="create-seed">
                  Seed
                </label>
                <div className="seed">
                  <input id="create-seed" className="fld" type="number" inputMode="numeric" placeholder="random" value={form.seed >= 0 ? form.seed : ''} onChange={(e) => setForm({ seed: e.target.value === '' ? -1 : Math.max(0, Math.floor(Number(e.target.value))) })} />
                  <button type="button" className="icon-x" aria-label="Random seed" onClick={() => setForm({ seed: -1 })}>
                    <Dices size={17} />
                  </button>
                </div>
              </div>
            </div>
            {hub.usable.length > 0 && (
              <div className="row between switch-row">
                <span>Make it bigger when done</span>
                <Switch
                  checked={!!hub.upscaleValue}
                  label="Make it bigger when done"
                  onChange={(on) => setForm(on ? { upscale: { path: hub.chosenUpscaler?.path ?? hub.usable[0].path, repeats: 1 }, upscaleOff: false } : { upscale: undefined, upscaleOff: true })}
                />
              </div>
            )}
          </div>
        )}
      </Sheet>
      <PicturePicker open={picking} onClose={() => setPicking(false)} />
    </>
  )
}
