import { Check, Eye, EyeOff, Loader2, X } from 'lucide-react'
import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '@/lib/format'

/* ───────────── Buttons ───────────── */

interface ButtonProps extends React.ComponentProps<'button'> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft'
  size?: 'sm' | 'md' | 'lg'
  busy?: boolean
  icon?: ReactNode
}

export function Button({ variant = 'secondary', size = 'md', busy, icon, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button className={cx('btn', `btn-${variant}`, `btn-${size}`, className)} disabled={disabled || busy} {...rest}>
      {busy ? <Loader2 size={15} className="spin" /> : icon}
      {children != null && <span>{children}</span>}
    </button>
  )
}

interface IconButtonProps extends React.ComponentProps<'button'> {
  label: string
  active?: boolean
  size?: 'sm' | 'md'
  danger?: boolean
}

export function IconButton({ label, active, size = 'md', danger, className, children, ...rest }: IconButtonProps) {
  return (
    <button className={cx('icon-btn', `icon-btn-${size}`, active && 'is-active', danger && 'is-danger', className)} aria-label={label} data-tip={label} {...rest}>
      {children}
    </button>
  )
}

/* ───────────── Form controls ───────────── */

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={cx('switch', checked && 'on')} onClick={() => onChange(!checked)}>
      <span className="switch-knob" />
    </button>
  )
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; size?: 'sm' | 'md' }) {
  return (
    <div className={cx('segmented', `segmented-${size}`)} role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} title={o.title} className={cx('seg', o.value === value && 'on')} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Select<T extends string | number>({ value, options, onChange, className, disabled }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string; disabled?: boolean }) {
  return (
    <div className={cx('select', className)}>
      <select
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value
          const match = options.find((o) => String(o.value) === raw)
          if (match) onChange(match.value)
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      <svg className="select-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

interface TextFieldProps {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  mono?: boolean
  secret?: boolean
  multiline?: boolean
  rows?: number
  disabled?: boolean
  className?: string
  /** Called on every edit (before the debounced commit). */
  onDraft?: (v: string) => void
  autoFocus?: boolean
  spellCheck?: boolean
  type?: 'text' | 'url' | 'search'
  onEnter?: () => void
  right?: ReactNode
  ariaLabel?: string
}

/** Edits a local draft and commits after a pause, on blur or on Enter: settings are never saved per keystroke. */
export function TextField({ value, onCommit, placeholder, mono, secret, multiline, rows = 4, disabled, className, onDraft, autoFocus, spellCheck, type = 'text', onEnter, right, ariaLabel }: TextFieldProps) {
  const [draft, setDraft] = useState(value)
  const [shown, setShown] = useState(false)
  const focused = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef({ draft, value, onCommit })
  latest.current = { draft, value, onCommit }

  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])

  const commit = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const { draft: d, value: v, onCommit: fn } = latest.current
    if (d !== v) fn(d)
  }, [])

  useEffect(() => () => commit(), [commit])

  const common = {
    value: draft,
    placeholder,
    disabled,
    autoFocus,
    spellCheck: spellCheck ?? false,
    'aria-label': ariaLabel,
    onFocus: () => (focused.current = true),
    onBlur: () => {
      focused.current = false
      commit()
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(e.target.value)
      onDraft?.(e.target.value)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(commit, 700)
    }
  }

  if (multiline) return <textarea className={cx('field-input', 'field-area', mono && 'mono', className)} rows={rows} {...common} />
  return (
    <div className={cx('field-wrap', className)}>
      <input
        className={cx('field-input', mono && 'mono')}
        type={secret && !shown ? 'password' : type === 'search' ? 'text' : type}
        autoComplete="off"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit()
            onEnter?.()
          }
        }}
        {...common}
      />
      {secret && (
        <button type="button" className="field-eye" onClick={() => setShown((s) => !s)} aria-label={shown ? 'Hide' : 'Show'}>
          {shown ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      )}
      {right}
    </div>
  )
}

export function NumberField({ value, onCommit, min, max, step = 1, suffix, className, disabled, float }: { value: number; onCommit: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string; className?: string; disabled?: boolean; float?: boolean }) {
  const [draft, setDraft] = useState(String(value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(String(value))
  }, [value])
  const commit = () => {
    focused.current = false
    let n = float ? parseFloat(draft) : parseInt(draft, 10)
    if (!Number.isFinite(n)) n = value
    if (min != null) n = Math.max(min, n)
    if (max != null) n = Math.min(max, n)
    setDraft(String(n))
    if (n !== value) onCommit(n)
  }
  return (
    <div className={cx('field-wrap', 'num', className)}>
      <input
        className="field-input mono"
        inputMode={float ? 'decimal' : 'numeric'}
        value={draft}
        disabled={disabled}
        step={step}
        onFocus={() => (focused.current = true)}
        onBlur={commit}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const cur = parseFloat(draft) || 0
            const next = cur + (e.key === 'ArrowUp' ? step : -step)
            setDraft(String(float ? Math.round(next * 1000) / 1000 : Math.round(next)))
          }
        }}
      />
      {suffix && <span className="field-suffix">{suffix}</span>}
    </div>
  )
}

export function Slider({ value, min, max, step = 1, onChange, format }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  const pct = ((value - min) / (max - min || 1)) * 100
  return (
    <div className="slider">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ '--pct': `${pct}%` } as CSSProperties} />
      <span className="slider-val mono">{format ? format(value) : value}</span>
    </div>
  )
}

export function Field({ label, hint, children, row, className }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; row?: boolean; className?: string }) {
  return (
    <div className={cx('field', row && 'field-row', className)}>
      {(label || hint) && (
        <div className="field-head">
          {label && <label className="field-label">{label}</label>}
          {hint && <div className="field-hint">{hint}</div>}
        </div>
      )}
      <div className="field-body">{children}</div>
    </div>
  )
}

/* ───────────── Surfaces ───────────── */

export function Card({ children, className, pad = true, style }: { children: ReactNode; className?: string; pad?: boolean; style?: CSSProperties }) {
  return (
    <div className={cx('card', pad && 'card-pad', className)} style={style}>
      {children}
    </div>
  )
}

export function Section({ title, subtitle, actions, children, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('section', className)}>
      <div className="section-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p className="section-sub">{subtitle}</p>}
        </div>
        {actions && <div className="section-actions">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

export function Badge({ children, tone = 'neutral', className, title }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info'; className?: string; title?: string }) {
  return (
    <span className={cx('badge', `badge-${tone}`, className)} title={title}>
      {children}
    </span>
  )
}

export function Progress({ value, indeterminate, tone = 'accent', height }: { value?: number; indeterminate?: boolean; tone?: 'accent' | 'ok'; height?: number }) {
  const pct = Math.max(0, Math.min(1, value ?? 0)) * 100
  return (
    <div className="progress" style={height ? { height } : undefined} role="progressbar" aria-valuenow={indeterminate ? undefined : Math.round(pct)}>
      <div className={cx('progress-bar', `tone-${tone}`, indeterminate && 'indeterminate')} style={indeterminate ? undefined : { width: `${pct}%` }} />
    </div>
  )
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="spin" />
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

export function Notice({ tone = 'info', children, action }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx('notice', `notice-${tone}`)}>
      <div className="notice-body">{children}</div>
      {action}
    </div>
  )
}

/* ───────────── Overlays ───────────── */

export function Modal({ open, onClose, title, children, footer, width = 560, tall }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number; tall?: boolean }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', tall && 'modal-tall')} style={{ maxWidth: width }} role="dialog" aria-modal="true">
        {title && (
          <div className="modal-head">
            <h3>{title}</h3>
            <IconButton label="Close" size="sm" onClick={onClose}>
              <X size={16} />
            </IconButton>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

interface PopoverProps {
  trigger: (api: { open: boolean; toggle: () => void; ref: React.RefObject<HTMLButtonElement | null> }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'start' | 'end'
  placement?: 'top' | 'bottom'
  width?: number
  className?: string
}

/** Floating panel anchored to its trigger. Rendered in a portal so scroll containers never clip it. */
export function Popover({ trigger, children, align = 'start', placement = 'bottom', width, className }: PopoverProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' })

  const place = useCallback(() => {
    const t = ref.current
    const p = panel.current
    if (!t || !p) return
    const r = t.getBoundingClientRect()
    const pw = width ?? p.offsetWidth
    const ph = p.offsetHeight
    const gap = 8
    let up = placement === 'top'
    if (up && r.top < ph + gap + 12) up = false
    if (!up && r.bottom + gap + ph > window.innerHeight - 12 && r.top > ph + gap) up = true
    let left = align === 'end' ? r.right - pw : r.left
    left = Math.max(12, Math.min(left, window.innerWidth - pw - 12))
    const maxH = Math.max(160, (up ? r.top : window.innerHeight - r.bottom) - gap - 12)
    setPos({ position: 'fixed', left, width, maxHeight: maxH, ...(up ? { bottom: window.innerHeight - r.top + gap } : { top: r.bottom + gap }), visibility: 'visible' })
  }, [align, placement, width])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      const n = e.target as Node
      if (panel.current?.contains(n) || ref.current?.contains(n)) return
      setOpen(false)
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    const re = () => place()
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    window.addEventListener('resize', re)
    window.addEventListener('scroll', re, true)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
      window.removeEventListener('resize', re)
      window.removeEventListener('scroll', re, true)
    }
  }, [open, place])

  return (
    <>
      {trigger({ open, toggle: () => setOpen((o) => !o), ref })}
      {open &&
        createPortal(
          <div ref={panel} className={cx('popover', className)} style={pos}>
            {children(() => setOpen(false))}
          </div>,
          document.body
        )}
    </>
  )
}

export function MenuItem({ icon, children, onClick, danger, active, disabled, hint }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; danger?: boolean; active?: boolean; disabled?: boolean; hint?: ReactNode }) {
  return (
    <button type="button" className={cx('menu-item', danger && 'danger', active && 'active')} onClick={onClick} disabled={disabled}>
      <span className="menu-icon">{icon}</span>
      <span className="menu-label">{children}</span>
      {hint && <span className="menu-hint">{hint}</span>}
      {active && <Check size={14} className="menu-check" />}
    </button>
  )
}

export function MenuSeparator() {
  return <div className="menu-sep" />
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="menu-heading">{children}</div>
}

/* ───────────── Toasts ───────────── */

export interface ToastItem {
  id: number
  kind: 'info' | 'ok' | 'error'
  text: string
}

export function Toasts({ items, dismiss }: { items: ToastItem[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={cx('toast', `toast-${t.kind}`)} onClick={() => dismiss(t.id)}>
          <span className="selectable">{t.text}</span>
        </div>
      ))}
    </div>
  )
}
