import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ScriptedTurn {
  /** Text chunks to stream as content deltas. */
  text?: string[]
  reasoning?: string[]
  /** Tool calls to emit (arguments are streamed in two halves). */
  toolCalls?: { id: string; name: string; args: string }[]
  /** Respond with this HTTP status + body instead of streaming. */
  error?: { status: number; body: unknown }
  finish?: string
}

export interface MockServer {
  url: string
  requests: any[]
  close(): Promise<void>
}

/** Minimal OpenAI-compatible server that replays one scripted turn per /chat/completions request. */
export async function startMockOpenAI(script: ScriptedTurn[]): Promise<MockServer> {
  const requests: any[] = []
  let turn = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'text-embedding-3-small' }, { id: 'mock-vision-vl' }] }))
      return
    }
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const json = JSON.parse(body)
        requests.push(json)
        const t = script[Math.min(turn++, script.length - 1)]
        if (t.error) {
          res.statusCode = t.error.status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(t.error.body))
          return
        }
        res.setHeader('Content-Type', 'text/event-stream')
        const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
        for (const r of t.reasoning ?? []) send({ choices: [{ delta: { reasoning_content: r } }] })
        for (const c of t.text ?? []) send({ choices: [{ delta: { content: c } }] })
        ;(t.toolCalls ?? []).forEach((tc, i) => {
          const half = Math.floor(tc.args.length / 2)
          send({ choices: [{ delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args.slice(0, half) } }] } }] })
          send({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: tc.args.slice(half) } }] } }] })
        })
        send({ choices: [{ delta: {}, finish_reason: t.finish ?? (t.toolCalls?.length ? 'tool_calls' : 'stop') }] })
        send({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } })
        res.write('data: [DONE]\n\n')
        res.end()
      })
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((r) => server.close(() => r()))
  }
}
