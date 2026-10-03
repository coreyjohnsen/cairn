import { create } from 'zustand'
import type { ImageGenRequest, ImageJob, ImageRecord, ImageTargetOption, LoraFile, LoraSelection, UpscalerFile } from '@shared/types'
import { invoke, on } from '@/lib/api'
import { errorText } from '@/lib/format'
import { type Ratio, resolveSize } from '@/lib/imageSize'
import { pictureToPng } from '@/lib/pictureFile'
import { useApp } from './app'

export type { Ratio }

/** What the next picture starts from: only the words, a picture, or a picture with just part of it repainted. */
export type StartMode = 'text' | 'image' | 'mask'

/** The Image Hub's create panel. Lives in the store so "reuse settings" from anywhere can fill it in. */
export interface HubForm {
  prompt: string
  /** undefined = the default negative prompt from settings */
  negative?: string
  /** `${backendId}::${model}`; empty = default target */
  targetKey: string
  ratio: Ratio
  customW: number
  customH: number
  /** Multiplier on the model's own size, used with the shape buttons. */
  scale: number
  steps?: number
  cfg?: number
  sampler?: string
  seed: number
  count: number
  /** `text` ignores the starting picture, which stays chosen in case the person switches back. */
  startMode: StartMode
  initImageId?: string
  strength: number
  /** Part of the starting picture to repaint: white where it changes. Only for the picture it was painted on. */
  mask?: { png: Uint8Array; preview: string; coverage: number }
  /** Send only the masked part (sharper detail) or the whole picture to the engine. */
  inpaintArea: 'masked' | 'whole'
  /** Width of the soft edge where new meets old, in pixels of the starting picture. */
  feather: number
  /** Margin kept around the mask when only the masked part is sent. */
  padding: number
  /** LoRAs to apply (built-in engine only). */
  loras: LoraSelection[]
  /** Make the finished picture bigger with this upscaler. */
  upscale?: { path: string; repeats: number }
  /** The user switched "Upscale when done" off, so the default upscaler is not applied. */
  upscaleOff?: boolean
}

export const DEFAULT_FORM: HubForm = { prompt: '', targetKey: '', ratio: 'auto', customW: 1024, customH: 1024, scale: 1, seed: -1, count: 1, startMode: 'text', strength: 0.6, inpaintArea: 'masked', feather: 12, padding: 64, loras: [] }

export const targetKeyOf = (t: { backendId: string; model: string }): string => `${t.backendId}::${t.model}`

interface ImagesState {
  records: ImageRecord[]
  jobs: Record<string, ImageJob>
  dismissed: Record<string, true>
  targets: ImageTargetOption[]
  targetsLoading: boolean
  /** LoRA and upscaler files found in the models folder. */
  loraFiles: LoraFile[]
  upscalers: UpscalerFile[]
  form: HubForm
  /** Opened in the lightbox, with the ids it can step through. */
  viewing: string | null
  siblings: string[]
  /** The mask editor is open on the starting picture. */
  maskEditorOpen: boolean
  /** The picture or job shown big in the Image Hub: a picture id, or `job:` and a job id. Null follows the newest. */
  focus: string | null
  init(): Promise<void>
  refreshTargets(force?: boolean): Promise<void>
  refreshAssets(): Promise<void>
  setForm(patch: Partial<HubForm>): void
  /** Copy a finished image's settings into the create panel. */
  reuse(rec: ImageRecord, opts?: { asInit?: boolean; mask?: boolean }): void
  /** Bring a picture from a file, the clipboard or a drop in as the starting image. */
  importPicture(file: Blob, name?: string): Promise<ImageRecord | null>
  generate(req: Omit<ImageGenRequest, 'source'>): Promise<string | null>
  cancel(jobId: string): void
  dismissJob(jobId: string): void
  remove(ids: string[]): Promise<void>
  favorite(id: string, fav: boolean): void
  view(id: string | null, siblings?: string[]): void
  openMaskEditor(open: boolean): void
  setFocus(key: string | null): void
}

const byNewest = (a: ImageRecord, b: ImageRecord) => b.createdAt - a.createdAt

function ratioFor(w: number, h: number): Ratio {
  const r = w / h
  const near = (x: number) => Math.abs(r - x) < 0.02
  if (near(1)) return '1:1'
  if (near(3 / 4)) return '3:4'
  if (near(4 / 3)) return '4:3'
  if (near(16 / 9)) return '16:9'
  if (near(9 / 16)) return '9:16'
  return 'custom'
}

export const useImages = create<ImagesState>()((set, get) => ({
  records: [],
  jobs: {},
  dismissed: {},
  targets: [],
  targetsLoading: false,
  loraFiles: [],
  upscalers: [],
  form: DEFAULT_FORM,
  viewing: null,
  siblings: [],
  maskEditorOpen: false,
  focus: null,

  async init() {
    on('images:added', (r) => set((s) => ({ records: [r, ...s.records.filter((x) => x.id !== r.id)].sort(byNewest) })))
    on('images:updated', (r) => set((s) => ({ records: s.records.map((x) => (x.id === r.id ? r : x)) })))
    on('images:removed', (ids) =>
      set((s) => ({ records: s.records.filter((x) => !ids.includes(x.id)), viewing: s.viewing && ids.includes(s.viewing) ? null : s.viewing, siblings: s.siblings.filter((x) => !ids.includes(x)) }))
    )
    on('images:job', (j) => {
      const before = get().jobs[j.id]
      set((s) => ({ jobs: { ...s.jobs, [j.id]: j } }))
      // The picture was made, but something did not work as asked (for example an upscaler that was ignored).
      if (j.status === 'done' && j.notice && before?.status !== 'done') useApp.getState().toast('error', j.notice)
    })
    const [records, jobs] = await Promise.all([invoke('images:list'), invoke('images:jobs')])
    set({ records: records.sort(byNewest), jobs: Object.fromEntries(jobs.map((j) => [j.id, j])) })
    void get().refreshTargets()
    void get().refreshAssets()
  },

  async refreshTargets(force = false) {
    set({ targetsLoading: true })
    try {
      set({ targets: await invoke('images:targets', force) })
    } catch (e) {
      useApp.getState().toast('error', errorText(e))
    } finally {
      set({ targetsLoading: false })
    }
  },

  async refreshAssets() {
    try {
      const [loraFiles, upscalers] = await Promise.all([invoke('images:loras'), invoke('images:upscalers')])
      set({ loraFiles, upscalers })
    } catch {
      /* the lists stay as they were */
    }
  },

  setForm(patch) {
    // A mask belongs to the picture it was painted on.
    set((s) => ({ form: { ...s.form, ...patch, ...('initImageId' in patch && patch.initImageId !== s.form.initImageId && !('mask' in patch) ? { mask: undefined } : {}) } }))
  },

  reuse(rec, opts) {
    const key = targetKeyOf({ backendId: rec.backendId, model: rec.model })
    const target = get().targets.find((t) => targetKeyOf(t) === key)
    const known = !!target
    // Keep a shape button only when it gives back exactly this size, otherwise pin the exact numbers.
    let ratio = ratioFor(rec.width, rec.height)
    if (ratio !== 'custom') {
      const probe = resolveSize({ ratio, customW: rec.width, customH: rec.height, scale: 1 }, target)
      if (probe.width !== rec.width || probe.height !== rec.height) ratio = 'custom'
    }
    set((s) => ({
      form: {
        ...s.form,
        prompt: rec.imported ? '' : rec.prompt,
        negative: rec.negativePrompt,
        targetKey: known ? key : s.form.targetKey,
        // "Start from this" makes a new picture of the model's usual size in the picture's shape; "Reuse settings" keeps the exact size.
        ratio: opts?.asInit ? 'auto' : ratio,
        customW: rec.width,
        customH: rec.height,
        scale: 1,
        steps: rec.steps,
        cfg: rec.cfgScale,
        sampler: rec.sampler,
        seed: rec.imported ? -1 : rec.seed,
        count: 1,
        // A picture made from another one keeps that starting picture (and how far it moved) when its settings are reused.
        initImageId: opts?.asInit ? rec.id : rec.initImageId && s.records.some((r) => r.id === rec.initImageId) ? rec.initImageId : undefined,
        startMode: opts?.asInit ? (opts.mask ? 'mask' : 'image') : rec.initImageId && s.records.some((r) => r.id === rec.initImageId) ? 'image' : 'text',
        strength: !opts?.asInit && rec.strength ? rec.strength : s.form.strength,
        mask: undefined,
        loras: rec.loras ?? [],
        upscale: undefined,
        // Reusing a picture's settings should give the same kind of picture, not add the default upscale.
        upscaleOff: true
      }
    }))
    useApp.getState().setView('images')
    set({ viewing: null })
  },

  async importPicture(file, name) {
    try {
      const png = await pictureToPng(file)
      const rec = await invoke('images:import', name || (file as File).name || 'Picture', png.data)
      set((s) => ({
        records: [rec, ...s.records.filter((x) => x.id !== rec.id)].sort(byNewest),
        // A mask belongs to the picture it was painted on.
        form: { ...s.form, initImageId: rec.id, mask: undefined, startMode: s.form.startMode === 'mask' ? 'mask' : 'image' }
      }))
      return rec
    } catch (e) {
      useApp.getState().toast('error', errorText(e))
      return null
    }
  },

  async generate(req) {
    try {
      const { jobId } = await invoke('images:generate', { ...req, source: 'hub' })
      // Show the picture being made, big; it turns into the finished picture by itself.
      set({ focus: `job:${jobId}` })
      return jobId
    } catch (e) {
      useApp.getState().toast('error', errorText(e))
      return null
    }
  },

  cancel(jobId) {
    void invoke('images:cancel', jobId)
  },

  dismissJob(jobId) {
    set((s) => ({ dismissed: { ...s.dismissed, [jobId]: true } }))
  },

  async remove(ids) {
    try {
      await invoke('images:delete', ids)
    } catch (e) {
      useApp.getState().toast('error', errorText(e))
    }
  },

  favorite(id, fav) {
    set((s) => ({ records: s.records.map((r) => (r.id === id ? { ...r, favorite: fav } : r)) }))
    void invoke('images:favorite', id, fav)
  },

  openMaskEditor(open) {
    set({ maskEditorOpen: open })
  },

  setFocus(key) {
    set({ focus: key })
  },

  view(id, siblings) {
    set({ viewing: id, siblings: id ? (siblings && siblings.includes(id) ? siblings : [id]) : [] })
  }
}))
