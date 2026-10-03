import { defaultSettings } from '../../src/shared/defaults'
import type { Settings } from '../../src/shared/types'
import type { ToolContext } from '../../src/main/tools/types'

export function makeCtx(workspace: string | null, mutate?: (s: Settings) => void, signal?: AbortSignal): ToolContext {
  const settings = defaultSettings('/tmp/cairn-test-models')
  mutate?.(settings)
  return {
    conversationId: 'c1',
    runId: 'r1',
    toolCallId: 't1',
    workspace,
    settings,
    signal: signal ?? new AbortController().signal,
    conversation: { id: 'c1', title: 't', createdAt: 0, updatedAt: 0, toolsEnabled: true, params: {}, messages: [] },
    services: { imageAvailable: () => false, generateImage: async () => [] },
    progress() {}
  }
}
