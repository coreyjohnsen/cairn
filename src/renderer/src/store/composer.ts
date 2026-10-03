import { create } from 'zustand'
import type { AttachmentInput } from '@shared/types'

/** Lets other screens (lightbox, suggestion chips, edit message) hand text or files to the composer. */
interface ComposerBus {
  nonce: number
  text: string | null
  files: AttachmentInput[]
  mode: 'chat' | 'image' | null
  push(p: { text?: string; files?: AttachmentInput[]; mode?: 'chat' | 'image' }): void
}

export const useComposerBus = create<ComposerBus>()((set) => ({
  nonce: 0,
  text: null,
  files: [],
  mode: null,
  push(p) {
    set((s) => ({ nonce: s.nonce + 1, text: p.text ?? null, files: p.files ?? [], mode: p.mode ?? null }))
  }
}))
