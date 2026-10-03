import type { ApprovalDecision, ApprovalRequest } from '@shared/types'

interface Pending {
  resolve: (d: ApprovalDecision) => void
  conversationId: string
}

export class ApprovalManager {
  private pending = new Map<string, Pending>()

  request(req: ApprovalRequest, conversationId: string): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      this.pending.set(req.id, { resolve, conversationId })
    })
  }

  resolve(id: string, decision: ApprovalDecision): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    this.pending.delete(id)
    p.resolve(decision)
    return true
  }

  /** Deny everything still waiting for this conversation (used when a run is aborted). */
  cancelConversation(conversationId: string): string[] {
    const ids: string[] = []
    for (const [id, p] of [...this.pending]) {
      if (p.conversationId === conversationId) {
        this.pending.delete(id)
        p.resolve('deny')
        ids.push(id)
      }
    }
    return ids
  }

  pendingCount(): number {
    return this.pending.size
  }
}
