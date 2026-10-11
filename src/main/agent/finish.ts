import type { Conversation, ConversationPlan, PlanStep } from '@shared/types'
import { resolveShell, runShell } from '../tools/shell'
import { type ToolContext, ToolError } from '../tools/types'
import { checkReferences, referenceText } from './references'

/** Commands that test or check a project, as opposed to listing files or running git. */
const CHECK_COMMAND = /\b(?:test|tests|vitest|jest|mocha|pytest|unittest|tap|ava|tsc|typecheck|type-check|lint|eslint|ruff|mypy|cargo\s+(?:test|check)|go\s+(?:test|vet)|node\s+(?:--check|--test)|check)\b/i

/** True when a test, typecheck, lint or page check has already passed in this chat. */
export function ranChecks(conv: Pick<Conversation, 'messages' | 'plan'>): boolean {
  if (conv.plan?.steps.some((s) => s.verified)) return true
  const calls = new Map<string, { name: string; arguments: string }>()
  for (const m of conv.messages) {
    for (const tc of m.toolCalls ?? []) calls.set(tc.id, tc)
  }
  for (const m of conv.messages) {
    if (m.role !== 'tool' || m.isError || m.denied || !m.toolCallId) continue
    const call = calls.get(m.toolCallId)
    if (!call) continue
    if (call.name === 'run_page') return true
    if (call.name === 'run_command') {
      let command = ''
      try {
        command = String((JSON.parse(call.arguments) as { command?: unknown }).command ?? '')
      } catch {
        /* unreadable arguments */
      }
      if (CHECK_COMMAND.test(command)) return true
    }
  }
  return false
}

/**
 * Run the checks of the steps this update moves to done. The first that fails stops the update (the plan stays as it was)
 * and the model gets the output, so a step cannot be called done on a promise. Passing steps are marked verified.
 */
export async function verifyDoneSteps(steps: PlanStep[], plan: ConversationPlan, ctx: ToolContext): Promise<ConversationPlan> {
  const next: ConversationPlan = { ...plan, steps: plan.steps.map((s) => ({ ...s })) }
  for (const done of steps) {
    if (!done.verify) continue
    const step = next.steps.find((s) => s.id === done.id)
    if (!step) continue
    if (!ctx.workspace) throw new ToolError(`Step "${done.text}" has a check (${done.verify}) but there is no workspace folder to run it in. Ask the user to choose one.`)
    ctx.progress(`Checking: ${done.verify}`)
    const settings = ctx.settings
    const timeout = Math.max(5, Math.min(600, settings.agent.shellTimeoutSec || 120))
    const r = await runShell(done.verify, ctx.workspace, resolveShell(settings.agent.shell), timeout, ctx.signal)
    if (r.cancelled) throw new ToolError('Cancelled by the user.')
    if (r.timedOut || r.code !== 0) {
      const why = r.timedOut ? `timed out after ${timeout}s` : `exited with code ${r.code}`
      throw new ToolError(
        `Step ${plan.steps.indexOf(done) + 1} "${done.text}" is NOT done: its check \`${done.verify}\` ${why}. The plan was not changed.\n${r.output.trim() || '(no output)'}\n\nFix what the check reports, then mark the step done again. If the check itself is wrong, change it with update_plan (the "verify" of that step).`
      )
    }
    step.verified = true
  }
  return next
}

/** What to tell the model when the last step has just been marked done: broken references and a missing test run. */
export async function finishReport(conv: Conversation, workspace: string | null): Promise<string> {
  const parts: string[] = ['[All steps are done. Final checks:']
  if (workspace) {
    try {
      const r = await checkReferences(workspace)
      parts.push(`- References: ${referenceText(r)}`)
    } catch (e) {
      parts.push(`- References: could not be checked (${e instanceof Error ? e.message : String(e)}).`)
    }
  }
  if (ranChecks(conv)) parts.push('- A test, typecheck or page check has passed in this chat.')
  else {
    parts.push(
      '- NOTHING has been run to prove this works: no test, typecheck, lint or page check has passed in this chat. Before you tell the user it is finished, run one: the project\'s tests or typecheck with run_command, and for a web page run_page. If the project has none, write a small test or smoke check and run it.'
    )
  }
  parts.push('Fix anything reported above before you summarize.]')
  return parts.join('\n')
}
