import { describe, expect, it } from 'vitest'
import { cleanEnhanced, enhancedOrError } from '../src/main/agent/enhance'

describe('enhanced prompts', () => {
  it('strips the wrappers models add', () => {
    expect(cleanEnhanced('<think>hmm</think>\nPrompt: "A cabin at dawn, soft mist."', 'cabin')).toBe('A cabin at dawn, soft mist.')
    expect(cleanEnhanced('```\nA cabin\nat dawn\n```', 'cabin')).toBe('A cabin at dawn')
  })

  it('returns the rewrite', () => {
    expect(enhancedOrError('A lone cabin below a snow-dusted ridge at dawn, mist in the valley, 35mm.', 'a cabin')).toMatch(/^A lone cabin/)
  })

  // A model that thinks first can use up the whole reply on thinking and answer with nothing. That used to hand the
  // original back as if it had been rewritten, and the prompt box then offered "Undo" for a change that never happened.
  it('says so when the model sent back nothing', () => {
    expect(() => enhancedOrError('', 'a cabin')).toThrow(/no text.*think/i)
    expect(() => enhancedOrError('<think>still working it out', 'a cabin')).toThrow(/no text|usable/i)
    expect(() => enhancedOrError('   \n', 'a cabin')).toThrow(/no text/i)
  })

  it('says so when the answer is unusable or is the same prompt', () => {
    expect(() => enhancedOrError('x '.repeat(900), 'a cabin')).toThrow(/usable/i)
    expect(() => enhancedOrError('  "a cabin"  ', 'a cabin')).toThrow(/unchanged/i)
  })
})
