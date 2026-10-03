import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ToolError } from './types'

export interface ResolvedPath {
  abs: string
  inside: boolean
}

/** Resolve symlinks for the longest existing prefix of `p` (the target itself may not exist yet). */
function realpathPrefix(p: string): string {
  let cur = p
  const tail: string[] = []
  for (;;) {
    try {
      const rp = fs.realpathSync.native(cur)
      return tail.length ? path.join(rp, ...tail.reverse()) : rp
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return p
      tail.push(path.basename(cur))
      cur = parent
    }
  }
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Resolve a model-supplied path against the workspace. Symlinks are resolved so a link inside
 * the workspace cannot be used to escape it. Paths outside are rejected unless allowOutside is set,
 * in which case `inside: false` is returned so the caller can force an approval.
 */
export function resolvePath(workspace: string | null, input: string, allowOutside: boolean): ResolvedPath {
  let p = (input ?? '').trim()
  if (p === '') p = '.'
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1))

  if (!workspace) {
    if (!path.isAbsolute(p)) {
      throw new ToolError(
        'No workspace folder is set for this chat, so relative paths cannot be resolved. ' +
          'Ask the user to choose a workspace folder (folder button under the message box).'
      )
    }
    if (!allowOutside) {
      throw new ToolError('No workspace folder is set for this chat. Ask the user to choose a workspace folder before using file tools.')
    }
    return { abs: path.resolve(p), inside: false }
  }

  const abs = path.resolve(workspace, p)
  const root = realpathPrefix(path.resolve(workspace))
  const real = realpathPrefix(abs)
  const inside = isInside(root, real)
  if (!inside && !allowOutside) {
    throw new ToolError(
      `Path "${input}" is outside the workspace (${workspace}). File tools are restricted to the workspace folder.`
    )
  }
  return { abs, inside }
}

export function displayPath(workspace: string | null, abs: string): string {
  if (workspace && isInside(workspace, abs)) {
    const rel = path.relative(workspace, abs)
    return rel === '' ? '.' : rel.split(path.sep).join('/')
  }
  return abs
}
