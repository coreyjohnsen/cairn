import type { CommandId } from '@shared/commands'
import { planText } from '@shared/plan'
import type { ConversationPlan } from '@shared/types'
import type { ToolImpl } from '../tools/types'

/** What each command lets the assistant use. Planning and reviewing never change project files; the others use the usual tools. */
const LOOK = ['list_directory', 'read_file', 'search_files', 'find_files', 'find_symbol', 'file_outline', 'find_usages', 'check_references', 'fetch_url', 'web_search', 'update_plan', 'update_project_notes']
const ONLY: Partial<Record<CommandId, string[]>> = {
  plan: LOOK,
  review: [...LOOK, 'run_command'],
  init: [...LOOK, 'run_command']
}

/** The tools to offer for this message. `create_tool` is offered only for /tool and nothing else, so the assistant cannot make tools on its own. */
export function toolsForMode(mode: CommandId | undefined, tools: ToolImpl[]): ToolImpl[] {
  const only = mode ? ONLY[mode] : undefined
  return tools.filter((t) => (only ? only.includes(t.name) : true))
}

export const allowsCreateTool = (mode: CommandId | undefined): boolean => mode === 'tool'

const PLAN = [
  'PLANNING MODE (the user started this message with /plan). Do not create, edit, move or delete any project file, and run no command that changes anything. Your job is to think the whole job through before any code exists.',
  '1. Look first. Read the project notes and the project map, then use find_symbol, file_outline and find_usages to see what the project already has that does part of this job. Name what you found.',
  '2. Probe what you do not know BEFORE designing around it. For every outside service, API, file format or data source the job depends on, read its documentation and fetch a REAL sample response with fetch_url (a public API call, a README, a schema). Design against what came back, not against what you remember: endpoint paths, field names, ID formats and whether a result is a list or an object are exactly what is usually remembered wrongly. If a page comes back empty it is drawn by JavaScript: look for its documentation, its source repository or a JSON API instead. Never invent data (player lists, prices, IDs, scores): if no real source exists, say so and plan a clearly labeled placeholder or ask the user.',
  '3. Then write the complete plan with update_plan. Its "design" must cover:',
  '   - Files: every file involved with the ONE thing it is responsible for, marked "existing: extend" or "new". A new file only when no existing file fits. Never two files for the same job.',
  '   - How the parts interact: who calls whom, what data passes between them, the public functions and types.',
  '   - Interfaces: every module\'s public functions (name, arguments, result) and every element id a page needs, written down once so each file is written against the same list.',
  '   - Test cases: what to test, where the tests live, the edge cases and failures. If the user asked for tests, the test runner is created and run once in the first steps, and every later step adds to it.',
  '   - Unknowns you probed and what the real samples showed; risks and open questions.',
  '   The "steps" are in build order, each naming its files and each with a "verify" command that exits 0 when the step works (`node --check file.js`, `npm test`, `python -m pytest tests/test_x.py`). Do the riskiest step first: the one that touches real data or an outside service. Build one thin slice that works from end to end (for example: load real data and show it) before adding the other features. Keep every step SMALL: one file, or one section of a larger file, that can be finished in one or two tool calls. Never make "build the whole app" one step. A big file gets one step per section.',
  '4. Finish with a short summary and ask the user to say /build to carry it out, or tell you what to change. If something is unclear, ask before planning.'
].join('\n')

const BUILD_WITH_PLAN = [
  'BUILD MODE (the user started this message with /build). Carry out the current plan below in order. Mark a step "doing" with update_plan when you start it and "done" when it is finished.',
  '- Work on ONE step at a time: the one marked "doing". When it is finished, call set_step_status (step number, "done") BEFORE you start anything else; it runs the step\'s check and starts the next step. Never do several steps in one go, and never leave a finished step marked as doing. If a check fails, fix what it reports; do not change the check to make it pass.',
  '- Write against the plan\'s interfaces: use the function names, arguments and element ids the design lists. Before you call a function from another file, look at what that file really offers (file_outline), do not rely on memory of what you meant to write.',
  '- After each file you write or edit you are told if it does not parse. Fix it immediately. For a web page, open it with run_page (and click its buttons) as soon as it can load, not at the end.',
  '- Write big files in parts: create the file with its skeleton first, then add each section with edit_file, about 150 to 250 lines per call. One huge write_file call is cut off by the token limit.',
  '- Before creating any file, check that no existing file already does that job; extend it instead.',
  '- If the plan turns out to be wrong, update it with update_plan and say why, rather than quietly doing something else.',
  '- When all steps are done: run check_references, and the project\'s typecheck, lint or tests (a page: run_page); search for references to anything you renamed or moved; remove leftovers and dead code; add new modules to the project notes with update_project_notes. Do not say it works until a test or check has actually passed. Then summarize what was built, and what was and was not verified.'
].join('\n')

const BUILD_NO_PLAN = 'BUILD MODE (the user started this message with /build) but there is no plan yet. First look at the project, then write a short plan with update_plan (files and what each is responsible for, in build order), then carry it out and keep it up to date.'

const TOOL = [
  'TOOL MODE (the user started this message with /tool). They want you to make a new tool for yourself.',
  '- First check the tools you already have: if one covers the need, say so and use it instead of making another.',
  '- Then call create_tool once with a small, single-purpose tool: a clear name, a description that says when to use it, a JSON Schema for the arguments, and the implementation. Prefer "javascript" for text and data work, "command" to run an existing program, "http" for a web API.',
  '- The user sees the whole definition and approves it. If they decline, ask what to change; do not try again unchanged.',
  '- Afterwards say in one or two sentences what the tool does. You may use it right away if that helps with the request.'
].join('\n')

const INIT = [
  'NOTES MODE (the user started this message with /init). Write the project notes file for this folder.',
  'Explore first: the manifest files (package.json, pyproject, Cargo.toml …), the README, the folder layout, entry points, scripts and tests. Read an existing notes file before replacing it. Then call update_project_notes with mode "replace". Write only what you actually found, in markdown, under about 150 lines, with these sections:',
  '- What this project is',
  '- How to run, build and test it (exact commands)',
  '- Layout: each important folder or file and the one thing it is responsible for',
  '- Conventions to follow (naming, structure, style, how things are tested)',
  '- Decisions and gotchas that should not be undone',
  'Tell the user briefly what you wrote.'
].join('\n')

const REVIEW = [
  'REVIEW MODE (the user started this message with /review). Do not change any files unless the user asks afterwards.',
  'Find what changed (git status and git diff with run_command when the folder is a git repository), read the changed files, then check:',
  '- duplicated logic, or two files doing the same job;',
  '- references to names, files or functions that were renamed, moved or removed;',
  '- dead code and leftovers;',
  '- behaviour without a test, and tests that no longer match;',
  '- departures from the project notes and from the style of the surrounding code.',
  'Report by file, most important first, each with what is wrong and the fix. Say plainly when you find nothing. Offer to apply the fixes.'
].join('\n')

/** The extra instructions for a message that started with a command. */
export function modeDirective(mode: CommandId | undefined, plan: ConversationPlan | undefined): string {
  switch (mode) {
    case 'plan':
      return PLAN
    case 'build':
      return plan && (plan.steps.length || plan.design) ? BUILD_WITH_PLAN : BUILD_NO_PLAN
    case 'tool':
      return TOOL
    case 'init':
      return INIT
    case 'review':
      return REVIEW
    default:
      return ''
  }
}

/** The working method, always shown when the assistant has file tools. Short, because it is sent with every request. */
export const WORKING_METHOD = [
  '- Look before you build: read the project notes and the project map, and use find_symbol, file_outline and find_usages to see what the project already has. Extend what exists; never make a second file or function for a job that one already does.',
  '- For a change that touches more than one or two files, first write the plan with update_plan: which file is responsible for what, how the parts interact, and how it will be tested. Make each step small (one file or one section of a file) with a "verify" command, then work through them one at a time, marking each done with set_step_status before starting the next.',
  '- Never guess an outside service. Before writing code that calls an API or reads a data format, fetch a real sample (fetch_url, or curl with run_command) and write the code against what came back. Never invent data (names, IDs, prices); use a real source, or a placeholder that says it is one.',
  '- Write large files in parts (a skeleton first, then each section with edit_file, about 150 to 250 lines per call); a single huge write_file call is cut off.',
  '- Keep one source of truth: when you move or rename something, use find_usages to find everything that referenced it and update it in the same piece of work.',
  '- After changing code, run the project\'s typecheck, lint or tests if it has them, and fix what they report before saying you are done. A page is checked with run_page; calls between files with check_references. "It should work" is not a result: run something.',
  '- If the same thing fails twice, stop and look (read_file, file_outline) instead of trying another guess.',
  '- When you add a module or settle a convention, record it in the project notes with update_project_notes (short and factual).'
].join('\n')

export function planSection(plan: ConversationPlan | undefined): string {
  if (!plan || (!plan.goal && plan.steps.length === 0)) return ''
  return `## Current plan\nThis is your plan for the job in progress. Follow it, and keep it current with update_plan.\n${planText(plan)}`
}
