import type { Settings } from '@shared/types'

/**
 * The user's limits on tool results and on how many tool calls one request may chain.
 * 0 (or anything that is not a positive number) means no limit, so both can be set to anything.
 */
export function toolOutputLimit(settings: Settings): number {
  const n = settings.chat.toolOutputLimit
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity
}

/** Share of the model's history budget one tool result may take, so that the result is never trimmed away again before the model reads it. */
const CONTEXT_SHARE = 0.4
const CHARS_PER_TOKEN = 3.6

/**
 * The most characters one tool result can take without crowding the conversation out of the model's memory.
 * `budgetTokens` is the history budget of the current request; Infinity when it is unknown (hosted models).
 */
export function contextOutputLimit(budgetTokens: number | undefined): number {
  if (!budgetTokens || !Number.isFinite(budgetTokens) || budgetTokens <= 0) return Infinity
  return Math.max(1500, Math.floor(budgetTokens * CONTEXT_SHARE * CHARS_PER_TOKEN))
}

/** What a tool should hold its output to: the user's limit, or less when the model's memory is smaller. */
export function outputLimitOf(ctx: { settings: Settings; outputLimit?: number }): number {
  return Math.min(toolOutputLimit(ctx.settings), ctx.outputLimit ?? Infinity)
}

export function maxAgentSteps(settings: Settings): number {
  const n = settings.chat.maxAgentSteps
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity
}

/** The most output a program is allowed to buffer when there is no limit, so a command that never stops cannot use all the memory. */
export const UNLIMITED_BUFFER_CHARS = 8_000_000

/**
 * How much of a program's output to keep (start and end) so that the result fits the limit without being cut again later.
 * `reserve` leaves room for the "characters omitted" line.
 */
export function collectorSizes(limit: number): { head: number; tail: number } {
  const total = Number.isFinite(limit) ? Math.max(200, limit - 100) : UNLIMITED_BUFFER_CHARS
  const head = Math.floor(total * 0.3)
  return { head, tail: total - head }
}
