import type { MemoryHardware, ModelShape } from './types'

/**
 * The memory planner: works out how much memory a model needs for a chosen context length, what stays in video memory and what
 * goes to RAM, and roughly how fast the result runs. Pure arithmetic over the model's shape (read from its file) and what the
 * computer has, so the screen can answer instantly as the context slider moves.
 *
 * These are estimates (about 5 to 10 percent off, more for unusual model designs). The engine prints where it really put things when
 * a model loads, and Cairn shows that next to the estimate.
 */

export const MiB = 1048576
export const GiB = 1073741824

export type KvType = 'f16' | 'q8_0' | 'q4_0'
/** Bytes per stored value of the cache: 16-bit, and the engine's 8-bit and 4-bit block formats. */
export const KV_BYTES: Record<KvType, number> = { f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 }

/** How a model is placed in memory. */
export interface RuntimeChoice {
  contextSize: number
  /** Layers on the GPU, counted from the last one. -1 puts everything there, the output layer too. 0 uses the CPU only. */
  gpuLayers: number
  /** Mixture-of-experts: the expert weights of this many of the first layers stay in RAM. */
  nCpuMoe: number
  /** The model's working memory (cache) lives in RAM, not video memory. */
  kvInRam: boolean
  kvCache: KvType
  flashAttn: boolean
}

export interface Estimate {
  gpu: { weights: number; cache: number; compute: number; overhead: number; picture: number; total: number }
  cpu: { weights: number; cache: number; compute: number; total: number }
  layersOnGpu: number
  outputOnGpu: boolean
  expertLayersInRam: number
  /** What can be used: what the computer has, less room kept for the screen, other programs and the system. */
  vramBudget: number
  ramBudget: number
  fitsGpu: boolean
  fitsRam: boolean
}

export type Verdict = 'gpu' | 'experts' | 'split' | 'cpu' | 'too-big'
export type SpeedLabel = 'smooth' | 'fine' | 'slow' | 'crawl'

export interface Speed {
  tokensPerSecond: number
  label: SpeedLabel
  /** How long a long prompt takes to read compared with an all-GPU run. */
  reading: 'quick' | 'slower' | 'slow'
}

export interface Plan {
  choice: RuntimeChoice
  estimate: Estimate
  speed: Speed
  verdict: Verdict
  fits: boolean
  headline: string
  detail: string[]
  warnings: string[]
}

const UBATCH = 512
const PAD = 256
const GPU_RUNTIME_OVERHEAD = 384 * MiB
const GPU_COMPUTE_BASE = 320 * MiB
const CPU_COMPUTE_BASE = 160 * MiB
const PICTURE_COMPUTE = 256 * MiB

/** Video memory kept free for the screen, the desktop and other programs. */
export const gpuReserve = (vramBytes: number): number => Math.max(640 * MiB, vramBytes * 0.06)
/** RAM kept free for the system and other programs. */
export const ramReserve = (ramBytes: number): number => Math.max(3 * GiB, ramBytes * 0.15)

const padTo = (n: number, to: number) => Math.ceil(n / to) * to

/** Positions in the cache one layer keeps: all of the context, or only the window of recent text for sliding-window layers. */
export function cacheCells(shape: ModelShape, layer: number, contextSize: number): number {
  const all = padTo(Math.max(1, contextSize), PAD)
  if (shape.swaLayers?.[layer] && shape.slidingWindow > 0) return Math.min(all, padTo(shape.slidingWindow + UBATCH, PAD))
  return all
}

/** Cache type that is really used: the 8-bit and 4-bit forms need flash attention. */
export const effectiveKv = (c: Pick<RuntimeChoice, 'kvCache' | 'flashAttn'>): KvType => (c.flashAttn ? c.kvCache : 'f16')

/** Bytes the cache holds per position in one layer. */
export function cacheBytesPerCell(shape: ModelShape, kv: KvType): number {
  const el = KV_BYTES[kv]
  if (shape.mlaDim) return shape.mlaDim * el
  return shape.kvHeads * (shape.headDimK + shape.headDimV) * el
}

/** Total cache for the whole model at a context length. */
export function cacheTotal(shape: ModelShape, contextSize: number, kv: KvType): number {
  let total = 0
  const per = cacheBytesPerCell(shape, kv)
  for (let il = 0; il < shape.layers; il++) total += per * cacheCells(shape, il, contextSize)
  return total
}

/** Where each part of the weights goes for a choice (llama.cpp puts the LAST layers on the GPU, and the output layer only when -ngl is above the layer count). */
function placement(shape: ModelShape, choice: RuntimeChoice, hasGpu: boolean) {
  const L = shape.layers
  const ngl = !hasGpu ? 0 : choice.gpuLayers < 0 ? L + 1 : choice.gpuLayers
  const gpuLayers = Math.min(Math.max(ngl, 0), L)
  return { ngl, gpuLayers, start: L - gpuLayers, outputOnGpu: ngl >= L + 1 }
}

export function estimateMemory(shape: ModelShape, choice: RuntimeChoice, hw: MemoryHardware): Estimate {
  const hasGpu = hw.vramMB > 0 && hw.backend !== 'cpu'
  const pl = placement(shape, choice, hasGpu)
  const kv = effectiveKv(choice)
  const perCell = cacheBytesPerCell(shape, kv)

  let gpuW = 0
  let cpuW = shape.embedBytes
  let expertLayersInRam = 0
  for (let il = 0; il < shape.layers; il++) {
    const bytes = shape.layerBytes[il] ?? 0
    if (il >= pl.start && pl.gpuLayers > 0) {
      const experts = il < choice.nCpuMoe ? (shape.layerExpertBytes[il] ?? 0) : 0
      if (experts > 0) expertLayersInRam++
      gpuW += bytes - experts
      cpuW += experts
    } else cpuW += bytes
  }
  if (pl.outputOnGpu) gpuW += shape.outputBytes
  else if (!shape.outputTied) cpuW += shape.outputBytes
  // Small leftovers (rotary tables and the like) travel with the GPU part when there is one.
  if (pl.gpuLayers > 0) gpuW += shape.otherBytes
  else cpuW += shape.otherBytes

  let gpuC = 0
  let cpuC = 0
  for (let il = 0; il < shape.layers; il++) {
    const bytes = perCell * cacheCells(shape, il, choice.contextSize)
    if (il >= pl.start && pl.gpuLayers > 0 && !choice.kvInRam) gpuC += bytes
    else cpuC += bytes
  }

  // Scratch space for one pass. Without flash attention the attention scores for a whole batch are held too.
  const scores = padTo(choice.contextSize, PAD) * UBATCH * Math.max(1, shape.heads) * 4
  const gpuCompute = pl.gpuLayers > 0 ? GPU_COMPUTE_BASE + (!choice.flashAttn && gpuC > 0 ? scores : 0) : 0
  const cpuAnything = cpuC > 0 || pl.gpuLayers < shape.layers || expertLayersInRam > 0 || !pl.outputOnGpu
  const cpuCompute = cpuAnything ? CPU_COMPUTE_BASE + (!choice.flashAttn && cpuC > 0 ? scores : 0) : 0

  const picture = shape.mmprojBytes > 0 && pl.gpuLayers > 0 ? shape.mmprojBytes + PICTURE_COMPUTE : 0
  const pictureCpu = shape.mmprojBytes > 0 && pl.gpuLayers === 0 ? shape.mmprojBytes : 0
  const overhead = pl.gpuLayers > 0 ? GPU_RUNTIME_OVERHEAD : 0

  const gpu = { weights: gpuW, cache: gpuC, compute: gpuCompute, overhead, picture, total: gpuW + gpuC + gpuCompute + overhead + picture }
  const cpu = { weights: cpuW + pictureCpu, cache: cpuC, compute: cpuCompute, total: cpuW + pictureCpu + cpuC + cpuCompute }
  const vramBytes = hasGpu ? hw.vramMB * MiB : 0
  const ramBytes = hw.ramMB * MiB
  const vramBudget = hasGpu ? vramBytes - gpuReserve(vramBytes) : 0
  const ramBudget = ramBytes - ramReserve(ramBytes)
  return {
    gpu,
    cpu,
    layersOnGpu: pl.gpuLayers,
    outputOnGpu: pl.outputOnGpu,
    expertLayersInRam,
    vramBudget,
    ramBudget,
    fitsGpu: gpu.total <= vramBudget,
    fitsRam: cpu.total <= ramBudget
  }
}

/* ───────────── speed ───────────── */

/** Part of the card's quoted memory speed that a model run really gets. */
const GPU_EFFICIENCY = 0.72

/**
 * Generating one word reads every weight it uses (for experts, only the chosen ones) plus the cache so far, from wherever they are.
 * Time is that much data over that memory's speed, so a layer in RAM costs roughly the ratio of the two speeds more than one on the GPU.
 */
export function estimateSpeed(shape: ModelShape, choice: RuntimeChoice, hw: MemoryHardware, est: Estimate, fill = 0.5): Speed {
  const hasGpu = hw.vramMB > 0 && hw.backend !== 'cpu'
  const pl = placement(shape, choice, hasGpu)
  const kv = effectiveKv(choice)
  const perCell = cacheBytesPerCell(shape, kv)
  const share = shape.experts > 0 ? shape.expertsUsed / shape.experts : 0
  let gpuBytes = 0
  let cpuBytes = 0
  for (let il = 0; il < shape.layers; il++) {
    const bytes = shape.layerBytes[il] ?? 0
    const exp = shape.layerExpertBytes[il] ?? 0
    const plain = bytes - exp
    const active = exp * share
    const onGpu = il >= pl.start && pl.gpuLayers > 0
    if (onGpu) {
      gpuBytes += plain
      if (il < choice.nCpuMoe) cpuBytes += active
      else gpuBytes += active
    } else cpuBytes += plain + active
    const read = perCell * Math.min(cacheCells(shape, il, choice.contextSize), Math.max(1, fill * choice.contextSize))
    if (onGpu && !choice.kvInRam) gpuBytes += read
    else cpuBytes += read
  }
  if (pl.outputOnGpu) gpuBytes += shape.outputBytes
  else cpuBytes += shape.outputTied ? shape.embedBytes : shape.outputBytes

  const gpuSpeed = Math.max(1, hw.gpuBandwidthGBs) * 1e9 * GPU_EFFICIENCY
  const cpuSpeed = Math.max(1, hw.ramBandwidthGBs) * 1e9
  // A little time per word goes to launching work and, when the model is split, to passing results between GPU and CPU.
  const overhead = 0.004 + (gpuBytes > 0 && cpuBytes > 0 ? 0.003 : 0)
  let t = gpuBytes / gpuSpeed + cpuBytes / cpuSpeed + overhead
  if (choice.kvInRam && pl.gpuLayers > 0) t *= 1.04
  const tps = 1 / t
  const label: SpeedLabel = tps >= 20 ? 'smooth' : tps >= 8 ? 'fine' : tps >= 3 ? 'slow' : 'crawl'
  const cpuShare = est.cpu.weights / Math.max(1, est.cpu.weights + est.gpu.weights)
  const reading = est.cpu.weights <= shape.embedBytes + 1 && !choice.kvInRam ? 'quick' : cpuShare > 0.4 || pl.gpuLayers === 0 ? 'slow' : 'slower'
  return { tokensPerSecond: tps, label, reading }
}

/* ───────────── plans ───────────── */

export const formatGB = (bytes: number): string => {
  const g = bytes / GiB
  return g >= 10 ? `${Math.round(g)} GB` : g >= 0.95 ? `${g.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MiB))} MB`
}

export function verdictOf(shape: ModelShape, choice: RuntimeChoice, est: Estimate): Verdict {
  if (!est.fitsGpu || !est.fitsRam) return 'too-big'
  if (est.layersOnGpu === 0) return 'cpu'
  if (est.expertLayersInRam > 0 && est.layersOnGpu === shape.layers) return 'experts'
  const allOnGpu = est.layersOnGpu === shape.layers && est.expertLayersInRam === 0 && !choice.kvInRam
  return allOnGpu ? 'gpu' : 'split'
}

/** Looks at one specific choice: does it fit, how fast, and what to say about it. */
export function evaluate(shape: ModelShape, hw: MemoryHardware, choice: RuntimeChoice): Plan {
  const estimate = estimateMemory(shape, choice, hw)
  const speed = estimateSpeed(shape, choice, hw, estimate)
  const verdict = verdictOf(shape, choice, estimate)
  const fits = verdict !== 'too-big'
  const text = describe(shape, hw, choice, estimate, speed, verdict)
  return { choice, estimate, speed, verdict, fits, ...text }
}

function describe(shape: ModelShape, hw: MemoryHardware, choice: RuntimeChoice, est: Estimate, speed: Speed, verdict: Verdict): { headline: string; detail: string[]; warnings: string[] } {
  const L = shape.layers
  const detail: string[] = []
  const warnings: string[] = []
  let headline: string
  const hasGpu = hw.vramMB > 0 && hw.backend !== 'cpu'
  if (verdict === 'too-big') {
    const overV = est.gpu.total - est.vramBudget
    const overR = est.cpu.total - est.ramBudget
    if (!hasGpu || est.layersOnGpu === 0) headline = `Does not fit: it needs about ${formatGB(est.cpu.total)} of RAM and you have about ${formatGB(Math.max(0, est.ramBudget))} to spare.`
    else if (overR > 0) headline = `Does not fit, even with RAM: about ${formatGB(overR)} too much for this computer.`
    else headline = `Does not fit in video memory by about ${formatGB(overV)}.`
  } else if (verdict === 'gpu') headline = 'Fits entirely in video memory. Full speed.'
  else if (verdict === 'cpu') headline = 'Runs on the CPU, all in RAM. Expect it to be slow.'
  else if (verdict === 'experts') headline = `Fits with the experts of ${est.expertLayersInRam} of ${L} layers in RAM. The rest stays on the GPU.`
  else headline = est.layersOnGpu < L ? `Fits with ${est.layersOnGpu} of ${L} layers on the GPU and the rest in RAM.` : 'Fits, with the model’s working memory in RAM.'

  if (hasGpu) {
    detail.push(`Video memory: about ${formatGB(est.gpu.total)} of ${formatGB(est.vramBudget)} usable (${formatGB(est.gpu.weights)} model, ${formatGB(est.gpu.cache)} working memory${est.gpu.picture ? `, ${formatGB(est.gpu.picture)} for pictures` : ''}, ${formatGB(est.gpu.compute + est.gpu.overhead)} scratch).`)
  }
  if (est.cpu.total > shape.embedBytes + CPU_COMPUTE_BASE * 1.5 || !hasGpu) {
    detail.push(`RAM: about ${formatGB(est.cpu.total)} of ${formatGB(est.ramBudget)} usable (${formatGB(est.cpu.weights)} model${est.cpu.cache ? `, ${formatGB(est.cpu.cache)} working memory` : ''}).`)
  }
  if (choice.kvInRam) warnings.push('The working memory is in RAM, so every word reads it over the slower memory. Fine for occasional long chats, noticeably slower otherwise.')
  if (speed.reading !== 'quick' && verdict !== 'too-big') warnings.push(speed.reading === 'slow' ? 'Reading long prompts (files, big chats) will be slow, possibly minutes.' : 'Reading long prompts is slower than with everything on the GPU.')
  if (!hasGpu && hw.backend !== 'cpu' && hw.vramMB === 0) warnings.push('No video memory was detected, so everything is planned for the CPU.')
  if (shape.trainedContext > 0 && choice.contextSize > shape.trainedContext) warnings.push(`This model was trained for ${shape.trainedContext.toLocaleString()} tokens; longer than that often works badly.`)
  if (shape.rough) warnings.push('This kind of model is new to Cairn, so the numbers may be off. The engine’s own report after loading is exact.')
  return { headline, detail, warnings }
}

/** Options to try for a wanted context, simplest first. */
function candidates(shape: ModelShape, hasGpu: boolean, base: RuntimeChoice): RuntimeChoice[] {
  const L = shape.layers
  if (!hasGpu) return [{ ...base, gpuLayers: 0 }]
  const out: RuntimeChoice[] = [{ ...base, gpuLayers: -1 }]
  if (shape.experts > 0) for (let k = 1; k <= L; k++) out.push({ ...base, gpuLayers: -1, nCpuMoe: k })
  for (let n = L; n >= 1; n--) out.push({ ...base, gpuLayers: n })
  if (shape.experts > 0) for (let n = L; n >= 1; n--) out.push({ ...base, gpuLayers: n, nCpuMoe: L })
  const keep = out.map((c) => ({ ...c, kvInRam: true }))
  return [...out, ...keep, { ...base, gpuLayers: 0 }]
}

export interface Wanted {
  contextSize: number
  kvCache: KvType
  flashAttn: boolean
}

/** The best way to run a model at the wanted context: the fastest placement that fits, or the nearest miss. */
export function recommend(shape: ModelShape, hw: MemoryHardware, wanted: Wanted): Plan {
  const hasGpu = hw.vramMB > 0 && hw.backend !== 'cpu'
  const base: RuntimeChoice = { ...wanted, gpuLayers: -1, nCpuMoe: 0, kvInRam: false }
  let best: Plan | null = null
  let nearest: Plan | null = null
  let nearestOver = Infinity
  for (const c of candidates(shape, hasGpu, base)) {
    const estimate = estimateMemory(shape, c, hw)
    if (estimate.fitsGpu && estimate.fitsRam) {
      const speed = estimateSpeed(shape, c, hw, estimate)
      // A clearly faster option wins; near ties keep the earlier, simpler one.
      if (!best || speed.tokensPerSecond > best.speed.tokensPerSecond * 1.03) best = evaluate(shape, hw, c)
    } else {
      const over = Math.max(0, estimate.gpu.total - estimate.vramBudget) + Math.max(0, estimate.cpu.total - estimate.ramBudget)
      if (over < nearestOver) {
        nearestOver = over
        nearest = evaluate(shape, hw, c)
      }
    }
  }
  return (best ?? nearest) as Plan
}

export const CONTEXT_STEPS = [4096, 8192, 16384, 32768, 65536, 131072, 262144]

export interface LadderRow {
  contextSize: number
  plan: Plan
}

/** What each context length would need: the way to run it and whether it fits. */
export function contextLadder(shape: ModelShape, hw: MemoryHardware, kvCache: KvType, flashAttn: boolean): LadderRow[] {
  const cap = shape.trainedContext > 0 ? shape.trainedContext : 131072
  const steps = CONTEXT_STEPS.filter((c) => c <= Math.max(cap, 8192))
  return steps.map((contextSize) => ({ contextSize, plan: recommend(shape, hw, { contextSize, kvCache, flashAttn }) }))
}

/** Longest context that fits at all (with any placement). */
export function longestThatFits(rows: LadderRow[]): number {
  let best = 0
  for (const r of rows) if (r.plan.fits) best = Math.max(best, r.contextSize)
  return best
}

/** Longest context that fits with every layer in video memory (full speed). */
export function longestOnGpu(rows: LadderRow[]): number {
  let best = 0
  for (const r of rows) if (r.plan.verdict === 'gpu') best = Math.max(best, r.contextSize)
  return best
}

/** The settings that make a plan happen. */
export function settingsFor(plan: Plan): { contextSize: number; gpuLayers: number; nCpuMoe: number; kvInRam: boolean; kvCache: KvType } {
  const c = plan.choice
  return { contextSize: c.contextSize, gpuLayers: c.gpuLayers, nCpuMoe: c.nCpuMoe, kvInRam: c.kvInRam, kvCache: c.kvCache }
}

/* ───────────── what the computer has ───────────── */

/** Quoted memory speed (GB/s) of common graphics cards. Only used to estimate speed, so a near match is fine. */
const GPU_BANDWIDTH: [RegExp, number][] = [
  [/rtx\s*5090/i, 1792], [/rtx\s*5080/i, 960], [/rtx\s*5070\s*ti/i, 896], [/rtx\s*5070/i, 672], [/rtx\s*5060\s*ti/i, 448], [/rtx\s*5060/i, 448],
  [/rtx\s*4090/i, 1008], [/rtx\s*4080\s*super/i, 736], [/rtx\s*4080/i, 717], [/rtx\s*4070\s*ti\s*super/i, 672], [/rtx\s*4070\s*ti/i, 504], [/rtx\s*4070\s*super/i, 504], [/rtx\s*4070/i, 504], [/rtx\s*4060\s*ti/i, 288], [/rtx\s*4060/i, 272],
  [/rtx\s*3090/i, 936], [/rtx\s*3080\s*ti/i, 912], [/rtx\s*3080/i, 760], [/rtx\s*3070\s*ti/i, 608], [/rtx\s*3070/i, 448], [/rtx\s*3060\s*ti/i, 448], [/rtx\s*3060/i, 360], [/rtx\s*3050/i, 224],
  [/rtx\s*2080\s*ti/i, 616], [/rtx\s*2080/i, 448], [/rtx\s*2070/i, 448], [/rtx\s*2060/i, 336],
  [/gtx\s*1080\s*ti/i, 484], [/gtx\s*1080/i, 320], [/gtx\s*1070/i, 256], [/gtx\s*1060/i, 192],
  [/rx\s*9070\s*xt/i, 640], [/rx\s*9070/i, 640], [/rx\s*7900\s*xtx/i, 960], [/rx\s*7900\s*xt/i, 800], [/rx\s*7900\s*gre/i, 576], [/rx\s*7800\s*xt/i, 624], [/rx\s*7700\s*xt/i, 432], [/rx\s*7600/i, 288],
  [/rx\s*6950\s*xt/i, 576], [/rx\s*6900\s*xt/i, 512], [/rx\s*6800/i, 512], [/rx\s*6750\s*xt/i, 432], [/rx\s*6700\s*xt/i, 384], [/rx\s*6700/i, 320], [/rx\s*6650\s*xt/i, 280], [/rx\s*6600\s*xt/i, 256], [/rx\s*6600/i, 224],
  [/rx\s*5700\s*xt/i, 448], [/rx\s*5700/i, 448], [/vega\s*64/i, 484], [/radeon\s*vii/i, 1024],
  [/arc\s*b580/i, 456], [/arc\s*b570/i, 380], [/arc\s*a770/i, 560], [/arc\s*a750/i, 512], [/arc\s*a580/i, 512], [/arc\s*a380/i, 186]
]

export const DEFAULT_GPU_BANDWIDTH = 300

export function gpuBandwidth(name: string): { gbs: number; known: boolean } {
  for (const [re, gbs] of GPU_BANDWIDTH) if (re.test(name)) return { gbs, known: true }
  return { gbs: DEFAULT_GPU_BANDWIDTH, known: false }
}

/** Memory speed (GB/s) a model run really gets from RAM: the quoted rate of the sticks over their channels, at about 70 percent. */
export function ramBandwidth(megaTransfersPerSecond: number, sticks: number): number {
  const channels = sticks <= 1 ? 1 : sticks <= 4 ? 2 : sticks <= 8 ? 4 : 8
  return Math.round(((megaTransfersPerSecond * 8 * channels) / 1000) * 0.7 * 10) / 10
}

/** Used when the memory type cannot be read: ordinary dual-channel DDR4-3200. */
export const ASSUMED_RAM_BANDWIDTH = ramBandwidth(3200, 2)
