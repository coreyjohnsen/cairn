import { create } from 'zustand'
import type { ModelOption, Settings, SystemInfo } from '@shared/types'
import type { ToastItem } from '@/components/ui'
import { invoke, on } from '@/lib/api'
import { errorText } from '@/lib/format'

export type ViewId = 'chat' | 'images' | 'models' | 'tools' | 'settings'
export type ModelsTab = 'connections' | 'local' | 'image' | 'engines' | 'serve'
export type SettingsTab = 'general' | 'chat' | 'agent' | 'storage' | 'about'

interface AppState {
  ready: boolean
  settings: Settings | null
  system: SystemInfo | null
  models: ModelOption[]
  modelsLoading: boolean
  view: ViewId
  modelsTab: ModelsTab
  settingsTab: SettingsTab
  toasts: ToastItem[]
  init(): Promise<void>
  setView(view: ViewId, tab?: ModelsTab | SettingsTab): void
  update(patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)): void
  refreshModels(force?: boolean): Promise<void>
  toast(kind: ToastItem['kind'], text: string): void
  dismissToast(id: number): void
}

let pending = 0
let toastId = 1

export const useApp = create<AppState>()((set, get) => ({
  ready: false,
  settings: null,
  system: null,
  models: [],
  modelsLoading: false,
  view: 'chat',
  modelsTab: 'connections',
  settingsTab: 'general',
  toasts: [],

  async init() {
    const [settings, system] = await Promise.all([invoke('settings:get'), invoke('system:info')])
    set({ settings, system, ready: true })
    on('settings:changed', (s) => {
      // Ignore echoes while our own edits are still in flight so typing never jumps back.
      if (pending === 0) set({ settings: s })
    })
    void get().refreshModels()
  },

  setView(view, tab) {
    if (view === 'models' && tab) set({ view, modelsTab: tab as ModelsTab })
    else if (view === 'settings' && tab) set({ view, settingsTab: tab as SettingsTab })
    else set({ view })
  },

  update(patch) {
    const cur = get().settings
    if (!cur) return
    const p = typeof patch === 'function' ? patch(cur) : patch
    set({ settings: { ...cur, ...p } })
    pending++
    invoke('settings:update', p)
      .then((s) => {
        pending--
        if (pending === 0) set({ settings: s })
      })
      .catch((e) => {
        pending--
        get().toast('error', errorText(e))
      })
  },

  async refreshModels(force = false) {
    set({ modelsLoading: true })
    try {
      set({ models: await invoke('models:list', force) })
    } catch (e) {
      get().toast('error', errorText(e))
    } finally {
      set({ modelsLoading: false })
    }
  },

  toast(kind, text) {
    const id = toastId++
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }].slice(-4) }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 9000 : 4500)
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  }
}))

export const useSettings = (): Settings => useApp((s) => s.settings)!
