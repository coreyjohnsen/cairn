import { describe, expect, it } from 'vitest'
import { summarizeStreaming } from '../src/renderer/src/lib/toolSummary'

describe('describing a tool call that is still being written', () => {
  it('names the file from the start of the arguments', () => {
    expect(summarizeStreaming('write_file', '{"path": "games/snake.html", "content": "<!doctype html><html><head><sty')).toMatchObject({ verb: 'Wrote', target: 'snake.html' })
    expect(summarizeStreaming('edit_file', '{"path":"src/app.ts","old_string":"a')).toMatchObject({ verb: 'Edited', target: 'app.ts' })
  })

  it('shows a command, a search or an address, cut off wherever the text stopped', () => {
    expect(summarizeStreaming('run_command', '{"command": "npm run build && npm te')).toMatchObject({ verb: 'Ran', target: 'npm run build && npm te' })
    expect(summarizeStreaming('fetch_url', '{"url": "https://example.com/a/b')).toMatchObject({ verb: 'Fetched', target: 'example.com/a/b' })
    expect(summarizeStreaming('web_search', '{"query": "llama.cpp --n-cpu-moe')).toMatchObject({ target: 'llama.cpp --n-cpu-moe' })
  })

  it('handles escapes, and a cut in the middle of one', () => {
    expect(summarizeStreaming('run_command', '{"command": "echo \\"hi\\" && ls"}').target).toBe('echo "hi" && ls')
    expect(() => summarizeStreaming('run_command', '{"command": "echo \\')).not.toThrow()
  })

  it('says nothing about the target before the model has named one', () => {
    expect(summarizeStreaming('write_file', '').target).toBe('')
    expect(summarizeStreaming('write_file', '{"pa').target).toBe('')
    expect(summarizeStreaming('write_file', '{"content": "<html>').target).toBe('')
  })

  it('still describes tools it does not know', () => {
    expect(summarizeStreaming('custom_thing', '{"path": "x"}').verb).toBe('custom thing')
  })
})
