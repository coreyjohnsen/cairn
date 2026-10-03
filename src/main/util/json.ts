export type ParsedArgs = { ok: true; value: Record<string, unknown> } | { ok: false; error: string }

/**
 * Parse tool-call arguments produced by a model. Small local models often emit slightly
 * broken JSON (code fences, trailing commas, single quotes, unbalanced braces), so try a
 * few cheap repairs before giving up.
 */
export function parseToolArgs(raw: string | undefined | null): ParsedArgs {
  const text = (raw ?? '').trim()
  if (!text) return { ok: true, value: {} }
  const attempts: string[] = [text]
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  if (unfenced !== text) attempts.push(unfenced)
  attempts.push(unfenced.replace(/,\s*([}\]])/g, '$1'))
  attempts.push(balance(unfenced.replace(/,\s*([}\]])/g, '$1')))
  if (unfenced.includes("'") && !unfenced.includes('"')) attempts.push(unfenced.replace(/'/g, '"'))

  let lastErr = ''
  for (const a of attempts) {
    try {
      const v = JSON.parse(a)
      if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown> }
      lastErr = 'Arguments must be a JSON object'
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }
  return { ok: false, error: `Could not parse tool arguments as JSON (${lastErr})` }
}

function balance(s: string): string {
  let braces = 0
  let brackets = 0
  let inStr = false
  let esc = false
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') braces++
    else if (ch === '}') braces--
    else if (ch === '[') brackets++
    else if (ch === ']') brackets--
  }
  let out = s
  if (inStr) out += '"'
  while (brackets-- > 0) out += ']'
  while (braces-- > 0) out += '}'
  return out
}

export function safeJsonStringify(v: unknown, space?: number): string {
  try {
    return JSON.stringify(v, null, space) ?? ''
  } catch {
    return String(v)
  }
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = max - head
  return `${text.slice(0, head)}\n\n… [${text.length - max} characters omitted] …\n\n${text.slice(text.length - tail)}`
}
