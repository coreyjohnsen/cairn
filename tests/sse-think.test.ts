import { describe, expect, it } from 'vitest'
import { parseSse } from '../src/main/providers/sse'
import { ThinkSplitter } from '../src/main/providers/think'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch))
      c.close()
    }
  })
}

async function collect(chunks: string[]) {
  const out = []
  for await (const m of parseSse(streamOf(chunks))) out.push(m)
  return out
}

describe('parseSse', () => {
  it('parses events split across chunks and CRLF endings', async () => {
    const msgs = await collect(['data: {"a":', '1}\r\n\r\nevent: ping\r\ndata: x\r', '\n\r\n', 'data: [DONE]\n\n'])
    expect(msgs).toEqual([
      { event: undefined, data: '{"a":1}' },
      { event: 'ping', data: 'x' },
      { event: undefined, data: '[DONE]' }
    ])
  })
  it('joins multi-line data and ignores comments', async () => {
    const msgs = await collect([': keepalive\n\ndata: one\ndata: two\n\n'])
    expect(msgs).toEqual([{ event: undefined, data: 'one\ntwo' }])
  })
  it('flushes a final event with no trailing blank line', async () => {
    const msgs = await collect(['data: last'])
    expect(msgs).toEqual([{ event: undefined, data: 'last' }])
  })
})

describe('ThinkSplitter', () => {
  const run = (chunks: string[]) => {
    const s = new ThinkSplitter()
    let text = ''
    let reasoning = ''
    for (const c of chunks) {
      const r = s.push(c)
      text += r.text
      reasoning += r.reasoning
    }
    const f = s.flush()
    return { text: text + f.text, reasoning: reasoning + f.reasoning }
  }
  it('splits think blocks', () => {
    expect(run(['<think>plan</think>Answer'])).toEqual({ text: 'Answer', reasoning: 'plan' })
  })
  it('handles tags split across chunks', () => {
    expect(run(['Hi <thi', 'nk>deep ', 'thought</th', 'ink> done'])).toEqual({ text: 'Hi  done', reasoning: 'deep thought' })
  })
  it('does not swallow a lone < character', () => {
    expect(run(['a < b', ' and c'])).toEqual({ text: 'a < b and c', reasoning: '' })
  })
  it('flushes an unfinished think block as reasoning', () => {
    expect(run(['<think>never closed'])).toEqual({ text: '', reasoning: 'never closed' })
  })
})
