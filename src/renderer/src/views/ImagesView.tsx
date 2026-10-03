import { type CSSProperties } from 'react'
import { usePanel } from '@/store/layout'
import { CreatePanel } from './images/CreatePanel'
import { Gallery } from './images/Gallery'

export function ImagesView() {
  const { width, collapsed } = usePanel('create')
  return (
    <div className="hub-layout" style={{ '--create-w': `${collapsed ? 0 : width}px` } as CSSProperties}>
      <CreatePanel />
      <Gallery />
    </div>
  )
}
