import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '../src/shared/defaults'
import { runtimeFor, sanitizeOverride, sanitizeOverrides } from '../src/shared/runtimePrefs'
import type { GpuDevice, Settings } from '../src/shared/types'
import { type PlacementFlags, LlamaManager, buildLlamaArgs, expertTensorPattern } from '../src/main/engines/llama-server'
import { parseWindowsMemory, usableVram } from '../src/main/engines/memory'
import { SettingsStore } from '../src/main/settings'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { LocalProvider } from '../src/main/engines/local-provider'

const base = defaultSettings('/m').local
const flags = (over: Partial<PlacementFlags> = {}): PlacementFlags => ({ nCpuMoe: true, overrideTensor: true, noKvOffload: true, ...over })
const args = (over: Partial<typeof base>, f: PlacementFlags | null = flags(), backend = 'vulkan', file = '/m/x.gguf') => buildLlamaArgs({ ...base, ...over }, file, 1, backend, null, null, f)

describe('placing a model in memory', () => {
  it('keeps the experts of the first layers in RAM with the engine’s own flag', () => {
    const a = args({ nCpuMoe: 12 })
    expect(a.slice(a.indexOf('--n-cpu-moe'), a.indexOf('--n-cpu-moe') + 2)).toEqual(['--n-cpu-moe', '12'])
    expect(a).not.toContain('--override-tensor')
  })

  it('falls back to a tensor pattern when the build is too old for that flag', () => {
    const a = args({ nCpuMoe: 3 }, flags({ nCpuMoe: false }))
    expect(a).not.toContain('--n-cpu-moe')
    const pattern = a[a.indexOf('--override-tensor') + 1]
    expect(pattern).toBe('blk\\.(?:0|1|2)\\.ffn_.*_exps\\.=CPU')
    const re = new RegExp(pattern.replace(/=CPU$/, ''))
    expect(re.test('blk.1.ffn_up_exps.weight')).toBe(true)
    expect(re.test('blk.2.ffn_gate_exps.weight')).toBe(true)
    expect(re.test('blk.3.ffn_down_exps.weight')).toBe(false)
    expect(re.test('blk.1.ffn_up_shexp.weight')).toBe(false)
    expect(re.test('blk.10.ffn_up_exps.weight')).toBe(false)
    expect(expertTensorPattern(1)).toBe('blk\\.(?:0)\\.ffn_.*_exps\\.=CPU')
  })

  it('adds nothing when the build has neither way, instead of failing to start', () => {
    const a = args({ nCpuMoe: 5 }, flags({ nCpuMoe: false, overrideTensor: false }))
    expect(a).not.toContain('--n-cpu-moe')
    expect(a).not.toContain('--override-tensor')
  })

  it('uses the older flags when the build cannot be asked', () => {
    expect(args({ nCpuMoe: 4 }, null)).toContain('--override-tensor')
    expect(args({ kvInRam: true }, null)).toContain('--no-kv-offload')
  })

  it('keeps the cache in RAM when asked', () => {
    expect(args({ kvInRam: true })).toContain('--no-kv-offload')
    expect(args({ kvInRam: false })).not.toContain('--no-kv-offload')
    expect(args({ kvInRam: true }, flags({ noKvOffload: false }))).not.toContain('--no-kv-offload')
  })

  it('adds no placement flags on the CPU, where there is nothing to place', () => {
    const a = args({ nCpuMoe: 8, kvInRam: true }, flags(), 'cpu')
    expect(a).not.toContain('--n-cpu-moe')
    expect(a).not.toContain('--no-kv-offload')
    expect(args({ nCpuMoe: 8, kvInRam: true, gpuLayers: 0 })).not.toContain('--n-cpu-moe')
  })

  it('lets the person’s own flags win', () => {
    expect(args({ nCpuMoe: 12, extraArgs: '--n-cpu-moe 4' }).filter((x) => x === '--n-cpu-moe')).toHaveLength(1)
    expect(args({ nCpuMoe: 12, extraArgs: '-ot exps=CPU' })).not.toContain('--n-cpu-moe')
    expect(args({ kvInRam: true, extraArgs: '-nkvo' }).filter((x) => x === '--no-kv-offload' || x === '-nkvo')).toHaveLength(1)
  })

  it('runs one model with the settings the planner saved for it, and others with the general ones', () => {
    const local = { ...base, contextSize: 8192, gpuLayers: -1, modelOverrides: { '/m/big.gguf': { contextSize: 32768, gpuLayers: 20, kvCache: 'q8_0' as const, nCpuMoe: 6, kvInRam: true } } }
    const big = buildLlamaArgs({ ...local, flashAttn: 'on' }, '/m/big.gguf', 1, 'vulkan', null, null, flags())
    expect(big.slice(big.indexOf('-c'), big.indexOf('-c') + 2)).toEqual(['-c', '32768'])
    expect(big.slice(big.indexOf('-ngl'), big.indexOf('-ngl') + 2)).toEqual(['-ngl', '20'])
    expect(big).toContain('--n-cpu-moe')
    expect(big).toContain('--no-kv-offload')
    expect(big.slice(big.indexOf('--cache-type-k'), big.indexOf('--cache-type-k') + 2)).toEqual(['--cache-type-k', 'q8_0'])
    const small = buildLlamaArgs({ ...local, flashAttn: 'on' }, '/m/small.gguf', 1, 'vulkan', null, null, flags())
    expect(small.slice(small.indexOf('-c'), small.indexOf('-c') + 2)).toEqual(['-c', '8192'])
    expect(small).not.toContain('--n-cpu-moe')
    expect(runtimeFor(local, '/m/big.gguf').contextSize).toBe(32768)
    expect(runtimeFor(local, '/m/small.gguf')).toBe(local)
    expect(runtimeFor(local, undefined)).toBe(local)
  })
})

describe('saved per-model settings', () => {
  it('keeps only sensible values', () => {
    expect(sanitizeOverride({ contextSize: 16384, gpuLayers: 20, kvCache: 'q8_0', nCpuMoe: 4, kvInRam: true })).toEqual({ contextSize: 16384, gpuLayers: 20, kvCache: 'q8_0', nCpuMoe: 4, kvInRam: true })
    expect(sanitizeOverride({ contextSize: 5, gpuLayers: 5000, kvCache: 'q2', nCpuMoe: -1, kvInRam: 'yes', evil: 1 })).toBeNull()
    expect(sanitizeOverride({ contextSize: 8192, kvCache: 'bogus' })).toEqual({ contextSize: 8192 })
    expect(sanitizeOverride('x')).toBeNull()
    expect(sanitizeOverrides({ '/a.gguf': { gpuLayers: -1 }, '': { gpuLayers: 1 }, '/b.gguf': {}, '/c.gguf': 7 })).toEqual({ '/a.gguf': { gpuLayers: -1 } })
    expect(sanitizeOverrides(null)).toEqual({})
  })

  it('is cleaned whenever settings change, and old settings files still load', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-ovr-'))
    try {
      const file = path.join(dir, 'settings.json')
      const old = defaultSettings('/m') as Settings
      const legacy = JSON.parse(JSON.stringify(old))
      delete legacy.local.nCpuMoe
      delete legacy.local.kvInRam
      delete legacy.local.modelOverrides
      fs.writeFileSync(file, JSON.stringify(legacy))
      const store = new SettingsStore(file, '/m')
      await store.load()
      expect(store.get().local).toMatchObject({ nCpuMoe: 0, kvInRam: false, modelOverrides: {} })
      store.update({ local: { ...store.get().local, nCpuMoe: -4, kvInRam: 'maybe' as never, modelOverrides: { '/a.gguf': { gpuLayers: 12, nCpuMoe: 99999 } as never } } })
      expect(store.get().local.nCpuMoe).toBe(0)
      expect(store.get().local.kvInRam).toBe(false)
      expect(store.get().local.modelOverrides).toEqual({ '/a.gguf': { gpuLayers: 12 } })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('reading this computer’s memory', () => {
  it('reads the RAM sticks Windows lists', () => {
    const two = JSON.stringify([{ Speed: 3200, ConfiguredClockSpeed: 3200, SMBIOSMemoryType: 26 }, { Speed: 3200, ConfiguredClockSpeed: 3200, SMBIOSMemoryType: 26 }])
    expect(parseWindowsMemory(two)).toEqual({ sticks: 2, megaTransfers: 3200, type: 'DDR4' })
    // One stick is listed as a single object, and the slowest stick sets the pace.
    expect(parseWindowsMemory(JSON.stringify({ Speed: 5600, ConfiguredClockSpeed: 4800, SMBIOSMemoryType: 34 }))).toEqual({ sticks: 1, megaTransfers: 4800, type: 'DDR5' })
    expect(parseWindowsMemory('not json')).toBeNull()
    expect(parseWindowsMemory('[]')).toBeNull()
    expect(parseWindowsMemory(JSON.stringify([{ Speed: 0 }]))).toBeNull()
  })

  it('counts the main graphics card and comparable ones of the same make, and ignores the rest', () => {
    const d = (vendor: GpuDevice['vendor'], name: string, vramMB?: number): GpuDevice => ({ vendor, name, vramMB })
    expect(usableVram([d('amd', 'RX 6900 XT', 16384), d('amd', 'Radeon Graphics', 512)])).toMatchObject({ vramMB: 16384, count: 1 })
    expect(usableVram([d('nvidia', 'RTX 3090', 24576), d('nvidia', 'RTX 3060', 12288)])).toMatchObject({ vramMB: 36864, count: 2 })
    expect(usableVram([d('nvidia', 'RTX 3090', 24576), d('amd', 'RX 7900', 24576)])).toMatchObject({ vramMB: 24576, count: 1 })
    expect(usableVram([d('unknown', 'Mystery', 8192), d('intel', 'UHD')])).toEqual({ vramMB: 0, count: 0, main: null })
  })
})

describe('what the engine reports after loading', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-fakellama-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  /** A stand-in for llama-server: lists its flags for --help, otherwise prints a start-up report and answers /health. */
  const fakeEngine = (): string => {
    const file = path.join(dir, 'llama-server')
    fs.writeFileSync(
      file,
      `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('usage: llama-server [options]\\n  -m, --model FILE\\n  --n-cpu-moe N\\n  --override-tensor REGEX\\n  --no-kv-offload\\n  --reasoning on|off|auto\\n  --jinja --host --port --ctx-size --threads --flash-attn')
  process.exit(0)
}
const port = Number(args[args.indexOf('--port') + 1])
console.log('load_tensors: offloaded 33/49 layers to GPU')
console.log('load_tensors:        CUDA0 model buffer size =  5000.00 MiB')
console.log('load_tensors:   CPU_Mapped model buffer size =  3000.00 MiB')
console.log('llama_kv_cache:      CUDA0 KV buffer size =   600.00 MiB')
console.log('llama_context:      CUDA0 compute buffer size =   300.00 MiB')
require('http').createServer((req, res) => { res.end('{"status":"ok"}') }).listen(port, '127.0.0.1')
`
    )
    fs.chmodSync(file, 0o755)
    return file
  }

  const manager = (settings: Settings) =>
    new LlamaManager({
      getSettings: () => settings,
      engines: { resolveBinary: () => fakeEngine(), resolvedBackend: () => 'cuda', spawnEnv: () => process.env } as never
    })

  it('starts with the planner’s flags, keeps the engine’s own account of where the model went, and the speed of the last answer', async () => {
    const settings = defaultSettings('/m')
    const model = path.join(dir, 'model.gguf')
    fs.writeFileSync(model, 'x')
    settings.local.modelOverrides = { [model]: { contextSize: 16384, gpuLayers: 33, nCpuMoe: 7, kvInRam: false } }
    const llama = manager(settings)
    await llama.ensure(model)
    const st = llama.status()
    expect(st.state).toBe('running')
    expect(st.log[0]).toContain('--n-cpu-moe 7')
    expect(st.log[0]).toContain('-c 16384')
    expect(st.memory).toEqual({ gpuModelMB: 5000, gpuCacheMB: 600, gpuComputeMB: 300, cpuModelMB: 3000, cpuCacheMB: 0, cpuComputeMB: 0, layersOnGpu: 33, layersTotal: 49 })
    expect(st.speed).toBeUndefined()
    llama.noteSpeed({ generation: 21.5, prompt: 480 })
    llama.noteSpeed({ generation: 22.5 })
    expect(llama.status().speed).toMatchObject({ generation: 22.5, prompt: 480 })
    llama.noteSpeed({})
    await llama.stop()
    expect(llama.status().memory).toBeUndefined()
    expect(llama.status().speed).toBeUndefined()
  })

  it('restarts the engine when the planner saves new settings for the loaded model', async () => {
    const settings = defaultSettings('/m')
    const model = path.join(dir, 'model.gguf')
    fs.writeFileSync(model, 'x')
    const llama = manager(settings)
    await llama.ensure(model)
    const first = llama.status().pid
    await llama.ensure(model)
    expect(llama.status().pid).toBe(first)
    settings.local.modelOverrides = { [model]: { contextSize: 32768 } }
    await llama.ensure(model)
    expect(llama.status().pid).not.toBe(first)
    expect(llama.status().log[0]).toContain('-c 32768')
    await llama.stop()
  })
})

describe('the speed of the latest answer', () => {
  it('is passed on from the engine’s own timings', async () => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], timings: { prompt_n: 10, prompt_per_second: 640.5, predicted_n: 5, predicted_per_second: 31.5 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const seen: unknown[] = []
      const llama = { acquire: async () => ({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, release() {} }), noteSpeed: (s: unknown) => seen.push(s) }
      const provider = new LocalProvider({ getSettings: () => defaultSettings('/m'), modelsDir: () => '/m', llama: llama as never })
      for await (const _ of provider.stream({ model: '/m/x.gguf', system: '', messages: [{ id: '1', role: 'user', createdAt: 0, content: 'hi' }], tools: [], params: {}, signal: new AbortController().signal, loadAttachment: async () => null })) void _
      expect(seen).toEqual([{ generation: 31.5, prompt: 640.5 }])
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('reports each local model’s own context length', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-ctx-'))
    try {
      fs.writeFileSync(path.join(dir, 'a.gguf'), 'x')
      fs.writeFileSync(path.join(dir, 'b.gguf'), 'x')
      const settings = defaultSettings(dir)
      settings.local.contextSize = 8192
      settings.local.modelOverrides = { [path.join(dir, 'b.gguf')]: { contextSize: 32768 } }
      const provider = new LocalProvider({ getSettings: () => settings, modelsDir: () => dir, llama: {} as never })
      const models = await provider.listModels()
      expect(models.find((m) => m.name === 'a')?.contextLength).toBe(8192)
      expect(models.find((m) => m.name === 'b')?.contextLength).toBe(32768)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
