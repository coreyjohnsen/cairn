import { describe, expect, it } from 'vitest'
import {
  MIN_COMPACT_BUDGET,
  applyCompaction,
  asksFrom,
  chooseCut,
  cleanNarrative,
  describeCall,
  isContextOverflow,
  keptFrom,
  ledgerFrom,
  mergeLedger,
  packBlocks,
  transcriptBlocks,
  validCompaction,
  writeNarrative
} from '../src/main/agent/compact'
import { LEDGER_MAX_CHARS, compactionText, ledgerText } from '../src/shared/compaction'
import type { ChatMessage, Compaction, LedgerEntry } from '../src/shared/types'

let n = 0
const id = () => `m${++n}`
const user = (content: string): ChatMessage => ({ id: id(), role: 'user', createdAt: 1, content })
const asst = (content: string, calls: { id: string; name: string; args: object }[] = []): ChatMessage => ({
  id: id(),
  role: 'assistant',
  createdAt: 1,
  content,
  toolCalls: calls.length ? calls.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.args) })) : undefined
})
const tool = (callId: string, name: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: id(), role: 'tool', createdAt: 1, content, toolCallId: callId, toolName: name, ...extra })

/** A task with `steps` read-file exchanges, each result `chars` long. */
function agentRun(steps: number, chars = 2000): ChatMessage[] {
  const out: ChatMessage[] = [user('Please refactor the parser module and keep the tests green.')]
  for (let i = 0; i < steps; i++) {
    out.push(asst('', [{ id: `c${i}`, name: 'read_file', args: { path: `src/f${i}.ts` } }]))
    out.push(tool(`c${i}`, 'read_file', 'x'.repeat(chars)))
  }
  return out
}

const compaction = (over: Partial<Compaction> = {}): Compaction => ({
  narrative: 'Goal: refactor the parser.',
  asks: ['Please refactor the parser module'],
  ledger: [{ k: 'read', t: 'src/a.ts', n: 1 }],
  upToMessageId: 'x',
  messages: 4,
  toolCalls: 2,
  tokensBefore: 5000,
  tokensAfter: 1200,
  createdAt: 1,
  source: 'model',
  rounds: 1,
  ...over
})

describe('chooseCut', () => {
  it('keeps the most recent messages that fit the tail and summarizes the rest', () => {
    const msgs = agentRun(8, 2000)
    const cut = chooseCut(msgs, 0, 1500)
    expect(cut).toBeGreaterThan(1)
    expect(cut).toBeLessThan(msgs.length)
    // The kept part starts with an assistant message (the call), never with a lone result.
    expect(msgs[cut].role).toBe('assistant')
  })

  it('never begins the kept part with a tool result, even when the tail budget would cut right there', () => {
    const msgs = agentRun(6, 3000)
    for (const tail of [100, 400, 900, 1700, 2600, 5000]) {
      const cut = chooseCut(msgs, 0, tail)
      if (cut > 0) expect(msgs[cut].role).not.toBe('tool')
    }
  })

  it('always keeps the last exchange, however large', () => {
    const msgs = [...agentRun(3, 500), asst('', [{ id: 'big', name: 'read_file', args: { path: 'huge.ts' } }]), tool('big', 'read_file', 'y'.repeat(60000))]
    const cut = chooseCut(msgs, 0, 300)
    expect(cut).toBe(msgs.length - 2)
    expect(msgs[cut].toolCalls?.[0].id).toBe('big')
  })

  it('says there is nothing to summarize when the chat is only the kept part', () => {
    const msgs = agentRun(1, 100)
    expect(chooseCut(msgs, 0, 100000)).toBe(0)
    expect(chooseCut(msgs, 2, 100)).toBe(2)
  })

  it('starts after the part that was already summarized', () => {
    const msgs = agentRun(10, 1500)
    const cut = chooseCut(msgs, 8, 800)
    expect(cut).toBeGreaterThan(8)
  })
})

describe('applyCompaction', () => {
  it('stands the summary in for the earlier messages, in the user seat so the roles still alternate', () => {
    const msgs = agentRun(6, 400)
    const cut = chooseCut(msgs, 0, 700)
    const c = compaction({ upToMessageId: msgs[cut - 1].id })
    const out = applyCompaction(msgs, c)
    expect(out).toHaveLength(msgs.length - cut + 1)
    expect(out[0].role).toBe('user')
    expect(out[0].content).toContain('Earlier in this conversation')
    expect(out[0].content).toContain('Goal: refactor the parser.')
    expect(out[1]).toBe(msgs[cut])
    // The original messages are untouched: the transcript still shows everything.
    expect(msgs[0].content).toBe('Please refactor the parser module and keep the tests green.')
  })

  it('folds the summary into the next user message instead of making two user messages in a row', () => {
    const msgs = [...agentRun(2, 300), asst('done'), user('now add a CLI flag')]
    const c = compaction({ upToMessageId: msgs[msgs.length - 2].id })
    const out = applyCompaction(msgs, c)
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
    expect(out[0].content).toContain('Goal: refactor the parser.')
    expect(out[0].content).toContain('now add a CLI flag')
  })

  it('ignores a summary whose last message has been removed', () => {
    const msgs = agentRun(3, 200)
    expect(validCompaction(msgs, compaction({ upToMessageId: 'gone' }))).toBeUndefined()
    expect(applyCompaction(msgs, compaction({ upToMessageId: 'gone' }))).toBe(msgs)
    expect(keptFrom(msgs, compaction({ upToMessageId: 'gone' }))).toBe(0)
    expect(keptFrom(msgs, compaction({ upToMessageId: msgs[2].id }))).toBe(3)
  })
})

describe('the list of tool calls', () => {
  it('describes each kind of call and how it ended', () => {
    const read = describeCall('read_file', '{"path":"src/a.ts","offset":50,"limit":100}', tool('1', 'read_file', 'ok'))
    expect(read).toMatchObject({ k: 'read', t: 'src/a.ts', note: 'lines 50-149' })
    expect(describeCall('read_file', '{"path":"b.ts"}', tool('1', 'read_file', 'boom', { isError: true }))).toMatchObject({ k: 'read', note: 'failed' })
    expect(describeCall('edit_file', '{"path":"src/a.ts"}')).toMatchObject({ k: 'wrote', note: 'edited' })
    expect(describeCall('move_path', '{"from":"a","to":"b"}')).toMatchObject({ k: 'wrote', t: 'a → b', note: 'moved' })
    expect(describeCall('run_command', '{"command":"npm test\\nmore"}', tool('1', 'run_command', 'Exit code: 1\nFAIL'))).toMatchObject({ k: 'cmd', t: 'npm test', note: 'exit 1' })
    expect(describeCall('search_files', '{"pattern":"foo","path":"src"}')).toMatchObject({ k: 'find', t: 'search "foo" in src' })
    expect(describeCall('web_search', '{"query":"vite config"}')).toMatchObject({ k: 'web' })
    expect(describeCall('my_tool', '{"thing":"abc"}')).toMatchObject({ k: 'misc', t: 'my_tool abc' })
  })

  it('files a declined call under "declined" so the model does not try again', () => {
    const e = describeCall('delete_path', '{"path":"build"}', tool('1', 'delete_path', 'no', { isError: true, denied: true }))
    expect(e.k).toBe('denied')
    expect(e.t).toBe('build')
  })

  it('lists calls from the messages, pairing each with its result, and counts them', () => {
    const msgs = [
      user('go'),
      asst('', [
        { id: 'a', name: 'read_file', args: { path: 'one.ts' } },
        { id: 'b', name: 'run_command', args: { command: 'npm run build' } }
      ]),
      tool('a', 'read_file', 'text'),
      tool('b', 'run_command', 'Exit code: 0\nbuilt')
    ]
    const { entries, calls } = ledgerFrom(msgs)
    expect(calls).toBe(2)
    expect(entries.map((e) => `${e.k}:${e.t}:${e.note ?? ''}`)).toEqual(['read:one.ts:', 'cmd:npm run build:exit 0'])
  })

  it('merges repeats into one line with a count, ordered by when they last happened', () => {
    const a = mergeLedger([], [{ k: 'read', t: 'a.ts', n: 1 }, { k: 'read', t: 'b.ts', n: 1 }])
    const b = mergeLedger(a, [{ k: 'read', t: 'a.ts', n: 1, note: 'lines 1-10' }])
    expect(b.map((e) => e.t)).toEqual(['b.ts', 'a.ts'])
    expect(b[1]).toMatchObject({ n: 2, note: 'lines 1-10' })
  })

  it('stays within its size however many calls there were, giving up the oldest first and saying so', () => {
    const many: LedgerEntry[] = Array.from({ length: 300 }, (_, i) => ({ k: 'read', t: `src/module-${i}/file-with-a-long-name-${i}.ts`, n: 1 }))
    const text = ledgerText(many)
    expect(text.length).toBeLessThanOrEqual(LEDGER_MAX_CHARS + 60)
    expect(text).toContain('file-with-a-long-name-299.ts')
    expect(text).not.toContain('file-with-a-long-name-0.ts')
    expect(text).toMatch(/older tool calls? not listed/)
  })

  it('keeps only the latest few user requests, shortened', () => {
    const msgs = ['one', 'two', 'three', 'four', 'five'].map((t) => user(`${t} ${'x'.repeat(600)}`))
    const asks = asksFrom([], msgs)
    expect(asks).toHaveLength(4)
    expect(asks[0].startsWith('two ')).toBe(true)
    expect(asks[0].length).toBeLessThanOrEqual(421)
  })
})

describe('what the model reads', () => {
  it('has the narrative, the requests, the list of calls and a note that file contents are gone', () => {
    const t = compactionText(compaction({ ledger: [{ k: 'wrote', t: 'src/a.ts', n: 2, note: 'edited' }, { k: 'cmd', t: 'npm test', n: 1, note: 'exit 1' }], toolCalls: 3 }))
    expect(t).toContain('Goal: refactor the parser.')
    expect(t).toContain('- Please refactor the parser module')
    expect(t).toContain('Files created or changed: src/a.ts (edited, ×2)')
    expect(t).toContain('Commands run: `npm test` (exit 1)')
    expect(t).toContain('Tool calls made so far (3)')
    expect(t).toMatch(/Call the tool again/)
  })

  it('still says what was done when the model could not write a narrative', () => {
    const t = compactionText(compaction({ narrative: '', source: 'ledger' }))
    expect(t).not.toMatch(/Goal:/)
    expect(t).toContain('Files read: src/a.ts')
  })
})

describe('asking the model to summarize', () => {
  it('shortens tool output to the part that matters and leaves reasoning out', () => {
    const blocks = transcriptBlocks([
      user('fix it'),
      { ...asst('looking', [{ id: 'a', name: 'read_file', args: { path: 'a.ts' } }]), reasoning: 'secret thoughts' },
      tool('a', 'read_file', `START${'m'.repeat(5000)}END`)
    ])
    const text = blocks.join('\n')
    expect(text).toContain('USER: fix it')
    expect(text).toContain('CALL read_file {"path":"a.ts"}')
    expect(text).not.toContain('secret thoughts')
    expect(text).toContain('START')
    expect(text).toContain('END')
    expect(text).toMatch(/characters left out/)
    expect(text.length).toBeLessThan(1500)
  })

  it('packs blocks into pieces that each fit, and cuts down a block that alone is too big', () => {
    const blocks = Array.from({ length: 10 }, (_, i) => `block ${i} ${'w'.repeat(1500)}`)
    const chunks = packBlocks(blocks, 1000)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.join('')).toContain('block 0')
    expect(chunks.join('')).toContain('block 9')
    const giant = packBlocks(['z'.repeat(100000)], 600)
    expect(giant).toHaveLength(1)
    expect(giant[0].length).toBeLessThan(3000)
  })

  it('cleans what comes back and rejects thin answers', () => {
    expect(cleanNarrative('<think>hmm</think>\nSure!\nGoal: do the thing. Done: a lot of work was finished in the module.', 4000)).toMatch(/^Goal: do the thing/)
    expect(cleanNarrative('```\nGoal: a b c d e f g h i j k l m n o p q r s t u v w x y z a b c d\n```', 4000)).toMatch(/^Goal:/)
    expect(cleanNarrative('ok', 4000)).toBe('')
    expect(cleanNarrative(`Goal: ${'a'.repeat(5000)}`, 600).length).toBeLessThanOrEqual(600)
  })

  it('folds long stretches in pieces, each time carrying the summary so far', async () => {
    const seen: string[] = []
    const out = await writeNarrative(
      async (_sys, user) => {
        seen.push(user)
        return `Goal: summary after piece ${seen.length}, with enough words to count as one.`
      },
      { prior: 'Goal: earlier summary that already exists here.', blocks: Array.from({ length: 6 }, (_, i) => `msg ${i} ${'q'.repeat(1200)}`), capacityTokens: 700, words: 200 }
    )
    expect(seen.length).toBeGreaterThan(1)
    expect(seen[0]).toContain('earlier summary that already exists')
    expect(seen[1]).toContain('summary after piece 1')
    expect(out).toContain(`piece ${seen.length}`)
  })

  it('gives null when the model returns nothing usable', async () => {
    expect(await writeNarrative(async () => '', { prior: '', blocks: ['USER: hi there friend'], capacityTokens: 800, words: 100 })).toBeNull()
  })
})

describe('isContextOverflow', () => {
  it('recognises what servers say when a request does not fit', () => {
    expect(isContextOverflow(new Error('HTTP 400: the request exceeds the available context size, try increasing it'))).toBe(true)
    expect(isContextOverflow(new Error("HTTP 400: This model's maximum context length is 8192 tokens. However, you requested 9100 tokens"))).toBe(true)
    expect(isContextOverflow(new Error('prompt is too long: 215000 tokens > 200000 maximum'))).toBe(true)
    expect(isContextOverflow(new Error('HTTP 500: slot unavailable, n_ctx too small'))).toBe(true)
  })
  it('does not mistake other failures for it', () => {
    expect(isContextOverflow(new Error('HTTP 401: invalid api key'))).toBe(false)
    expect(isContextOverflow(new Error('Could not reach the model server (ECONNREFUSED). Is it running?'))).toBe(false)
    expect(isContextOverflow(new Error('HTTP 429: rate limited'))).toBe(false)
  })
})

describe('limits', () => {
  it('does not summarize when the room for the chat is so small that a summary would not help', () => {
    expect(MIN_COMPACT_BUDGET).toBeGreaterThanOrEqual(2000)
  })
})
