import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultSettings } from '../src/shared/defaults'
import type { DownloadSpec } from '../src/shared/types'
import { downloadFile, DownloadError } from '../src/main/engines/download'
import { destFor, headersFor } from '../src/main/engines/downloads'
import { availableBackends, parseCudaVersion, parseLspci, parseNvidiaSmiCsv, parseWindowsAdapters, recommend, vendorFromName } from '../src/main/engines/gpu'
import { parseCivitai, parseHfSearch, parseHfTree } from '../src/main/engines/hub'
import { findMmproj, isMmproj, isSecondaryShard, quantFromName, scanGguf, scanImageWeights, splitArgs } from '../src/main/engines/library'
import { buildLlamaArgs } from '../src/main/engines/llama-server'
import { binaryNames } from '../src/main/engines/manager'
import { pickAsset, type Release } from '../src/main/engines/releases'

describe('gpu detection parsers', () => {
  it('classifies vendors', () => {
    expect(vendorFromName('NVIDIA GeForce GTX 1080 Ti')).toBe('nvidia')
    expect(vendorFromName('AMD Radeon RX 6900 XT')).toBe('amd')
    expect(vendorFromName('Intel(R) Arc(TM) A770')).toBe('intel')
    expect(vendorFromName('Microsoft Basic Render Driver')).toBe('unknown')
  })

  it('parses nvidia-smi csv including compute capability', () => {
    const out = 'NVIDIA GeForce RTX 3080, 10240, 551.86, 8.6\nNVIDIA GeForce GTX 1070, 8192, 551.86, 6.1\n'
    const d = parseNvidiaSmiCsv(out)
    expect(d).toHaveLength(2)
    expect(d[0]).toMatchObject({ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3080', vramMB: 10240, computeCap: '8.6' })
    expect(d[1].computeCap).toBe('6.1')
    expect(parseNvidiaSmiCsv('')).toEqual([])
  })

  it('reads the CUDA version from the nvidia-smi banner', () => {
    expect(parseCudaVersion('| NVIDIA-SMI 551.86   Driver Version: 551.86   CUDA Version: 12.4 |')).toBe('12.4')
    expect(parseCudaVersion('nothing here')).toBeUndefined()
  })

  it('parses Windows adapters and prefers registry VRAM over the 4 GB WMI cap', () => {
    const video = JSON.stringify([
      { Name: 'AMD Radeon RX 6900 XT', AdapterRAM: 4293918720, DriverVersion: '31.0.21924.61' },
      { Name: 'Microsoft Basic Render Driver', AdapterRAM: 0 }
    ])
    const vram = JSON.stringify({ DriverDesc: 'AMD Radeon RX 6900 XT', vram: 17163091968 })
    const d = parseWindowsAdapters(video, vram)
    expect(d).toHaveLength(1)
    expect(d[0].vendor).toBe('amd')
    expect(d[0].vramMB).toBe(16368)
    expect(parseWindowsAdapters('not json', '')).toEqual([])
  })

  it('parses lspci display controllers', () => {
    const out = [
      '03:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 21 [Radeon RX 6800/6800 XT / 6900 XT] (rev c1)',
      '00:02.0 Display controller: Intel Corporation UHD Graphics 630',
      '00:1f.3 Audio device: Intel Corporation Cannon Lake PCH cAVS'
    ].join('\n')
    const d = parseLspci(out)
    expect(d.map((x) => x.vendor)).toEqual(['amd', 'intel'])
    expect(d[0].name).toMatch(/Radeon RX 6800/)
  })
})

describe('backend recommendation', () => {
  const base = { rocmRuntime: false, vulkanRuntime: true }
  it('NVIDIA on Windows gets CUDA, with a note for Pascal cards', () => {
    const r = recommend('llama', { ...base, platform: 'win32', arch: 'x64', devices: [{ vendor: 'nvidia', name: 'GTX 1070', computeCap: '6.1' }] })
    expect(r.backend).toBe('cuda')
    expect(r.notes.join(' ')).toMatch(/CUDA 12/)
  })
  it('AMD on Windows gets Vulkan (RX 6900 XT case)', () => {
    const r = recommend('sd', { ...base, platform: 'win32', arch: 'x64', devices: [{ vendor: 'amd', name: 'AMD Radeon RX 6900 XT' }] })
    expect(r.backend).toBe('vulkan')
  })
  it('AMD on Linux uses ROCm only when the runtime exists', () => {
    const dev = [{ vendor: 'amd' as const, name: 'RX 7900 XTX' }]
    for (const engine of ['sd', 'llama'] as const) {
      const withRt = recommend(engine, { ...base, rocmRuntime: true, platform: 'linux', arch: 'x64', devices: dev })
      expect(withRt.backend).toBe('rocm')
      expect(withRt.notes.join(' ')).toMatch(/switch to Vulkan/)
      expect(recommend(engine, { ...base, rocmRuntime: false, platform: 'linux', arch: 'x64', devices: dev }).backend).toBe('vulkan')
    }
  })
  it('NVIDIA on Linux uses CUDA for llama.cpp when the driver is new enough, otherwise Vulkan with advice', () => {
    const dev = (cudaVersion: string) => [{ vendor: 'nvidia' as const, name: 'RTX 4090', cudaVersion, computeCap: '8.9' }]
    expect(recommend('llama', { ...base, platform: 'linux', arch: 'x64', devices: dev('12.8') }).backend).toBe('cuda')
    expect(recommend('llama', { ...base, platform: 'linux', arch: 'x64', devices: dev('13.0') }).backend).toBe('cuda')
    const old = recommend('llama', { ...base, platform: 'linux', arch: 'x64', devices: dev('12.2') })
    expect(old.backend).toBe('vulkan')
    expect(old.notes.join(' ')).toMatch(/driver supports CUDA 12\.2/)
    // stable-diffusion.cpp has no official Linux CUDA build
    expect(recommend('sd', { ...base, platform: 'linux', arch: 'x64', devices: dev('12.8') }).backend).toBe('vulkan')
  })
  it('compares CUDA versions numerically (12.10 is newer than 12.8)', () => {
    const r = recommend('llama', { ...base, platform: 'linux', arch: 'x64', devices: [{ vendor: 'nvidia', name: 'RTX 5090', cudaVersion: '12.10' }] })
    expect(r.backend).toBe('cuda')
  })
  it('NVIDIA on Windows falls back to Vulkan when the driver predates the CUDA build', () => {
    expect(recommend('llama', { ...base, platform: 'win32', arch: 'x64', devices: [{ vendor: 'nvidia', name: 'GTX 1060', cudaVersion: '11.8', computeCap: '6.1' }] }).backend).toBe('vulkan')
  })
  it('no GPU gives CPU', () => {
    expect(recommend('llama', { ...base, platform: 'win32', arch: 'x64', devices: [] }).backend).toBe('cpu')
  })
  it('only CPU is offered on non-x64', () => {
    expect(availableBackends('llama', 'linux', 'arm64')).toEqual(['cpu'])
  })
})

const asset = (name: string) => ({ name, url: `https://example.test/${name}`, size: 1 })
const rel = (tag: string, names: string[], prerelease = false): Release => ({ tag, name: tag, prerelease, assets: names.map(asset) })

describe('release asset picking', () => {
  const llamaWin = rel('b6800', [
    'llama-b6800-bin-win-cpu-x64.zip',
    'llama-b6800-bin-win-cpu-arm64.zip',
    'llama-b6800-bin-win-vulkan-x64.zip',
    'llama-b6800-bin-win-cuda-12.4-x64.zip',
    'llama-b6800-bin-win-cuda-13.4-x64.zip',
    'llama-b6800-bin-win-cuda-13.4-arm64.zip',
    'llama-b6800-bin-win-rocm-10.0-x64.zip',
    'llama-b6800-bin-win-sycl-x64.zip',
    'cudart-llama-bin-win-cuda-12.4-x64.zip',
    'cudart-llama-bin-win-cuda-13.4-x64.zip',
    'llama-b6800-bin-ubuntu-x64.tar.gz',
    'llama-b6800-bin-ubuntu-arm64.tar.gz',
    'llama-b6800-bin-ubuntu-vulkan-x64.tar.gz',
    'llama-b6800-bin-ubuntu-cuda-12.8-x64.tar.gz',
    'llama-b6800-bin-ubuntu-cuda-13.4-x64.tar.gz',
    'cudart-llama-b6800-bin-ubuntu-cuda-12.8-x64.tar.gz',
    'cudart-llama-b6800-bin-ubuntu-cuda-13.4-x64.tar.gz',
    'llama-b6800-bin-ubuntu-rocm-10.0-x64.tar.gz',
    'llama-b6800-bin-ubuntu-openvino-2026.4-x64.tar.gz',
    'llama-b6800-xcframework.zip'
  ])

  it('picks the Vulkan build for Windows', () => {
    const c = pickAsset('llama', [llamaWin], { platform: 'win32', arch: 'x64', backend: 'vulkan' })
    expect(c?.asset.name).toBe('llama-b6800-bin-win-vulkan-x64.zip')
  })

  it('picks the newest CUDA the driver supports, with the matching runtime archive', () => {
    const c = pickAsset('llama', [llamaWin], { platform: 'win32', arch: 'x64', backend: 'cuda', cudaMax: '12.8' })
    expect(c?.asset.name).toBe('llama-b6800-bin-win-cuda-12.4-x64.zip')
    expect(c?.extras.map((e) => e.name)).toEqual(['cudart-llama-bin-win-cuda-12.4-x64.zip'])
    const newest = pickAsset('llama', [llamaWin], { platform: 'win32', arch: 'x64', backend: 'cuda', cudaMax: '13.6' })
    expect(newest?.asset.name).toContain('13.4')
    expect(newest?.extras[0]?.name).toBe('cudart-llama-bin-win-cuda-13.4-x64.zip')
  })

  it('forces CUDA 12 for GTX 10-series even when the driver supports 13', () => {
    const c = pickAsset('llama', [llamaWin], { platform: 'win32', arch: 'x64', backend: 'cuda', cudaMax: '13.6', cuda12Only: true })
    expect(c?.detail).toBe('CUDA 12.4')
  })

  it('refuses CUDA builds newer than the driver supports', () => {
    expect(pickAsset('llama', [llamaWin], { platform: 'win32', arch: 'x64', backend: 'cuda', cudaMax: '11.8' })).toBeNull()
  })

  it('picks Linux builds', () => {
    expect(pickAsset('llama', [llamaWin], { platform: 'linux', arch: 'x64', backend: 'cpu' })?.asset.name).toBe('llama-b6800-bin-ubuntu-x64.tar.gz')
    expect(pickAsset('llama', [llamaWin], { platform: 'linux', arch: 'x64', backend: 'vulkan' })?.asset.name).toBe('llama-b6800-bin-ubuntu-vulkan-x64.tar.gz')
    expect(pickAsset('llama', [llamaWin], { platform: 'linux', arch: 'x64', backend: 'rocm' })?.asset.name).toBe('llama-b6800-bin-ubuntu-rocm-10.0-x64.tar.gz')
    expect(pickAsset('llama', [llamaWin], { platform: 'linux', arch: 'arm64', backend: 'cpu' })?.asset.name).toBe('llama-b6800-bin-ubuntu-arm64.tar.gz')
  })

  it('picks Linux CUDA with the build-tagged cudart tarball, respecting the driver and GTX limits', () => {
    const c = pickAsset('llama', [llamaWin], { platform: 'linux', arch: 'x64', backend: 'cuda', cudaMax: '13.6' })
    expect(c?.asset.name).toBe('llama-b6800-bin-ubuntu-cuda-13.4-x64.tar.gz')
    expect(c?.extras.map((e) => e.name)).toEqual(['cudart-llama-b6800-bin-ubuntu-cuda-13.4-x64.tar.gz'])
    const pascal = pickAsset('llama', [llamaWin], { platform: 'linux', arch: 'x64', backend: 'cuda', cudaMax: '13.6', cuda12Only: true })
    expect(pascal?.asset.name).toBe('llama-b6800-bin-ubuntu-cuda-12.8-x64.tar.gz')
    expect(pascal?.extras[0]?.name).toBe('cudart-llama-b6800-bin-ubuntu-cuda-12.8-x64.tar.gz')
    expect(pickAsset('llama', [llamaWin], { platform: 'linux', arch: 'x64', backend: 'cuda', cudaMax: '12.2' })).toBeNull()
  })

  it('does not mistake sycl/openvino/xcframework assets for a requested backend', () => {
    expect(pickAsset('llama', [llamaWin], { platform: 'win32', arch: 'x64', backend: 'cpu' })?.asset.name).toBe('llama-b6800-bin-win-cpu-x64.zip')
  })

  it('scans past a newest release that lacks the wanted build', () => {
    const newest = rel('b6900', ['llama-b6900-bin-win-cpu-x64.zip'])
    const c = pickAsset('llama', [newest, llamaWin], { platform: 'win32', arch: 'x64', backend: 'vulkan' })
    expect(c?.tag).toBe('b6800')
  })

  it('skips prereleases when a stable one exists', () => {
    const pre = rel('b7000', ['llama-b7000-bin-win-vulkan-x64.zip'], true)
    expect(pickAsset('llama', [pre, llamaWin], { platform: 'win32', arch: 'x64', backend: 'vulkan' })?.tag).toBe('b6800')
  })

  it('matches stable-diffusion.cpp builds', () => {
    // Names taken from the real master-929-3f8527a release.
    const sd = rel('master-929-3f8527a', [
      'cudart-sd-bin-win-cu12-x64.zip',
      'sd-master-3f8527a-bin-Darwin-macOS-26.6.2-arm64.zip',
      'sd-master-3f8527a-bin-Linux-Ubuntu-24.04-x86_64-rocm-7.14.0.zip',
      'sd-master-3f8527a-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip',
      'sd-master-3f8527a-bin-Linux-Ubuntu-24.04-x86_64.zip',
      'sd-master-3f8527a-bin-win-cpu-x64.zip',
      'sd-master-3f8527a-bin-win-cuda12-x64.zip',
      'sd-master-3f8527a-bin-win-rocm-7.14.0-x64.zip',
      'sd-master-3f8527a-bin-win-vulkan-x64.zip'
    ])
    expect(pickAsset('sd', [sd], { platform: 'win32', arch: 'x64', backend: 'vulkan' })?.asset.name).toBe('sd-master-3f8527a-bin-win-vulkan-x64.zip')
    expect(pickAsset('sd', [sd], { platform: 'win32', arch: 'x64', backend: 'cpu' })?.asset.name).toBe('sd-master-3f8527a-bin-win-cpu-x64.zip')
    expect(pickAsset('sd', [sd], { platform: 'win32', arch: 'x64', backend: 'rocm' })?.asset.name).toBe('sd-master-3f8527a-bin-win-rocm-7.14.0-x64.zip')
    const cuda = pickAsset('sd', [sd], { platform: 'win32', arch: 'x64', backend: 'cuda', cudaMax: '12.6' })
    expect(cuda?.asset.name).toBe('sd-master-3f8527a-bin-win-cuda12-x64.zip')
    expect(cuda?.extras[0]?.name).toBe('cudart-sd-bin-win-cu12-x64.zip')
    expect(pickAsset('sd', [sd], { platform: 'linux', arch: 'x64', backend: 'rocm' })?.asset.name).toBe('sd-master-3f8527a-bin-Linux-Ubuntu-24.04-x86_64-rocm-7.14.0.zip')
    expect(pickAsset('sd', [sd], { platform: 'linux', arch: 'x64', backend: 'vulkan' })?.asset.name).toBe('sd-master-3f8527a-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip')
    expect(pickAsset('sd', [sd], { platform: 'linux', arch: 'x64', backend: 'cpu' })?.asset.name).toBe('sd-master-3f8527a-bin-Linux-Ubuntu-24.04-x86_64.zip')
    expect(pickAsset('sd', [sd], { platform: 'linux', arch: 'x64', backend: 'cuda' })).toBeNull()
    expect(pickAsset('sd', [sd], { platform: 'linux', arch: 'arm64', backend: 'cpu' })).toBeNull()
  })

  it('ignores unrelated assets', () => {
    expect(pickAsset('llama', [rel('b1', ['README.md', 'llama-b1-xcframework.zip'])], { platform: 'win32', arch: 'x64', backend: 'cpu' })).toBeNull()
  })
})

describe('model library helpers', () => {
  it('extracts quantisation from file names', () => {
    expect(quantFromName('Llama-3.1-8B-Instruct-Q4_K_M.gguf')).toBe('Q4_K_M')
    expect(quantFromName('qwen2.5-7b-instruct-q8_0.gguf')).toBe('Q8_0')
    expect(quantFromName('model-IQ3_XS.gguf')).toBe('IQ3_XS')
    expect(quantFromName('gemma-2-9b-it-BF16.gguf')).toBe('BF16')
    expect(quantFromName('plain.gguf')).toBeUndefined()
  })

  it('recognises projector and shard files', () => {
    expect(isMmproj('/m/mmproj-F16.gguf')).toBe(true)
    expect(isMmproj('/m/model.gguf')).toBe(false)
    expect(isSecondaryShard('x-00002-of-00004.gguf')).toBe(true)
    expect(isSecondaryShard('x-00001-of-00004.gguf')).toBe(false)
    expect(isSecondaryShard('x.gguf')).toBe(false)
  })

  it('splits extra arguments honouring quotes', () => {
    expect(splitArgs('--a 1 --b "two words" --c \'x y\'')).toEqual(['--a', '1', '--b', 'two words', '--c', 'x y'])
    expect(splitArgs('')).toEqual([])
    expect(splitArgs('  --x   ')).toEqual(['--x'])
    expect(splitArgs('--p "a\\"b"')).toEqual(['--p', 'a"b'])
  })

  it('scans a models folder, pairing projectors and skipping shards/image GGUFs', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cairn-lib-'))
    try {
      const w = async (rel: string, size = 10) => {
        const f = path.join(root, rel)
        await fsp.mkdir(path.dirname(f), { recursive: true })
        await fsp.writeFile(f, Buffer.alloc(size))
        return f
      }
      const vision = await w('llm/vision/Qwen-VL-7B-Q4_K_M.gguf', 100)
      const proj = await w('llm/vision/mmproj-Qwen-VL-F16.gguf')
      await w('llm/big/Big-70B-Q4_K_M-00001-of-00002.gguf', 50)
      await w('llm/big/Big-70B-Q4_K_M-00002-of-00002.gguf', 50)
      await w('image/flux1-schnell-Q4_0.gguf')
      await w('diffusion_models/flux-dev-Q8_0.gguf')
      await w('image/sdxl_turbo.safetensors', 20)
      await w('vae/ae.safetensors', 5)
      await w('notes.txt')

      const llms = await scanGguf([root])
      const names = llms.map((m) => m.name)
      expect(names).toContain('Qwen-VL-7B-Q4_K_M')
      expect(names).toContain('Big-70B-Q4_K_M-00001-of-00002')
      expect(names).not.toContain('Big-70B-Q4_K_M-00002-of-00002')
      expect(names.some((n) => /flux/i.test(n))).toBe(false)
      expect(names.some((n) => /mmproj/i.test(n))).toBe(false)
      const q = llms.find((m) => m.path === vision)!
      expect(q.mmprojPath).toBe(proj)
      expect(q.quant).toBe('Q4_K_M')
      expect(await findMmproj(vision)).toBe(proj)

      const weights = (await scanImageWeights([root])).map((x) => x.name)
      expect(weights).toEqual(expect.arrayContaining(['sdxl_turbo.safetensors', 'ae.safetensors', 'flux1-schnell-Q4_0.gguf', 'flux-dev-Q8_0.gguf']))
      expect(weights).not.toContain('Qwen-VL-7B-Q4_K_M.gguf')
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })
})

describe('llama-server arguments', () => {
  const local = defaultSettings('/m').local
  it('builds the default command line', () => {
    const a = buildLlamaArgs({ ...local, contextSize: 8192, gpuLayers: -1, threads: 0, flashAttn: 'auto', extraArgs: '' }, '/m/x.gguf', 8123, 'vulkan', null)
    expect(a).toEqual(['-m', '/m/x.gguf', '--host', '127.0.0.1', '--port', '8123', '-c', '8192', '-ngl', '99', '--jinja', '--no-webui', '-np', '1'])
  })
  it('uses zero GPU layers on the CPU backend and forwards options', () => {
    const a = buildLlamaArgs({ ...local, contextSize: 4096, gpuLayers: -1, threads: 6, flashAttn: 'on', extraArgs: '--cache-type-k q8_0' }, '/m/x.gguf', 1, 'cpu', '/m/mmproj.gguf')
    expect(a).toContain('-ngl')
    expect(a[a.indexOf('-ngl') + 1]).toBe('0')
    expect(a.slice(a.indexOf('-t'), a.indexOf('-t') + 2)).toEqual(['-t', '6'])
    expect(a.slice(a.indexOf('-fa'), a.indexOf('-fa') + 2)).toEqual(['-fa', 'on'])
    expect(a.slice(a.indexOf('--mmproj'), a.indexOf('--mmproj') + 2)).toEqual(['--mmproj', '/m/mmproj.gguf'])
    expect(a.slice(-2)).toEqual(['--cache-type-k', 'q8_0'])
  })
  it('can start with thinking off, using the flag the build has, unless the user set one', () => {
    const base = { ...local, extraArgs: '' }
    const neu = buildLlamaArgs(base, '/m/x.gguf', 1, 'cuda', null, '--reasoning')
    expect(neu.slice(neu.indexOf('--reasoning'), neu.indexOf('--reasoning') + 2)).toEqual(['--reasoning', 'off'])
    const old = buildLlamaArgs(base, '/m/x.gguf', 1, 'cuda', null, '--reasoning-budget')
    expect(old.slice(old.indexOf('--reasoning-budget'), old.indexOf('--reasoning-budget') + 2)).toEqual(['--reasoning-budget', '0'])
    expect(buildLlamaArgs(base, '/m/x.gguf', 1, 'cuda', null)).not.toContain('--reasoning-budget')
    const own = buildLlamaArgs({ ...base, extraArgs: '--reasoning on' }, '/m/x.gguf', 1, 'cuda', null, '--reasoning')
    expect(own.filter((a) => a === '--reasoning')).toHaveLength(1)
    expect(own.at(-1)).toBe('on')
  })
  it('respects an explicit layer count', () => {
    const a = buildLlamaArgs({ ...local, gpuLayers: 20 }, '/m/x.gguf', 1, 'cuda', null)
    expect(a[a.indexOf('-ngl') + 1]).toBe('20')
  })
})

describe('hub response parsing', () => {
  it('parses Hugging Face search results', () => {
    const hits = parseHfSearch([{ id: 'bartowski/Llama-3.2-3B-Instruct-GGUF', downloads: 12, likes: 3, tags: ['gguf'] }, { nope: true }])
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe('bartowski/Llama-3.2-3B-Instruct-GGUF')
    expect(parseHfSearch({})).toEqual([])
  })

  it('lists weight files with encoded resolve URLs', () => {
    const files = parseHfTree(
      [
        { type: 'file', path: 'README.md', size: 1 },
        { type: 'file', path: 'model-Q4_K_M.gguf', size: 5, lfs: { size: 4000 } },
        { type: 'directory', path: 'sub' },
        { type: 'file', path: 'sub dir/a b.safetensors', size: 7 }
      ],
      'https://huggingface.co',
      'owner/repo'
    )
    expect(files.map((f) => f.path)).toEqual(['model-Q4_K_M.gguf', 'sub dir/a b.safetensors'])
    expect(files[0].size).toBe(4000)
    expect(files[0].url).toBe('https://huggingface.co/owner/repo/resolve/main/model-Q4_K_M.gguf')
    expect(files[1].url).toBe('https://huggingface.co/owner/repo/resolve/main/sub%20dir/a%20b.safetensors')
  })

  it('parses Civitai models and falls back to the version download URL', () => {
    const hits = parseCivitai({
      items: [
        {
          id: 1,
          name: 'Alpine Realism',
          type: 'Checkpoint',
          creator: { username: 'peak' },
          stats: { downloadCount: 99 },
          modelVersions: [{ id: 55, name: 'v1', baseModel: 'SDXL 1.0', files: [{ id: 9, name: 'alp.safetensors', sizeKB: 100, type: 'Model', primary: true }, { id: 10, name: 'x.zip', type: 'Training Data' }] }]
        },
        { name: 'broken' }
      ]
    })
    expect(hits).toHaveLength(1)
    expect(hits[0].versions[0].files).toHaveLength(1)
    expect(hits[0].versions[0].files[0].downloadUrl).toBe('https://civitai.com/api/download/models/55')
  })
})

describe('download destinations and auth', () => {
  const spec = (over: Partial<DownloadSpec>): DownloadSpec => ({ url: 'https://huggingface.co/a/b/resolve/main/x.gguf', subdir: 'llm', filename: 'x.gguf', source: 'hf', ...over })

  it('keeps every download inside the models directory', () => {
    const root = path.resolve('/models')
    expect(destFor(root, spec({}))).toBe(path.join(root, 'llm', 'x.gguf'))
    const evil = destFor(root, spec({ subdir: '../../etc', filename: '../../passwd' }))
    expect(path.relative(root, evil).startsWith('..')).toBe(false)
    expect(path.isAbsolute(path.relative(root, evil))).toBe(false)
  })

  it('adds credentials only for the matching service', () => {
    const s = defaultSettings('/m')
    s.paths.hfToken = 'hf_secret'
    s.paths.civitaiToken = 'civ_secret'
    expect(headersFor(s, spec({})).headers.Authorization).toBe('Bearer hf_secret')
    const civ = headersFor(s, spec({ url: 'https://civitai.com/api/download/models/55', source: 'civitai' }))
    expect(civ.headers.Authorization).toBe('Bearer civ_secret')
    expect(civ.url).toContain('token=civ_secret')
    const other = headersFor(s, spec({ url: 'https://example.com/x.gguf', source: 'url' }))
    expect(other.headers.Authorization).toBeUndefined()
    expect(other.url).toBe('https://example.com/x.gguf')
  })
})

/* ───────────────────────────── downloader against a real local server ───────────────────────────── */

describe('resumable downloader', () => {
  const payload = Buffer.alloc(300_000)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff

  let tmp: string
  let server: http.Server
  let cdn: http.Server
  let port = 0
  let cdnPort = 0
  const hits: Record<string, number> = {}
  const seen = (k: string) => (hits[k] = (hits[k] ?? 0) + 1)

  const serveRange = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '')
    if (m) {
      const start = Number(m[1])
      if (start >= payload.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${payload.length}` })
        return res.end()
      }
      res.writeHead(206, { 'Content-Length': payload.length - start, 'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}` })
      return res.end(payload.subarray(start))
    }
    res.writeHead(200, { 'Content-Length': payload.length })
    res.end(payload)
  }

  beforeAll(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cairn-dl-'))
    cdn = http.createServer((req, res) => {
      if (req.url === '/signed') {
        // First request carries an "expired signature": 403. Later ones succeed.
        if (seen('cdn') === 1) {
          res.writeHead(403)
          return res.end('expired')
        }
        return serveRange(req, res)
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((r) => cdn.listen(0, '127.0.0.1', r))
    cdnPort = (cdn.address() as AddressInfo).port

    server = http.createServer((req, res) => {
      const url = req.url ?? ''
      if (url === '/file') return serveRange(req, res)
      if (url === '/flaky') {
        if (seen('flaky') === 1) {
          res.writeHead(503)
          return res.end()
        }
        return serveRange(req, res)
      }
      if (url === '/truncate') {
        // First attempt: promise everything, send half, then drop the connection.
        if (seen('truncate') === 1) {
          res.writeHead(200, { 'Content-Length': payload.length })
          res.write(payload.subarray(0, 120_000))
          setTimeout(() => res.destroy(), 30)
          return
        }
        return serveRange(req, res)
      }
      if (url === '/redirect') {
        res.writeHead(302, { Location: `http://127.0.0.1:${cdnPort}/signed` })
        return res.end()
      }
      if (url === '/forbidden') {
        res.writeHead(403)
        return res.end('nope')
      }
      if (url === '/missing') {
        res.writeHead(404)
        return res.end()
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise((r) => server.close(r))
    await new Promise((r) => cdn.close(r))
    await fsp.rm(tmp, { recursive: true, force: true })
  })

  const same = async (file: string) => expect((await fsp.readFile(file)).equals(payload)).toBe(true)

  it('downloads a file and reports progress', async () => {
    const dest = path.join(tmp, 'a', 'plain.bin')
    let last = 0
    await downloadFile({ url: `http://127.0.0.1:${port}/file`, dest, onProgress: (r) => (last = r) })
    await same(dest)
    expect(last).toBe(payload.length)
    expect(fs.existsSync(`${dest}.part`)).toBe(false)
  })

  it('resumes from an existing .part file', async () => {
    const dest = path.join(tmp, 'resume.bin')
    await fsp.writeFile(`${dest}.part`, payload.subarray(0, 100_000))
    await downloadFile({ url: `http://127.0.0.1:${port}/file`, dest })
    await same(dest)
  })

  it('treats a .part file that is already complete as done (HTTP 416)', async () => {
    const dest = path.join(tmp, 'complete.bin')
    await fsp.writeFile(`${dest}.part`, payload)
    await downloadFile({ url: `http://127.0.0.1:${port}/file`, dest })
    await same(dest)
  })

  it('retries a transient 503', async () => {
    const dest = path.join(tmp, 'flaky.bin')
    await downloadFile({ url: `http://127.0.0.1:${port}/flaky`, dest, retries: 3 })
    await same(dest)
    expect(hits.flaky).toBe(2)
  }, 15000)

  it('continues after the connection drops mid-transfer', async () => {
    const dest = path.join(tmp, 'truncate.bin')
    await downloadFile({ url: `http://127.0.0.1:${port}/truncate`, dest, retries: 3 })
    await same(dest)
    expect(hits.truncate).toBeGreaterThanOrEqual(2)
  }, 15000)

  it('retries a 403 that comes from a redirected CDN (expired signature)', async () => {
    const dest = path.join(tmp, 'cdn.bin')
    await downloadFile({ url: `http://127.0.0.1:${port}/redirect`, dest, retries: 3 })
    await same(dest)
    expect(hits.cdn).toBe(2)
  }, 15000)

  it('fails fast with a helpful message on a direct 403', async () => {
    const dest = path.join(tmp, 'denied.bin')
    const err = await downloadFile({ url: `http://127.0.0.1:${port}/forbidden`, dest, retries: 3 }).catch((e) => e)
    expect(err).toBeInstanceOf(DownloadError)
    expect(err.fatal).toBe(true)
    expect(err.message).toMatch(/access denied/i)
    expect(fs.existsSync(dest)).toBe(false)
  })

  it('fails fast on 404', async () => {
    const err = await downloadFile({ url: `http://127.0.0.1:${port}/missing`, dest: path.join(tmp, 'm.bin'), retries: 3 }).catch((e) => e)
    expect(err).toBeInstanceOf(DownloadError)
    expect(err.message).toMatch(/404/)
  })

  it('can be cancelled', async () => {
    const ac = new AbortController()
    ac.abort()
    const err = await downloadFile({ url: `http://127.0.0.1:${port}/file`, dest: path.join(tmp, 'c.bin'), signal: ac.signal }).catch((e) => e)
    expect(String(err.message)).toMatch(/cancel/i)
  })
})

describe('Real-ESRGAN upscale engine', () => {
  const esrganRel = rel('v0.2.5.0', [
    'realesr-animevideov3.pth',
    'realesrgan-ncnn-vulkan-20220424-macos.zip',
    'realesrgan-ncnn-vulkan-20220424-ubuntu.zip',
    'realesrgan-ncnn-vulkan-20220424-windows.zip'
  ])
  const base = { platform: 'win32' as const, arch: 'x64', devices: [], rocmRuntime: false, vulkanRuntime: true }

  it('is one Vulkan build per OS, on x64 only', () => {
    expect(availableBackends('esrgan', 'win32', 'x64')).toEqual(['vulkan'])
    expect(availableBackends('esrgan', 'linux', 'x64')).toEqual(['vulkan'])
    expect(availableBackends('esrgan', 'win32', 'arm64')).toEqual([])
    expect(availableBackends('esrgan', 'darwin', 'x64')).toEqual([])
  })

  it('always recommends Vulkan, for any GPU, and warns when no Vulkan runtime is found', () => {
    for (const vendor of ['nvidia', 'amd', 'intel'] as const) {
      expect(recommend('esrgan', { ...base, devices: [{ vendor, name: 'GPU' }] }).backend).toBe('vulkan')
    }
    expect(recommend('esrgan', { ...base, vulkanRuntime: false }).notes.join(' ')).toMatch(/No Vulkan runtime/)
  })

  it('picks the zip for the operating system and ignores the .pth models', () => {
    expect(pickAsset('esrgan', [esrganRel], { platform: 'win32', arch: 'x64', backend: 'vulkan' })?.asset.name).toBe('realesrgan-ncnn-vulkan-20220424-windows.zip')
    expect(pickAsset('esrgan', [esrganRel], { platform: 'linux', arch: 'x64', backend: 'vulkan' })?.asset.name).toBe('realesrgan-ncnn-vulkan-20220424-ubuntu.zip')
    expect(pickAsset('esrgan', [esrganRel], { platform: 'linux', arch: 'arm64', backend: 'vulkan' })).toBeNull()
    expect(pickAsset('esrgan', [rel('v0.2.3.0', ['RealESRGANv2-animevideo-xsx2.pth'])], { platform: 'win32', arch: 'x64', backend: 'vulkan' })).toBeNull()
  })

  it('scans past releases that only carry model files', () => {
    const c = pickAsset('esrgan', [rel('v0.3.0', []), rel('v0.2.4.0', []), esrganRel], { platform: 'win32', arch: 'x64', backend: 'vulkan' })
    expect(c?.tag).toBe('v0.2.5.0')
  })

  it('looks for the program by its real name', () => {
    expect(binaryNames('esrgan', 'win32')).toEqual(['realesrgan-ncnn-vulkan.exe'])
    expect(binaryNames('esrgan', 'linux')).toEqual(['realesrgan-ncnn-vulkan'])
  })
})
