import { create } from 'zustand'
import type { RemoteDevice, RemotePairing, RemoteStatus } from '@shared/types'
import { invoke, on } from '@/lib/api'
import { errorText } from '@/lib/format'
import { useApp } from './app'

interface RemoteState {
  /** The "Connect your phone" window is showing. */
  open: boolean
  status: RemoteStatus | null
  /** The code and links on screen right now. */
  offer: RemotePairing | null
  /** A phone just used the code. */
  paired: RemoteDevice | null
  busy: boolean
  init(): Promise<void>
  show(): void
  hide(): void
  /** Switches the companion on (the computer starts serving, then offers a code). */
  turnOn(): void
  turnOff(): void
  newCode(): Promise<void>
  dismissPaired(): void
  updateDevice(id: string, patch: { name?: string; scopes?: { images?: boolean; tools?: boolean } }): Promise<void>
  removeDevice(id: string): Promise<void>
}

export const useRemote = create<RemoteState>()((set, get) => ({
  open: false,
  status: null,
  offer: null,
  paired: null,
  busy: false,

  async init() {
    on('remote:status', (status) => set({ status }))
    on('remote:paired', (paired) => set({ paired, offer: null }))
    try {
      set({ status: await invoke('remote:status') })
    } catch {
      /* the companion is not available (older build): the button stays hidden */
    }
  },

  show() {
    set({ open: true, paired: null })
  },

  hide() {
    set({ open: false, offer: null, paired: null })
    void invoke('remote:cancelPair').catch(() => {})
  },

  turnOn() {
    const app = useApp.getState()
    const s = app.settings
    if (s) app.update({ remote: { ...s.remote, enabled: true } })
  },

  turnOff() {
    const app = useApp.getState()
    const s = app.settings
    if (s) app.update({ remote: { ...s.remote, enabled: false } })
    set({ offer: null })
  },

  async newCode() {
    if (get().busy) return
    set({ busy: true })
    try {
      set({ offer: await invoke('remote:pair'), paired: null })
    } catch (e) {
      useApp.getState().toast('error', errorText(e))
    } finally {
      set({ busy: false })
    }
  },

  dismissPaired() {
    set({ paired: null })
  },

  async updateDevice(id, patch) {
    // Show the change at once; the computer confirms with a fresh status.
    set((s) => ({ status: s.status && { ...s.status, devices: s.status.devices.map((d) => (d.id === id ? { ...d, ...(patch.name ? { name: patch.name } : {}), scopes: { ...d.scopes, ...patch.scopes } } : d)) } }))
    try {
      await invoke('remote:updateDevice', id, patch)
    } catch (e) {
      useApp.getState().toast('error', errorText(e))
      set({ status: await invoke('remote:status') })
    }
  },

  async removeDevice(id) {
    try {
      await invoke('remote:removeDevice', id)
    } catch (e) {
      useApp.getState().toast('error', errorText(e))
    }
  }
}))
