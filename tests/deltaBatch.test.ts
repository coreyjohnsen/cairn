import { describe, expect, it } from 'vitest'
import { DeltaBatch } from '../src/renderer/src/lib/deltaBatch'

describe('DeltaBatch', () => {
  it('joins tokens per message and hands them over once', () => {
    const b = new DeltaBatch()
    b.add('m1', 'c1', 'Hel')
    b.add('m1', 'c1', 'lo', '')
    b.add('m1', 'c1', undefined, 'think')
    b.add('m2', 'c1', 'x')
    expect(b.take()).toEqual([
      ['m1', { conv: 'c1', content: 'Hello', reasoning: 'think' }],
      ['m2', { conv: 'c1', content: 'x', reasoning: '' }]
    ])
    expect(b.size).toBe(0)
    expect(b.take()).toEqual([])
  })

  it('forgets tokens a finished message already contains, so the end of a reply is not repeated', () => {
    const b = new DeltaBatch()
    b.add('m1', 'c1', 'irn**')
    b.drop('m1')
    expect(b.take()).toEqual([])
  })

  it('keeps tokens for other messages when one is dropped', () => {
    const b = new DeltaBatch()
    b.add('m1', 'c1', 'a')
    b.add('m2', 'c1', 'b')
    b.drop('m1')
    expect(b.take().map(([id]) => id)).toEqual(['m2'])
  })
})
