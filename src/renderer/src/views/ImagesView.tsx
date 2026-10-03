import { type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { MaskEditor } from '@/components/MaskEditor'
import { useImages } from '@/store/images'
import { usePanel } from '@/store/layout'
import { CreatePanel } from './images/CreatePanel'
import { Gallery } from './images/Gallery'

/** The mask editor covers the whole window, so it lives outside the side panel it was opened from. */
function MaskHost() {
  const open = useImages((s) => s.maskEditorOpen)
  const init = useImages((s) => (s.form.initImageId ? s.records.find((r) => r.id === s.form.initImageId) : undefined))
  const mask = useImages((s) => s.form.mask)
  const setForm = useImages((s) => s.setForm)
  const openMaskEditor = useImages((s) => s.openMaskEditor)
  if (!open || !init) return null
  return createPortal(
    <MaskEditor
      picture={init}
      initial={mask?.png}
      onCancel={() => openMaskEditor(false)}
      onDone={(m) => {
        setForm({ mask: m, startMode: 'mask' })
        openMaskEditor(false)
      }}
    />,
    document.body
  )
}

export function ImagesView() {
  const { width, collapsed } = usePanel('create')
  return (
    <div className="hub-layout" style={{ '--create-w': `${collapsed ? 0 : width}px` } as CSSProperties}>
      <CreatePanel />
      <Gallery />
      <MaskHost />
    </div>
  )
}
