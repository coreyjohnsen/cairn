export interface SseMessage {
  event?: string
  data: string
}

/**
 * Parse a Server-Sent Events byte stream. Handles \r\n and \n line endings, multi-line data
 * fields and events split across network chunks.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let event: string | undefined
  let dataLines: string[] = []

  const flush = (): SseMessage | null => {
    if (dataLines.length === 0) {
      event = undefined
      return null
    }
    const msg: SseMessage = { event, data: dataLines.join('\n') }
    event = undefined
    dataLines = []
    return msg
  }

  const onAbort = () => void reader.cancel().catch(() => {})
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.search(/\r\n|\n|\r/)) >= 0) {
        // A lone trailing \r might be the first half of \r\n; wait for more data.
        if (buffer[nl] === '\r' && nl === buffer.length - 1) break
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + (buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? 2 : 1))
        if (line === '') {
          const m = flush()
          if (m) yield m
        } else if (line.startsWith(':')) {
          // comment / keep-alive
        } else {
          const colon = line.indexOf(':')
          const field = colon < 0 ? line : line.slice(0, colon)
          let val = colon < 0 ? '' : line.slice(colon + 1)
          if (val.startsWith(' ')) val = val.slice(1)
          if (field === 'data') dataLines.push(val)
          else if (field === 'event') event = val
        }
      }
    }
    buffer += decoder.decode()
    if (buffer.length > 0) {
      for (const line of buffer.split(/\r\n|\n|\r/)) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
        else if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '')
      }
    }
    const m = flush()
    if (m) yield m
  } finally {
    signal?.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }
}
