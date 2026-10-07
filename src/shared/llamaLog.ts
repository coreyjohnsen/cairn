import type { LlamaMemoryReport } from './types'

/**
 * Reads the engine's start-up report to learn where the model really went. llama.cpp prints lines like
 *   load_tensors:        CUDA0 model buffer size =  4095.05 MiB
 *   load_tensors:   CPU_Mapped model buffer size =   281.81 MiB
 *   llama_kv_cache:      CUDA0 KV buffer size =   512.00 MiB
 *   llama_context:      CUDA0 compute buffer size =   296.00 MiB
 *   load_tensors: offloaded 33/33 layers to GPU
 * (older builds call the first "llm_load_tensors" and leave out the word "model"). Memory on the card is video memory;
 * anything the engine calls CPU or Host is RAM.
 */

const BUFFER = /([A-Za-z][\w.]*)\s+(model|KV|compute|output|RS)?\s*buffer size\s*=\s*([\d.]+)\s*MiB/i
const OFFLOADED = /offloaded\s+(\d+)\s*\/\s*(\d+)\s+layers\s+to\s+GPU/i

const isRam = (device: string): boolean => /^CPU/i.test(device) || /host$/i.test(device)

export function parseLlamaMemory(log: string[]): LlamaMemoryReport | null {
  const r: LlamaMemoryReport = { gpuModelMB: 0, gpuCacheMB: 0, gpuComputeMB: 0, cpuModelMB: 0, cpuCacheMB: 0, cpuComputeMB: 0 }
  let seen = false
  for (const line of log) {
    const off = OFFLOADED.exec(line)
    if (off) {
      r.layersOnGpu = Number(off[1])
      r.layersTotal = Number(off[2])
      continue
    }
    const m = BUFFER.exec(line)
    if (!m) continue
    const kind = (m[2] ?? 'model').toLowerCase()
    if (kind === 'output' || kind === 'rs') continue
    const mb = Number(m[3])
    if (!Number.isFinite(mb)) continue
    const ram = isRam(m[1])
    seen = true
    if (kind === 'model') ram ? (r.cpuModelMB += mb) : (r.gpuModelMB += mb)
    else if (kind === 'kv') ram ? (r.cpuCacheMB += mb) : (r.gpuCacheMB += mb)
    else if (kind === 'compute') ram ? (r.cpuComputeMB += mb) : (r.gpuComputeMB += mb)
  }
  if (!seen) return null
  for (const k of ['gpuModelMB', 'gpuCacheMB', 'gpuComputeMB', 'cpuModelMB', 'cpuCacheMB', 'cpuComputeMB'] as const) r[k] = Math.round(r[k])
  return r
}
