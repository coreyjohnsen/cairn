import { X } from 'lucide-react'
import { type ReactNode, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '@/lib/format'

/** A panel that slides up from the bottom on phones and sits in the middle on tablets. Tapping outside closes it. */
export function Sheet({ open, onClose, title, children, footer, tall, className }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; tall?: boolean; className?: string }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="sheet-root" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className={cx('sheet', tall && 'tall', className)}>
        <div className="sheet-grab" aria-hidden />
        {title !== undefined && (
          <div className="sheet-head">
            <h2>{title}</h2>
            <button type="button" className="sheet-x" aria-label="Close" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        )}
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

/** One tappable row inside a sheet: an icon, a label and an optional detail. */
export function SheetItem({ icon, label, detail, danger, onClick, disabled }: { icon?: ReactNode; label: ReactNode; detail?: ReactNode; danger?: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={cx('sheet-item', danger && 'danger')} onClick={onClick} disabled={disabled}>
      {icon && <span className="sheet-item-icon">{icon}</span>}
      <span className="sheet-item-main">
        <span>{label}</span>
        {detail && <span className="faint xs">{detail}</span>}
      </span>
    </button>
  )
}
