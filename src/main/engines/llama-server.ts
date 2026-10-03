import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { LlamaStatus, Settings } from '@shared/types'
import { emit } from '../events'
import { killTree } from '../tools/shell'
import type { EngineManager } from './manager'
import { probeFlags } from '../images/sdcpp'
import { findMmproj, splitArgs } from './library'

/** A claim on the loaded model: the model stays loaded and is not swapped for another until every lease on it is released. */
export interface LlamaLease {
  /** The server's base URL (no /v1). */
  base: string
  release(): void
}

interface Waiter {
  key: string
  grant(): void
  reject(e: unknown): void
}

/** Taken by whatever must have the model to itself, such as freeing video memory for a picture. */
const EXCLUSIVE = '\0exclusive'

export interface LlamaDeps {
  getSettings(): Settings
  engines: EngineManager
}

const MAX_LOG_LINES = 400
const READY_TIMEOUT_MS = 15 * 60 * 1000

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Builds the llama-server command line from settings (exported for tests). */
export function buildLlamaArgs(
  settings: Settings['local'],
  modelPath: string,
  port: number,
  backend: string | null,
  mmproj: string | null,
  /** Start with thinking switched off at the engine, using whichever flag this build has. */
  noThink?: '--reasoning' | '--reasoning-budget' | null
): string[] {
  const ngl = backend === 'cpu' ? 0 : settings.gpuLayers < 0 ? 99 : settings.gpuLayers
  const args = ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-c', String(settings.contextSize), '-ngl', String(ngl), '--jinja', '--no-webui', '-np', '1']
  if (settings.threads > 0) args.push('-t', String(settings.threads))
  if (settings.flashAttn !== 'auto') args.push('-fa', settings.flashAttn)
  if (mmproj) args.push('--mmproj', mmproj)
  const extra = splitArgs(settings.extraArgs)
  // The user's own reasoning flags win over ours.
  if (noThink && !extra.some((a) => a.startsWith('--reasoning'))) args.push(...(noThink === '--reasoning' ? ['--reasoning', 'off'] : ['--reasoning-budget', '0']))
  args.push(...extra)
  return args
}

/**
 * Owns the built-in llama.cpp server process: starts it for a given GGUF model on demand,
 * restarts it when the model or runtime settings change, and stops it on idle/quit.
 */
export class LlamaManager {
  private proc: ChildProcess | null = null
  private st: LlamaStatus = { state: 'stopped', log: [] }
  private chain: Promise<unknown> = Promise.resolve()
  private signature = ''
  private busy = 0
  private idleTimer: NodeJS.Timeout | null = null
  private emitTimer: NodeJS.Timeout | null = null
  /** Leases that are held now, and what they are for (a model, or EXCLUSIVE). */
  private leases = 0
  private leaseKey = ''
  private waiters: Waiter[] = []

  constructor(private d: LlamaDeps) {}

  status(): LlamaStatus {
    return { ...this.st, log: [...this.st.log] }
  }

  baseUrl(): string | null {
    return this.st.state === 'running' && this.st.port ? `http://127.0.0.1:${this.st.port}` : null
  }

  private publish(immediate = true): void {
    if (immediate) {
      if (this.emitTimer) clearTimeout(this.emitTimer)
      this.emitTimer = null
      emit('llama:status', this.status())
      return
    }
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null
        emit('llama:status', this.status())
      }, 300)
    }
  }

  private set(patch: Partial<LlamaStatus>, immediate = true): void {
    this.st = { ...this.st, ...patch }
    this.publish(immediate)
  }

  private addLog(chunk: string): void {
    const lines = chunk.split(/\r?\n/).map((l) => l.trimEnd().slice(0, 500)).filter(Boolean)
    if (!lines.length) return
    const log = [...this.st.log, ...lines].slice(-MAX_LOG_LINES)
    this.st = { ...this.st, log }
    this.publish(false)
  }

  private configSignature(modelPath: string, noThink: boolean): string {
    const s = this.d.getSettings()
    const bin = this.d.engines.resolveBinary('llama')
    return JSON.stringify([modelPath, noThink, bin, s.local.contextSize, s.local.gpuLayers, s.local.threads, s.local.flashAttn, s.local.extraArgs, s.local.port, s.engines.llama.env])
  }

  /** Make sure `modelPath` is loaded; resolves with the server's base URL (no /v1). */
  ensure(modelPath: string, opts: { noThink?: boolean } = {}): Promise<string> {
    const run = this.chain.then(() => this.ensureLocked(modelPath, !!opts.noThink))
    this.chain = run.catch(() => {})
    return run
  }

  private async ensureLocked(modelPath: string, noThink: boolean): Promise<string> {
    const sig = this.configSignature(modelPath, noThink)
    if (this.st.state === 'running' && this.st.modelPath === modelPath && this.signature === sig && this.proc && this.proc.exitCode === null) {
      this.touch()
      return this.baseUrl()!
    }
    await this.stopLocked()
    return this.start(modelPath, sig, noThink)
  }

  private async start(modelPath: string, sig: string, noThink: boolean): Promise<string> {
    const settings = this.d.getSettings()
    const binary = this.d.engines.resolveBinary('llama')
    if (!binary) {
      const msg = 'The llama.cpp engine is not installed yet. Open Models → Engines to install it (one click), or choose your own llama-server binary.'
      this.set({ state: 'error', error: msg })
      throw new Error(msg)
    }
    if (!fs.existsSync(modelPath)) {
      const msg = `Model file not found: ${modelPath}`
      this.set({ state: 'error', error: msg })
      throw new Error(msg)
    }
    const port = settings.local.port || (await freePort())
    const mmproj = await findMmproj(modelPath)
    const backend = this.d.engines.resolvedBackend('llama')
    let reasoningFlag: '--reasoning' | '--reasoning-budget' | null = null
    if (noThink) {
      const flags = await probeFlags(binary, this.d.engines.spawnEnv('llama', binary))
      // Newer builds have --reasoning on/off/auto; older ones have --reasoning-budget 0.
      reasoningFlag = flags?.has('--reasoning') ? '--reasoning' : '--reasoning-budget'
    }
    const args = buildLlamaArgs(settings.local, modelPath, port, backend, mmproj, reasoningFlag)

    this.set({ state: 'starting', modelPath, mmprojPath: mmproj ?? undefined, port, error: undefined, pid: undefined, startedAt: Date.now(), log: [`$ ${path.basename(binary)} ${args.join(' ')}`] })

    let exited: { code: number | null } | null = null
    let child: ChildProcess
    try {
      child = spawn(binary, args, {
        cwd: path.dirname(binary),
        env: this.d.engines.spawnEnv('llama', binary),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (e) {
      const msg = `Could not start llama-server: ${(e as Error).message}`
      this.set({ state: 'error', error: msg })
      throw new Error(msg)
    }
    this.proc = child
    this.set({ pid: child.pid })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => this.addLog(d))
    child.stderr?.on('data', (d: string) => this.addLog(d))
    child.on('error', (err) => this.addLog(`spawn error: ${err.message}`))
    child.on('exit', (code) => {
      exited = { code }
      if (this.proc === child) {
        this.proc = null
        if (this.st.state === 'running' || this.st.state === 'starting') {
          const tail = this.st.log.slice(-6).join('\n')
          this.set({ state: code === 0 || code === null ? 'stopped' : 'error', error: code ? `llama-server exited with code ${code}.\n${tail}` : undefined, pid: undefined })
        } else {
          this.set({ pid: undefined })
        }
      }
    })

    const base = `http://127.0.0.1:${port}`
    const deadline = Date.now() + READY_TIMEOUT_MS
    for (;;) {
      if (exited) {
        const tail = this.st.log.slice(-12).join('\n')
        const msg = `llama-server stopped while loading the model (exit code ${(exited as { code: number | null }).code}).\n${tail}`
        this.set({ state: 'error', error: msg, pid: undefined })
        throw new Error(msg)
      }
      try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })
        if (r.ok) break
      } catch {
        /* still starting */
      }
      if (Date.now() > deadline) {
        await this.stopLocked()
        const msg = 'Timed out waiting for the model to load.'
        this.set({ state: 'error', error: msg })
        throw new Error(msg)
      }
      await sleep(400)
    }
    this.signature = sig
    this.set({ state: 'running', error: undefined })
    this.touch()
    return base
  }

  async stop(): Promise<void> {
    const run = this.chain.then(() => this.stopLocked())
    this.chain = run.catch(() => {})
    await run
  }

  private async stopLocked(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const p = this.proc
    if (!p) {
      if (this.st.state !== 'stopped' && this.st.state !== 'error') this.set({ state: 'stopped', pid: undefined })
      return
    }
    this.proc = null
    const done = new Promise<void>((resolve) => {
      if (p.exitCode !== null) return resolve()
      p.once('exit', () => resolve())
      setTimeout(resolve, 5000)
    })
    killTree(p.pid)
    await done
    this.set({ state: 'stopped', pid: undefined, error: undefined })
  }

  /**
   * Waits for a turn, then makes sure the model is loaded and keeps it loaded until `release()` is called.
   * Requests for the same model share it; a request for another model waits until the current users are done, and
   * requests are served in the order they arrived, so nobody waits forever. Waiting stops when `signal` aborts.
   */
  async acquire(modelPath: string, opts: { noThink?: boolean; signal?: AbortSignal } = {}): Promise<LlamaLease> {
    const release = await this.admit(`${modelPath}\0${opts.noThink ? 1 : 0}`, opts.signal)
    try {
      const base = await this.ensure(modelPath, { noThink: opts.noThink })
      return { base, release }
    } catch (e) {
      release()
      throw e
    }
  }

  /** Runs `fn` while nothing else uses the model. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.admit(EXCLUSIVE)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private admit(key: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('Cancelled'))
    const take = (): (() => void) => {
      this.leases++
      this.leaseKey = key
      this.hold()
      let done = false
      return () => {
        if (done) return
        done = true
        this.leases = Math.max(0, this.leases - 1)
        this.release()
        this.pump()
      }
    }
    if (this.waiters.length === 0 && (this.leases === 0 || this.leaseKey === key)) return Promise.resolve(take())
    return new Promise<() => void>((resolve, reject) => {
      const w: Waiter = {
        key,
        grant: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve(take())
        },
        reject
      }
      const onAbort = () => {
        const i = this.waiters.indexOf(w)
        if (i === -1) return
        this.waiters.splice(i, 1)
        reject(new Error('Cancelled'))
        // Whoever was queued behind this one may be able to go now.
        this.pump()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(w)
    })
  }

  /** Lets the waiters at the front of the line in, as long as they can share what is loaded. */
  private pump(): void {
    while (this.waiters.length) {
      const w = this.waiters[0]
      if (this.leases > 0 && this.leaseKey !== w.key) return
      this.waiters.shift()
      w.grant()
    }
  }

  /** Mark the server as in use (prevents idle unloading while a response streams). */
  hold(): void {
    this.busy++
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  release(): void {
    this.busy = Math.max(0, this.busy - 1)
    this.touch()
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const minutes = this.d.getSettings().local.idleUnloadMinutes
    if (minutes > 0 && this.st.state === 'running' && this.busy === 0) {
      this.idleTimer = setTimeout(() => {
        if (this.busy === 0) void this.stop()
        else this.touch()
      }, minutes * 60_000)
    }
  }

  /** Free VRAM for image generation. The model is reloaded automatically on the next chat message. */
  async unloadForImages(): Promise<boolean> {
    // Wait for answers that are still being written (for example to another program) rather than cutting them off.
    return this.exclusive(async () => {
      if (this.st.state !== 'running' && this.st.state !== 'starting') return false
      await this.stop()
      return true
    })
  }
}
