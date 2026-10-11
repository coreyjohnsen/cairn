import type { ConversationPlan, PlanStatus, PlanStep } from './types'

export const MAX_PLAN_STEPS = 40
export const MAX_STEP_CHARS = 300
export const MAX_VERIFY_CHARS = 400
export const MAX_DESIGN_CHARS = 12000
const STATUSES: PlanStatus[] = ['todo', 'doing', 'done', 'blocked']

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`)

const asStatus = (v: unknown): PlanStatus => {
  const s = typeof v === 'string' ? v.toLowerCase().replace(/[\s-]+/g, '_') : ''
  if (STATUSES.includes(s as PlanStatus)) return s as PlanStatus
  if (s === 'in_progress' || s === 'active' || s === 'current') return 'doing'
  if (s === 'complete' || s === 'completed' || s === 'finished') return 'done'
  return 'todo'
}

export interface PlanInput {
  goal?: unknown
  design?: unknown
  steps?: unknown
}

/**
 * The plan after the model's latest update. Steps are replaced as a whole (the model sends the full list each time, which
 * is easier for it than editing one entry); goal and design are kept from before when not sent. Returns an error in words
 * when the update cannot be used, so the model can correct it.
 */
export function applyPlanUpdate(prior: ConversationPlan | undefined, input: PlanInput, now = Date.now()): { plan: ConversationPlan } | { error: string } {
  const goal = typeof input.goal === 'string' && input.goal.trim() ? clip(input.goal.trim(), 400) : (prior?.goal ?? '')
  const design = typeof input.design === 'string' ? (input.design.trim() ? clip(input.design.trim(), MAX_DESIGN_CHARS) : undefined) : prior?.design
  let steps: PlanStep[]
  if (input.steps === undefined) {
    if (!prior) return { error: 'Send "steps": a list of the steps to take, each with "text" and "status" (todo, doing, done or blocked).' }
    steps = prior.steps
  } else {
    if (!Array.isArray(input.steps)) return { error: '"steps" must be a list.' }
    if (input.steps.length > MAX_PLAN_STEPS) return { error: `A plan may have at most ${MAX_PLAN_STEPS} steps. Group the small ones.` }
    steps = []
    for (const raw of input.steps) {
      const item = typeof raw === 'string' ? { text: raw } : raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
      const text = item && typeof item.text === 'string' ? item.text.trim() : ''
      if (!text) return { error: 'Every step needs a "text".' }
      const given = item && typeof item.verify === 'string' ? item.verify.trim() : undefined
      // A step the model sends again without its check keeps the check it had (matched by position, then by wording).
      const before = prior?.steps[steps.length]?.text === text ? prior.steps[steps.length] : prior?.steps.find((s) => s.text === text)
      const verify = given !== undefined ? (given ? clip(given, MAX_VERIFY_CHARS) : undefined) : before?.verify
      const step: PlanStep = { id: `s${steps.length + 1}`, text: clip(text, MAX_STEP_CHARS), status: asStatus(item?.status) }
      if (verify) step.verify = verify
      if (before?.verified && step.status === 'done') step.verified = true
      steps.push(step)
    }
  }
  if (!goal && steps.length === 0) return { error: 'A plan needs a goal or at least one step.' }
  // One thing at a time: when several are marked in progress, only the first stays so.
  const firstDoing = steps.findIndex((s) => s.status === 'doing')
  steps = steps.map((s, i) => (s.status === 'doing' && i !== firstDoing ? { ...s, status: 'todo' as const } : s))
  return { plan: { goal, design, steps, updatedAt: now } }
}

/** Steps that this update moves to done (they were not done before). */
export function newlyDone(prior: ConversationPlan | undefined, next: ConversationPlan): PlanStep[] {
  return next.steps.filter((s, i) => s.status === 'done' && (prior?.steps[i]?.text !== s.text || prior.steps[i].status !== 'done'))
}

/** The plan with one step (1-based) set to a new status. */
export function withStepStatus(plan: ConversationPlan, number: number, status: unknown): { plan: ConversationPlan } | { error: string } {
  if (!Number.isInteger(number) || number < 1 || number > plan.steps.length) {
    return { error: `There is no step ${number}; the plan has ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}.` }
  }
  const steps = plan.steps.map((s, i) => (i === number - 1 ? { ...s, status: asStatus(status) } : s))
  return applyPlanUpdate(plan, { steps })
}

export function planProgress(plan: Pick<ConversationPlan, 'steps'>): { done: number; total: number } {
  return { done: plan.steps.filter((s) => s.status === 'done').length, total: plan.steps.length }
}

/**
 * A short reminder added to the answer of a tool that changed files, so the model keeps the plan current and does one
 * step at a time. Empty when there is no plan or it is finished.
 */
export function planReminder(plan: ConversationPlan | undefined): string {
  if (!plan || plan.steps.length === 0) return ''
  const open = plan.steps.filter((s) => s.status !== 'done')
  if (open.length === 0) return ''
  const doing = plan.steps.findIndex((s) => s.status === 'doing')
  if (doing >= 0) {
    return `[Plan: step ${doing + 1} of ${plan.steps.length} is in progress: "${plan.steps[doing].text}". Stay on that step. When it is finished, call set_step_status to mark it done (and the next one doing), then carry on.]`
  }
  return `[Plan: ${open.length} of ${plan.steps.length} steps are not done and none is marked in progress. Call update_plan to mark the step you are working on as doing, and finished steps as done.]`
}

const MARK: Record<PlanStatus, string> = { todo: '[ ]', doing: '[>]', done: '[x]', blocked: '[!]' }

/** The plan as plain text, for the model (in the system prompt and as the tool's answer). */
export function planText(plan: ConversationPlan, withDesign = true): string {
  const { done, total } = planProgress(plan)
  const lines: string[] = []
  if (plan.goal) lines.push(`Goal: ${plan.goal}`)
  if (total) {
    lines.push(`Steps (${done} of ${total} done; [ ] to do, [>] doing now, [x] done, [!] blocked):`)
    plan.steps.forEach((s, i) => lines.push(`${i + 1}. ${MARK[s.status]} ${s.text}${s.verify ? ` (check: ${s.verify}${s.verified ? ' ✓ passed' : ''})` : ''}`))
  }
  if (withDesign && plan.design) lines.push('', 'Design:', plan.design)
  return lines.join('\n')
}
