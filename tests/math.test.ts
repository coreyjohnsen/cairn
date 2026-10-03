import { describe, expect, it } from 'vitest'
import { prepareMath } from '../src/renderer/src/lib/math'

describe('prepareMath', () => {
  it('leaves ordinary formulas and text alone', () => {
    expect(prepareMath('Fast ($O(n)$) and $$x^2$$ here')).toBe('Fast ($O(n)$) and $$x^2$$ here')
    expect(prepareMath('no maths here')).toBe('no maths here')
  })

  it('converts the backslash styles to dollars', () => {
    expect(prepareMath('so \\( x^2 + 1 \\) holds')).toBe('so $x^2 + 1$ holds')
    expect(prepareMath('\\[ a = b \\]')).toBe('\n$$\na = b\n$$\n')
  })

  it('shows prices as prices', () => {
    expect(prepareMath('It costs $5 and $10 in total')).toBe('It costs \\$5 and \\$10 in total')
    expect(prepareMath('Pay $5.')).toBe('Pay \\$5.')
    expect(prepareMath('$x$ is $5')).toBe('$x$ is \\$5')
  })

  it('shows a dollar sign that is never closed', () => {
    expect(prepareMath('open $x and nothing more')).toBe('open \\$x and nothing more')
    expect(prepareMath('open $$x never closed')).toBe('open \\$\\$x never closed')
  })

  it('does not look across paragraphs', () => {
    expect(prepareMath('a $x\n\nb$')).toBe('a \\$x\n\nb\\$')
  })

  it('keeps code exactly as written', () => {
    const code = 'run `echo $HOME and $PATH` then\n```bash\nprice=$5 \\( not math \\)\n```\n'
    expect(prepareMath(code)).toBe(code)
  })

  it('keeps already escaped dollars', () => {
    expect(prepareMath('cost \\$5 and \\$6')).toBe('cost \\$5 and \\$6')
  })

  it('works inside table cells', () => {
    const row = '| Slow ($O(2^n)$) | Fast ($O(n)$) |'
    expect(prepareMath(row)).toBe(row)
  })
})
