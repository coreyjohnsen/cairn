import { AlertTriangle, ArrowLeftRight, Info } from 'lucide-react'
import { useMemo } from 'react'
import { checkSize } from '@shared/imageSize'
import type { ImageTargetOption } from '@shared/types'
import { shapeDiffers } from '@shared/img2img'
import { cx } from '@/lib/format'
import { RATIOS, SCALES, archOf, describeSize, resolveSize } from '@/lib/imageSize'
import type { HubForm } from '@/store/images'
import { Field, IconButton, NumberField } from './ui'

interface Props {
  form: HubForm
  setForm: (patch: Partial<HubForm>) => void
  target?: ImageTargetOption
  /** The starting picture, when there is one: Auto takes its shape and other shapes are checked against it. */
  like?: { width: number; height: number }
}

/** Shape buttons, size buttons or exact width and height, and plain-language warnings about the result. */
export function SizeControls({ form, setForm, target, like }: Props) {
  const size = resolveSize(form, target, like)
  const d = target?.defaults
  const { arch, guessed } = archOf(target)
  const { width, height } = size

  const notes = useMemo(() => {
    if (!target) return []
    // "Auto" at the default scale uses the model's own settings, which the user chose for it.
    if (!(width > 0 && height > 0)) return target.kind === 'openai' ? checkSize({ arch, width: 1024, height: 1024, kind: 'openai' }).slice(0, 1) : []
    return checkSize({ arch, name: target.label, width, height, builtin: target.kind === 'builtin', vaeTiling: target.vaeTiling, guessed, kind: target.kind })
  }, [target, arch, guessed, width, height])

  const pickRatio = (id: HubForm['ratio']) => {
    if (id === 'custom' && form.ratio !== 'custom') {
      // Start from the size in use instead of an unrelated number.
      const now = width > 0 ? { width, height } : d ? { width: d.width, height: d.height } : { width: form.customW, height: form.customH }
      setForm({ ratio: 'custom', customW: now.width, customH: now.height })
    } else {
      setForm({ ratio: id })
    }
  }

  const custom = form.ratio === 'custom'
  const atDefault = !!d && form.customW === d.width && form.customH === d.height

  return (
    <>
      <Field label="Shape" hint={custom ? undefined : describeSize(form, target, like)}>
        <div className="ratio-grid">
          {RATIOS.map((r) => (
            <button key={r.id} type="button" className={cx('ratio', form.ratio === r.id && 'on')} onClick={() => pickRatio(r.id)}>
              {r.id !== 'auto' && r.id !== 'custom' && <span className="ratio-box" style={{ aspectRatio: `${r.rw} / ${r.rh}` }} />}
              <span>{r.label}</span>
            </button>
          ))}
        </div>

        {custom ? (
          <>
            <div className="size-row">
              <NumberField value={form.customW} min={64} max={2048} step={64} suffix="w" onCommit={(v) => setForm({ customW: v })} />
              <IconButton label="Swap width and height" size="sm" onClick={() => setForm({ customW: form.customH, customH: form.customW })}>
                <ArrowLeftRight size={14} />
              </IconButton>
              <NumberField value={form.customH} min={64} max={2048} step={64} suffix="h" onCommit={(v) => setForm({ customH: v })} />
            </div>
            {d && !atDefault && (
              <button type="button" className="link-btn" style={{ marginTop: 8 }} onClick={() => setForm({ customW: d.width, customH: d.height })}>
                Use the model's size ({d.width} × {d.height})
              </button>
            )}
          </>
        ) : (
          <div className="size-presets" role="group" aria-label="Size">
            {SCALES.map((sc) => (
              <button key={sc.value} type="button" className={cx('size-chip', (form.scale ?? 1) === sc.value && 'on')} aria-pressed={(form.scale ?? 1) === sc.value} onClick={() => setForm({ scale: sc.value })}>
                {sc.label}
              </button>
            ))}
          </div>
        )}

        {like && size.width > 0 && shapeDiffers(like, size.width, size.height) && (
          <div className="size-notes" role="status">
            <div className="size-note warn">
              <AlertTriangle size={14} />
              <span>
                This shape is different from your starting picture ({like.width} × {like.height}), so it will be stretched.{' '}
                <button type="button" className="link-btn" onClick={() => setForm({ ratio: 'auto' })}>
                  Use the picture's shape
                </button>
              </span>
            </div>
          </div>
        )}

        {notes.length > 0 && (
          <div className="size-notes" role="status">
            {notes.map((n) => (
              <div key={n.text} className={cx('size-note', n.level)}>
                {n.level === 'warn' ? <AlertTriangle size={14} /> : <Info size={14} />}
                <span>{n.text}</span>
              </div>
            ))}
          </div>
        )}
      </Field>
    </>
  )
}
