import { describe, expect, it } from 'vitest'
import {
  ASSUMED_RAM_BANDWIDTH,
  GiB,
  MiB,
  type RuntimeChoice,
  cacheCells,
  cacheTotal,
  contextLadder,
  effectiveKv,
  estimateMemory,
  evaluate,
  gpuBandwidth,
  longestOnGpu,
  longestThatFits,
  ramBandwidth,
  recommend,
  settingsFor
} from '../src/shared/memoryPlan'
import type { MemoryHardware, ModelShape } from '../src/shared/types'

const flags = { nCpuMoe: true, overrideTensor: true, noKvOffload: true, known: true }

/** A Radeon RX 6900 XT with 32 GB of ordinary dual-channel DDR4. */
const hw = (over: Partial<MemoryHardware> = {}): MemoryHardware => ({
  backend: 'vulkan',
  gpuName: 'AMD Radeon RX 6900 XT',
  gpuCount: 1,
  vramMB: 16384,
  ramMB: 32768,
  gpuBandwidthGBs: 512,
  gpuBandwidthKnown: true,
  ramBandwidthGBs: 36,
  ramDetail: 'DDR4-3200, 2 sticks',
  ramDetected: true,
  flags,
  ...over
})

const evenLayers = (layers: number, total: number): number[] => Array.from({ length: layers }, () => total / layers)

/** Llama 3 8B at Q4_K_M: 32 layers, 8 key/value heads of 128, a 4.9 GB file. */
const llama8b = (): ModelShape => ({
  arch: 'llama', fileBytes: 4.92e9, layers: 32, embedding: 4096, heads: 32, kvHeads: 8, headDimK: 128, headDimV: 128, trainedContext: 131072,
  experts: 0, expertsUsed: 0, slidingWindow: 0, swaLayers: null,
  layerBytes: evenLayers(32, 4.2e9), layerExpertBytes: new Array(32).fill(0),
  embedBytes: 295e6, outputBytes: 431e6, outputTied: false, otherBytes: 1e6, rough: false, mmprojBytes: 0
})

/** Llama 3 70B at Q4_K_M: 80 layers, 8 key/value heads of 128, about 42 GB. */
const llama70b = (): ModelShape => ({ ...llama8b(), layers: 80, embedding: 8192, heads: 64, fileBytes: 42.5e9, layerBytes: evenLayers(80, 41.2e9), layerExpertBytes: new Array(80).fill(0), embedBytes: 0.6e9, outputBytes: 0.9e9 })

/** Qwen3 30B-A3B at Q4_K_M: 48 layers, 128 experts of which 8 are used, 4 key/value heads of 128, about 18.6 GB. */
const qwenMoe = (): ModelShape => ({
  arch: 'qwen3moe', fileBytes: 18.6e9, layers: 48, embedding: 2048, heads: 32, kvHeads: 4, headDimK: 128, headDimV: 128, trainedContext: 40960,
  experts: 128, expertsUsed: 8, slidingWindow: 0, swaLayers: null,
  layerBytes: evenLayers(48, 17.4e9), layerExpertBytes: evenLayers(48, 16.6e9),
  embedBytes: 0.35e9, outputBytes: 0.5e9, outputTied: false, otherBytes: 1e6, rough: false, mmprojBytes: 0
})

/** Gemma 3 12B at Q4_K_M: 48 layers, 8 key/value heads of 256, one layer in six sees everything, the rest a window of 1024. */
const gemma12b = (): ModelShape => ({
  arch: 'gemma3', fileBytes: 7.3e9, layers: 48, embedding: 3840, heads: 16, kvHeads: 8, headDimK: 256, headDimV: 256, trainedContext: 131072,
  experts: 0, expertsUsed: 0, slidingWindow: 1024, swaLayers: Array.from({ length: 48 }, (_, i) => i % 6 < 5),
  layerBytes: evenLayers(48, 6.3e9), layerExpertBytes: new Array(48).fill(0),
  embedBytes: 0.7e9, outputBytes: 0.7e9, outputTied: true, otherBytes: 1e6, rough: false, mmprojBytes: 0
})

const choice = (over: Partial<RuntimeChoice> = {}): RuntimeChoice => ({ contextSize: 8192, gpuLayers: -1, nCpuMoe: 0, kvInRam: false, kvCache: 'f16', flashAttn: true, ...over })

describe('working-memory (cache) size', () => {
  it('matches what the engine reports for well-known models', () => {
    // llama.cpp prints "KV buffer size = 1024.00 MiB" for Llama 3 8B at 8192 tokens, and 2560 MiB for the 70B.
    expect(cacheTotal(llama8b(), 8192, 'f16') / MiB).toBe(1024)
    expect(cacheTotal(llama70b(), 8192, 'f16') / MiB).toBe(2560)
    expect(cacheTotal(qwenMoe(), 8192, 'f16') / MiB).toBe(768)
  })

  it('is about half at 8-bit and a quarter at 4-bit', () => {
    const f16 = cacheTotal(llama8b(), 16384, 'f16')
    expect(cacheTotal(llama8b(), 16384, 'q8_0') / f16).toBeCloseTo(0.531, 2)
    expect(cacheTotal(llama8b(), 16384, 'q4_0') / f16).toBeCloseTo(0.281, 2)
  })

  it('only holds a window of recent text for sliding-window layers', () => {
    const g = gemma12b()
    const per = 8 * (256 + 256) * 2
    const global = 8 * per * 16384
    const local = 40 * per * 1536 // the window of 1024 plus a batch of 512
    expect(cacheTotal(g, 16384, 'f16')).toBe(global + local)
    const allGlobal = cacheTotal({ ...g, swaLayers: null }, 16384, 'f16')
    expect(cacheTotal(g, 16384, 'f16') / allGlobal).toBeLessThan(0.3)
    expect(cacheCells(g, 0, 100_000)).toBe(1536)
    expect(cacheCells(g, 5, 100_000)).toBe(100_096)
  })

  it('rounds the context up the way the engine does', () => {
    expect(cacheCells(llama8b(), 0, 8000)).toBe(8192)
  })

  it('stays at full precision when flash attention is off', () => {
    expect(effectiveKv({ kvCache: 'q8_0', flashAttn: false })).toBe('f16')
    expect(effectiveKv({ kvCache: 'q8_0', flashAttn: true })).toBe('q8_0')
  })
})

describe('where the weights go', () => {
  it('puts the last layers on the GPU, and the output layer only when the count is above the layer count', () => {
    const all = estimateMemory(llama8b(), choice({ gpuLayers: -1 }), hw())
    expect(all.layersOnGpu).toBe(32)
    expect(all.outputOnGpu).toBe(true)
    const noOutput = estimateMemory(llama8b(), choice({ gpuLayers: 32 }), hw())
    expect(noOutput.outputOnGpu).toBe(false)
    expect(all.gpu.weights - noOutput.gpu.weights).toBeCloseTo(431e6, -3)
    const half = estimateMemory(llama8b(), choice({ gpuLayers: 16 }), hw())
    expect(half.layersOnGpu).toBe(16)
    expect(half.gpu.weights).toBeCloseTo(16 * (4.2e9 / 32) + 1e6, -3)
    expect(half.cpu.weights).toBeCloseTo(16 * (4.2e9 / 32) + 295e6 + 431e6, -3)
  })

  it('keeps the word embeddings in RAM always, and copies them to the GPU for the output when tied', () => {
    const g = gemma12b()
    const e = estimateMemory(g, choice({ gpuLayers: -1 }), hw())
    expect(e.cpu.weights).toBeGreaterThanOrEqual(0.7e9)
    expect(e.gpu.weights).toBeCloseTo(6.3e9 + 0.7e9 + 1e6, -3)
    const withoutOutput = estimateMemory(g, choice({ gpuLayers: 48 }), hw())
    expect(withoutOutput.gpu.weights).toBeCloseTo(6.3e9 + 1e6, -3)
  })

  it('moves only the experts of the first layers to RAM', () => {
    const m = qwenMoe()
    const base = estimateMemory(m, choice({ nCpuMoe: 0 }), hw({ vramMB: 65536 }))
    const some = estimateMemory(m, choice({ nCpuMoe: 12 }), hw({ vramMB: 65536 }))
    expect(some.expertLayersInRam).toBe(12)
    expect(base.gpu.weights - some.gpu.weights).toBeCloseTo(12 * (16.6e9 / 48), -3)
    expect(some.cpu.weights - base.cpu.weights).toBeCloseTo(12 * (16.6e9 / 48), -3)
  })

  it('keeps the cache in RAM when asked, and for layers that are not on the GPU', () => {
    const inRam = estimateMemory(llama8b(), choice({ kvInRam: true }), hw())
    expect(inRam.gpu.cache).toBe(0)
    expect(inRam.cpu.cache).toBe(1024 * MiB)
    const half = estimateMemory(llama8b(), choice({ gpuLayers: 16 }), hw())
    expect(half.gpu.cache).toBe(512 * MiB)
    expect(half.cpu.cache).toBe(512 * MiB)
  })

  it('uses only RAM without a GPU', () => {
    const e = estimateMemory(llama8b(), choice(), hw({ vramMB: 0, backend: 'cpu' }))
    expect(e.layersOnGpu).toBe(0)
    expect(e.gpu.total).toBe(0)
    expect(e.cpu.weights).toBeGreaterThan(4.8e9)
  })

  it('needs room for the attention scores when flash attention is off', () => {
    const on = estimateMemory(llama8b(), choice({ flashAttn: true }), hw())
    const off = estimateMemory(llama8b(), choice({ flashAttn: false }), hw())
    expect(off.gpu.compute - on.gpu.compute).toBe(8192 * 512 * 32 * 4)
  })

  it('counts the picture-reading file', () => {
    const e = estimateMemory({ ...llama8b(), mmprojBytes: 600e6 }, choice(), hw())
    expect(e.gpu.picture).toBeGreaterThan(600e6)
  })
})

describe('plans', () => {
  it('says a small model fits in video memory with room to spare', () => {
    const p = recommend(llama8b(), hw(), { contextSize: 8192, kvCache: 'f16', flashAttn: true })
    expect(p.verdict).toBe('gpu')
    expect(p.fits).toBe(true)
    expect(settingsFor(p)).toMatchObject({ gpuLayers: -1, nCpuMoe: 0, kvInRam: false })
    expect(p.speed.tokensPerSecond).toBeGreaterThan(30)
    expect(p.speed.label).toBe('smooth')
    expect(p.speed.reading).toBe('quick')
    expect(p.headline).toMatch(/Fits entirely in video memory/)
  })

  it('suggests keeping the experts of a mixture-of-experts model in RAM when it is too big for the card', () => {
    const p = recommend(qwenMoe(), hw(), { contextSize: 16384, kvCache: 'f16', flashAttn: true })
    expect(p.verdict).toBe('experts')
    expect(p.choice.nCpuMoe).toBeGreaterThan(0)
    expect(p.choice.nCpuMoe).toBeLessThan(48)
    expect(p.estimate.fitsGpu).toBe(true)
    expect(p.speed.tokensPerSecond).toBeGreaterThan(15)
    expect(p.headline).toMatch(/experts of \d+ of 48 layers in RAM/)
    // Only as many experts as needed leave the GPU.
    const one = evaluate(qwenMoe(), hw(), { ...p.choice, nCpuMoe: p.choice.nCpuMoe - 1 })
    expect(one.estimate.fitsGpu).toBe(false)
  })

  it('splits a big dense model between GPU and RAM and warns about slow reading', () => {
    const p = recommend(llama70b(), hw({ ramMB: 65536 }), { contextSize: 8192, kvCache: 'f16', flashAttn: true })
    expect(p.verdict).toBe('split')
    expect(p.estimate.layersOnGpu).toBeGreaterThan(10)
    expect(p.estimate.layersOnGpu).toBeLessThan(60)
    expect(p.speed.tokensPerSecond).toBeLessThan(6)
    expect(p.speed.reading).not.toBe('quick')
    expect(p.warnings.join(' ')).toMatch(/slower|slow/)
  })

  it('says so when a model cannot fit anywhere, and how far off it is', () => {
    const p = recommend(llama70b(), hw({ ramMB: 16384 }), { contextSize: 8192, kvCache: 'f16', flashAttn: true })
    expect(p.verdict).toBe('too-big')
    expect(p.fits).toBe(false)
    expect(p.headline).toMatch(/Does not fit/)
  })

  it('runs on the CPU when there is no graphics card', () => {
    const p = recommend(llama8b(), hw({ vramMB: 0, backend: 'cpu' }), { contextSize: 8192, kvCache: 'f16', flashAttn: true })
    expect(p.verdict).toBe('cpu')
    expect(p.choice.gpuLayers).toBe(0)
    expect(p.speed.tokensPerSecond).toBeLessThan(10)
  })

  it('makes a longer context fit by putting some layers in RAM, and the 8-bit cache by itself fits more', () => {
    const f16 = contextLadder(gemma12b(), hw(), 'f16', true)
    const q8 = contextLadder({ ...llama8b() }, hw(), 'q8_0', true)
    const llamaF16 = contextLadder(llama8b(), hw(), 'f16', true)
    expect(longestOnGpu(q8)).toBeGreaterThan(longestOnGpu(llamaF16))
    expect(longestThatFits(llamaF16)).toBeGreaterThanOrEqual(longestOnGpu(llamaF16))
    // Gemma's sliding windows keep long contexts cheap.
    expect(longestOnGpu(f16)).toBeGreaterThanOrEqual(65536)
  })

  it('gets slower, never faster, as the context grows', () => {
    const rows = contextLadder(llama8b(), hw(), 'f16', true).filter((r) => r.plan.fits)
    for (let i = 1; i < rows.length; i++) expect(rows[i].plan.speed.tokensPerSecond).toBeLessThanOrEqual(rows[i - 1].plan.speed.tokensPerSecond * 1.001)
  })

  it('puts the cache in RAM only when nothing else lets the context fit', () => {
    const shape = llama8b()
    const easy = recommend(shape, hw(), { contextSize: 16384, kvCache: 'f16', flashAttn: true })
    expect(easy.choice.kvInRam).toBe(false)
    // A tiny card with a huge context: the cache has to live in RAM for the model to fit at all.
    const tiny = recommend(shape, hw({ vramMB: 6144, ramMB: 65536 }), { contextSize: 131072, kvCache: 'f16', flashAttn: true })
    expect(tiny.fits).toBe(true)
    expect(tiny.estimate.cpu.cache).toBeGreaterThan(0)
  })

  it('warns when the context is longer than the model was trained for', () => {
    const p = evaluate(qwenMoe(), hw({ vramMB: 65536 }), choice({ contextSize: 65536 }))
    expect(p.warnings.join(' ')).toMatch(/trained for 40,960/)
  })

  it('flags models it cannot size exactly', () => {
    const p = evaluate({ ...llama8b(), rough: true }, hw(), choice())
    expect(p.warnings.join(' ')).toMatch(/new to Cairn/)
  })

  it('does not call a split placement full speed', () => {
    const p = evaluate(llama8b(), hw(), choice({ gpuLayers: 20 }))
    expect(p.verdict).toBe('split')
    expect(p.speed.tokensPerSecond).toBeLessThan(evaluate(llama8b(), hw(), choice()).speed.tokensPerSecond)
  })
})

describe('what the computer has', () => {
  it('knows the memory speed of common cards, and says when it is guessing', () => {
    expect(gpuBandwidth('AMD Radeon RX 6900 XT')).toEqual({ gbs: 512, known: true })
    expect(gpuBandwidth('NVIDIA GeForce RTX 4070 Ti SUPER')).toEqual({ gbs: 672, known: true })
    expect(gpuBandwidth('NVIDIA GeForce RTX 3060')).toEqual({ gbs: 360, known: true })
    expect(gpuBandwidth('Mystery Accelerator 9000').known).toBe(false)
  })

  it('works out RAM speed from the sticks', () => {
    expect(ramBandwidth(3200, 2)).toBeCloseTo(35.8, 1)
    expect(ramBandwidth(5600, 2)).toBeCloseTo(62.7, 1)
    expect(ramBandwidth(3200, 1)).toBeCloseTo(17.9, 1)
    expect(ramBandwidth(3200, 4)).toBeCloseTo(35.8, 1)
    expect(ASSUMED_RAM_BANDWIDTH).toBeCloseTo(35.8, 1)
    expect(GiB).toBe(1024 ** 3)
  })
})
