import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { EngineBackend, EngineId, EngineInstallProgress, EngineStatus, InstalledBuild, Settings } from '@shared/types'
import type { AppPaths } from '../paths'
import { readJson, writeJson } from '../util/fsx'
import { downloadFile } from './download'
import { extractArchive, findFile } from './extract'
import { availableBackends, detectGpus, recommend } from './gpu'
import { ENGINE_REPOS, fetchReleases, pickAsset } from './releases'

export interface EngineDeps {
  getSettings(): Settings
  updateSettings(patch: Partial<Settings>): void
  paths: AppPaths
  onProgress(p: EngineInstallProgress): void
  onChanged(engine: EngineId): void
}

const NICE: Record<EngineId, string> = { llama: 'llama.cpp', sd: 'stable-diffusion.cpp', esrgan: 'Real-ESRGAN upscaler' }

export function binaryNames(engine: EngineId, platform: NodeJS.Platform = process.platform): string[] {
  const exe = platform === 'win32' ? '.exe' : ''
  if (engine === 'esrgan') return [`realesrgan-ncnn-vulkan${exe}`]
  return engine === 'llama' ? [`llama-server${exe}`] : [`sd-cli${exe}`, `sd${exe}`]
}

export class EngineManager {
  private builds: InstalledBuild[] = []
  private installing = new Map<EngineId, AbortController>()

  constructor(private d: EngineDeps) {}

  async init(): Promise<void> {
    const idx = await readJson<{ builds: InstalledBuild[] }>(this.d.paths.enginesIndex)
    this.builds = (idx?.builds ?? []).filter((b) => fs.existsSync(b.binary))
  }

  private async persist(): Promise<void> {
    await writeJson(this.d.paths.enginesIndex, { builds: this.builds })
  }

  buildsFor(engine: EngineId): InstalledBuild[] {
    return this.builds.filter((b) => b.engine === engine).sort((a, b) => b.installedAt - a.installedAt)
  }

  activeBuild(engine: EngineId): InstalledBuild | undefined {
    const wanted = this.d.getSettings().engines[engine].activeBuildId
    const list = this.buildsFor(engine)
    return list.find((b) => b.id === wanted) ?? list[0]
  }

  /** Custom binary if configured and present, otherwise the active managed build. */
  resolveBinary(engine: EngineId): string | null {
    const custom = this.d.getSettings().engines[engine].customPath.trim()
    if (custom && fs.existsSync(custom)) return custom
    return this.activeBuild(engine)?.binary ?? null
  }

  /** Backend of the binary that will run (unknown for custom binaries). */
  resolvedBackend(engine: EngineId): EngineBackend | null {
    const custom = this.d.getSettings().engines[engine].customPath.trim()
    if (custom && fs.existsSync(custom)) return null
    return this.activeBuild(engine)?.backend ?? null
  }

  async status(engine: EngineId): Promise<EngineStatus> {
    const gpu = await detectGpus()
    return {
      engine,
      builds: this.buildsFor(engine),
      activeBuildId: this.activeBuild(engine)?.id,
      resolvedBinary: this.resolveBinary(engine) ?? undefined,
      recommended: recommend(engine, gpu).backend,
      available: availableBackends(engine, gpu.platform, gpu.arch)
    }
  }

  /** The Real-ESRGAN models that came with the build (a `models` folder beside the program), if any. */
  esrganModelsDir(): string | null {
    const bin = this.resolveBinary('esrgan')
    if (!bin) return null
    const dir = path.join(path.dirname(bin), 'models')
    return fs.existsSync(dir) ? dir : null
  }

  /** Environment for spawning an engine binary: user overrides plus the binary's folder on the library path. */
  spawnEnv(engine: EngineId, binary: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.d.getSettings().engines[engine].env }
    const dir = path.dirname(binary)
    if (process.platform === 'win32') env.PATH = `${dir};${env.PATH ?? ''}`
    else env.LD_LIBRARY_PATH = `${dir}${env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : ''}`
    return env
  }

  cancelInstall(engine: EngineId): void {
    this.installing.get(engine)?.abort()
  }

  isInstalling(engine: EngineId): boolean {
    return this.installing.has(engine)
  }

  async install(engine: EngineId, backend: EngineBackend): Promise<void> {
    if (this.installing.has(engine)) throw new Error(`${NICE[engine]} is already being installed.`)
    const ac = new AbortController()
    this.installing.set(engine, ac)
    const report = (p: Omit<EngineInstallProgress, 'engine'>) => this.d.onProgress({ engine, ...p })
    try {
      report({ phase: 'resolving', label: `Looking up the latest ${NICE[engine]} ${backend.toUpperCase()} build…` })
      const gpu = await detectGpus()
      const nv = gpu.devices.find((x) => x.vendor === 'nvidia')
      const releases = await fetchReleases(ENGINE_REPOS[engine], 15, ac.signal)
      const choice = pickAsset(engine, releases, {
        platform: gpu.platform,
        arch: gpu.arch,
        backend,
        cudaMax: nv?.cudaVersion,
        cuda12Only: nv?.computeCap ? Number(nv.computeCap) < 7.5 : false
      })
      if (!choice && backend === 'cuda' && nv?.cudaVersion) {
        throw new Error(
          `No CUDA build of ${NICE[engine]} is compatible with your NVIDIA driver (it supports CUDA ${nv.cudaVersion}${nv.computeCap && Number(nv.computeCap) < 7.5 ? ', and CUDA 12 is required for your GTX card' : ''}). ` +
            'Update the NVIDIA driver, or choose Vulkan.'
        )
      }
      if (!choice) {
        throw new Error(
          `No prebuilt ${backend.toUpperCase()} build of ${NICE[engine]} was found for ${gpu.platform}/${gpu.arch} in the latest releases. ` +
            'Choose another backend, or download/compile a build yourself and select it with "Use my own binary".'
        )
      }

      const id = `${engine}-${choice.tag}-${backend}`
      const dir = path.join(this.d.paths.engines, engine, `${choice.tag}-${backend}`)
      const work = path.join(this.d.paths.tmp, id)
      await fsp.rm(work, { recursive: true, force: true })
      await fsp.mkdir(work, { recursive: true })
      await fsp.rm(dir, { recursive: true, force: true })

      const all = [choice.asset, ...choice.extras]
      for (let i = 0; i < all.length; i++) {
        const asset = all[i]
        const file = path.join(work, asset.name)
        await downloadFile({
          url: asset.url,
          dest: file,
          signal: ac.signal,
          onProgress: (received, total) =>
            report({
              phase: 'downloading',
              label: `Downloading ${NICE[engine]} ${choice.tag} (${choice.detail})${all.length > 1 ? ` — file ${i + 1} of ${all.length}` : ''}`,
              received,
              total: total || asset.size
            })
        })
        report({ phase: 'extracting', label: `Extracting ${asset.name}…` })
        await extractArchive(file, dir)
      }
      await fsp.rm(work, { recursive: true, force: true })

      const binary = await findFile(dir, binaryNames(engine))
      if (!binary) throw new Error(`The download did not contain ${binaryNames(engine)[0]}. The release layout may have changed — use "Use my own binary" instead.`)
      if (process.platform !== 'win32') {
        await fsp.chmod(binary, 0o755).catch(() => {})
      }

      this.builds = this.builds.filter((b) => b.id !== id)
      const build: InstalledBuild = { id, engine, tag: choice.tag, backend, dir, binary, assetName: choice.asset.name, installedAt: Date.now() }
      this.builds.push(build)
      await this.persist()
      const s = this.d.getSettings()
      this.d.updateSettings({ engines: { ...s.engines, [engine]: { ...s.engines[engine], activeBuildId: id } } })
      report({ phase: 'done', label: `${NICE[engine]} ${choice.tag} (${choice.detail}) is ready.` })
      this.d.onChanged(engine)
    } catch (e) {
      const cancelled = ac.signal.aborted
      report({ phase: 'error', label: cancelled ? 'Installation cancelled.' : 'Installation failed.', error: cancelled ? 'Cancelled' : e instanceof Error ? e.message : String(e) })
      if (!cancelled) throw e
    } finally {
      this.installing.delete(engine)
    }
  }

  async uninstall(engine: EngineId, buildId: string): Promise<void> {
    const b = this.builds.find((x) => x.id === buildId && x.engine === engine)
    if (!b) return
    await fsp.rm(b.dir, { recursive: true, force: true })
    this.builds = this.builds.filter((x) => x.id !== buildId)
    await this.persist()
    const s = this.d.getSettings()
    if (s.engines[engine].activeBuildId === buildId) {
      this.d.updateSettings({ engines: { ...s.engines, [engine]: { ...s.engines[engine], activeBuildId: '' } } })
    }
    this.d.onChanged(engine)
  }

  activate(engine: EngineId, buildId: string): void {
    if (!this.builds.some((b) => b.id === buildId && b.engine === engine)) return
    const s = this.d.getSettings()
    this.d.updateSettings({ engines: { ...s.engines, [engine]: { ...s.engines[engine], activeBuildId: buildId } } })
    this.d.onChanged(engine)
  }
}
