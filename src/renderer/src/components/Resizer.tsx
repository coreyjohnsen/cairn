import { useRef, useState } from 'react'
import { cx } from '@/lib/format'
import { PANELS, type PanelId, clampWidth, useLayout } from '@/store/layout'

interface Props {
  panel: PanelId
  /** Which edge of the panel the handle sits on. A panel on the left grows when its right edge is dragged right. */
  side: 'left' | 'right'
}

/**
 * A thin drag handle on the edge of a side panel. Drag to resize, double-click to go back to the usual width,
 * or focus it and use the arrow keys (Shift for bigger steps).
 */
export function Resizer({ panel, side }: Props) {
  const spec = PANELS[panel]
  const width = useLayout((s) => s.widths[panel] ?? spec.def)
  const setWidth = useLayout((s) => s.setWidth)
  const resetWidth = useLayout((s) => s.resetWidth)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; w: number } | null>(null)
  const sign = side === 'right' ? 1 : -1

  const end = () => {
    start.current = null
    setDragging(false)
    document.documentElement.classList.remove('is-resizing')
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize the ${spec.label}`}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      className={cx('resizer', `resizer-${side}`, dragging && 'dragging')}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, w: width }
        setDragging(true)
        document.documentElement.classList.add('is-resizing')
      }}
      onPointerMove={(e) => {
        const s = start.current
        if (s) setWidth(panel, clampWidth(panel, s.w + sign * (e.clientX - s.x)))
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => resetWidth(panel)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          const grow = (e.key === 'ArrowRight') === (side === 'right')
          setWidth(panel, width + (grow ? step : -step))
        } else if (e.key === 'Home') {
          e.preventDefault()
          setWidth(panel, spec.min)
        } else if (e.key === 'End') {
          e.preventDefault()
          setWidth(panel, spec.max)
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          resetWidth(panel)
        }
      }}
    />
  )
}
