import type {
  ApprovalKind,
  Conversation,
  ImageRef,
  ImageStage,
  Settings,
  ToolPermission,
  ToolSource
} from '@shared/types'

export interface ToolResult {
  content: string
  isError?: boolean
  images?: ImageRef[]
}

export interface ImageToolArgs {
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  steps?: number
  seed?: number
  count?: number
}

export interface ToolServices {
  imageAvailable(): boolean
  generateImage(args: ImageToolArgs, ctx: ToolContext): Promise<ImageRef[]>
}

export interface ToolContext {
  conversationId: string
  runId: string
  toolCallId: string
  /** Absolute workspace folder, or null when none is configured. */
  workspace: string | null
  settings: Settings
  signal: AbortSignal
  conversation: Conversation
  services: ToolServices
  /** Characters this result may take so it fits the model's memory (Infinity when unknown). Use `outputLimitOf(ctx)`. */
  outputLimit?: number
  progress(label?: string, fraction?: number, stage?: ImageStage): void
}

export interface ApprovalPreview {
  kind: ApprovalKind
  title: string
  path?: string
  command?: string
  cwd?: string
  diff?: string
  reason?: string
  /** Ask even when the tool's permission is "auto" (e.g. path outside the workspace). */
  forceApproval?: boolean
}

export interface ToolImpl {
  name: string
  description: string
  /** JSON Schema (type: object) */
  parameters: Record<string, unknown>
  source: ToolSource
  group: string
  defaultPermission: ToolPermission
  /** Validate arguments and describe the action for the approval dialog. May throw to reject early. */
  describe?(args: Record<string, unknown>, ctx: ToolContext): Promise<ApprovalPreview> | ApprovalPreview
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

export class ToolError extends Error {}

export function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key]
  if (typeof v === 'string') return v
  if (v === undefined || v === null) {
    if (required) throw new ToolError(`Missing required argument "${key}"`)
    return ''
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  throw new ToolError(`Argument "${key}" must be a string`)
}

export function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key]
  if (v === undefined || v === null || v === '') return fallback
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new ToolError(`Argument "${key}" must be a number`)
  return n
}

export function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = args[key]
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v.toLowerCase() === 'true'
  return fallback
}
