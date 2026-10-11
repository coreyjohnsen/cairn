/**
 * Slash commands: a message that starts with one of these changes how the assistant works on that message only.
 * `/plan` thinks the whole job through before any code is written, `/build` carries a plan out, `/tool` is the only
 * way the assistant may make itself a new tool, `/init` writes the project notes, and `/review` checks the changes.
 */

export type CommandId = 'plan' | 'build' | 'tool' | 'init' | 'review'

export interface SlashCommand {
  id: CommandId | 'imagine'
  /** What is typed, with the slash. */
  name: string
  /** Whether text after the command is needed. */
  arg: 'required' | 'optional' | 'none'
  hint: string
  description: string
}

export const COMMANDS: SlashCommand[] = [
  {
    id: 'plan',
    name: '/plan',
    arg: 'required',
    hint: 'what to build or change',
    description: 'Think the whole job through first: what each file is for, how the parts fit together, how it is tested. Nothing is written until you say /build.'
  },
  {
    id: 'build',
    name: '/build',
    arg: 'optional',
    hint: 'anything to change about the plan',
    description: 'Carry out the current plan step by step, keeping it up to date as it goes.'
  },
  {
    id: 'tool',
    name: '/tool',
    arg: 'required',
    hint: 'what the new tool should do',
    description: 'Let the assistant make a new tool for itself. It cannot do this without the command, and you approve the finished tool first.'
  },
  {
    id: 'init',
    name: '/init',
    arg: 'optional',
    hint: 'anything to include',
    description: 'Look through the project and write its notes file (CAIRN.md), which every later chat starts from.'
  },
  {
    id: 'review',
    name: '/review',
    arg: 'optional',
    hint: 'what to look at',
    description: 'Check the recent changes for duplicated code, files doing the same job, leftover references and missing tests.'
  },
  {
    id: 'imagine',
    name: '/imagine',
    arg: 'required',
    hint: 'a picture to make',
    description: 'Make a picture straight away with the image model.'
  }
]

/** What the message says when a command needs nothing more from the person. */
export const DEFAULT_ARG: Partial<Record<CommandId, string>> = {
  build: 'Go ahead and build it.',
  init: 'Look through this project and write its notes file.',
  review: 'Review the changes made so far.'
}

export interface ParsedCommand {
  id: CommandId
  /** The text after the command, trimmed. */
  text: string
}

/**
 * The command a message starts with, or null when it is ordinary text (an unknown word after a slash is ordinary text,
 * so pasting a path such as "/usr/bin" still works). `/imagine` is handled separately.
 */
export function parseCommand(input: string): ParsedCommand | null {
  const m = /^\s*\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(input)
  if (!m) return null
  const cmd = COMMANDS.find((c) => c.id !== 'imagine' && c.id === m[1].toLowerCase())
  if (!cmd) return null
  return { id: cmd.id as CommandId, text: (m[2] ?? '').trim() }
}

/** Commands matching what is being typed ("/pl" → /plan), for the menu above the message box. Empty once a space is typed. */
export function matchCommands(input: string): SlashCommand[] {
  const m = /^\/([a-z]*)$/i.exec(input.trimStart())
  if (!m) return []
  const q = m[1].toLowerCase()
  return COMMANDS.filter((c) => c.id.startsWith(q))
}
