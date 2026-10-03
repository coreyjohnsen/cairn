import type {
  ImageBackendConfig,
  ProviderConfig,
  ProviderKind,
  SdModelConfig,
  ServerSettings,
  Settings,
  ToolPermission
} from './types'

export const SETTINGS_VERSION = 1
export const LOCAL_PROVIDER_ID = 'local'
export const BUILTIN_IMAGE_BACKEND_ID = 'builtin'

export const DEFAULT_SYSTEM_PROMPT =
  'You are a capable, thoughtful AI assistant running inside Cairn, a desktop app on the user\'s own computer. ' +
  'Be direct, accurate and concise. Use Markdown when it improves readability. If you are unsure, say so instead of guessing.'

export interface ProviderPreset {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  needsKey: boolean
  local?: boolean
  note?: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'ollama', name: 'Ollama', kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false, local: true, note: 'Local models served by Ollama' },
  { id: 'lmstudio', name: 'LM Studio', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', needsKey: false, local: true, note: 'Enable the local server in LM Studio' },
  { id: 'llamacpp', name: 'llama.cpp server', kind: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', needsKey: false, local: true, note: 'Your own llama-server instance' },
  { id: 'koboldcpp', name: 'KoboldCpp', kind: 'openai', baseUrl: 'http://127.0.0.1:5001/v1', needsKey: false, local: true },
  { id: 'vllm', name: 'vLLM', kind: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', needsKey: false, local: true },
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', needsKey: true },
  { id: 'gemini', name: 'Google Gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, note: 'One key, hundreds of models' },
  { id: 'groq', name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true },
  { id: 'together', name: 'Together AI', kind: 'openai', baseUrl: 'https://api.together.xyz/v1', needsKey: true },
  { id: 'mistral', name: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', needsKey: true },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', needsKey: true },
  { id: 'xai', name: 'xAI', kind: 'openai', baseUrl: 'https://api.x.ai/v1', needsKey: true },
  { id: 'custom', name: 'Custom (OpenAI-compatible)', kind: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', needsKey: false }
]

export function newId(prefix = ''): string {
  const rnd = Math.random().toString(36).slice(2, 10)
  return `${prefix}${Date.now().toString(36)}${rnd}`
}

export function makeProvider(preset: ProviderPreset, id?: string): ProviderConfig {
  return {
    id: id ?? newId('prov_'),
    name: preset.name,
    kind: preset.kind,
    baseUrl: preset.baseUrl,
    apiKey: '',
    enabled: true,
    preset: preset.id,
    headers: {},
    manualModels: [],
    capOverrides: {}
  }
}

export function defaultLocalProvider(): ProviderConfig {
  return {
    id: LOCAL_PROVIDER_ID,
    name: 'This computer (llama.cpp)',
    kind: 'local',
    baseUrl: '',
    apiKey: '',
    enabled: true,
    headers: {},
    manualModels: [],
    capOverrides: {}
  }
}

export function defaultImageBackends(): ImageBackendConfig[] {
  return [
    {
      id: BUILTIN_IMAGE_BACKEND_ID,
      name: 'Built-in (stable-diffusion.cpp)',
      kind: 'builtin',
      enabled: true,
      baseUrl: '',
      apiKey: '',
      comfyWorkflow: '',
      defaultModel: ''
    }
  ]
}

export const IMAGE_BACKEND_PRESETS: Omit<ImageBackendConfig, 'id'>[] = [
  { name: 'ComfyUI', kind: 'comfyui', enabled: true, baseUrl: 'http://127.0.0.1:8188', apiKey: '', comfyWorkflow: '', defaultModel: '' },
  { name: 'AUTOMATIC1111 / Forge', kind: 'a1111', enabled: true, baseUrl: 'http://127.0.0.1:7860', apiKey: '', comfyWorkflow: '', defaultModel: '' },
  { name: 'OpenAI Images', kind: 'openai', enabled: true, baseUrl: 'https://api.openai.com/v1', apiKey: '', comfyWorkflow: '', defaultModel: 'gpt-image-1' }
]

export function blankSdModel(arch: SdModelConfig['arch'] = 'sdxl'): SdModelConfig {
  const base: SdModelConfig = {
    id: newId('sd_'),
    name: 'New image model',
    arch,
    model: '',
    diffusionModel: '',
    vae: '',
    clipL: '',
    clipG: '',
    t5xxl: '',
    llm: '',
    steps: 25,
    cfg: 7,
    sampler: 'euler_a',
    width: 1024,
    height: 1024,
    vaeTiling: false,
    offloadToCpu: false,
    clipOnCpu: false,
    flashAttn: false,
    extraArgs: ''
  }
  switch (arch) {
    case 'sd':
      return { ...base, steps: 25, cfg: 7, width: 512, height: 512 }
    case 'sdxl':
      return { ...base, steps: 25, cfg: 7, width: 1024, height: 1024, vaeTiling: true }
    case 'flux':
      return { ...base, steps: 20, cfg: 1, sampler: 'euler', width: 1024, height: 1024, vaeTiling: true, clipOnCpu: true }
    case 'sd3':
      return { ...base, steps: 28, cfg: 4.5, sampler: 'euler', width: 1024, height: 1024, vaeTiling: true }
    case 'zimage':
      // Z-Image Turbo is distilled: 8 steps, no classifier-free guidance.
      return { ...base, steps: 8, cfg: 1, sampler: 'euler', width: 1024, height: 1024 }
    default:
      return base
  }
}

export const SD_SAMPLERS = ['euler_a', 'euler', 'heun', 'dpm2', 'dpm++2s_a', 'dpm++2m', 'dpm++2mv2', 'lcm'] as const

export const SIZE_PRESETS: { label: string; w: number; h: number }[] = [
  { label: 'Square', w: 1024, h: 1024 },
  { label: 'Portrait', w: 832, h: 1216 },
  { label: 'Landscape', w: 1216, h: 832 },
  { label: 'Wide', w: 1344, h: 768 },
  { label: 'Tall', w: 768, h: 1344 },
  { label: 'SD 512', w: 512, h: 512 },
  { label: 'SD 512×768', w: 512, h: 768 },
  { label: 'SD 768×512', w: 768, h: 512 }
]

/** Default permission by tool name (anything not listed asks). */
export const BUILTIN_TOOL_DEFAULTS: Record<string, ToolPermission> = {
  list_directory: 'auto',
  read_file: 'auto',
  search_files: 'auto',
  find_files: 'auto',
  write_file: 'ask',
  edit_file: 'ask',
  move_path: 'ask',
  delete_path: 'ask',
  run_command: 'ask',
  fetch_url: 'auto',
  web_search: 'auto',
  generate_image: 'auto'
}

export function defaultServerSettings(): ServerSettings {
  return { enabled: false, access: 'local', port: 8321, requireKey: true, apiKey: '', allowedOrigins: [], exposeAll: true, chatModels: [], imageModels: [] }
}

export function defaultSettings(modelsDir: string): Settings {
  return {
    version: SETTINGS_VERSION,
    appearance: { theme: 'alpenglow', fontScale: 1, ridgelines: true, reduceMotion: false },
    providers: [defaultLocalProvider()],
    defaultModel: '',
    chat: {
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      temperature: 0.7,
      topP: 0.95,
      maxTokens: 0,
      autoTitle: true,
      maxAgentSteps: 25,
      toolOutputLimit: 0,
      toolsDefault: true,
      detectImageIntent: true,
      sendOnEnter: true,
      contextBudget: 0,
      thinking: 'auto'
    },
    agent: {
      workspace: '',
      allowOutsideWorkspace: false,
      autoApproveAll: false,
      toolPermissions: {},
      shell: 'auto',
      shellTimeoutSec: 120,
      searxngUrl: ''
    },
    customTools: [],
    mcpServers: [],
    engines: {
      llama: { customPath: '', backendPref: 'auto', activeBuildId: '', env: {} },
      sd: { customPath: '', backendPref: 'auto', activeBuildId: '', env: {} },
      esrgan: { customPath: '', backendPref: 'auto', activeBuildId: '', env: {} }
    },
    local: {
      contextSize: 8192,
      gpuLayers: -1,
      threads: 0,
      port: 0,
      flashAttn: 'auto',
      extraArgs: '',
      idleUnloadMinutes: 0,
      lastModelPath: '',
      modelNames: {}
    },
    image: {
      backends: defaultImageBackends(),
      loraPresets: [],
      aliases: [],
      modelDefaults: {},
      upscaleByDefault: true,
      localModels: [],
      defaultTarget: undefined,
      unloadLlmForImages: true,
      negativePrompt: 'blurry, low quality, deformed, watermark, text'
    },
    server: defaultServerSettings(),
    paths: {
      modelsDir,
      extraModelDirs: [],
      hfEndpoint: 'https://huggingface.co',
      hfToken: '',
      civitaiToken: ''
    },
    onboardingDismissed: false
  }
}

/** Curated starter downloads for the Library. URLs are plain HTTPS and can be edited by the user. */
export interface StarterPack {
  id: string
  title: string
  blurb: string
  arch: SdModelConfig['arch']
  vramHint: string
  files: { url: string; filename: string; subdir: string; role: 'model' | 'diffusionModel' | 'vae' | 'clipL' | 't5xxl' | 'clipG' | 'llm'; sizeHint: string }[]
  defaults?: Partial<SdModelConfig>
}

export const STARTER_PACKS: StarterPack[] = [
  {
    id: 'sdxl-turbo',
    title: 'SDXL Turbo',
    blurb: 'Fast 1–4 step SDXL. A great first model — works on 6 GB+ GPUs.',
    arch: 'sdxl',
    vramHint: '6 GB+',
    files: [
      {
        url: 'https://huggingface.co/stabilityai/sdxl-turbo/resolve/main/sd_xl_turbo_1.0_fp16.safetensors',
        filename: 'sd_xl_turbo_1.0_fp16.safetensors',
        subdir: 'image',
        role: 'model',
        sizeHint: '6.9 GB'
      }
    ],
    defaults: { steps: 4, cfg: 1, width: 512, height: 512, sampler: 'euler_a' }
  },
  {
    id: 'sd-turbo',
    title: 'SD Turbo',
    blurb: 'Fast one-step SD 2.1 distilled model at 512 px. Light on VRAM.',
    arch: 'sd',
    vramHint: '3 GB+',
    files: [
      {
        url: 'https://huggingface.co/stabilityai/sd-turbo/resolve/main/sd_turbo.safetensors',
        filename: 'sd_turbo.safetensors',
        subdir: 'image',
        role: 'model',
        sizeHint: '5.2 GB'
      }
    ],
    defaults: { steps: 4, cfg: 1, width: 512, height: 512, sampler: 'euler_a' }
  },
  {
    id: 'flux-schnell-q4',
    title: 'FLUX.1 schnell (Q4)',
    blurb: 'High-quality 4-step FLUX in a compact quantisation. Needs the three helper files below.',
    arch: 'flux',
    vramHint: '8 GB+',
    files: [
      {
        url: 'https://huggingface.co/leejet/FLUX.1-schnell-gguf/resolve/main/flux1-schnell-q4_0.gguf',
        filename: 'flux1-schnell-q4_0.gguf',
        subdir: 'image',
        role: 'diffusionModel',
        sizeHint: '6.8 GB'
      },
      {
        url: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/ae.safetensors',
        filename: 'flux-ae.safetensors',
        subdir: 'image/vae',
        role: 'vae',
        sizeHint: '335 MB'
      },
      {
        url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors',
        filename: 'clip_l.safetensors',
        subdir: 'image/text-encoders',
        role: 'clipL',
        sizeHint: '246 MB'
      },
      {
        url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp16.safetensors',
        filename: 't5xxl_fp16.safetensors',
        subdir: 'image/text-encoders',
        role: 't5xxl',
        sizeHint: '9.8 GB'
      }
    ],
    defaults: { steps: 4, cfg: 1, sampler: 'euler', width: 1024, height: 1024, clipOnCpu: true, vaeTiling: true }
  },
  {
    id: 'z-image-turbo-q8',
    title: 'Z-Image Turbo (Q8)',
    blurb: 'Fast 8-step model from Alibaba. This is the highest-quality compact version and sits comfortably on a 16 GB card. Includes the text-encoder file and the FLUX VAE it needs; none of the three downloads needs a login.',
    arch: 'zimage',
    vramHint: '12 GB+',
    files: [
      {
        url: 'https://huggingface.co/leejet/Z-Image-Turbo-GGUF/resolve/main/z_image_turbo-Q8_0.gguf',
        filename: 'z_image_turbo-Q8_0.gguf',
        subdir: 'image',
        role: 'diffusionModel',
        sizeHint: '6.6 GB'
      },
      {
        url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        filename: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        subdir: 'image/text-encoders',
        role: 'llm',
        sizeHint: '2.5 GB'
      },
      {
        url: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors',
        filename: 'flux-ae.safetensors',
        subdir: 'image/vae',
        role: 'vae',
        sizeHint: '335 MB'
      }
    ],
    defaults: { steps: 8, cfg: 1, sampler: 'euler', width: 1024, height: 1024 }
  },
  {
    id: 'z-image-turbo-q4',
    title: 'Z-Image Turbo (Q4)',
    blurb: 'The same model in a smaller file for 6 to 8 GB cards. Slightly less detail than the Q8 version.',
    arch: 'zimage',
    vramHint: '6 GB+',
    files: [
      {
        url: 'https://huggingface.co/leejet/Z-Image-Turbo-GGUF/resolve/main/z_image_turbo-Q4_K.gguf',
        filename: 'z_image_turbo-Q4_K.gguf',
        subdir: 'image',
        role: 'diffusionModel',
        sizeHint: '3.9 GB'
      },
      {
        url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        filename: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        subdir: 'image/text-encoders',
        role: 'llm',
        sizeHint: '2.5 GB'
      },
      {
        url: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors',
        filename: 'flux-ae.safetensors',
        subdir: 'image/vae',
        role: 'vae',
        sizeHint: '335 MB'
      }
    ],
    defaults: { steps: 8, cfg: 1, sampler: 'euler', width: 1024, height: 1024, offloadToCpu: true, vaeTiling: true }
  }
]
