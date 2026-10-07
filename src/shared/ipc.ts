import type {
  LoraFile,
  UpscalerFile,
  ApprovalDecision,
  ChatEvent,
  CivitaiHit,
  Conversation,
  ConversationPatch,
  ConversationSummary,
  CustomToolConfig,
  DetectedServer,
  DownloadItem,
  DownloadSpec,
  EngineBackend,
  EngineId,
  EngineInstallProgress,
  EngineStatus,
  GpuInfo,
  HfFile,
  HfModelHit,
  ImageGenRequest,
  ImageJob,
  ImageRecord,
  ImageTargetOption,
  ImageWeightFile,
  LlamaStatus,
  ServerModelInfo,
  ServerStatus,
  LocalModelFile,
  McpStatus,
  MemoryHardware,
  ModelOption,
  ModelShape,
  RemotePairing,
  RemoteScopes,
  RemoteDevice,
  RemoteStatus,
  OsPlatform,
  SendRequest,
  Settings,
  SystemInfo,
  ToolInfo,
  ToolTestResult
} from './types'

/** Request/response channels (renderer → main). */
export interface IpcInvokeMap {
  'settings:get': { args: []; result: Settings }
  'settings:update': { args: [patch: Partial<Settings>]; result: Settings }

  'models:list': { args: [force?: boolean]; result: ModelOption[] }
  'models:test': { args: [providerId: string]; result: { ok: boolean; count: number; error?: string } }
  'providers:detect': { args: []; result: DetectedServer[] }

  'conversations:list': { args: []; result: ConversationSummary[] }
  'conversations:get': { args: [id: string]; result: Conversation | null }
  'conversations:create': { args: [init?: ConversationPatch]; result: Conversation }
  'conversations:update': { args: [id: string, patch: ConversationPatch]; result: Conversation }
  'conversations:delete': { args: [id: string]; result: void }
  'conversations:truncate': { args: [id: string, fromMessageId: string]; result: Conversation }
  'conversations:search': { args: [query: string]; result: ConversationSummary[] }
  'conversations:export': { args: [id: string]; result: string | null }

  'chat:send': { args: [req: SendRequest]; result: { runId: string } }
  'chat:regenerate': { args: [conversationId: string, opts?: { noTools?: boolean }]; result: { runId: string } }
  'chat:abort': { args: [conversationId: string]; result: void }
  /** Summarize the older part of the chat now, to free the model's memory. */
  'chat:compact': { args: [conversationId: string]; result: void }
  /** Go back to sending the model the whole chat. */
  'chat:uncompact': { args: [conversationId: string]; result: Conversation | null }
  'chat:approve': { args: [approvalId: string, decision: ApprovalDecision]; result: void }
  'chat:active': { args: []; result: string[] }
  'chat:enhance': { args: [prompt: string]; result: string }

  'tools:list': { args: [conversationId?: string]; result: ToolInfo[] }
  'tools:test': { args: [tool: CustomToolConfig, args: Record<string, unknown>]; result: ToolTestResult }
  'mcp:status': { args: []; result: McpStatus[] }
  'mcp:reconnect': { args: [id: string]; result: void }

  'images:list': { args: []; result: ImageRecord[] }
  'images:jobs': { args: []; result: ImageJob[] }
  'images:loras': { args: []; result: LoraFile[] }
  'images:upscalers': { args: []; result: UpscalerFile[] }
  /** Open (and create if needed) the LoRA or upscaler folder, so files can be dropped in. */
  'images:openFolder': { args: [kind: 'lora' | 'upscale']; result: string }
  'images:targets': { args: [force?: boolean]; result: ImageTargetOption[] }
  'images:generate': { args: [req: ImageGenRequest]; result: { jobId: string } }
  'images:cancel': { args: [jobId: string]; result: void }
  'images:delete': { args: [ids: string[]]; result: void }
  'images:favorite': { args: [id: string, favorite: boolean]; result: void }
  'images:reveal': { args: [id: string]; result: void }
  'images:saveAs': { args: [id: string]; result: string | null }
  'images:toAttachment': { args: [id: string]; result: { name: string; mime: string; data: Uint8Array } | null }
  'images:import': { args: [name: string, data: Uint8Array]; result: ImageRecord }
  'images:setMask': { args: [png: Uint8Array]; result: { maskId: string } }
  'images:testBackend': { args: [backendId: string]; result: { ok: boolean; message: string } }

  'engines:gpu': { args: [force?: boolean]; result: GpuInfo }
  'engines:status': { args: [engine: EngineId]; result: EngineStatus }
  'engines:install': { args: [engine: EngineId, backend: EngineBackend]; result: void }
  'engines:cancelInstall': { args: [engine: EngineId]; result: void }
  'engines:uninstall': { args: [engine: EngineId, buildId: string]; result: void }
  'engines:activate': { args: [engine: EngineId, buildId: string]; result: void }
  'llama:status': { args: []; result: LlamaStatus }
  'server:status': { args: []; result: ServerStatus }
  'server:models': { args: []; result: ServerModelInfo[] }
  'server:newKey': { args: []; result: string }
  'llama:start': { args: [modelPath: string]; result: void }
  /** Reads the layer, cache and expert sizes from a model file's header, for the memory planner. */
  'memory:inspect': { args: [modelPath: string]; result: ModelShape }
  /** Video memory, RAM, their speeds and the memory flags the installed engine understands. */
  'memory:hardware': { args: [force?: boolean]; result: MemoryHardware }
  'llama:stop': { args: []; result: void }

  'library:gguf': { args: []; result: LocalModelFile[] }
  'library:imageWeights': { args: []; result: ImageWeightFile[] }
  'library:delete': { args: [path: string]; result: void }
  /** Give a GGUF file a display name; an empty name goes back to the file name. */
  'library:setName': { args: [path: string, name: string]; result: void }
  'hf:search': { args: [query: string, kind?: 'llm' | 'image']; result: HfModelHit[] }
  'hf:files': { args: [repo: string]; result: HfFile[] }
  'civitai:search': { args: [query: string, type: string]; result: CivitaiHit[] }
  'downloads:start': { args: [spec: DownloadSpec]; result: { id: string } }
  'downloads:cancel': { args: [id: string]; result: void }
  'downloads:list': { args: []; result: DownloadItem[] }
  'downloads:clear': { args: []; result: void }

  'system:info': { args: []; result: SystemInfo }
  'system:selectFolder': { args: [title?: string]; result: string | null }
  /** `startIn` is a folder under the models directory (such as `image/vae`) where the dialog opens. */
  'system:selectFile': { args: [title?: string, extensions?: string[], startIn?: string]; result: string | null }
  'system:openPath': { args: [path: string]; result: void }
  'system:showItem': { args: [path: string]; result: void }
  'system:openExternal': { args: [url: string]; result: void }
  'system:setTitleBar': { args: [colors: { color: string; symbolColor: string }]; result: void }

  /** The companion (phones and tablets): this computer's side. Never offered to a paired device. */
  'remote:status': { args: []; result: RemoteStatus }
  /** Start a one-time pairing offer: a code and links for the QR code. Replaces any earlier offer. */
  'remote:pair': { args: []; result: RemotePairing }
  'remote:cancelPair': { args: []; result: void }
  'remote:updateDevice': { args: [id: string, patch: { name?: string; scopes?: Partial<RemoteScopes> }]; result: RemoteDevice | null }
  'remote:removeDevice': { args: [id: string]; result: void }
}

/** Push channels (main → renderer). */
export interface IpcEventMap {
  'settings:changed': Settings
  'chat:event': ChatEvent
  'images:added': ImageRecord
  'images:updated': ImageRecord
  'images:removed': string[]
  'images:job': ImageJob
  'engines:progress': EngineInstallProgress
  'engines:changed': EngineId
  'llama:status': LlamaStatus
  'server:status': ServerStatus
  'downloads:update': DownloadItem
  'mcp:status': McpStatus[]
  'conversations:changed': ConversationSummary
  /** A chat was deleted. */
  'conversations:removed': string
  'remote:status': RemoteStatus
  /** A phone used the pairing code: close the QR code window. */
  'remote:paired': RemoteDevice
}

export type InvokeChannel = keyof IpcInvokeMap
export type EventChannel = keyof IpcEventMap

export const INVOKE_CHANNELS: InvokeChannel[] = [
  'settings:get',
  'settings:update',
  'models:list',
  'models:test',
  'providers:detect',
  'conversations:list',
  'conversations:get',
  'conversations:create',
  'conversations:update',
  'conversations:delete',
  'conversations:truncate',
  'conversations:search',
  'conversations:export',
  'chat:send',
  'chat:regenerate',
  'chat:abort',
  'chat:compact',
  'chat:uncompact',
  'chat:approve',
  'chat:active',
  'chat:enhance',
  'tools:list',
  'tools:test',
  'mcp:status',
  'mcp:reconnect',
  'images:list',
  'images:jobs',
  'images:targets',
  'images:loras',
  'images:upscalers',
  'images:openFolder',
  'images:generate',
  'images:cancel',
  'images:delete',
  'images:favorite',
  'images:reveal',
  'images:saveAs',
  'images:toAttachment',
  'images:import',
  'images:setMask',
  'images:testBackend',
  'engines:gpu',
  'engines:status',
  'engines:install',
  'engines:cancelInstall',
  'engines:uninstall',
  'engines:activate',
  'llama:status',
  'server:status',
  'server:models',
  'server:newKey',
  'llama:start',
  'memory:inspect',
  'memory:hardware',
  'llama:stop',
  'library:gguf',
  'library:imageWeights',
  'library:delete',
  'library:setName',
  'hf:search',
  'hf:files',
  'civitai:search',
  'downloads:start',
  'downloads:cancel',
  'downloads:list',
  'downloads:clear',
  'system:info',
  'system:selectFolder',
  'system:selectFile',
  'system:openPath',
  'system:showItem',
  'system:openExternal',
  'system:setTitleBar',
  'remote:status',
  'remote:pair',
  'remote:cancelPair',
  'remote:updateDevice',
  'remote:removeDevice'
]

export const EVENT_CHANNELS: EventChannel[] = [
  'settings:changed',
  'chat:event',
  'images:added',
  'images:updated',
  'images:removed',
  'images:job',
  'engines:progress',
  'engines:changed',
  'llama:status',
  'server:status',
  'downloads:update',
  'mcp:status',
  'conversations:changed',
  'conversations:removed',
  'remote:status',
  'remote:paired'
]

export interface CairnApi {
  invoke<K extends InvokeChannel>(channel: K, ...args: IpcInvokeMap[K]['args']): Promise<IpcInvokeMap[K]['result']>
  on<K extends EventChannel>(channel: K, listener: (payload: IpcEventMap[K]) => void): () => void
  platform: OsPlatform
}
