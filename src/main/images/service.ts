import type { ImageBackendConfig, ImageGenRequest, ImageJob, ImageRecord, ImageRef, ImageStage, ImageTargetOption, Settings } from '@shared/types'
import { profileFor, snapSize } from '@shared/imageSize'
import { expandAliases } from '@shared/imagePrefs'
import { IMPORT_MAX_BYTES, IMPORT_MAX_SIDE, clampStrength, sizeLikePicture } from '@shared/img2img'
import path from 'node:path'
import { newId } from '@shared/defaults'
import { emit } from '../events'
import type { EngineManager } from '../engines/manager'
import type { ImageApi } from '../agent/runner'
import { A1111Backend } from './a1111'
import { InpaintError, type PreparedInpaint, prepareInpaint } from './inpaint'
import { isPng } from './pixels'
import { loraDirOf, resolveLora, scanLoras, scanUpscalers, upscaleDirOf } from './assets'
import { ComfyBackend } from './comfyui'
import { EsrganUpscaler } from './esrgan'
import { OpenAIImagesBackend } from './openai-images'
import { SdCppBackend } from './sdcpp'
import { imageSize } from './size'
import type { ImageStore } from './store'
import { BackendError, type BackendModel, type GenParams, type ImageBackend, randomSeed, sniffImageExt } from './types'

export interface ImageServiceDeps {
  getSettings(): Settings
  store: ImageStore
  engines: EngineManager
  llama: { unloadForImages(): Promise<boolean> }
  tmpDir: string
  /** The models folder; LoRAs and upscalers live under it (image/lora, image/upscale). */
  modelsDir?: () => string
  /** Test seam: replace backend construction. */
  makeBackend?: (cfg: ImageBackendConfig) => ImageBackend
  /** Test seam: replace the Real-ESRGAN upscaler. */
  makeEsrgan?: () => Pick<EsrganUpscaler, 'upscale'>
}

/** An upscaler chosen for a job: where it is, how many passes, and which program runs it. */
interface ChosenUpscaler {
  path: string
  repeats: number
  engine: 'esrgan' | 'sd'
}

interface JobEntry {
  job: ImageJob
  controller: AbortController
  listeners: Set<(fraction: number, label?: string, stage?: ImageStage) => void>
  promise: Promise<ImageRecord[]>
  resolve(v: ImageRecord[]): void
  reject(e: unknown): void
  lastEmit: number
}

const TARGET_TTL_MS = 30_000
const KEEP_FINISHED_JOBS = 40
const FALLBACK_SIZE = 768

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

export function toRef(r: ImageRecord): ImageRef {
  return { id: r.id, file: r.file, thumb: r.thumb, prompt: r.prompt, width: r.width, height: r.height }
}

export class ImageService implements ImageApi {
  private jobs = new Map<string, JobEntry>()
  private queue: string[] = []
  private pumping = false
  /** Masks sent by the interface, kept briefly until the job that uses them runs. */
  private masks = new Map<string, Uint8Array>()
  private targetCache = new Map<string, { at: number; options: ImageTargetOption[] }>()

  private esrganInstance?: Pick<EsrganUpscaler, 'upscale'>

  constructor(private d: ImageServiceDeps) {}

  /** Real-ESRGAN (ncnn) upscaler; made on first use. */
  private esrgan(): Pick<EsrganUpscaler, 'upscale'> {
    return (this.esrganInstance ??= this.d.makeEsrgan ? this.d.makeEsrgan() : new EsrganUpscaler({ engines: this.d.engines, tmpDir: this.d.tmpDir }))
  }

  /* ───────────────────────────── backends & targets ───────────────────────────── */

  private backend(cfg: ImageBackendConfig): ImageBackend {
    if (this.d.makeBackend) return this.d.makeBackend(cfg)
    switch (cfg.kind) {
      case 'builtin':
        return new SdCppBackend({ getSettings: this.d.getSettings, engines: this.d.engines, tmpDir: this.d.tmpDir })
      case 'comfyui':
        return new ComfyBackend(cfg)
      case 'a1111':
        return new A1111Backend(cfg)
      case 'openai':
        return new OpenAIImagesBackend(cfg)
    }
  }

  invalidate(): void {
    this.targetCache.clear()
  }

  /** Cheap synchronous check used to decide whether the model is offered the generate_image tool. */
  available(): boolean {
    const s = this.d.getSettings()
    return s.image.backends.some((b) => {
      if (!b.enabled) return false
      if (b.kind === 'builtin') return s.image.localModels.length > 0 && !!this.d.engines.resolveBinary('sd')
      if (b.kind === 'openai') return !!b.apiKey || !!b.baseUrl
      return !!b.baseUrl
    })
  }

  private async optionsFor(cfg: ImageBackendConfig, force: boolean): Promise<ImageTargetOption[]> {
    const cached = this.targetCache.get(cfg.id)
    if (!force && cached && Date.now() - cached.at < TARGET_TTL_MS) return cached.options

    const base = { backendId: cfg.id, backendName: cfg.name, kind: cfg.kind }
    const be = this.backend(cfg)
    let options: ImageTargetOption[]
    try {
      let reason: string | undefined
      if (cfg.kind === 'builtin' && !this.d.engines.resolveBinary('sd')) reason = 'The image engine is not installed yet (Models → Engines).'
      const models: BackendModel[] = await withTimeout(be.listModels(), 6000, `${cfg.name}`)
      if (!models.length) {
        options = [
          {
            ...base,
            model: '',
            label: cfg.name,
            supportsImg2Img: be.supportsImg2Img,
            supportsMask: be.supportsInpaint,
            supportsNegative: be.supportsNegative,
            supportsLora: cfg.kind === 'builtin',
            available: false,
            unavailableReason: cfg.kind === 'builtin' ? 'No image models yet. Add one in Models → Image models.' : 'No models were reported by this backend.'
          }
        ]
      } else {
        options = models.map((m) => ({
          ...base,
          model: m.id,
          label: m.label,
          supportsImg2Img: be.supportsImg2Img,
          supportsMask: be.supportsInpaint,
          supportsNegative: be.supportsNegative,
          supportsLora: cfg.kind === 'builtin',
          defaults: m.defaults,
          arch: m.arch,
          vaeTiling: m.vaeTiling,
          available: !reason,
          unavailableReason: reason
        }))
      }
    } catch (e) {
      options = [
        {
          ...base,
          model: cfg.defaultModel,
          label: cfg.name,
          supportsImg2Img: be.supportsImg2Img,
          supportsMask: be.supportsInpaint,
          supportsNegative: be.supportsNegative,
          available: false,
          unavailableReason: e instanceof Error ? e.message : String(e)
        }
      ]
    }
    this.targetCache.set(cfg.id, { at: Date.now(), options })
    return options
  }

  async targets(force = false): Promise<ImageTargetOption[]> {
    const s = this.d.getSettings()
    const live = new Set(s.image.backends.map((b) => b.id))
    for (const id of [...this.targetCache.keys()]) if (!live.has(id)) this.targetCache.delete(id)
    const groups = await Promise.all(s.image.backends.filter((b) => b.enabled).map((b) => this.optionsFor(b, force)))
    return groups.flat()
  }

  /** Only the models that run on this computer. Quick, because it never waits for a remote connection (used when sharing models with other programs). */
  async builtinTargets(): Promise<ImageTargetOption[]> {
    const s = this.d.getSettings()
    const groups = await Promise.all(s.image.backends.filter((b) => b.enabled && b.kind === 'builtin').map((b) => this.optionsFor(b, false)))
    return groups.flat().filter((o) => o.model)
  }

  async testBackend(backendId: string): Promise<{ ok: boolean; message: string }> {
    const cfg = this.d.getSettings().image.backends.find((b) => b.id === backendId)
    if (!cfg) return { ok: false, message: 'That connection no longer exists.' }
    try {
      const message = await withTimeout(this.backend(cfg).test(), 20_000, 'The connection test')
      this.targetCache.delete(cfg.id)
      return { ok: true, message }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }

  /* ───────────────────────────── jobs ───────────────────────────── */

  listJobs(): ImageJob[] {
    return [...this.jobs.values()].map((e) => e.job).sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Queue a request and return immediately (used by the Image Hub). */
  submit(req: ImageGenRequest): ImageJob {
    return this.enqueue(req).job
  }

  /** Queue a request and wait for it (used by chat). */
  async generate(req: ImageGenRequest, hooks: { onProgress(fraction: number, label?: string, stage?: ImageStage): void; signal: AbortSignal }): Promise<ImageRef[]> {
    const entry = this.enqueue(req)
    entry.listeners.add(hooks.onProgress)
    const onAbort = () => this.cancel(entry.job.id)
    if (hooks.signal.aborted) onAbort()
    else hooks.signal.addEventListener('abort', onAbort, { once: true })
    try {
      return (await entry.promise).map(toRef)
    } finally {
      hooks.signal.removeEventListener('abort', onAbort)
      entry.listeners.delete(hooks.onProgress)
    }
  }

  cancel(jobId: string): void {
    const e = this.jobs.get(jobId)
    if (!e) return
    if (e.job.status === 'queued') {
      this.queue = this.queue.filter((id) => id !== jobId)
      this.finish(e, 'cancelled', undefined, new BackendError('Cancelled'))
    } else if (e.job.status === 'running') {
      e.controller.abort()
    }
  }

  private enqueue(req: ImageGenRequest): JobEntry {
    const prompt = (req.prompt ?? '').trim()
    let resolve!: (v: ImageRecord[]) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<ImageRecord[]>((res, rej) => {
      resolve = res
      reject = rej
    })
    promise.catch(() => {}) // hub jobs have no awaiter; failures are reported through job events

    const entry: JobEntry = {
      job: { id: newId('job'), status: 'queued', request: { ...req, prompt }, progress: 0, resultIds: [], createdAt: Date.now() },
      controller: new AbortController(),
      listeners: new Set(),
      promise,
      resolve,
      reject,
      lastEmit: 0
    }
    this.jobs.set(entry.job.id, entry)
    emit('images:job', { ...entry.job })
    if (!prompt) {
      this.finish(entry, 'error', 'Describe the image you want first.', new BackendError('Describe the image you want first.'))
      return entry
    }
    this.queue.push(entry.job.id)
    void this.pump()
    return entry
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!
        const e = this.jobs.get(id)
        if (!e || e.job.status !== 'queued') continue
        await this.runJob(e)
      }
    } finally {
      this.pumping = false
    }
  }

  private progress(e: JobEntry, fraction: number, label?: string, stage?: ImageStage): void {
    const f = clamp(Number.isFinite(fraction) ? fraction : 0, 0, 1)
    const labelChanged = label !== undefined && label !== e.job.label
    const stageChanged = stage !== undefined && stage !== e.job.stage
    e.job.progress = Math.max(e.job.progress, f)
    if (label !== undefined) e.job.label = label
    if (stage !== undefined) e.job.stage = stage
    for (const l of e.listeners) {
      try {
        l(e.job.progress, e.job.label, e.job.stage)
      } catch {
        /* a listener must never break generation */
      }
    }
    const now = Date.now()
    if (labelChanged || stageChanged || now - e.lastEmit > 120) {
      e.lastEmit = now
      emit('images:job', { ...e.job })
    }
  }

  private finish(e: JobEntry, status: 'done' | 'error' | 'cancelled', error?: string, rejection?: unknown, records?: ImageRecord[]): void {
    e.job.status = status
    e.job.error = status === 'error' ? error : undefined
    e.job.label = status === 'done' ? 'Done' : status === 'cancelled' ? 'Cancelled' : e.job.label
    e.job.stage = undefined
    if (status === 'done') e.job.progress = 1
    e.job.resultIds = (records ?? []).map((r) => r.id)
    emit('images:job', { ...e.job })
    if (status === 'done') e.resolve(records ?? [])
    else e.reject(rejection ?? new BackendError(error ?? 'Failed'))
    this.trimJobs()
  }

  private trimJobs(): void {
    const finished = [...this.jobs.values()].filter((e) => e.job.status === 'done' || e.job.status === 'error' || e.job.status === 'cancelled').sort((a, b) => b.job.createdAt - a.job.createdAt)
    for (const e of finished.slice(KEEP_FINISHED_JOBS)) this.jobs.delete(e.job.id)
  }

  private async runJob(e: JobEntry): Promise<void> {
    e.job.status = 'running'
    e.job.progress = 0.01
    e.job.label = 'Starting…'
    emit('images:job', { ...e.job })
    try {
      const records = await this.execute(e)
      this.finish(e, 'done', undefined, undefined, records)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (e.controller.signal.aborted || msg === 'Cancelled') this.finish(e, 'cancelled', undefined, err)
      else this.finish(e, 'error', msg, err)
    }
  }

  /* ───────────────────────────── execution ───────────────────────────── */

  private async resolveTarget(req: ImageGenRequest): Promise<{ cfg: ImageBackendConfig; opt: ImageTargetOption | undefined; model: string }> {
    const s = this.d.getSettings()
    const options = await this.targets()
    const wanted = req.target ?? s.image.defaultTarget
    if (wanted) {
      const cfg = s.image.backends.find((b) => b.id === wanted.backendId)
      if (cfg && cfg.enabled) {
        const opt = options.find((o) => o.backendId === cfg.id && o.model === wanted.model)
        if (opt || wanted.model) return { cfg, opt, model: wanted.model }
      }
      // The saved default points at something that no longer exists: fall through to the first usable target.
    }
    const first = options.find((o) => o.available)
    if (first) {
      const cfg = s.image.backends.find((b) => b.id === first.backendId)!
      return { cfg, opt: first, model: first.model }
    }
    const why = options.find((o) => o.unavailableReason)?.unavailableReason
    throw new BackendError(`No image model is ready yet. ${why ?? 'Open the Image Hub and set one up under Models → Image models.'}`)
  }

  /** The LoRA and upscaler folders. */
  private folders(): { lora: string; upscale: string } {
    const root = this.d.modelsDir?.()
    if (!root) throw new BackendError('The models folder is not known.')
    return { lora: loraDirOf(root), upscale: upscaleDirOf(root) }
  }

  async listLoras() {
    const root = this.d.modelsDir?.()
    return root ? scanLoras(loraDirOf(root)) : []
  }

  async listUpscalers() {
    const root = this.d.modelsDir?.()
    return scanUpscalers(root ? upscaleDirOf(root) : '', this.d.engines.esrganModelsDir())
  }

  /** The upscaler to use, which must be one that listUpscalers finds (the upscale folder, or the models that came with the Real-ESRGAN download). */
  private async upscalerFor(choice: { path: string; repeats?: number }): Promise<ChosenUpscaler> {
    const found = (await this.listUpscalers()).find((u) => path.resolve(u.path) === path.resolve(choice.path))
    if (!found) throw new BackendError('That upscaler is no longer in the upscaler folder (Models, Image models, Upscalers).')
    return { path: found.path, repeats: clamp(Math.round(choice.repeats ?? 1), 1, 3), engine: found.engine }
  }

  /** Enlarge a picture with the program that runs the chosen upscaler. Real-ESRGAN works with any picture; the built-in engine only with its own. */
  private async enlarge(bytes: Uint8Array, up: ChosenUpscaler, cfg: ImageBackendConfig | undefined, hooks: Parameters<ImageBackend['generate']>[1], label?: string) {
    if (up.engine === 'esrgan') return this.esrgan().upscale(bytes, up, hooks, label)
    if (!cfg) throw new BackendError('This upscaler needs the built-in image engine. Turn it on under Models, Image models, or choose a Real-ESRGAN upscaler.')
    const be = this.backend(cfg)
    if (!be.upscale) throw new BackendError('This image engine cannot upscale pictures.')
    return be.upscale(bytes, up, hooks)
  }

  /** Make an existing picture bigger instead of drawing a new one. */
  private async executeUpscale(e: JobEntry): Promise<ImageRecord[]> {
    const req = e.job.request
    const settings = this.d.getSettings()
    if (!req.upscale) throw new BackendError('Choose an upscaler first.')
    const source = this.d.store.get(req.upscaleOf!)
    const bytes = source ? await this.d.store.readBytes(source.id) : null
    if (!source || !bytes) throw new BackendError('The picture to upscale no longer exists.')
    const up = await this.upscalerFor(req.upscale)
    // Real-ESRGAN works on any picture; only stable-diffusion.cpp's own upscaler needs the built-in engine.
    const cfg = settings.image.backends.find((b) => b.kind === 'builtin' && b.enabled)
    if (up.engine === 'sd' && !cfg) throw new BackendError('This upscaler needs the built-in image engine. Turn it on under Models, Image models, or choose a Real-ESRGAN upscaler.')
    if (settings.image.unloadLlmForImages) {
      this.progress(e, 0.01, 'Freeing GPU memory…')
      await this.d.llama.unloadForImages().catch(() => false)
    }
    const started = Date.now()
    const out = await this.enlarge(bytes, up, cfg, { signal: e.controller.signal, onProgress: (f, label, stage) => this.progress(e, f, label, stage) })
    if (e.controller.signal.aborted) throw new BackendError('Cancelled')
    const durationMs = Date.now() - started
    const records: ImageRecord[] = []
    for (const img of out) {
      const size = imageSize(img.data)
      records.push(
        await this.d.store.add(img.data, {
          prompt: source.prompt,
          negativePrompt: source.negativePrompt,
          backendId: source.backendId,
          backendName: source.backendName,
          model: source.model,
          width: size?.width ?? source.width,
          height: size?.height ?? source.height,
          steps: source.steps,
          cfgScale: source.cfgScale,
          seed: source.seed,
          sampler: source.sampler,
          durationMs,
          source: req.source,
          conversationId: req.conversationId,
          loras: source.loras,
          upscaler: path.basename(up.path).replace(/\.[^.]+$/, ''),
          upscaledFrom: source.id
        })
      )
    }
    return records
  }

  /** Keep a mask (a PNG, white where the picture should be repainted) for a job that is about to be submitted. */
  setMask(png: Uint8Array): string {
    if (!png || png.length === 0) throw new BackendError('The mask is empty.')
    if (png.length > IMPORT_MAX_BYTES) throw new BackendError('The mask is too big.')
    const bytes = png instanceof Uint8Array ? png : new Uint8Array(png)
    const size = imageSize(bytes)
    if (!isPng(bytes) || !size) throw new BackendError('The mask must be a PNG picture.')
    if (size.width > IMPORT_MAX_SIDE || size.height > IMPORT_MAX_SIDE || size.width < 8 || size.height < 8) throw new BackendError(`The mask size (${size.width} × ${size.height}) is not usable.`)
    const id = newId('mask_')
    this.masks.set(id, bytes)
    // Only the most recent few are kept.
    while (this.masks.size > 16) this.masks.delete(this.masks.keys().next().value as string)
    return id
  }

  /** Bring a picture from a file into the library so it can be used as a starting image. */
  async importPicture(name: string, data: Uint8Array): Promise<ImageRecord> {
    if (!data || data.length === 0) throw new BackendError('That file is empty.')
    if (data.length > IMPORT_MAX_BYTES) throw new BackendError(`That picture is too big (${Math.round(data.length / 1048576)} MB). The limit is ${Math.round(IMPORT_MAX_BYTES / 1048576)} MB.`)
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    const size = imageSize(bytes)
    if (!size) throw new BackendError('That file is not a PNG, JPEG or WebP picture.')
    if (size.width > IMPORT_MAX_SIDE || size.height > IMPORT_MAX_SIDE) throw new BackendError(`That picture is ${size.width} × ${size.height}; the most allowed is ${IMPORT_MAX_SIDE} on a side.`)
    if (size.width < 64 || size.height < 64) throw new BackendError(`That picture is only ${size.width} × ${size.height}, too small to start from.`)
    // eslint-disable-next-line no-control-regex
    const label = path.basename(String(name ?? '')).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || 'Picture'
    return this.d.store.add(bytes, {
      prompt: label,
      negativePrompt: '',
      backendId: 'import',
      backendName: 'Imported',
      model: '',
      width: size.width,
      height: size.height,
      seed: 0,
      durationMs: 0,
      source: 'hub',
      imported: true
    })
  }

  private async execute(e: JobEntry): Promise<ImageRecord[]> {
    const req = e.job.request
    if (req.upscaleOf) return this.executeUpscale(e)
    const settings = this.d.getSettings()
    const { cfg, opt, model } = await this.resolveTarget(req)
    if (opt && !opt.available) throw new BackendError(opt.unavailableReason ?? `${cfg.name} is not available right now.`)
    if (!model && cfg.kind === 'builtin') throw new BackendError('Pick an image model first.')
    const be = this.backend(cfg)
    const signal = e.controller.signal
    if (signal.aborted) throw new BackendError('Cancelled')

    const d = opt?.defaults
    // Steps and guidance the user saved for this model come before the model's own defaults, for every way of asking for a picture.
    const saved = settings.image.modelDefaults?.[`${cfg.id}::${model}`]
    const official = cfg.kind === 'openai'
    let width = req.width > 0 ? req.width : d?.width ?? (official ? 1024 : FALLBACK_SIZE)
    let height = req.height > 0 ? req.height : d?.height ?? (official ? 1024 : FALLBACK_SIZE)
    const stepsWanted = req.steps ?? saved?.steps ?? d?.steps ?? 0
    // Some model types (FLUX, SD3, Z-Image) need sizes in multiples of 16 rather than 8.
    const sd = cfg.kind === 'builtin' ? settings.image.localModels.find((m) => m.id === model) : undefined
    const multiple = profileFor(sd?.arch, sd?.name)?.multiple ?? 8

    let initImage: Uint8Array | undefined
    if (req.initImageId) {
      if (!be.supportsImg2Img) throw new BackendError(`${cfg.name} does not support image-to-image. Choose a different image model for this.`)
      initImage = (await this.d.store.readBytes(req.initImageId)) ?? undefined
      if (!initImage) throw new BackendError('The source image for image-to-image no longer exists.')
      // The built-in engine reads PNG and JPEG; WebP cannot be decoded there.
      if (cfg.kind === 'builtin' && sniffImageExt(initImage) === 'webp') {
        throw new BackendError('The built-in engine cannot start from a WebP picture. Save it as PNG or JPEG first, or bring it in again with "Start from a picture", which converts it.')
      }
      // With no size asked for, the result takes the starting picture's shape, so the picture is not stretched.
      const pic = imageSize(initImage)
      if (pic && !(req.width > 0) && !(req.height > 0)) {
        const s = sizeLikePicture(pic, width * height, multiple)
        width = s.width
        height = s.height
      }
    }

    // LoRAs and upscalers belong to the built-in engine; check them before anything slow starts.
    let loras: GenParams['loras']
    let loraDir: string | undefined
    if (req.loras?.length) {
      if (cfg.kind !== 'builtin') throw new BackendError(`LoRAs only work with the built-in image engine, not ${cfg.name}. Choose a built-in model, or remove the LoRAs.`)
      loraDir = this.folders().lora
      loras = []
      for (const l of req.loras.slice(0, 8)) {
        if (!(await resolveLora(loraDir, l.id))) throw new BackendError(`The LoRA "${l.id}" is no longer in the LoRA folder. Remove it or put the file back.`)
        loras.push({ id: l.id, strength: clamp(Number.isFinite(l.strength) ? l.strength : 1, -2, 2) })
      }
    }
    let upscale: ChosenUpscaler | undefined
    if (req.upscale) {
      upscale = await this.upscalerFor(req.upscale)
      if (upscale.engine === 'sd' && cfg.kind !== 'builtin') {
        throw new BackendError(`This upscaler only works with the built-in image engine, not ${cfg.name}. Choose a Real-ESRGAN upscaler instead.`)
      }
    }
    // Painting a mask: cut the starting picture and the mask to what the engine will see, and remember how to blend the result back.
    let inpaint: PreparedInpaint | undefined
    if (req.inpaint) {
      if (!initImage) throw new BackendError('A mask needs a starting picture. Choose one under "Starting image".')
      if (!be.supportsInpaint) throw new BackendError(`${cfg.name} cannot use a mask. Choose a built-in or AUTOMATIC1111 model, or remove the mask.`)
      if (upscale?.engine === 'sd') throw new BackendError('The built-in upscaler cannot be combined with a mask. Choose a Real-ESRGAN upscaler, or switch upscaling off.')
      const maskPng = this.masks.get(req.inpaint.maskId)
      if (!maskPng) throw new BackendError('The mask is no longer available. Open the mask editor and press Done again.')
      try {
        inpaint = prepareInpaint({
          init: initImage,
          mask: maskPng,
          area: req.inpaint.area === 'whole' ? 'whole' : 'masked',
          feather: Number.isFinite(req.inpaint.feather) ? req.inpaint.feather : 12,
          padding: Number.isFinite(req.inpaint.padding) ? req.inpaint.padding : 64,
          width: snapSize(width, multiple),
          height: snapSize(height, multiple),
          multiple
        })
      } catch (err) {
        throw err instanceof InpaintError ? new BackendError(err.message) : err
      }
      initImage = inpaint.init
      width = inpaint.width
      height = inpaint.height
    }
    const triggers = (req.loras ?? []).map((l) => l.trigger?.trim()).filter((t): t is string => !!t)
    // Aliases the user defined are replaced by what they stand for; the picture's record keeps the expanded text, which is what the model saw.
    const prompt = expandAliases(req.prompt, settings.image.aliases).text

    const params: GenParams = {
      prompt: triggers.length ? `${triggers.join(', ')}, ${prompt}` : prompt,
      negative: be.supportsNegative ? expandAliases(req.negativePrompt ?? settings.image.negativePrompt ?? '', settings.image.aliases).text : '',
      width: official ? width : snapSize(width, multiple),
      height: official ? height : snapSize(height, multiple),
      steps: stepsWanted > 0 ? Math.round(stepsWanted) : official ? 0 : 25,
      cfg: req.cfgScale ?? saved?.cfg ?? d?.cfg ?? 7,
      seed: req.seed >= 0 ? Math.floor(req.seed) : randomSeed(),
      sampler: req.sampler || d?.sampler || 'euler_a',
      count: clamp(Math.round(req.count || 1), 1, 8),
      model,
      initImage,
      mask: inpaint?.mask,
      strength: initImage ? clampStrength(req.strength) : undefined,
      loras,
      loraDir,
      // stable-diffusion.cpp upscales inside its own run; Real-ESRGAN is run afterwards on the finished pictures.
      upscale: upscale?.engine === 'sd' ? { path: upscale.path, repeats: upscale.repeats } : undefined
    }

    if (cfg.kind === 'builtin' && settings.image.unloadLlmForImages) {
      this.progress(e, 0.01, 'Freeing GPU memory…')
      await this.d.llama.unloadForImages().catch(() => false)
    }

    const started = Date.now()
    const images = await be.generate(params, { signal, onProgress: (f, label, stage) => this.progress(e, f, label, stage) })
    if (signal.aborted) throw new BackendError('Cancelled')
    // With a mask, the engine's picture only replaces the masked part of the original; the rest stays as it was.
    if (inpaint) {
      this.progress(e, 0.97, 'Blending the new part into the picture…')
      for (let i = 0; i < images.length; i++) {
        try {
          images[i] = { ...images[i], data: inpaint.finish(images[i].data) }
        } catch (err) {
          throw err instanceof InpaintError ? new BackendError(err.message) : err
        }
      }
    }
    // Which pictures Real-ESRGAN actually enlarged (the built-in engine's upscaling is recorded for all of them, as before).
    const enlarged = new Set<number>()
    if (upscale?.engine === 'esrgan') {
      // The pictures are already drawn, so a failed upscale keeps them and says what went wrong.
      for (let i = 0; i < images.length; i++) {
        const n = images.length
        try {
          const [big] = await this.enlarge(images[i].data, upscale, undefined, { signal, onProgress: (f, label, stage) => this.progress(e, (i + f) / n, label, stage) }, n > 1 ? `Upscaling picture ${i + 1} of ${n}…` : 'Upscaling the finished image…')
          images[i] = { ...images[i], data: big.data }
          enlarged.add(i)
        } catch (err) {
          if (signal.aborted) throw new BackendError('Cancelled')
          images[i] = { ...images[i], warning: `The picture was drawn but could not be made bigger. ${err instanceof Error ? err.message : String(err)}` }
        }
      }
    }
    const durationMs = Date.now() - started

    const warning = images.find((i) => i.warning)?.warning
    if (warning) e.job.notice = warning

    const records: ImageRecord[] = []
    for (const img of images) {
      const size = imageSize(img.data)
      records.push(
        await this.d.store.add(img.data, {
          prompt,
          negativePrompt: params.negative,
          backendId: cfg.id,
          backendName: cfg.name,
          model: opt?.label ?? model,
          width: size?.width ?? params.width,
          height: size?.height ?? params.height,
          steps: params.steps || undefined,
          cfgScale: official ? undefined : params.cfg,
          seed: img.seed,
          sampler: official ? undefined : params.sampler,
          durationMs,
          source: req.source,
          conversationId: req.conversationId,
          initImageId: initImage ? req.initImageId : undefined,
          strength: initImage ? params.strength : undefined,
          masked: inpaint ? true : undefined,
          loras: req.loras?.length ? req.loras : undefined,
          upscaler: upscale && (upscale.engine === 'sd' || enlarged.has(images.indexOf(img))) ? path.basename(upscale.path).replace(/\.[^.]+$/, '') : undefined
        })
      )
    }
    return records
  }
}
