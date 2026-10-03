import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineBackend, EngineId, GpuDevice, GpuInfo, GpuVendor } from '@shared/types'

function run(cmd: string, args: string[], timeoutMs = 6000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? null : String(stdout))
      })
    } catch {
      resolve(null)
    }
  })
}

export function vendorFromName(name: string): GpuVendor {
  if (/nvidia|geforce|\brtx\b|\bgtx\b|quadro|tesla|titan/i.test(name)) return 'nvidia'
  if (/\bamd\b|radeon|\brx\s?\d|ati\b|instinct|vega|firepro/i.test(name)) return 'amd'
  if (/intel|\barc\b|iris|\buhd\b/i.test(name)) return 'intel'
  if (/apple|\bm[1-9]\b/i.test(name)) return 'apple'
  return 'unknown'
}

const IGNORED_ADAPTERS = /microsoft basic|remote display|virtual|vmware|hyper-v|parsec|citrix|displaylink|indirect display/i

/** `nvidia-smi --query-gpu=name,memory.total,driver_version[,compute_cap] --format=csv,noheader,nounits` */
export function parseNvidiaSmiCsv(out: string): GpuDevice[] {
  const devices: GpuDevice[] = []
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split(',').map((s) => s.trim())
    if (parts.length < 2) continue
    const vram = Number(parts[1])
    devices.push({
      vendor: 'nvidia',
      name: parts[0],
      vramMB: Number.isFinite(vram) ? vram : undefined,
      driver: parts[2] || undefined,
      computeCap: parts[3] && /^\d+\.\d+$/.test(parts[3]) ? parts[3] : undefined
    })
  }
  return devices
}

export function parseCudaVersion(out: string): string | undefined {
  const m = /CUDA Version:\s*(\d+\.\d+)/i.exec(out)
  return m ? m[1] : undefined
}

interface WinAdapter {
  Name?: string
  AdapterRAM?: number
  DriverVersion?: string
}
interface WinVram {
  DriverDesc?: string
  vram?: number
}

/** Parse the JSON from `Get-CimInstance Win32_VideoController` plus the registry VRAM query. */
export function parseWindowsAdapters(videoJson: string, vramJson: string): GpuDevice[] {
  const asArray = <T>(s: string): T[] => {
    try {
      const v = JSON.parse(s)
      return Array.isArray(v) ? v : v ? [v] : []
    } catch {
      return []
    }
  }
  const adapters = asArray<WinAdapter>(videoJson)
  const vrams = asArray<WinVram>(vramJson)
  const out: GpuDevice[] = []
  for (const a of adapters) {
    const name = (a.Name ?? '').trim()
    if (!name || IGNORED_ADAPTERS.test(name)) continue
    const reg = vrams.find((v) => v.DriverDesc?.trim() === name)
    let vramMB: number | undefined
    if (reg?.vram && reg.vram > 0) vramMB = Math.round(reg.vram / 1048576)
    else if (a.AdapterRAM && a.AdapterRAM > 0) vramMB = Math.round(a.AdapterRAM / 1048576) // capped at 4 GB by WMI
    out.push({ vendor: vendorFromName(name), name, vramMB, driver: a.DriverVersion })
  }
  return out
}

/** Lines from `lspci` for display controllers. */
export function parseLspci(out: string): GpuDevice[] {
  const devices: GpuDevice[] = []
  for (const line of out.split(/\r?\n/)) {
    if (!/(VGA compatible controller|3D controller|Display controller)/i.test(line)) continue
    const after = line.replace(/^.*?(VGA compatible controller|3D controller|Display controller)[^:]*:\s*/i, '')
    const bracket = [...after.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]).filter((s) => !/^[0-9a-f]{4}:[0-9a-f]{4}$/i.test(s))
    const pretty = (bracket.length ? bracket[bracket.length - 1] : after).replace(/\(rev [0-9a-f]+\)/i, '').trim()
    const name = after.includes('[AMD/ATI]') || /Advanced Micro/i.test(after) ? `AMD ${pretty}` : /NVIDIA/i.test(after) ? `NVIDIA ${pretty}` : pretty
    if (IGNORED_ADAPTERS.test(name)) continue
    devices.push({ vendor: vendorFromName(after + ' ' + name), name: name.replace(/^(AMD|NVIDIA) \1/, '$1') })
  }
  return devices
}

function readSysfsVram(): Map<string, number> {
  const map = new Map<string, number>()
  try {
    for (const card of fs.readdirSync('/sys/class/drm')) {
      if (!/^card\d+$/.test(card)) continue
      const dev = path.join('/sys/class/drm', card, 'device')
      try {
        const vendor = fs.readFileSync(path.join(dev, 'vendor'), 'utf8').trim()
        const total = Number(fs.readFileSync(path.join(dev, 'mem_info_vram_total'), 'utf8').trim())
        if (vendor === '0x1002' && total > 0) map.set(card, Math.round(total / 1048576))
      } catch {
        /* not an amdgpu card */
      }
    }
  } catch {
    /* no drm */
  }
  return map
}

function findOnPath(fileName: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    try {
      if (fs.statSync(path.join(dir, fileName)).isFile()) return true
    } catch {
      /* keep looking */
    }
  }
  return false
}

function whichSync(bin: string): boolean {
  return process.platform === 'win32' ? findOnPath(`${bin}.exe`) || findOnPath(`${bin}.cmd`) : findOnPath(bin)
}

export function detectRocmRuntime(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    if (process.env.HIP_PATH && fs.existsSync(process.env.HIP_PATH)) return true
    if (fs.existsSync('C:\\Program Files\\AMD\\ROCm') || fs.existsSync('C:\\TheRock')) return true
    return findOnPath('hipblas.dll') || (process.env.PATH ?? '').toLowerCase().includes('rocm')
  }
  return fs.existsSync('/opt/rocm') || whichSync('rocminfo') || whichSync('rocm-smi')
}

export function detectVulkanRuntime(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return fs.existsSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'vulkan-1.dll'))
  return (
    fs.existsSync('/usr/share/vulkan/icd.d') ||
    fs.existsSync('/etc/vulkan/icd.d') ||
    fs.existsSync('/usr/lib/x86_64-linux-gnu/libvulkan.so.1') ||
    fs.existsSync('/usr/lib64/libvulkan.so.1')
  )
}

/** Backends that have official prebuilt binaries per engine/platform. */
export function availableBackends(engine: EngineId, platform: NodeJS.Platform, arch: string): EngineBackend[] {
  // Real-ESRGAN (ncnn) has one Windows and one Linux build, and both run on Vulkan: NVIDIA, AMD and Intel alike.
  if (engine === 'esrgan') return arch === 'x64' && (platform === 'win32' || platform === 'linux') ? ['vulkan'] : []
  if (arch !== 'x64') return platform === 'win32' || platform === 'linux' ? ['cpu'] : []
  if (platform === 'win32') return ['cuda', 'rocm', 'vulkan', 'cpu']
  if (platform === 'linux') return engine === 'sd' ? ['rocm', 'vulkan', 'cpu'] : ['cuda', 'rocm', 'vulkan', 'cpu']
  return []
}

/** Oldest CUDA the driver must support for the smallest prebuilt llama.cpp CUDA build on each OS. */
const LLAMA_MIN_CUDA: Partial<Record<NodeJS.Platform, string>> = { win32: '12.4', linux: '12.8' }

function cudaAtLeast(have: string, min: string): boolean {
  const [a1 = 0, a2 = 0] = have.split('.').map(Number)
  const [b1 = 0, b2 = 0] = min.split('.').map(Number)
  return a1 > b1 || (a1 === b1 && a2 >= b2)
}

export function recommend(
  engine: EngineId,
  info: Pick<GpuInfo, 'platform' | 'arch' | 'devices' | 'rocmRuntime' | 'vulkanRuntime'>
): { backend: EngineBackend; notes: string[] } {
  const avail = availableBackends(engine, info.platform, info.arch)
  const notes: string[] = []
  if (engine === 'esrgan') {
    if (!info.vulkanRuntime) notes.push('No Vulkan runtime was found. Update your graphics driver if the upscaler will not start.')
    return { backend: 'vulkan', notes }
  }
  const has = (b: EngineBackend) => avail.includes(b)
  const nv = info.devices.find((d) => d.vendor === 'nvidia')
  const amd = info.devices.find((d) => d.vendor === 'amd')
  const intel = info.devices.find((d) => d.vendor === 'intel')
  let pick: EngineBackend = 'cpu'

  if (nv) {
    const minCuda = engine === 'llama' ? LLAMA_MIN_CUDA[info.platform] : undefined
    const driverTooOld = !!(minCuda && nv.cudaVersion && !cudaAtLeast(nv.cudaVersion, minCuda))
    if (has('cuda') && !driverTooOld) {
      pick = 'cuda'
      const cc = nv.computeCap ? Number(nv.computeCap) : undefined
      if (cc !== undefined && cc < 7.5) notes.push('Older GeForce GTX card detected: the CUDA 12 build will be used (CUDA 13 dropped Pascal and older GPUs).')
    } else if (has('vulkan')) {
      pick = 'vulkan'
      if (driverTooOld) notes.push(`Your NVIDIA driver supports CUDA ${nv.cudaVersion}, but the prebuilt CUDA build needs ${minCuda} or newer. Update the NVIDIA driver to use CUDA; Vulkan works in the meantime.`)
      else notes.push('Official builds for NVIDIA on this system use Vulkan. For maximum speed compile with CUDA yourself and pick it under "Use my own binary".')
    }
  } else if (amd) {
    if (info.platform === 'linux' && has('rocm') && info.rocmRuntime) {
      pick = 'rocm'
      notes.push('The prebuilt ROCm build must match the ROCm version installed on this machine. If it fails to start, switch to Vulkan.')
    } else if (has('vulkan')) {
      pick = 'vulkan'
      if (info.platform === 'win32') notes.push('Vulkan works out of the box on Radeon cards. HIP/ROCm is faster in some cases but needs AMD\'s HIP runtime installed.')
      else if (!info.rocmRuntime) notes.push('ROCm was not found, so Vulkan (Mesa RADV) is recommended.')
    }
  } else if (intel && has('vulkan')) {
    pick = 'vulkan'
  } else {
    notes.push('No dedicated GPU was detected, so models will run on the CPU.')
  }
  if (!has(pick)) pick = has('cpu') ? 'cpu' : (avail[0] ?? 'cpu')
  if (pick === 'vulkan' && !info.vulkanRuntime) notes.push('No Vulkan runtime was found — update your graphics driver if the Vulkan build fails to start.')
  return { backend: pick, notes }
}

let cache: GpuInfo | null = null

export async function detectGpus(force = false): Promise<GpuInfo> {
  if (cache && !force) return cache
  const platform = process.platform
  const devices: GpuDevice[] = []

  // NVIDIA (works on Windows and Linux when the driver is installed)
  let smi = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version,compute_cap', '--format=csv,noheader,nounits'])
  if (smi === null) smi = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'])
  if (smi) {
    const nv = parseNvidiaSmiCsv(smi)
    const plain = await run('nvidia-smi', [])
    const cuda = plain ? parseCudaVersion(plain) : undefined
    for (const d of nv) devices.push({ ...d, cudaVersion: cuda })
  }

  if (platform === 'win32') {
    const video = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress'
    ])
    const vram = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | Where-Object { $_.'HardwareInformation.qwMemorySize' } | Select-Object DriverDesc,@{n='vram';e={[int64]$_.'HardwareInformation.qwMemorySize'}} | ConvertTo-Json -Compress"
    ])
    if (video) {
      for (const d of parseWindowsAdapters(video, vram ?? '[]')) {
        if (d.vendor === 'nvidia' && devices.some((x) => x.vendor === 'nvidia')) continue // already covered by nvidia-smi
        devices.push(d)
      }
    }
  } else if (platform === 'linux') {
    const lspci = await run('lspci', [])
    if (lspci) {
      const sys = readSysfsVram()
      const amdVram = [...sys.values()]
      let amdIdx = 0
      for (const d of parseLspci(lspci)) {
        if (d.vendor === 'nvidia' && devices.some((x) => x.vendor === 'nvidia')) continue
        if (d.vendor === 'amd') d.vramMB = amdVram[amdIdx++]
        devices.push(d)
      }
    } else {
      for (const [, mb] of readSysfsVram()) devices.push({ vendor: 'amd', name: 'AMD GPU', vramMB: mb })
    }
  }

  const base = {
    platform,
    arch: process.arch,
    devices,
    rocmRuntime: detectRocmRuntime(platform),
    vulkanRuntime: detectVulkanRuntime(platform)
  }
  const rec = recommend('llama', base)
  cache = {
    ...base,
    recommended: rec.backend,
    notes: rec.notes,
    cpuThreads: os.cpus().length,
    totalRamMB: Math.round(os.totalmem() / 1048576)
  }
  return cache
}
