import { pathToFileURL } from 'node:url'
import { BUILTIN_TOOL_DEFAULTS } from '@shared/defaults'
import { checkReferences, referenceText } from '../agent/references'
import { displayPath, resolvePath } from './sandbox'
import { type PageReport, type ToolContext, ToolError, type ToolImpl, num, str } from './types'

const D = BUILTIN_TOOL_DEFAULTS

/** The page report as the model reads it: problems first, then what the page shows. */
export function pageReportText(r: PageReport, shown: string): string {
  const lines: string[] = []
  if (r.loadError) lines.push(`The page did not load: ${r.loadError}`)
  const problems = r.errors.length + r.failedRequests.length + (r.crashed ? 1 : 0) + r.clicks.filter((c) => !c.found).length + r.expected.filter((c) => !c.found).length
  lines.push(problems === 0 && !r.loadError ? `No errors in ${shown}.` : `${problems} problem${problems === 1 ? '' : 's'} in ${shown}:`)
  if (r.errors.length) lines.push('Console errors and uncaught exceptions:', ...r.errors.map((e) => `  - ${e}`))
  if (r.failedRequests.length) lines.push('Files or requests that failed:', ...r.failedRequests.map((e) => `  - ${e}`))
  for (const c of r.expected.filter((x) => !x.found)) lines.push(`  - expected an element matching "${c.selector}", but there is none`)
  for (const c of r.clicks.filter((x) => !x.found)) lines.push(`  - could not click "${c.selector}": no element matches`)
  if (r.warnings.length) lines.push('Warnings:', ...r.warnings.slice(0, 8).map((e) => `  - ${e}`))
  if (r.clicks.some((c) => c.found)) lines.push(`Clicked: ${r.clicks.filter((c) => c.found).map((c) => c.selector).join(', ')}`)
  if (!r.loadError) {
    lines.push(`Title: ${r.title || '(none)'}`)
    lines.push(`The page shows: ${r.text ? `"${r.text}"` : '(nothing: the page body is empty)'}`)
  }
  return lines.join('\n')
}

export const pageHasProblems = (r: PageReport): boolean =>
  !!r.loadError || !!r.crashed || r.errors.length > 0 || r.failedRequests.length > 0 || r.clicks.some((c) => !c.found) || r.expected.some((c) => !c.found)

function isLocalUrl(u: URL): boolean {
  return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
}

/** Tools that check the assistant's own work. */
export function verifyTools(): ToolImpl[] {
  const runPage: ToolImpl = {
    name: 'run_page',
    description:
      'Open a web page of the project in a hidden browser and report what goes wrong: console errors, uncaught exceptions, files that did not load, and the text the page shows. Use it after you write or change an HTML page (give the .html file), to catch undefined functions, missing elements and broken script paths that a syntax check cannot see. Optionally click buttons ("click") to exercise their handlers and check that elements exist ("expect"); errors from those clicks are reported too. It can also open a dev server on localhost.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The .html file, relative to the workspace' },
        url: { type: 'string', description: 'Instead of a file: an http(s) address on localhost or 127.0.0.1' },
        click: { type: 'array', items: { type: 'string' }, description: 'CSS selectors to click, in order, after the page has loaded (e.g. "#searchBtn")' },
        expect: { type: 'array', items: { type: 'string' }, description: 'CSS selectors that must exist on the page' },
        wait_ms: { type: 'integer', description: 'How long to let the page run before reading it (default 1500)' }
      }
    },
    source: 'builtin',
    group: 'Checks',
    defaultPermission: D.run_page,
    describe(args, ctx) {
      const target = pageTarget(args, ctx)
      return { kind: 'generic', title: `Open ${target.shown} in a hidden browser`, command: target.url, reason: 'The page runs its own scripts, which can make network requests.' }
    },
    async execute(args, ctx) {
      if (!ctx.services.runPage) throw new ToolError('Opening pages is not available here.')
      const target = pageTarget(args, ctx)
      const list = (key: string): string[] => (Array.isArray(args[key]) ? (args[key] as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 20) : [])
      ctx.progress(`Opening ${target.shown}…`)
      const report = await ctx.services.runPage(target.url, { waitMs: num(args, 'wait_ms', 1500), click: list('click'), expect: list('expect'), signal: ctx.signal })
      return { content: pageReportText(report, target.shown), isError: pageHasProblems(report) }
    }
  }

  const checkRefs: ToolImpl = {
    name: 'check_references',
    description:
      'Look across the whole project for names that point at nothing: a call to Module.function where that module defines no such function, a script that looks up an element id no page defines, a page that names a script, stylesheet or image that is not there. Run it when several files were written separately, before you say a build is finished, and after renaming or moving things. It is a heuristic: it finds likely mistakes, it does not prove the project correct.',
    parameters: { type: 'object', properties: {} },
    source: 'builtin',
    group: 'Checks',
    defaultPermission: D.check_references,
    async execute(_args, ctx) {
      if (!ctx.workspace) throw new ToolError('There is no workspace folder to check. Ask the user to choose one.')
      ctx.progress('Checking references…')
      const r = await checkReferences(ctx.workspace)
      return { content: referenceText(r), isError: r.problems.length > 0 }
    }
  }

  return [runPage, checkRefs]
}

function pageTarget(args: Record<string, unknown>, ctx: ToolContext): { url: string; shown: string } {
  const given = str(args, 'url', false).trim()
  if (given) {
    let u: URL
    try {
      u = new URL(given)
    } catch {
      throw new ToolError('url is not a valid address.')
    }
    if (!isLocalUrl(u)) throw new ToolError('Only addresses on localhost or 127.0.0.1 can be opened. For a file, give "path".')
    return { url: u.toString(), shown: u.toString() }
  }
  const p = str(args, 'path', false).trim()
  if (!p) throw new ToolError('Give "path" (an .html file in the workspace) or "url" (a localhost address).')
  if (!/\.html?$/i.test(p)) throw new ToolError('path must be an .html file.')
  const r = resolvePath(ctx.workspace, p, ctx.settings.agent.allowOutsideWorkspace)
  if (!r.inside && !ctx.settings.agent.allowOutsideWorkspace) throw new ToolError(`"${p}" is outside the workspace.`)
  return { url: pathToFileURL(r.abs).toString(), shown: displayPath(ctx.workspace, r.abs) }
}
