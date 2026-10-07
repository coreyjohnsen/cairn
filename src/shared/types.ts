// Shared domain types — imported by main, preload and renderer.
// Keep this file free of runtime dependencies.

/** Same values as OsPlatform, declared here so the renderer does not need Node typings. */
export type OsPlatform = 'aix' | 'android' | 'cygwin' | 'darwin' | 'freebsd' | 'haiku' | 'linux' | 'netbsd' | 'openbsd' | 'sunos' | 'win32'

/* ───────────────────────────── Appearance ───────────────────────────── */

export type ThemeId = 'system' | 'alpenglow' | 'glacier' | 'granite' | 'timberline'

export interface AppearanceSettings {
  theme: ThemeId
  fontScale: number // 0.85 – 1.25
  ridgelines: boolean // decorative mountain backdrops
  reduceMotion: boolean
}

/* ───────────────────────────── Providers / models ───────────────────────────── */

/** openai = any OpenAI-compatible server, anthropic = Anthropic Messages API, local = built-in llama.cpp */
export type ProviderKind = 'openai' | 'anthropic' | 'local'

export interface ModelCaps {
  vision?: boolean
  tools?: boolean
  reasoning?: boolean
}

export interface ProviderModel extends ModelCaps {
  id: string
  name?: string
  contextLength?: number
}

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  enabled: boolean
  preset?: string
  /** Extra HTTP headers (e.g. OpenRouter attribution). */
  headers: Record<string, string>
  /** Models the user typed in by hand (for servers with no /models endpoint). */
  manualModels: ProviderModel[]
  /** Per-model capability overrides keyed by model id. */
  capOverrides: Record<string, ModelCaps>
}

export interface ModelOption {
  /** `${providerId}::${modelId}` */
  ref: string
  providerId: string
  providerName: string
  id: string
  name: string
  caps: ModelCaps
  contextLength?: number
}

export function makeModelRef(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}
export function parseModelRef(ref: string | undefined | null): { providerId: string; modelId: string } | null {
  if (!ref) return null
  const i = ref.indexOf('::')
  if (i < 0) return null
  return { providerId: ref.slice(0, i), modelId: ref.slice(i + 2) }
}

export interface DetectedServer {
  presetId: string
  name: string
  baseUrl: string
  modelCount: number
}

/* ───────────────────────────── Messages / conversations ───────────────────────────── */

export interface Attachment {
  id: string
  kind: 'image' | 'text'
  name: string
  mime: string
  /** File name inside <data>/attachments */
  file: string
  size: number
  /** For text attachments: the extracted text (also inlined into the prompt). */
  text?: string
}

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string exactly as produced by the model. */
  arguments: string
}

/** Light reference to a generated image so chat can render it without a lookup. */
export interface ImageRef {
  id: string
  file: string
  thumb: string
  prompt: string
  width: number
  height: number
}

export interface MessageUsage {
  promptTokens?: number
  completionTokens?: number
  tokensPerSecond?: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  createdAt: number
  content: string
  reasoning?: string
  attachments?: Attachment[]
  /** assistant: tool calls requested */
  toolCalls?: ToolCall[]
  /** tool: which call this answers */
  toolCallId?: string
  toolName?: string
  isError?: boolean
  /** tool call was refused by the user */
  denied?: boolean
  images?: ImageRef[]
  status?: 'streaming' | 'done' | 'aborted' | 'error'
  error?: string
  /** Model that produced an assistant message (display name). */
  model?: string
  durationMs?: number
  usage?: MessageUsage
  /** Informational line shown in the transcript (never sent to the model). */
  notice?: string
}

/** Whether a reasoning model should think before answering. `auto` leaves the model's own default alone. */
export type ThinkingMode = 'auto' | 'on' | 'off'

export interface ConversationParams {
  temperature?: number
  topP?: number
  maxTokens?: number
  /** Overrides the default from Settings. */
  thinking?: ThinkingMode
}

export interface ImageTarget {
  backendId: string
  model: string
}

/** One line of the record of what the assistant did with tools, kept after the messages themselves are summarized away. */
export interface LedgerEntry {
  /** read file, wrote or edited a file, ran a command, searched, used the web, anything else, was declined by the user */
  k: 'read' | 'wrote' | 'cmd' | 'find' | 'web' | 'misc' | 'denied'
  /** The file, command, search or call this is about. */
  t: string
  /** How many times it happened. */
  n: number
  /** Outcome, such as "exit 1", "failed" or "lines 1-200". */
  note?: string
}

/**
 * What stands in for the older part of a long chat once it has been summarized, so the model's memory does not fill up.
 * The messages themselves are kept and shown; only what the model is sent changes.
 */
export interface Compaction {
  /** The model's own account of the goal, what is done, what was learned and what is next. Empty when it could not write one. */
  narrative: string
  /** What was asked of the assistant lately, word for word (shortened). */
  asks: string[]
  /** Every tool call made, listed from the messages rather than written by the model, so it cannot be wrong or forgotten. */
  ledger: LedgerEntry[]
  /** Messages up to and including this one are replaced by the summary. */
  upToMessageId: string
  /** How much it stands in for, over every time the chat was summarized. */
  messages: number
  toolCalls: number
  /** Rough size of the model's view of the chat before and after, in tokens. */
  tokensBefore: number
  tokensAfter: number
  createdAt: number
  /** `model` when the model wrote the narrative; `ledger` when only the list of tool calls could be kept. */
  source: 'model' | 'ledger'
  /** How many times the summary has been rolled forward. */
  rounds: number
}

/** How full the model's memory was at its last request. */
export interface ContextUsage {
  /** Tokens in the request, as the server counted them when it said, otherwise estimated. */
  used: number
  /** The model's context size. */
  window: number
  at: number
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned?: boolean
  titleSet?: boolean
  modelRef?: string
  systemPrompt?: string
  workspace?: string
  toolsEnabled: boolean
  imageTarget?: ImageTarget
  params: ConversationParams
  messages: ChatMessage[]
  /** Set once the older part of the chat has been summarized for the model. */
  compaction?: Compaction
  contextUsage?: ContextUsage
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned?: boolean
  messageCount: number
  preview: string
}

export type ConversationPatch = Partial<
  Pick<
    Conversation,
    'title' | 'modelRef' | 'systemPrompt' | 'workspace' | 'toolsEnabled' | 'imageTarget' | 'params' | 'pinned'
  >
>

export interface AttachmentInput {
  name: string
  mime: string
  data: Uint8Array
}

/* ───────────────────────────── Chat run events ───────────────────────────── */

export type ApprovalKind = 'write' | 'edit' | 'delete' | 'move' | 'command' | 'network' | 'generic'

export interface ApprovalRequest {
  id: string
  toolCallId: string
  toolName: string
  source: 'builtin' | 'custom' | 'mcp'
  kind: ApprovalKind
  title: string
  path?: string
  command?: string
  cwd?: string
  /** Unified diff-ish preview (edit/write). */
  diff?: string
  args: unknown
  /** Why approval is required (e.g. outside workspace). */
  reason?: string
}

export type ApprovalDecision = 'allow' | 'allow-chat' | 'always' | 'deny'

export type ChatEvent =
  | { type: 'run-start'; runId: string; conversationId: string }
  | { type: 'message'; runId: string; conversationId: string; message: ChatMessage }
  | { type: 'delta'; runId: string; conversationId: string; messageId: string; content?: string; reasoning?: string }
  | { type: 'tool-progress'; runId: string; conversationId: string; toolCallId: string; label?: string; progress?: number; stage?: ImageStage }
  | { type: 'approval'; runId: string; conversationId: string; approval: ApprovalRequest }
  | { type: 'approval-resolved'; runId: string; conversationId: string; approvalId: string }
  | { type: 'status'; runId: string; conversationId: string; status: string }
  | { type: 'title'; conversationId: string; title: string }
  | { type: 'context'; conversationId: string; usage: ContextUsage }
  | { type: 'compaction'; conversationId: string; compaction?: Compaction }
  | { type: 'run-end'; runId: string; conversationId: string; outcome: 'done' | 'aborted' | 'error'; error?: string }

export interface SendRequest {
  conversationId: string
  text: string
  attachments?: AttachmentInput[]
  /** 'image' sends the text straight to the image generator. */
  mode?: 'chat' | 'image'
  /** Run this reply without tools, whatever the chat says. Set by the host for phones that may not use tools. */
  noTools?: boolean
}

/* ───────────────────────────── Tools ───────────────────────────── */

export type ToolPermission = 'auto' | 'ask' | 'deny'
export type ToolSource = 'builtin' | 'custom' | 'mcp'

export interface ToolInfo {
  name: string
  description: string
  source: ToolSource
  group: string
  permission: ToolPermission
  defaultPermission: ToolPermission
  available: boolean
  unavailableReason?: string
}

export type CustomToolImpl =
  | { type: 'command'; file: string; args: string[]; cwd?: string; timeoutSec: number }
  | { type: 'http'; method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'; url: string; headers: Record<string, string>; body?: string; timeoutSec: number }
  | { type: 'javascript'; code: string; timeoutSec: number }

export interface CustomToolConfig {
  id: string
  name: string
  description: string
  enabled: boolean
  /** JSON Schema (type: object) as a string for easy editing. */
  parameters: string
  permission: ToolPermission
  impl: CustomToolImpl
}

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  url: string
  headers: Record<string, string>
  permission: ToolPermission
}

export interface McpStatus {
  id: string
  state: 'connecting' | 'connected' | 'error' | 'disabled'
  error?: string
  tools: { name: string; description: string }[]
}

export interface ToolTestResult {
  ok: boolean
  output: string
  durationMs: number
}

/* ───────────────────────────── Images ───────────────────────────── */

export type ImageBackendKind = 'builtin' | 'comfyui' | 'a1111' | 'openai'

export interface ImageBackendConfig {
  id: string
  name: string
  kind: ImageBackendKind
  enabled: boolean
  baseUrl: string
  apiKey: string
  /** ComfyUI: custom API-format workflow with {{placeholders}}; empty = built-in default workflow. */
  comfyWorkflow: string
  defaultModel: string
}

export type SdArch = 'sd' | 'sdxl' | 'flux' | 'sd3' | 'zimage' | 'custom'

export interface SdModelConfig {
  id: string
  name: string
  arch: SdArch
  /** Single-file checkpoint (passed as -m). */
  model: string
  /** Diffusion-only weights (Flux / SD3 GGUF etc.) passed as --diffusion-model. */
  diffusionModel: string
  vae: string
  clipL: string
  clipG: string
  t5xxl: string
  /** Language-model text encoder (Z-Image uses Qwen3-4B) passed as --llm. */
  llm: string
  steps: number
  cfg: number
  sampler: string
  width: number
  height: number
  vaeTiling: boolean
  offloadToCpu: boolean
  clipOnCpu: boolean
  flashAttn: boolean
  extraArgs: string
}

/** A LoRA file in the LoRA folder. */
export interface LoraFile {
  /** Folder-relative name without the extension, with forward slashes: what goes in the prompt tag. */
  id: string
  name: string
  path: string
  sizeBytes: number
  /** The kind of model it was made for, when the file says so (or its name suggests it). */
  base?: 'sd' | 'sdxl' | 'flux' | 'sd3'
  baseGuessed?: boolean
  /** Trigger words listed inside the file, most used first. */
  triggers: string[]
}

export interface LoraSelection {
  id: string
  strength: number
  /** Words that wake the LoRA up; put at the start of the prompt. */
  trigger?: string
}

/** An upscaler (ESRGAN-style) file in the upscale folder. */
export interface UpscalerFile {
  path: string
  name: string
  sizeBytes: number
  /** How many times larger it makes the picture, from its name (4 when unclear). */
  scale: number
  /**
   * Which program runs it. 'esrgan' is Real-ESRGAN (ncnn, Vulkan): ncnn models (.param + .bin) work for any picture.
   * 'sd' is stable-diffusion.cpp's own upscaler, which only reliably loads RealESRGAN_x4plus_anime_6B.
   */
  engine: 'esrgan' | 'sd'
  /** What the model was trained on, guessed from its name: general photos and art, or anime and illustration. */
  style: 'general' | 'anime'
  /** Comes with the upscale engine download, so it is not in the upscaler folder. */
  bundled?: boolean
}

export interface UpscaleChoice {
  path: string
  /** Run it this many times in a row (each pass multiplies the size again). */
  repeats?: number
}

/** A saved combination of LoRAs with their strengths and trigger words, applied in one click. */
export interface LoraPreset {
  id: string
  name: string
  loras: LoraSelection[]
}

/** A word or short phrase the user types in an image prompt that is replaced by a longer text when the picture is made. */
export interface PromptAlias {
  id: string
  name: string
  text: string
}

export interface ImageSettings {
  backends: ImageBackendConfig[]
  /** What the user set for each LoRA, keyed by its id. */
  loraMeta?: Record<string, { strength?: number; trigger?: string }>
  /** Named LoRA combinations. */
  loraPresets?: LoraPreset[]
  /** Prompt aliases, expanded in the prompt and the "avoid" text of every picture (Image Hub, chat and tools). */
  aliases?: PromptAlias[]
  /** Steps and guidance the user saved as the default for a model, keyed by `backendId::model`. */
  modelDefaults?: Record<string, { steps?: number; cfg?: number }>
  /** Switch "Upscale when done" on with realesrgan-x4plus whenever that model is installed (Image Hub). On unless turned off. */
  upscaleByDefault?: boolean
  localModels: SdModelConfig[]
  defaultTarget?: ImageTarget
  /** Stop the built-in LLM while the built-in image engine runs, to free VRAM. */
  unloadLlmForImages: boolean
  negativePrompt: string
}

/** How to use a mask that was sent with `images:setMask`. */
export interface InpaintRequest {
  maskId: string
  /** "masked": the engine sees only the masked part plus a margin, at full size; "whole": it sees the whole picture. */
  area: 'masked' | 'whole'
  /** Width of the soft edge where the new part meets the old, in pixels of the starting picture. */
  feather: number
  /** Margin kept around the mask when only the masked part is sent, in pixels of the starting picture. */
  padding: number
}

export interface ImageGenRequest {
  prompt: string
  negativePrompt?: string
  target?: ImageTarget
  width: number
  height: number
  steps?: number
  cfgScale?: number
  /** -1 = random */
  seed: number
  sampler?: string
  count: number
  initImageId?: string
  strength?: number
  /** Repaint only the part of the starting picture a mask marks (built-in engine and AUTOMATIC1111). */
  inpaint?: InpaintRequest
  /** Built-in engine only. */
  loras?: LoraSelection[]
  /** Make the result bigger with an upscaler once it is drawn (built-in engine only). */
  upscale?: UpscaleChoice
  /** Upscale this existing image instead of drawing a new one. */
  upscaleOf?: string
  source: 'hub' | 'chat'
  conversationId?: string
}

export interface ImageRecord {
  id: string
  file: string
  thumb: string
  createdAt: number
  prompt: string
  negativePrompt: string
  backendId: string
  backendName: string
  model: string
  width: number
  height: number
  steps?: number
  cfgScale?: number
  seed: number
  sampler?: string
  durationMs: number
  source: 'hub' | 'chat'
  conversationId?: string
  favorite: boolean
  initImageId?: string
  /** How far this picture was allowed to move away from its starting picture (0.05 to 1). */
  strength?: number
  /** Brought in from a file by the user rather than made by the app. */
  imported?: boolean
  /** Only part of the starting picture was repainted (a mask was used). */
  masked?: boolean
  loras?: LoraSelection[]
  /** Upscaler used (file name), when the picture was made bigger. */
  upscaler?: string
  /** The picture this one is an upscaled copy of. */
  upscaledFrom?: string
}

/** The part of making a picture the engine is working on right now (built-in engine only). */
export type ImageStage = 'loading' | 'encoding' | 'sampling' | 'decoding' | 'upscaling' | 'saving'

/** What a running tool last reported, as shown on its card. */
export interface ToolProgress {
  label?: string
  progress?: number
  stage?: ImageStage
}

export interface ImageJob {
  id: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  request: ImageGenRequest
  /** 0..1 */
  progress: number
  label?: string
  /** Set by engines that report their stages; others only have a label. */
  stage?: ImageStage
  error?: string
  /** The picture was made, but something did not work as asked (shown to the user once). */
  notice?: string
  resultIds: string[]
  createdAt: number
}

export interface ImageTargetOption {
  backendId: string
  backendName: string
  kind: ImageBackendKind
  model: string
  label: string
  supportsImg2Img: boolean
  /** Can repaint just the part of a picture that a mask marks. */
  supportsMask?: boolean
  supportsNegative: boolean
  /** LoRAs and upscalers can be used (built-in engine). */
  supportsLora?: boolean
  defaults?: { width: number; height: number; steps: number; cfg: number; sampler: string }
  /** Built-in engine models: what kind of model it is, and whether decoding is done in tiles. */
  arch?: SdArch
  vaeTiling?: boolean
  available: boolean
  unavailableReason?: string
}

/* ───────────────────────────── Engines / GPU ───────────────────────────── */

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown'
export type EngineBackend = 'cuda' | 'rocm' | 'vulkan' | 'cpu'
export type EngineId = 'llama' | 'sd' | 'esrgan'

export interface GpuDevice {
  vendor: GpuVendor
  name: string
  vramMB?: number
  driver?: string
  /** NVIDIA: highest CUDA version the driver supports, e.g. "12.4" */
  cudaVersion?: string
  /** NVIDIA compute capability, e.g. "8.6" */
  computeCap?: string
}

export interface GpuInfo {
  platform: OsPlatform
  arch: string
  devices: GpuDevice[]
  /** ROCm / HIP runtime appears to be installed. */
  rocmRuntime: boolean
  vulkanRuntime: boolean
  recommended: EngineBackend
  /** Human-readable reasoning shown in the UI. */
  notes: string[]
  cpuThreads: number
  totalRamMB: number
}

export interface InstalledBuild {
  id: string
  engine: EngineId
  tag: string
  backend: EngineBackend
  dir: string
  binary: string
  assetName: string
  installedAt: number
}

export interface EngineStatus {
  engine: EngineId
  builds: InstalledBuild[]
  activeBuildId?: string
  /** Absolute binary currently resolved (custom path or managed build), if any. */
  resolvedBinary?: string
  recommended: EngineBackend
  available: EngineBackend[]
}

export interface EngineInstallProgress {
  engine: EngineId
  phase: 'resolving' | 'downloading' | 'extracting' | 'done' | 'error'
  label: string
  received?: number
  total?: number
  error?: string
}

export interface EngineSettings {
  customPath: string
  backendPref: 'auto' | EngineBackend
  activeBuildId: string
  env: Record<string, string>
}

export interface LocalRuntimeSettings {
  contextSize: number
  /** -1 = all layers (auto) */
  gpuLayers: number
  threads: number
  port: number
  flashAttn: 'auto' | 'on' | 'off'
  /** How the model's working memory (the KV cache) is stored. 8-bit takes about half the video memory of 16-bit, so twice the context fits. Needs flash attention. */
  kvCache: 'f16' | 'q8_0' | 'q4_0'
  /** Mixture-of-experts models: keep the expert weights of this many of the first layers in RAM, the rest on the GPU. 0 = none. */
  nCpuMoe: number
  /** Keep the model's working memory (the KV cache) in RAM instead of video memory. Slower, but lets a much longer context fit. */
  kvInRam: boolean
  /** Settings chosen for one model (by the memory planner), keyed by file path. They replace the ones above for that model only. */
  modelOverrides: Record<string, ModelRuntimeOverride>
  extraArgs: string
  /** Stop the server after this many idle minutes (0 = never). */
  idleUnloadMinutes: number
  /** Last model loaded, restored on demand. */
  lastModelPath: string
  /** Names the user chose for GGUF files, keyed by file path. */
  modelNames: Record<string, string>
}

/** What the planner saved for one model. Anything left out follows the general runtime settings. */
export interface ModelRuntimeOverride {
  contextSize?: number
  gpuLayers?: number
  kvCache?: 'f16' | 'q8_0' | 'q4_0'
  nCpuMoe?: number
  kvInRam?: boolean
}

/** Where the engine actually put the model, read from its own start-up report (in MB). */
export interface LlamaMemoryReport {
  gpuModelMB: number
  gpuCacheMB: number
  gpuComputeMB: number
  cpuModelMB: number
  cpuCacheMB: number
  cpuComputeMB: number
  layersOnGpu?: number
  layersTotal?: number
}

/** Speed of the latest answer from the loaded model, in tokens per second. */
export interface LlamaSpeed {
  generation?: number
  prompt?: number
  at: number
}

/* ───────────── Memory planner ───────────── */

/** What the memory planner needs to know about a model, read from the header of its GGUF file. */
export interface ModelShape {
  arch: string
  name?: string
  /** Size of the whole model on disk (all parts together), in bytes. */
  fileBytes: number
  layers: number
  embedding: number
  heads: number
  kvHeads: number
  headDimK: number
  headDimV: number
  /** Cache values per token per layer for models that compress it (MLA); replaces the head sizes. */
  mlaDim?: number
  /** The longest context the model was trained for. */
  trainedContext: number
  experts: number
  expertsUsed: number
  slidingWindow: number
  /** Which layers only look at a sliding window of recent text, or null when all look at everything. */
  swaLayers: boolean[] | null
  /** Bytes of weights in each layer, and how much of that is the routed experts. */
  layerBytes: number[]
  layerExpertBytes: number[]
  /** Word embeddings (always kept in RAM) and the output layer (reuses the embeddings when tied). */
  embedBytes: number
  outputBytes: number
  outputTied: boolean
  otherBytes: number
  /** The estimate may be off for this kind of model (it is new, or not a plain transformer). */
  rough: boolean
  /** Size of the picture-reading file next to the model, if there is one. */
  mmprojBytes: number
}

/** What this computer offers the planner. */
export interface MemoryHardware {
  /** The engine build that will run the model; null when it is your own binary or not installed. */
  backend: EngineBackend | null
  gpuName: string
  gpuCount: number
  /** Video memory in MB (all cards of the main kind together); 0 without a GPU. */
  vramMB: number
  ramMB: number
  gpuBandwidthGBs: number
  gpuBandwidthKnown: boolean
  ramBandwidthGBs: number
  ramDetail: string
  ramDetected: boolean
  /** Which memory-placement flags the installed llama.cpp understands. */
  flags: { nCpuMoe: boolean; overrideTensor: boolean; noKvOffload: boolean; known: boolean }
}

export type LlamaState = 'stopped' | 'starting' | 'running' | 'error'

export interface LlamaStatus {
  state: LlamaState
  /** What the engine reported about where the model went, once it finished loading. */
  memory?: LlamaMemoryReport
  speed?: LlamaSpeed
  modelPath?: string
  mmprojPath?: string
  port?: number
  pid?: number
  error?: string
  startedAt?: number
  /** Last lines of server output. */
  log: string[]
}

export interface LocalModelFile {
  path: string
  /** File name without the extension. */
  name: string
  /** The name the user gave it (shown instead of `name` when present). */
  label?: string
  sizeBytes: number
  quant?: string
  mmprojPath?: string
  /** Where it was found (library root). */
  root: string
}

export interface ImageWeightFile {
  path: string
  name: string
  sizeBytes: number
  root: string
}

/* ───────────────────────────── Downloads / hubs ───────────────────────────── */

export interface DownloadSpec {
  url: string
  /** Sub-directory under the models dir: 'llm' | 'image' | 'vae' | 'text-encoders' */
  subdir: string
  filename: string
  source: 'hf' | 'civitai' | 'url'
  label?: string
  /** Text models: name to show in the model list once the file has arrived. */
  modelName?: string
}

export interface DownloadItem {
  id: string
  spec: DownloadSpec
  dest: string
  status: 'queued' | 'downloading' | 'done' | 'error' | 'cancelled'
  received: number
  total: number
  error?: string
  speedBps?: number
}

export interface HfModelHit {
  id: string
  downloads: number
  likes: number
  tags: string[]
  updated?: string
}
export interface HfFile {
  path: string
  size: number
  /** Direct download URL (respects the configured Hugging Face endpoint/mirror). */
  url: string
}
export interface CivitaiHit {
  id: number
  name: string
  type: string
  creator?: string
  downloads?: number
  versions: {
    id: number
    name: string
    baseModel?: string
    files: { id: number; name: string; sizeKB: number; downloadUrl: string; format?: string; primary?: boolean }[]
  }[]
}

/* ───────────────────────────── Settings ───────────────────────────── */

export interface ChatSettings {
  systemPrompt: string
  temperature: number
  topP: number
  /** 0 = provider default */
  maxTokens: number
  autoTitle: boolean
  /** Most tool calls one request may chain before it stops. 0 = no limit. */
  maxAgentSteps: number
  /** Longest tool result sent to the model, in characters. 0 = no limit. */
  toolOutputLimit: number
  toolsDefault: boolean
  detectImageIntent: boolean
  sendOnEnter: boolean
  /** Soft context budget (tokens) used to trim long chats; 0 = auto for local, unlimited otherwise. */
  contextBudget: number
  /** Summarize the older part of a chat when the model's memory is nearly full, instead of dropping it. */
  autoCompact: boolean
  /** How full the memory may get before that happens, as a percent of the room for the conversation. */
  compactAt: number
  /** Default for new chats; each chat can override it from the message box. */
  thinking: ThinkingMode
}

export interface AgentSettings {
  workspace: string
  allowOutsideWorkspace: boolean
  autoApproveAll: boolean
  toolPermissions: Record<string, ToolPermission>
  shell: 'auto' | 'powershell' | 'cmd' | 'bash' | 'sh'
  shellTimeoutSec: number
  searxngUrl: string
}

export interface PathSettings {
  modelsDir: string
  extraModelDirs: string[]
  hfEndpoint: string
  hfToken: string
  civitaiToken: string
}

export interface Settings {
  version: number
  appearance: AppearanceSettings
  providers: ProviderConfig[]
  defaultModel: string
  chat: ChatSettings
  agent: AgentSettings
  customTools: CustomToolConfig[]
  mcpServers: McpServerConfig[]
  engines: { llama: EngineSettings; sd: EngineSettings; esrgan: EngineSettings }
  local: LocalRuntimeSettings
  image: ImageSettings
  server: ServerSettings
  remote: RemoteSettings
  paths: PathSettings
  onboardingDismissed: boolean
}

/* ───────────────────────────── API server ───────────────────────────── */

/** Lets other programs use the models on this computer through an OpenAI-compatible web address. */
export interface ServerSettings {
  /** Run the server (and start it again whenever Cairn starts). */
  enabled: boolean
  /** 'local' only accepts programs on this computer; 'network' also accepts other devices on the network. */
  access: 'local' | 'network'
  port: number
  /** Programs must send the key. Always on when the server is open to the network. */
  requireKey: boolean
  apiKey: string
  /** Web pages (origins such as https://example.com, or *) that may call the server from a browser. */
  allowedOrigins: string[]
  /** Share every model. When off, only the chosen ones are shared. */
  exposeAll: boolean
  /** Chat models shared when `exposeAll` is off: GGUF file paths. */
  chatModels: string[]
  /** Image models shared when `exposeAll` is off: built-in image model ids. */
  imageModels: string[]
}

export interface ServerModelInfo {
  /** The name other programs use in the "model" field. */
  id: string
  type: 'chat' | 'image'
  name: string
  /** What is stored in the settings lists: the GGUF path (chat) or the image model id. */
  key: string
  exposed: boolean
  /** Image models only: false while the image engine or the model is missing. */
  available: boolean
  detail?: string
}

export interface ServerLogEntry {
  id: number
  at: number
  method: string
  path: string
  model?: string
  status: number
  ms: number
  client: string
  tokens?: number
  error?: string
}

export type ServerState = 'stopped' | 'starting' | 'running' | 'error'

export interface ServerStatus {
  state: ServerState
  error?: string
  port?: number
  /** Addresses other programs can use as the base URL, ending in /v1. */
  urls: string[]
  active: number
  total: number
  startedAt?: number
  recent: ServerLogEntry[]
}

/* ───────────────────────────── Companion (phones and tablets) ───────────────────────────── */

/** Lets paired phones and tablets use this computer's chats, pictures and models from a web page. */
export interface RemoteSettings {
  /** Serve the companion web app (and start again whenever Cairn starts). */
  enabled: boolean
  port: number
  /** An address to put in the QR code instead of the detected ones, for a Tailscale name, a tunnel or a domain. */
  publicUrl: string
  /** Stop the computer from sleeping while the companion is on, so the phone can always reach it. */
  keepAwake: boolean
}

/** What a paired device may do besides chatting. Chatting with models is always allowed once paired. */
export interface RemoteScopes {
  /** See and make pictures. */
  images: boolean
  /** Let the assistant use tools (files, commands) in chats started from this device, and answer permission requests. */
  tools: boolean
}

export interface RemoteDevice {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
  /** Where it last connected from. */
  lastAddress?: string
  scopes: RemoteScopes
  /** Has the live connection open right now. */
  online: boolean
}

export interface RemoteAddress {
  /** "Home Wi-Fi", "Tailscale", "Your address". */
  label: string
  /** The page a phone opens, such as http://192.168.1.20:8742 */
  url: string
  kind: 'lan' | 'tailscale' | 'custom'
}

export type RemoteState = 'stopped' | 'starting' | 'running' | 'error'

export interface RemoteStatus {
  state: RemoteState
  error?: string
  port?: number
  addresses: RemoteAddress[]
  devices: RemoteDevice[]
  /** The computer is being kept awake right now. */
  awake: boolean
  /** The companion web app has not been built yet (a development checkout), so phones would see nothing. */
  missingClient: boolean
}

/** A one-time pairing offer shown on this computer: scan the code or type it on the phone. */
export interface RemotePairing {
  /** The code in its short form, "K7QM-4TXD". */
  code: string
  expiresAt: number
  /** One link per address; the phone's own camera opens it and signs in. */
  links: { label: string; kind: RemoteAddress['kind']; url: string }[]
}

/* ───────────────────────────── System ───────────────────────────── */

export interface SystemInfo {
  platform: OsPlatform
  arch: string
  appVersion: string
  dataDir: string
  modelsDir: string
  home: string
  isPackaged: boolean
}
