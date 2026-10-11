import type { Compaction, LedgerEntry } from './types'

/** Longest the list of tool calls may be in the summary, so it never takes the room it is meant to free. */
export const LEDGER_MAX_CHARS = 2400

const short = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1)).trimEnd()}…`)

function entryText(e: LedgerEntry): string {
  const t = e.k === 'cmd' ? `\`${short(e.t, 110)}\`` : e.k === 'find' || e.k === 'web' ? short(e.t, 90) : short(e.t, 120)
  const bits = [e.note, e.n > 1 ? `×${e.n}` : ''].filter(Boolean).join(', ')
  return bits ? `${t} (${bits})` : t
}

const GROUPS: { k: LedgerEntry['k']; title: string }[] = [
  { k: 'read', title: 'Files read' },
  { k: 'wrote', title: 'Files created or changed' },
  { k: 'cmd', title: 'Commands run' },
  { k: 'find', title: 'Searches and listings' },
  { k: 'web', title: 'Web' },
  { k: 'misc', title: 'Other tool calls' },
  { k: 'denied', title: 'Declined by the user (do not retry)' }
]

/**
 * The tool calls made so far, grouped, newest kept when there are too many. This list is made from the messages
 * themselves, not written by the model, so it is complete and exact however small the model is.
 */
export function ledgerText(entries: LedgerEntry[], maxChars = LEDGER_MAX_CHARS): string {
  // Entries are in the order they last happened; the oldest are given up first.
  let keep = entries.map((e, i) => ({ e, i }))
  const render = (list: { e: LedgerEntry; i: number }[], dropped: number): string => {
    const lines: string[] = []
    for (const g of GROUPS) {
      const items = list.filter((x) => x.e.k === g.k).map((x) => entryText(x.e))
      if (items.length) lines.push(`${g.title}: ${items.join('; ')}`)
    }
    if (dropped > 0) lines.push(`(${dropped} older tool call${dropped === 1 ? '' : 's'} not listed)`)
    return lines.join('\n')
  }
  let text = render(keep, 0)
  let dropped = 0
  while (text.length > maxChars && keep.length > 1) {
    // Drop the oldest few at a time, so long ledgers do not take many passes.
    const step = Math.max(1, Math.ceil(keep.length / 12))
    dropped += keep.slice(0, step).reduce((n, x) => n + x.e.n, 0)
    keep = keep.slice(step)
    text = render(keep, dropped)
  }
  return text
}

/** Everything the model is told in place of the older messages. */
export function compactionText(c: Pick<Compaction, 'narrative' | 'asks' | 'ledger' | 'toolCalls'>): string {
  const parts: string[] = ['[Earlier in this conversation. It was summarized because the conversation grew longer than your memory. Treat this as what happened.]']
  if (c.narrative.trim()) parts.push(c.narrative.trim())
  if (c.asks.length) parts.push(`What the user asked, in their words (oldest first):\n${c.asks.map((a) => `- ${a}`).join('\n')}`)
  const ledger = ledgerText(c.ledger)
  if (ledger) parts.push(`Tool calls made so far (${c.toolCalls}):\n${ledger}`)
  parts.push('File contents and command output from before this point are no longer in your memory. Call the tool again when you need them, asking for only the part you need.')
  return parts.join('\n\n')
}
