export interface Delta {
  conv: string
  content: string
  reasoning: string
}

/**
 * Streaming tokens waiting for the next screen refresh. A full message snapshot supersedes anything
 * still waiting for it, so `drop` must be called when one arrives: otherwise the waiting tokens are
 * added on top of a message that already has them, and the end of the reply appears twice.
 */
export class DeltaBatch {
  private pending = new Map<string, Delta>()

  add(messageId: string, conv: string, content = '', reasoning = ''): void {
    const cur = this.pending.get(messageId) ?? { conv, content: '', reasoning: '' }
    cur.content += content
    cur.reasoning += reasoning
    this.pending.set(messageId, cur)
  }

  drop(messageId: string): void {
    this.pending.delete(messageId)
  }

  get size(): number {
    return this.pending.size
  }

  take(): [string, Delta][] {
    const out = [...this.pending.entries()]
    this.pending.clear()
    return out
  }
}
