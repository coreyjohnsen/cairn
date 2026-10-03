import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { justify } from '@/lib/justify'

export interface GridItem {
  key: string
  aspect: number
  render: (size: { width: number; height: number }) => ReactNode
}

/** Pictures in rows, filling the width, in the order given (left to right, then down). */
export function JustifiedGrid({ items, target = 230, gap = 14 }: { items: GridItem[]; target?: number; gap?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(Math.floor(el.clientWidth))
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const aspectKey = items.map((i) => i.aspect).join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the aspects
  const rows = useMemo(() => justify(items.map((i) => i.aspect), width, target, gap), [aspectKey, width, target, gap])

  return (
    <div ref={ref} className="jgrid" style={{ ['--jgap' as string]: `${gap}px` }}>
      {rows.map((row) => (
        <div key={row.items[0].index} className="jrow" style={{ height: Math.floor(row.height) }}>
          {row.items.map(({ index, width: w }) => (
            <div key={items[index].key} className="jcell" style={{ width: Math.floor(w), height: Math.floor(row.height) }}>
              {items[index].render({ width: Math.floor(w), height: Math.floor(row.height) })}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
