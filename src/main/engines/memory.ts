import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import type { EngineBackend, GpuDevice, MemoryHardware, ModelShape } from '@shared/types'
import { ASSUMED_RAM_BANDWIDTH, gpuBandwidth, ramBandwidth } from '@shared/memoryPlan'
import { probeFlags } from '../images/sdcpp'
import { detectGpus } from './gpu'
import { readModelShape } from './gguf'
import { findMmproj } from './library'
import type { EngineManager } from './manager'

/** What the memory planner needs from this computer: video memory, RAM, their speeds, and which placement flags the engine has. */

const shapeCache = new Map<string, { mtimeMs: number; size: number; shape: ModelShape }>()

/** Reads a model file's shape (cached until the file changes). */
export async function inspectModel(modelPath: string): Promise<ModelShape> {
  if (!/\.gguf$/i.test(modelPath)) throw new Error('That is not a GGUF model file.')
  const st = await fsp.stat(modelPath).catch(() => null)
  if (!st?.isFile()) throw new Error(`Model file not found: ${modelPath}`)
  const hit = shapeCache.get(modelPath)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.shape
  const shape = await readModelShape(modelPath, await findMmproj(modelPath))
  shapeCache.set(modelPath, { mtimeMs: st.mtimeMs, size: st.size, shape })
  return shape
}

interface WinMemory {
  Speed?: number
  ConfiguredClockSpeed?: number
  SMBIOSMemoryType?: number
}

const DDR_NAME: Record<number, string> = { 24: 'DDR3', 26: 'DDR4', 34: 'DDR5' }

/** The sticks of RAM from `Get-CimInstance Win32_PhysicalMemory | ConvertTo-Json`. */
export function parseWindowsMemory(json: string): { sticks: number; megaTransfers: number; type: string } | null {
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return null
  }
  const list = (Array.isArray(v) ? v : v ? [v] : []) as WinMemory[]
  if (!list.length) return null
  const speeds = list.map((m) => Number(m.ConfiguredClockSpeed) || Number(m.Speed) || 0).filter((n) => n >= 400 && n <= 20000)
  if (!speeds.length) return null
  const type = DDR_NAME[list.find((m) => m.SMBIOSMemoryType && DDR_NAME[m.SMBIOSMemoryType])?.SMBIOSMemoryType ?? 0] ?? 'DDR'
  return { sticks: list.length, megaTransfers: Math.min(...speeds), type }
}

let ramCache: { bandwidth: number; detail: string; detected: boolean } | null = null

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 8000, windowsHide: true, maxBuffer: 1 << 20 }, (err, out) => resolve(err ? null : String(out)))
    } catch {
      resolve(null)
    }
  })
}

async function detectRam(): Promise<{ bandwidth: number; detail: string; detected: boolean }> {
  if (ramCache) return ramCache
  let found: { bandwidth: number; detail: string; detected: boolean } | null = null
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_PhysicalMemory | Select-Object Speed,ConfiguredClockSpeed,SMBIOSMemoryType | ConvertTo-Json -Compress'])
    const m = out ? parseWindowsMemory(out) : null
    if (m) found = { bandwidth: ramBandwidth(m.megaTransfers, m.sticks), detail: `${m.type}-${m.megaTransfers}, ${m.sticks} stick${m.sticks === 1 ? '' : 's'}`, detected: true }
  }
  ramCache = found ?? { bandwidth: ASSUMED_RAM_BANDWIDTH, detail: 'assumed ordinary dual-channel DDR4', detected: false }
  return ramCache
}

/** The video memory the model can use: the biggest card, plus any card of the same make that is comparable (the engine splits layers over them). */
export function usableVram(devices: GpuDevice[]): { vramMB: number; count: number; main: GpuDevice | null } {
  const cards = devices.filter((d) => d.vendor !== 'unknown' && (d.vramMB ?? 0) > 0).sort((a, b) => (b.vramMB ?? 0) - (a.vramMB ?? 0))
  const main = cards[0]
  if (!main) return { vramMB: 0, count: 0, main: null }
  const same = cards.filter((d) => d.vendor === main.vendor && (d.vramMB ?? 0) >= (main.vramMB ?? 0) * 0.25)
  return { vramMB: same.reduce((a, d) => a + (d.vramMB ?? 0), 0), count: same.length, main }
}

export async function memoryHardware(engines: EngineManager, force = false): Promise<MemoryHardware> {
  const gpu = await detectGpus(force)
  const backend: EngineBackend | null = engines.resolvedBackend('llama') ?? (engines.resolveBinary('llama') ? gpu.recommended : null)
  const vram = usableVram(gpu.devices)
  const bw = vram.main ? gpuBandwidth(vram.main.name) : { gbs: 0, known: false }
  const ram = await detectRam()
  const binary = engines.resolveBinary('llama')
  const probed = binary ? await probeFlags(binary, engines.spawnEnv('llama', binary)) : null
  return {
    backend,
    gpuName: vram.main?.name ?? '',
    gpuCount: vram.count,
    vramMB: backend === 'cpu' ? 0 : vram.vramMB,
    ramMB: gpu.totalRamMB,
    gpuBandwidthGBs: bw.gbs,
    gpuBandwidthKnown: bw.known,
    ramBandwidthGBs: ram.bandwidth,
    ramDetail: ram.detail,
    ramDetected: ram.detected,
    flags: {
      nCpuMoe: !!probed?.has('--n-cpu-moe'),
      overrideTensor: probed ? probed.has('--override-tensor') : true,
      noKvOffload: probed ? probed.has('--no-kv-offload') : true,
      known: !!probed
    }
  }
}
