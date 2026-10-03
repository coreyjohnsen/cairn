import { create } from 'zustand'
import type { DownloadItem, EngineId, EngineInstallProgress, EngineStatus, GpuInfo, ImageWeightFile, LlamaStatus, LocalModelFile, McpStatus, ToolInfo } from '@shared/types'
import { invoke, on } from '@/lib/api'
import { errorText } from '@/lib/format'
import { useApp } from './app'
import { useImages } from './images'

interface LibraryState {
  gpu: GpuInfo | null
  engines: Partial<Record<EngineId, EngineStatus>>
  install: Partial<Record<EngineId, EngineInstallProgress>>
  downloads: DownloadItem[]
  llama: LlamaStatus
  gguf: LocalModelFile[]
  weights: ImageWeightFile[]
  mcp: McpStatus[]
  tools: ToolInfo[]
  init(): Promise<void>
  refreshGpu(force?: boolean): Promise<void>
  refreshEngine(id: EngineId): Promise<void>
  refreshFiles(): Promise<void>
  refreshTools(): Promise<void>
}

export const useLibrary = create<LibraryState>()((set, get) => ({
  gpu: null,
  engines: {},
  install: {},
  downloads: [],
  llama: { state: 'stopped', log: [] },
  gguf: [],
  weights: [],
  mcp: [],
  tools: [],

  async init() {
    on('engines:progress', (p) => {
      set((s) => ({ install: { ...s.install, [p.engine]: p } }))
      if (p.phase === 'done') {
        void get().refreshEngine(p.engine)
        // The upscale engine brings its own models, so the upscaler lists change when it is installed.
        if (p.engine === 'esrgan') void useImages.getState().refreshAssets()
      }
    })
    on('engines:changed', (id) => {
      void get().refreshEngine(id)
      if (id === 'esrgan') void useImages.getState().refreshAssets()
    })
    on('llama:status', (l) => set({ llama: l }))
    on('mcp:status', (mcp) => {
      set({ mcp })
      void get().refreshTools()
    })
    on('downloads:update', (d) => {
      set((s) => ({ downloads: s.downloads.some((x) => x.id === d.id) ? s.downloads.map((x) => (x.id === d.id ? d : x)) : [...s.downloads, d] }))
      if (d.status === 'done') {
        void get().refreshFiles()
        void useApp.getState().refreshModels(true)
      }
    })
    const [downloads, llama, mcp] = await Promise.all([invoke('downloads:list'), invoke('llama:status'), invoke('mcp:status')])
    set({ downloads, llama, mcp })
    void get().refreshEngine('llama')
    void get().refreshEngine('sd')
    void get().refreshEngine('esrgan')
    void get().refreshGpu()
    void get().refreshFiles()
    void get().refreshTools()
  },

  async refreshGpu(force = false) {
    try {
      set({ gpu: await invoke('engines:gpu', force) })
    } catch (e) {
      useApp.getState().toast('error', errorText(e))
    }
  },

  async refreshEngine(id) {
    try {
      const st = await invoke('engines:status', id)
      set((s) => ({ engines: { ...s.engines, [id]: st } }))
    } catch {
      /* shown in the Engines tab when it matters */
    }
  },

  async refreshFiles() {
    try {
      const [gguf, weights] = await Promise.all([invoke('library:gguf'), invoke('library:imageWeights')])
      set({ gguf, weights })
    } catch {
      /* ignore */
    }
  },

  async refreshTools() {
    try {
      set({ tools: await invoke('tools:list') })
    } catch {
      /* ignore */
    }
  }
}))
