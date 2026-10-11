import type { CommandId } from '@shared/commands'
import { planText } from '@shared/plan'
import type { ConversationPlan } from '@shared/types'
import type { ToolImpl } from '../tools/types'

/** What each command lets the assistant use. Planning and reviewing never change project files; the others use the usual tools. */
const LOOK = ['list_directory', 'read_file', 'search_files', 'find_files', 'fetch_url', 'web_search', 'update_plan', 'update_project_notes']
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
  '1. Look first. Read the project notes, list the folders, and search for existing code that already does part of this job. Name what you found.',
  '2. Then write the complete plan with update_plan. Its "design" must cover:',
  '   - Files: every file involved with the ONE thing it is responsible for, marked "existing: extend" or "new". A new file only when no existing file fits. Never two files for the same job.',
  '   - How the parts interact: who calls whom, what data passes between them, the public functions and types.',
  '   - Test cases: what to test, where the tests live, the edge cases and failures.',
  '   - Risks and open questions.',
  '   The "steps" are in build order and each names its files.',
  '3. Finish with a short summary and ask the user to say /build to carry it out, or tell you what to change. If something is unclear, ask before planning.'
].join('\n')

const BUILD_WITH_PLAN = [
  'BUILD MODE (the user started this message with /build). Carry out the current plan below in order. Mark a step "doing" with update_plan when you start it and "done" when it is finished.',
  '- Before creating any file, check that no existing file already does that job; extend it instead.',
  '- If the plan turns out to be wrong, update it with update_plan and say why, rather than quietly doing something else.',
  '- When all steps are done: run the project\'s typecheck, lint or tests if it has them; search for references to anything you renamed or moved; remove leftovers and dead code; add new modules to the project notes with update_project_notes. Then summarize what was built.'
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
  '- Look before you build: read the project notes, and search the project for code that already does what you need. Extend what exists; never make a second file or function for a job that one already does.',
  '- For a change that touches more than one or two files, first write the plan with update_plan: which file is responsible for what, how the parts interact, and how it will be tested. Keep it current as you work.',
  '- Keep one source of truth: when you move or rename something, search for everything that referenced it and update it in the same piece of work.',
  '- After changing code, run the project\'s typecheck, lint or tests if it has them, and fix what they report before saying you are done.',
  '- When you add a module or settle a convention, record it in the project notes with update_project_notes (short and factual).'
].join('\n')

export function planSection(plan: ConversationPlan | undefined): string {
  if (!plan || (!plan.goal && plan.steps.length === 0)) return ''
  return `## Current plan\nThis is your plan for the job in progress. Follow it, and keep it current with update_plan.\n${planText(plan)}`
}
