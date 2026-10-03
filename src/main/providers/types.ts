import type { Attachment, ChatMessage, ModelCaps, ProviderModel } from '@shared/types'

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema object */
  parameters: Record<string, unknown>
}

export interface SamplingParams {
  temperature?: number
  topP?: number
  maxTokens?: number
}

export interface LoadedAttachment {
  mime: string
  base64: string
}

export interface ProviderRequest {
  model: string
  system: string
  /** Conversation history, already trimmed to fit. */
  messages: ChatMessage[]
  tools: ToolDef[]
  params: SamplingParams
  /** Undefined leaves the model's own default alone. */
  thinking?: 'on' | 'off'
  /** The real model name when `model` is only a placeholder (the managed local server). */
  modelHint?: string
  signal: AbortSignal
  loadAttachment: (a: Attachment) => Promise<LoadedAttachment | null>
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; args?: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number; tokensPerSecond?: number }
  | { type: 'finish'; reason?: string }

export interface Provider {
  readonly id: string
  listModels(signal?: AbortSignal): Promise<ProviderModel[]>
  stream(req: ProviderRequest): AsyncGenerator<StreamEvent>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public status?: number
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export type CapsInput = ModelCaps
