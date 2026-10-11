import os from 'node:os'
import type { CommandId } from '@shared/commands'
import type { Conversation, Settings } from '@shared/types'
import { resolveShell } from '../tools/shell'
import type { ToolImpl } from '../tools/types'
import { WORKING_METHOD, modeDirective, planSection } from './modes'
import type { Notes } from './notes'

export function osLabel(): string {
  const p = os.platform()
  if (p === 'win32') {
    const build = Number(os.release().split('.')[2] ?? 0)
    return `${build >= 22000 ? 'Windows 11' : 'Windows 10'} (${os.arch()})`
  }
  if (p === 'darwin') return `macOS (${os.arch()})`
  return `Linux ${os.release()} (${os.arch()})`
}

export interface PromptExtras {
  /** The project notes found in the workspace. */
  notes?: Notes | null
  /** The slash command this message started with. */
  mode?: CommandId
}

export function buildSystemPrompt(settings: Settings, conv: Conversation, tools: ToolImpl[], workspace: string | null, extras: PromptExtras = {}): string {
  const base = (conv.systemPrompt ?? settings.chat.systemPrompt ?? '').trim()
  const names = new Set(tools.map((t) => t.name))
  const lines: string[] = []
  if (base) lines.push(base, '')

  lines.push('## Environment')
  lines.push(`- Current date and time: ${new Date().toString()}`)
  lines.push(`- Operating system: ${osLabel()}`)
  if (tools.length) {
    if (names.has('run_command')) lines.push(`- Shell for run_command: ${resolveShell(settings.agent.shell).name}`)
    lines.push(`- Workspace folder: ${workspace ?? 'none selected (ask the user to choose one before using file tools)'}`)
  }

  if (tools.length) {
    lines.push('', '## Using tools')
    lines.push('- Call a tool only when it helps; answer directly when you already know the answer.')
    if (names.has('read_file') || names.has('edit_file')) {
      lines.push('- Read a file before editing it, and prefer edit_file for small changes. Paths are relative to the workspace folder.')
    }
    if (names.has('run_command')) {
      lines.push('- Use run_command for builds, tests and git. Never run destructive commands unless the user clearly asked for them.')
    }
    if (names.has('generate_image')) {
      lines.push('- When the user asks for a picture, drawing, photo, logo or any other image, call generate_image with a detailed prompt instead of describing it in words.')
    }
    lines.push('- If a tool returns an error, read it, correct the call and try again at most once or twice before asking the user.')
    lines.push('- After using tools, give the user a short summary of what you did and found.')
    if (names.has('read_file') && workspace) {
      lines.push('', '## How to work', WORKING_METHOD)
    }
    if (extras.notes) {
      lines.push('', `## Project notes (${extras.notes.file})`, 'Written for this folder. Follow them, and keep them true.', extras.notes.text.trim())
    }
    const plan = names.has('update_plan') ? planSection(conv.plan) : ''
    if (plan) lines.push('', plan)
    const directive = modeDirective(extras.mode, conv.plan)
    if (directive) lines.push('', '## This message', directive)
  }
  return lines.join('\n').trim()
}
