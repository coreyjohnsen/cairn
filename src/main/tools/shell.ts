import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BUILTIN_TOOL_DEFAULTS } from '@shared/defaults'
import type { AgentSettings } from '@shared/types'
import { displayPath, resolvePath } from './sandbox'
import { type ToolContext, ToolError, type ToolImpl, num, str } from './types'
import { collectorSizes, outputLimitOf } from '../util/limits'

export interface ShellSpec {
  name: string
  file: string
  args: (command: string) => string[]
  verbatim?: boolean
}

export function resolveShell(pref: AgentSettings['shell'], platform: NodeJS.Platform = process.platform): ShellSpec {
  const win = platform === 'win32'
  let choice = pref
  if (choice === 'auto') choice = win ? 'powershell' : fs.existsSync('/bin/bash') ? 'bash' : 'sh'
  switch (choice) {
    case 'powershell':
      return {
        name: 'PowerShell',
        file: win ? 'powershell.exe' : 'pwsh',
        args: (c) => [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${c}`
        ]
      }
    case 'cmd':
      return { name: 'cmd', file: 'cmd.exe', args: (c) => ['/d', '/s', '/c', c], verbatim: true }
    case 'sh':
      return { name: 'sh', file: '/bin/sh', args: (c) => ['-c', c] }
    default:
      return { name: 'bash', file: win ? 'bash' : '/bin/bash', args: (c) => ['-c', c] }
  }
}

/** Keeps the start and end of very long output instead of the whole thing. */
export class OutputCollector {
  private full = ''
  private head = ''
  private tail = ''
  private overflow = false
  total = 0

  constructor(
    private headSize = 8000,
    private tailSize = 20000
  ) {}

  push(chunk: string): void {
    this.total += chunk.length
    if (!this.overflow) {
      this.full += chunk
      if (this.full.length > this.headSize + this.tailSize) {
        this.overflow = true
        this.head = this.full.slice(0, this.headSize)
        this.tail = this.full.slice(-this.tailSize)
        this.full = ''
      }
      return
    }
    this.tail = (this.tail + chunk).slice(-this.tailSize)
  }

  toString(): string {
    if (!this.overflow) return this.full
    const omitted = this.total - this.head.length - this.tail.length
    return `${this.head}\n\n… [${omitted} characters omitted] …\n\n${this.tail}`
  }
}

export function killTree(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

export interface RunResult {
  code: number | null
  output: string
  timedOut: boolean
  cancelled: boolean
}

export function runShell(command: string, cwd: string, shell: ShellSpec, timeoutSec: number, signal: AbortSignal, env?: NodeJS.ProcessEnv, outputLimit = 28000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell.file, shell.args(command), {
      cwd,
      env: env ?? process.env,
      windowsHide: true,
      windowsVerbatimArguments: shell.verbatim,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const sizes = collectorSizes(outputLimit)
    const out = new OutputCollector(sizes.head, sizes.tail)
    let timedOut = false
    let cancelled = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, timeoutSec * 1000)
    const onAbort = () => {
      cancelled = true
      killTree(child.pid)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => out.push(d))
    child.stderr.on('data', (d: string) => out.push(d))
    child.on('error', (err) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new ToolError(`Failed to start ${shell.name}: ${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ code, output: out.toString(), timedOut, cancelled })
    })
  })
}

export function shellTools(): ToolImpl[] {
  const tool: ToolImpl = {
    name: 'run_command',
    description:
      'Run a shell command on the user\'s computer and return its output. Use it for builds, tests, git, package managers and inspecting the system. ' +
      'The command runs in the workspace folder by default. Avoid interactive programs and anything that never exits.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to execute' },
        cwd: { type: 'string', description: 'Working directory relative to the workspace (default: workspace root)' },
        timeout_sec: { type: 'integer', description: 'Kill the command after this many seconds (default from settings)' }
      },
      required: ['command']
    },
    source: 'builtin',
    group: 'Shell',
    defaultPermission: BUILTIN_TOOL_DEFAULTS.run_command,
    describe(args, ctx) {
      const { cwd, inside } = pickCwd(args, ctx)
      const shell = resolveShell(ctx.settings.agent.shell)
      return {
        kind: 'command',
        title: `Run in ${shell.name}`,
        command: str(args, 'command'),
        cwd,
        reason: inside ? undefined : 'Working directory is outside the workspace',
        forceApproval: !inside
      }
    },
    async execute(args, ctx) {
      const command = str(args, 'command')
      if (!command.trim()) throw new ToolError('command must not be empty')
      const { cwd } = pickCwd(args, ctx)
      try {
        if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory')
      } catch {
        throw new ToolError(`Working directory does not exist: ${cwd}`)
      }
      const shell = resolveShell(ctx.settings.agent.shell)
      const timeout = Math.max(1, Math.min(3600, num(args, 'timeout_sec', ctx.settings.agent.shellTimeoutSec || 120)))
      ctx.progress(`Running in ${displayPath(ctx.workspace, cwd)}…`)
      const r = await runShell(command, cwd, shell, timeout, ctx.signal, undefined, outputLimitOf(ctx))
      if (r.cancelled) return { content: `Command cancelled.\n${r.output}`, isError: true }
      if (r.timedOut) return { content: `Command timed out after ${timeout}s and was killed.\n${r.output}`, isError: true }
      const header = `Exit code: ${r.code}`
      return { content: `${header}\n${r.output || '(no output)'}`, isError: r.code !== 0 }
    }
  }
  return [tool]
}

function pickCwd(args: Record<string, unknown>, ctx: ToolContext): { cwd: string; inside: boolean } {
  const given = str(args, 'cwd', false)
  if (!given) {
    if (ctx.workspace) return { cwd: ctx.workspace, inside: true }
    return { cwd: os.homedir(), inside: false }
  }
  const r = resolvePath(ctx.workspace, given, true)
  if (!r.inside && !ctx.settings.agent.allowOutsideWorkspace) {
    throw new ToolError(`Working directory "${given}" is outside the workspace.`)
  }
  return { cwd: path.resolve(r.abs), inside: r.inside }
}
