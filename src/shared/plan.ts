import type { ConversationPlan, PlanStatus, PlanStep } from './types'

export const MAX_PLAN_STEPS = 40
export const MAX_STEP_CHARS = 300
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
      steps.push({ id: `s${steps.length + 1}`, text: clip(text, MAX_STEP_CHARS), status: asStatus(item?.status) })
    }
  }
  if (!goal && steps.length === 0) return { error: 'A plan needs a goal or at least one step.' }
  // One thing at a time: when several are marked in progress, only the first stays so.
  const firstDoing = steps.findIndex((s) => s.status === 'doing')
  steps = steps.map((s, i) => (s.status === 'doing' && i !== firstDoing ? { ...s, status: 'todo' as const } : s))
  return { plan: { goal, design, steps, updatedAt: now } }
}

export function planProgress(plan: Pick<ConversationPlan, 'steps'>): { done: number; total: number } {
  return { done: plan.steps.filter((s) => s.status === 'done').length, total: plan.steps.length }
}

const MARK: Record<PlanStatus, string> = { todo: '[ ]', doing: '[>]', done: '[x]', blocked: '[!]' }

/** The plan as plain text, for the model (in the system prompt and as the tool's answer). */
export function planText(plan: ConversationPlan, withDesign = true): string {
  const { done, total } = planProgress(plan)
  const lines: string[] = []
  if (plan.goal) lines.push(`Goal: ${plan.goal}`)
  if (total) {
    lines.push(`Steps (${done} of ${total} done; [ ] to do, [>] doing now, [x] done, [!] blocked):`)
    plan.steps.forEach((s, i) => lines.push(`${i + 1}. ${MARK[s.status]} ${s.text}`))
  }
  if (withDesign && plan.design) lines.push('', 'Design:', plan.design)
  return lines.join('\n')
}
