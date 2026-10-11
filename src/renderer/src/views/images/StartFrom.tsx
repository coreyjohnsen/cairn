import { FolderOpen, ImagePlus, Images, LayoutGrid, Pencil, Replace, X } from 'lucide-react'
import { useRef } from 'react'
import type { ImageRecord } from '@shared/types'
import { Button, Field, IconButton, Segmented } from '@/components/ui'
import { firstPicture } from '@/lib/pictureFile'
import type { StartMode } from '@/store/images'

interface Props {
  mode: StartMode
  onMode(m: StartMode): void
  /** The model chosen can start from a picture. */
  imageOk: boolean
  /** Why not, when it cannot. */
  unsupportedHint?: string
  /** The picture being edited. */
  init?: ImageRecord
  /** The Image Hub is showing the grid, so the editor (in the big view) is not on screen. */
  gridShown: boolean
  onShowEditor(): void
  onClearPicture(): void
  /** A file from disk (browse, drop or paste). */
  onPick(file: File): void
  /** Open the list of pictures already made. */
  onChoose(): void
}

/**
 * The "Start from" part of the create panel: words only, or a picture to edit. The editing itself happens on the big
 * picture (paint, describe, generate, all in one place), so this only says which picture and how to change it.
 */
export function StartFrom(p: Props) {
  const input = useRef<HTMLInputElement>(null)
  const { mode, init } = p

  return (
    <Field label="Start from">
      <Segmented
        size="sm"
        fill
        value={mode}
        onChange={p.onMode}
        options={[
          { value: 'text', label: 'Text', title: 'Make a new picture from your words alone' },
          { value: 'edit', label: 'Edit a picture', title: p.imageOk ? 'Change a picture: paint the part to change, or redo all of it' : p.unsupportedHint, disabled: !p.imageOk }
        ]}
      />
      <div className="faint xs start-hint">
        {mode === 'edit' ? 'Paint on the big picture to choose the part to change, describe it under the picture, then press Generate. Nothing painted redoes the whole picture.' : p.unsupportedHint && !p.imageOk ? p.unsupportedHint : 'Draws a new picture from your words alone.'}
      </div>

      {mode === 'edit' && !init && (
        <div className="start-drop">
          <ImagePlus size={20} />
          <strong>Choose a picture to edit</strong>
          <span className="faint xs">Drop one here, paste it, or pick one.</span>
          <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
            <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => input.current?.click()}>
              Browse files…
            </Button>
            <Button size="sm" icon={<Images size={14} />} onClick={p.onChoose}>
              From your pictures
            </Button>
          </div>
        </div>
      )}

      {mode === 'edit' && init && (
        <div className="start-edit">
          <div className="start-edit-line">
            <Pencil size={14} />
            <span className="grow small">
              Editing a {init.width} × {init.height} picture{init.imported ? ' from a file' : ''}.
            </span>
          </div>
          {p.gridShown && (
            <Button size="sm" icon={<LayoutGrid size={14} />} onClick={p.onShowEditor}>
              Open the editor
            </Button>
          )}
          <div className="start-tools">
            <Button size="sm" variant="ghost" icon={<Replace size={14} />} onClick={() => input.current?.click()} title="Choose another file">
              Replace
            </Button>
            <Button size="sm" variant="ghost" icon={<Images size={14} />} onClick={p.onChoose} title="Choose from the pictures you have made">
              Gallery
            </Button>
            <span className="grow" />
            <IconButton label="Stop editing this picture" size="sm" onClick={p.onClearPicture}>
              <X size={15} />
            </IconButton>
          </div>
        </div>
      )}

      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = firstPicture(e.target.files)
          e.target.value = ''
          if (f) p.onPick(f)
        }}
      />
    </Field>
  )
}
