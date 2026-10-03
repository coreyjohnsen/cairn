import { baseName, truncate } from './format'

export type ToolIconKey = 'read' | 'write' | 'edit' | 'list' | 'search' | 'find' | 'move' | 'delete' | 'shell' | 'web' | 'image' | 'custom'

export interface ToolSummary {
  icon: ToolIconKey
  verb: string
  target: string
}

export function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

/** One-line, human description of a tool call: "Edited  src/app.ts". */
export function summarizeTool(name: string, rawArgs: string): ToolSummary {
  const a = parseArgs(rawArgs)
  switch (name) {
    case 'read_file':
      return { icon: 'read', verb: 'Read', target: baseName(str(a.path)) || str(a.path) }
    case 'write_file':
      return { icon: 'write', verb: 'Wrote', target: baseName(str(a.path)) || str(a.path) }
    case 'edit_file':
      return { icon: 'edit', verb: 'Edited', target: baseName(str(a.path)) || str(a.path) }
    case 'list_directory':
      return { icon: 'list', verb: 'Listed', target: str(a.path) || '.' }
    case 'search_files':
      return { icon: 'search', verb: 'Searched for', target: truncate(str(a.pattern), 60) }
    case 'find_files':
      return { icon: 'find', verb: 'Found files', target: truncate(str(a.glob), 60) }
    case 'move_path':
      return { icon: 'move', verb: 'Moved', target: `${baseName(str(a.from))} → ${baseName(str(a.to))}` }
    case 'delete_path':
      return { icon: 'delete', verb: 'Deleted', target: baseName(str(a.path)) || str(a.path) }
    case 'run_command':
      return { icon: 'shell', verb: 'Ran', target: truncate(str(a.command).split('\n')[0], 90) }
    case 'fetch_url':
      return { icon: 'web', verb: 'Fetched', target: truncate(str(a.url).replace(/^https?:\/\//, ''), 70) }
    case 'web_search':
      return { icon: 'web', verb: 'Searched the web for', target: truncate(str(a.query), 70) }
    case 'generate_image':
      return { icon: 'image', verb: 'Generated an image of', target: truncate(str(a.prompt), 80) }
    default: {
      const first = Object.values(a).find((v) => typeof v === 'string' || typeof v === 'number') as string | number | undefined
      return { icon: 'custom', verb: name.replace(/__/g, ' / ').replace(/_/g, ' '), target: first != null ? truncate(String(first), 70) : '' }
    }
  }
}

/** "Reading", "Editing" … while the call is in flight. */
export function presentTense(verb: string): string {
  const map: Record<string, string> = {
    Read: 'Reading',
    Wrote: 'Writing',
    Edited: 'Editing',
    Listed: 'Listing',
    'Searched for': 'Searching for',
    'Found files': 'Finding files',
    Moved: 'Moving',
    Deleted: 'Deleting',
    Ran: 'Running',
    Fetched: 'Fetching',
    'Searched the web for': 'Searching the web for',
    'Generated an image of': 'Generating an image of'
  }
  return map[verb] ?? verb
}
