const OPEN = '<think>'
const CLOSE = '</think>'

export interface Split {
  text: string
  reasoning: string
}

/**
 * Streaming splitter that moves <think>…</think> sections out of normal text.
 * Tags may be split across chunks, so potential partial tags are held back.
 */
export class ThinkSplitter {
  private buf = ''
  private inThink = false

  push(chunk: string): Split {
    this.buf += chunk
    return this.drain(false)
  }

  flush(): Split {
    return this.drain(true)
  }

  private drain(final: boolean): Split {
    let text = ''
    let reasoning = ''
    for (;;) {
      const tag = this.inThink ? CLOSE : OPEN
      const idx = this.buf.indexOf(tag)
      if (idx >= 0) {
        const before = this.buf.slice(0, idx)
        if (this.inThink) reasoning += before
        else text += before
        this.buf = this.buf.slice(idx + tag.length)
        this.inThink = !this.inThink
        continue
      }
      // No complete tag: emit everything except a possible partial tag at the end.
      let keep = 0
      if (!final) {
        const max = Math.min(tag.length - 1, this.buf.length)
        for (let k = max; k > 0; k--) {
          if (tag.startsWith(this.buf.slice(this.buf.length - k))) {
            keep = k
            break
          }
        }
      }
      const emit = this.buf.slice(0, this.buf.length - keep)
      this.buf = this.buf.slice(this.buf.length - keep)
      if (this.inThink) reasoning += emit
      else text += emit
      break
    }
    return { text, reasoning }
  }
}

/** Loopback, private-network and `.local` hosts: servers the user runs themselves. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.localhost')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/**
 * Extra request fields that switch a model's thinking on or off, for the servers that have a
 * documented way to do it. Everything else gets nothing, because a strict server would reject
 * a field it does not know:
 *  - OpenRouter: `reasoning.enabled`
 *  - Ollama (port 11434): `reasoning_effort: "none"` turns thinking off; on is its default
 *  - llama.cpp, vLLM and other servers on this machine or network: `chat_template_kwargs`, which
 *    the model's chat template reads (`enable_thinking` for Qwen3-style templates,
 *    `reasoning_effort` for gpt-oss, which cannot be fully switched off)
 */
export function thinkingBody(opts: { baseUrl: string; model: string; thinking?: 'on' | 'off' }): Record<string, unknown> {
  if (!opts.thinking) return {}
  const on = opts.thinking === 'on'
  let url: URL
  try {
    url = new URL(opts.baseUrl)
  } catch {
    return {}
  }
  const host = url.hostname.toLowerCase()
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return { reasoning: { enabled: on } }
  if (!isLocalHost(host)) return {}
  if (url.port === '11434') return on ? {} : { reasoning_effort: 'none' }
  // Templates name the switch differently (Qwen3 and GLM: enable_thinking; Granite and DeepSeek V3.1: thinking).
  const kwargs: Record<string, unknown> = { enable_thinking: on, thinking: on }
  if (!on && /gpt-oss/i.test(opts.model)) kwargs.reasoning_effort = 'low'
  return { chat_template_kwargs: kwargs }
}
