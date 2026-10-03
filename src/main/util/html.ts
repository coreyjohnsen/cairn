const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™'
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      if (Number.isFinite(code) && code > 0 && code < 0x110000) {
        try {
          return String.fromCodePoint(code)
        } catch {
          return m
        }
      }
      return m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

export function htmlTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : ''
}

/** Lightweight HTML → readable text (no DOM needed). */
export function htmlToText(html: string): string {
  let s = html
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(script|style|noscript|svg|head|template|iframe)[\s\S]*?<\/\1>/gi, '')
  s = s.replace(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, '').trim()
    return text ? `${text} (${href})` : ''
  })
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|section|article|header|footer|main|nav|ul|ol|table|blockquote|pre|form)>/gi, '\n\n')
  s = s.replace(/<\/(h[1-6]|li|tr)>/gi, '\n')
  s = s.replace(/<li\b[^>]*>/gi, '- ')
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => '\n' + '#'.repeat(Number(n)) + ' ')
  s = s.replace(/<\/t[dh]>/gi, '\t')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  s = s.replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n')
  return s.trim()
}
