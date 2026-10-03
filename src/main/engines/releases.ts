import type { EngineBackend, EngineId } from '@shared/types'

export interface ReleaseAsset {
  name: string
  url: string
  size: number
}

export interface Release {
  tag: string
  name: string
  prerelease: boolean
  assets: ReleaseAsset[]
}

export interface AssetChoice {
  tag: string
  backend: EngineBackend
  asset: ReleaseAsset
  /** Extra archives to extract into the same folder (e.g. the CUDA runtime DLLs). */
  extras: ReleaseAsset[]
  /** Human note, e.g. "CUDA 12.4". */
  detail: string
}

export const ENGINE_REPOS: Record<EngineId, string> = {
  llama: 'ggml-org/llama.cpp',
  sd: 'leejet/stable-diffusion.cpp',
  // The portable Real-ESRGAN-ncnn-vulkan builds (with their models) are attached to this repo's releases.
  esrgan: 'xinntao/Real-ESRGAN'
}

export async function fetchReleases(repo: string, count = 15, signal?: AbortSignal): Promise<Release[]> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=${count}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Cairn' },
    signal: signal ?? AbortSignal.timeout(20000)
  })
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      throw new Error('GitHub rate limit reached while looking up the latest engine build. Wait a few minutes, or download a build manually and use "Use my own binary".')
    }
    throw new Error(`Could not read releases for ${repo} (HTTP ${res.status}).`)
  }
  const json = (await res.json()) as any[]
  return json.map((r) => ({
    tag: String(r.tag_name),
    name: String(r.name ?? r.tag_name),
    prerelease: Boolean(r.prerelease),
    assets: (r.assets ?? []).map((a: any) => ({ name: String(a.name), url: String(a.browser_download_url), size: Number(a.size) || 0 }))
  }))
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

export interface PickOptions {
  platform: NodeJS.Platform
  arch: string
  backend: EngineBackend
  /** Highest CUDA version the driver supports (e.g. "12.4"). */
  cudaMax?: string
  /** Force CUDA 12.x (GTX 10-series and older). */
  cuda12Only?: boolean
}

type Matcher = (name: string) => { backend: EngineBackend; version?: string } | null

function llamaMatcher(platform: NodeJS.Platform, arch: string): Matcher {
  const a = arch === 'arm64' ? 'arm64' : 'x64'
  return (name) => {
    if (!/^llama-b\d+-bin-/.test(name)) return null
    if (platform === 'win32') {
      let m: RegExpExecArray | null
      if (new RegExp(`^llama-b\\d+-bin-win-cpu-${a}\\.zip$`).test(name)) return { backend: 'cpu' }
      if (new RegExp(`^llama-b\\d+-bin-win-vulkan-${a}\\.zip$`).test(name)) return { backend: 'vulkan' }
      if ((m = new RegExp(`^llama-b\\d+-bin-win-cuda-(\\d+\\.\\d+)-${a}\\.zip$`).exec(name))) return { backend: 'cuda', version: m[1] }
      if ((m = new RegExp(`^llama-b\\d+-bin-win-(?:rocm|hip)[-\\w.]*?-${a}\\.zip$`).exec(name))) return { backend: 'rocm' }
      return null
    }
    if (platform === 'linux') {
      if (new RegExp(`^llama-b\\d+-bin-ubuntu-${a}\\.tar\\.gz$`).test(name)) return { backend: 'cpu' }
      if (new RegExp(`^llama-b\\d+-bin-ubuntu-vulkan-${a}\\.tar\\.gz$`).test(name)) return { backend: 'vulkan' }
      let m: RegExpExecArray | null
      if ((m = new RegExp(`^llama-b\\d+-bin-ubuntu-cuda-(\\d+\\.\\d+)-${a}\\.tar\\.gz$`).exec(name))) return { backend: 'cuda', version: m[1] }
      if (new RegExp(`^llama-b\\d+-bin-ubuntu-rocm[-\\w.]*?-${a}\\.tar\\.gz$`).test(name)) return { backend: 'rocm' }
      return null
    }
    return null
  }
}

function sdMatcher(platform: NodeJS.Platform, arch: string): Matcher {
  return (name) => {
    if (!/^sd-master-[\w]+-bin-/.test(name) || arch !== 'x64') return null
    if (platform === 'win32') {
      let m: RegExpExecArray | null
      if (/-bin-win-(cpu|avx2)-x64\.zip$/.test(name)) return { backend: 'cpu' }
      if (/-bin-win-vulkan-x64\.zip$/.test(name)) return { backend: 'vulkan' }
      if ((m = /-bin-win-cuda(\d+)(?:\.(\d+))?-x64\.zip$/.exec(name))) return { backend: 'cuda', version: m[2] ? `${m[1]}.${m[2]}` : `${m[1]}.0` }
      if (/-bin-win-(rocm|hip)[-\w.]*-x64\.zip$/.test(name)) return { backend: 'rocm' }
      return null
    }
    if (platform === 'linux') {
      const m = /-bin-Linux-[\w.-]+?-x86_64(?:-(vulkan|rocm|cuda)[\w.-]*)?\.zip$/.exec(name)
      if (m) return { backend: (m[1] as EngineBackend | undefined) ?? 'cpu' }
    }
    return null
  }
}

/** realesrgan-ncnn-vulkan-20220424-windows.zip / -ubuntu.zip: one Vulkan build per OS, models included. */
function esrganMatcher(platform: NodeJS.Platform, arch: string): Matcher {
  return (name) => {
    if (arch !== 'x64') return null
    const os = platform === 'win32' ? 'windows' : platform === 'linux' ? 'ubuntu' : null
    if (!os) return null
    return new RegExp(`^realesrgan-ncnn-vulkan-[\\w.]+-${os}\\.zip$`, 'i').test(name) ? { backend: 'vulkan' } : null
  }
}

/** Runtime archives that must sit next to the CUDA build (cudart/cublas libraries). */
function cudartAsset(engine: EngineId, platform: NodeJS.Platform, release: Release, version: string): ReleaseAsset | undefined {
  const v = version.replace('.', '\\.')
  if (engine === 'llama') {
    // Windows: cudart-llama-bin-win-cuda-12.4-x64.zip   Linux: cudart-llama-b<N>-bin-ubuntu-cuda-12.8-x64.tar.gz
    const re = platform === 'win32' ? new RegExp(`^cudart-llama-bin-win-cuda-${v}-x64\\.zip$`) : new RegExp(`^cudart-llama-b\\d+-bin-ubuntu-cuda-${v}-x64\\.tar\\.gz$`)
    return release.assets.find((a) => re.test(a.name))
  }
  const major = version.split('.')[0]
  return release.assets.find((a) => new RegExp(`^cudart-sd-bin-win-cu${major}-x64\\.zip$`).test(a.name))
}

/**
 * Choose the newest release that contains a build for the requested backend.
 * (GitHub's "latest" marker is not reliable for these repos, so recent releases are scanned.)
 */
export function pickAsset(engine: EngineId, releases: Release[], opts: PickOptions): AssetChoice | null {
  const matcher = engine === 'llama' ? llamaMatcher(opts.platform, opts.arch) : engine === 'esrgan' ? esrganMatcher(opts.platform, opts.arch) : sdMatcher(opts.platform, opts.arch)
  for (const rel of releases) {
    if (rel.prerelease && releases.some((r) => !r.prerelease)) continue
    const candidates = rel.assets
      .map((asset) => ({ asset, m: matcher(asset.name) }))
      .filter((c): c is { asset: ReleaseAsset; m: { backend: EngineBackend; version?: string } } => c.m !== null && c.m.backend === opts.backend)
    if (!candidates.length) continue

    let chosen = candidates[0]
    let detail = opts.backend.toUpperCase()
    if (opts.backend === 'cuda') {
      let usable = candidates.filter((c) => c.m.version)
      if (opts.cuda12Only) usable = usable.filter((c) => c.m.version!.split('.')[0] === '12')
      if (opts.cudaMax) usable = usable.filter((c) => cmpVersion(c.m.version!, opts.cudaMax!) <= 0)
      if (!usable.length) continue
      usable.sort((a, b) => cmpVersion(b.m.version!, a.m.version!))
      chosen = usable[0]
      detail = `CUDA ${chosen.m.version}`
    }
    const extras: ReleaseAsset[] = []
    if (opts.backend === 'cuda' && chosen.m.version) {
      const rt = cudartAsset(engine, opts.platform, rel, chosen.m.version)
      if (rt) extras.push(rt)
    }
    return { tag: rel.tag, backend: opts.backend, asset: chosen.asset, extras, detail }
  }
  return null
}
