/**
 * Gets chat text ready for the math renderer.
 *
 * Models write formulas in two styles: `$x^2$` / `$$ … $$`, and `\( x^2 \)` / `\[ … \]`. The renderer
 * only understands the dollar style, so the second style is converted. A dollar sign that is not
 * a formula (prices such as "$5 and $10") would otherwise swallow the text between two of them, so
 * each `$` must follow the usual rules for opening and closing a formula or it is shown as itself.
 * Code (fenced blocks and `inline code`) is left exactly as it is.
 */

type Piece = { code: boolean; text: string }

/** Split into pieces that are code and pieces that are not. */
function splitCode(src: string): Piece[] {
  const out: Piece[] = []
  const lines = src.split('\n')
  let fence: string | null = null
  let buf: string[] = []
  const flush = (code: boolean) => {
    if (buf.length) out.push({ code, text: buf.join('') })
    buf = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] + (i < lines.length - 1 ? '\n' : '')
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence === null && m) {
      flush(false)
      fence = m[1][0].repeat(m[1].length)
      buf.push(line)
    } else if (fence !== null) {
      buf.push(line)
      const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`)
      if (close.test(line)) {
        flush(true)
        fence = null
      }
    } else {
      buf.push(line)
    }
  }
  flush(fence !== null)
  // Inline code inside the non-fenced pieces.
  const result: Piece[] = []
  for (const p of out) {
    if (p.code) {
      result.push(p)
      continue
    }
    let rest = p.text
    for (;;) {
      const m = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/.exec(rest)
      if (!m) break
      if (m.index > 0) result.push({ code: false, text: rest.slice(0, m.index) })
      result.push({ code: true, text: m[0] })
      rest = rest.slice(m.index + m[0].length)
    }
    if (rest) result.push({ code: false, text: rest })
  }
  return result
}

/** Walk one stretch of text and keep only the dollar signs that really start and end a formula. */
function guardDollars(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '\\' && i + 1 < n) {
      out += c + text[i + 1]
      i += 2
      continue
    }
    if (c !== '$') {
      out += c
      i++
      continue
    }
    if (text[i + 1] === '$') {
      // A display formula: keep it when it is closed, otherwise show the signs.
      const close = text.indexOf('$$', i + 2)
      if (close === -1) {
        out += '\\$\\$'
        i += 2
      } else {
        out += text.slice(i, close + 2)
        i = close + 2
      }
      continue
    }
    const next = text[i + 1]
    let close = -1
    if (next !== undefined && !/\s/.test(next)) {
      for (let j = i + 1; j < n; j++) {
        if (text[j] === '\\') {
          j++
          continue
        }
        if (text[j] === '\n' && text[j + 1] === '\n') break
        if (text[j] === '$' && text[j + 1] !== '$' && !/\s/.test(text[j - 1]) && !/[0-9]/.test(text[j + 1] ?? '')) {
          close = j
          break
        }
      }
    }
    if (close === -1) {
      out += '\\$'
      i++
    } else {
      out += text.slice(i, close + 1)
      i = close + 1
    }
  }
  return out
}

export function prepareMath(src: string): string {
  if (!src.includes('$') && !src.includes('\\(') && !src.includes('\\[')) return src
  return splitCode(src)
    .map((p) => {
      if (p.code) return p.text
      const converted = p.text
        .replace(/\\\[([\s\S]+?)\\\]/g, (_m, f: string) => `\n$$\n${f.trim()}\n$$\n`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_m, f: string) => `$${f.trim()}$`)
      return guardDollars(converted)
    })
    .join('')
}
