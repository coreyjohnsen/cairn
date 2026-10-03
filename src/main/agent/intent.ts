const VERB = '(?:generate|create|make|draw|paint|render|produce|design|sketch|illustrate|imagine|show me|give me)'
const NOUN = '(?:image|picture|photo|photograph|illustration|drawing|painting|artwork|render|wallpaper|portrait|logo|icon|sketch|poster|scene|landscape|pic)s?'

const NOUN_RE = new RegExp(
  `^\\s*(?:(?:please|pls|hey|ok|okay)[,\\s]+)?(?:(?:can|could|would|will) you\\s+)?(?:please\\s+)?${VERB}\\s+(?:me\\s+)?(?:an?\\s+|the\\s+|some\\s+)?(?:[\\w'-]+\\s+){0,3}?${NOUN}\\b\\s*(?:of|showing|depicting|featuring|with|that shows|where)?\\s*(.*)$`,
  'is'
)
const DRAW_RE = /^\s*(?:(?:please|pls)[,\s]+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:draw|paint|sketch|illustrate)\s+(?:me\s+)?(.{3,})$/is
const SLASH_RE = /^\s*\/(?:imagine|image|img|draw)\s+(.+)$/is

/** True for an explicit `/imagine …` style command, which always goes to the image generator. */
export function isExplicitImageCommand(text: string): boolean {
  return SLASH_RE.test(text)
}

/**
 * Detect "make me a picture of …" style requests so they can be routed straight to the
 * image generator when the chat model cannot call tools. Returns the image prompt or null.
 */
export function detectImageRequest(text: string): string | null {
  const t = text.trim()
  if (!t || t.length > 600) return null
  let m = SLASH_RE.exec(t)
  if (m) return m[1].trim()
  m = DRAW_RE.exec(t)
  if (m) return m[1].trim().replace(/[.!?]+$/, '')
  m = NOUN_RE.exec(t)
  if (m) {
    const subject = m[1].trim().replace(/[.!?]+$/, '')
    return subject.length >= 3 ? subject : t.replace(/[.!?]+$/, '')
  }
  return null
}
