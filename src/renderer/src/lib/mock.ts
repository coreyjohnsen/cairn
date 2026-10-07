/**
 * Development-only demo backend. When the renderer runs in a plain browser (no Electron),
 * this installs an in-memory `window.cairn` with believable data so every screen can be
 * designed, screenshotted and clicked through. It is never bundled into the packaged app.
 *
 * URL options: ?theme=glacier ?view=images ?tab=local ?platform=win32 ?scenario=empty|onboarding
 */
import type { EventChannel, InvokeChannel, IpcEventMap, IpcInvokeMap } from '@shared/ipc'
import { defaultSettings, newId } from '@shared/defaults'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatEvent,
  ChatMessage,
  Compaction,
  Conversation,
  ConversationSummary,
  DownloadItem,
  ImageJob,
  ImageRecord,
  ImageStage,
  ImageTargetOption,
  LlamaStatus,
  MemoryHardware,
  ModelOption,
  ModelShape,
  RemoteDevice,
  RemoteStatus,
  ServerStatus,
  Settings,
  ToolInfo
} from '@shared/types'
import { BUILTIN_TOOL_DEFAULTS } from '@shared/defaults'
import { ridgeHeights } from '@/components/Ridgeline'

type Handlers = { [K in InvokeChannel]?: (...args: IpcInvokeMap[K]['args']) => IpcInvokeMap[K]['result'] | Promise<IpcInvokeMap[K]['result']> }

const q = new URLSearchParams(location.search)
// ?fast makes the scripted image jobs finish in about a second.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, q.has('fast') ? Math.min(ms, 120) : ms))
const now = Date.now()
const MIN = 60_000
const HOUR = 60 * MIN

/* ───────────── generated mountain pictures ───────────── */

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** A region of a picture, as fractions of its width and height. */
interface Region {
  x: number
  y: number
  w: number
  h: number
}

export function mountainArt(seed: string, w = 512, h = 512, patches: Region[] = []): string {
  const n = hash(seed)
  const hue = [12, 200, 265, 150, 30, 330][n % 6]
  const sky1 = `hsl(${hue} 45% ${18 + (n % 9)}%)`
  const sky2 = `hsl(${(hue + 25) % 360} 70% ${52 + (n % 14)}%)`
  const layers = [0, 1, 2, 3].map((i) => {
    const hs = ridgeHeights(n + i * 101, 60, 0.55)
    const floor = 0.18 + i * 0.1
    const ceil = 0.7 - i * 0.12
    let d = `M0,${h}`
    hs.forEach((v, k) => {
      d += ` L${((k / (hs.length - 1)) * w).toFixed(1)},${(h - (floor + v * (ceil - floor)) * h).toFixed(1)}`
    })
    return `<path d="${d} L${w},${h} Z" fill="hsl(${(hue + 10 * i) % 360} ${40 - i * 6}% ${34 - i * 8}%)" opacity="${0.55 + i * 0.15}"/>`
  })
  const sx = (0.25 + ((n >> 3) % 50) / 100) * w
  // A repainted region: something new and obvious inside the part that was painted.
  const edit = patches.length
    ? `<defs><linearGradient id="au" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5eead4"/><stop offset=".55" stop-color="#a78bfa"/><stop offset="1" stop-color="#f472b6"/></linearGradient><filter id="soft"><feGaussianBlur stdDeviation="${(w * 0.012).toFixed(1)}"/></filter></defs>${patches.map((patch) => `<ellipse cx="${((patch.x + patch.w / 2) * w).toFixed(1)}" cy="${((patch.y + patch.h / 2) * h).toFixed(1)}" rx="${((patch.w / 2) * w).toFixed(1)}" ry="${((patch.h / 2) * h).toFixed(1)}" fill="url(#au)" opacity=".9" filter="url(#soft)"/>`).join('')}`
    : ''
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky1}"/><stop offset="1" stop-color="${sky2}"/></linearGradient><radialGradient id="s"><stop offset="0" stop-color="#fff3d6" stop-opacity=".95"/><stop offset="1" stop-color="#fff3d6" stop-opacity="0"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${sx}" cy="${h * 0.34}" r="${h * 0.16}" fill="url(#s)"/>${layers.join('')}${edit}</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/* ───────────── demo data ───────────── */

const SIZES: [number, number][] = [[1024, 1024], [832, 1216], [1216, 832], [1024, 1024], [1344, 768], [832, 1216], [1024, 1024], [1216, 832]]
const PROMPTS = [
  'A misty alpine lake at first light, snow-capped peaks, soft pink alpenglow, ultra detailed',
  'Lone cabin below a snow-dusted ridge at dawn, smoke from the chimney, volumetric fog',
  'Aerial view of a glacier river braiding through a granite valley, golden hour',
  'Minimalist mountain range at dusk, layered silhouettes in blue and rose, flat illustration',
  'Climber on a knife-edge ridge above the clouds, wind-blown snow, cinematic',
  'Pine forest creeping up a steep slope, low morning cloud, muted green palette',
  'Moonlit peak reflected in a still tarn, stars, long exposure',
  'Prayer flags fluttering on a high pass, Himalayan sunrise, shallow depth of field'
]

/** Which picture a result was repainted from and where, so the demo shows the change. */
const repainted = new Map<string, { from: string; regions: Region[] }>()
const masks = new Map<string, Uint8Array>()

async function maskRegion(png: Uint8Array): Promise<Region | null> {
  const bmp = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }))
  const w = Math.min(bmp.width, 160)
  const h = Math.max(1, Math.round((w * bmp.height) / bmp.width))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(bmp, 0, 0, w, h)
  const d = g.getImageData(0, 0, w, h).data
  let x0 = w
  let y0 = h
  let x1 = 0
  let y1 = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4] > 127) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
    }
  }
  return x1 < x0 ? null : { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h }
}

const records: ImageRecord[] = Array.from({ length: 14 }, (_, i) => {
  const [width, height] = SIZES[i % SIZES.length]
  return {
    id: `img_demo${i}`,
    file: `img_demo${i}.png`,
    thumb: `img_demo${i}.jpg`,
    createdAt: now - i * 47 * MIN,
    prompt: PROMPTS[i % PROMPTS.length],
    negativePrompt: 'blurry, low quality, deformed, watermark, text',
    backendId: 'builtin',
    backendName: 'Built-in (stable-diffusion.cpp)',
    model: 'SDXL Turbo',
    width,
    height,
    steps: 4,
    cfgScale: 1,
    seed: 1_000_000 + i * 7919,
    sampler: 'euler_a',
    durationMs: 4200 + i * 310,
    source: i % 4 === 1 ? 'chat' : 'hub',
    favorite: i % 5 === 0,
    conversationId: i % 4 === 1 ? 'c_demo1' : undefined
  }
})

const emptyScenario = q.get('scenario') === 'empty' || q.get('scenario') === 'onboarding'
const onboarding = q.get('scenario') === 'onboarding'

const LOCAL = 'local'
const modelsAll: ModelOption[] = onboarding
  ? []
  : [
      { ref: `${LOCAL}::/models/llm/Qwen3-8B-Q4_K_M.gguf`, providerId: LOCAL, providerName: 'This computer (llama.cpp)', id: '/models/llm/Qwen3-8B-Q4_K_M.gguf', name: 'Qwen3-8B-Q4_K_M', caps: { tools: true, reasoning: true }, contextLength: 32768 },
      { ref: `${LOCAL}::/models/llm/gemma-3-12b-it-Q4_K_M.gguf`, providerId: LOCAL, providerName: 'This computer (llama.cpp)', id: '/models/llm/gemma-3-12b-it-Q4_K_M.gguf', name: 'gemma-3-12b-it-Q4_K_M', caps: { vision: true, tools: false } },
      { ref: 'ollama::llama3.2:3b', providerId: 'ollama', providerName: 'Ollama', id: 'llama3.2:3b', name: 'llama3.2:3b', caps: { tools: true } },
      { ref: 'ollama::qwen2.5-coder:14b', providerId: 'ollama', providerName: 'Ollama', id: 'qwen2.5-coder:14b', name: 'qwen2.5-coder:14b', caps: { tools: true } },
      { ref: 'openai::gpt-4o', providerId: 'openai', providerName: 'OpenAI', id: 'gpt-4o', name: 'gpt-4o', caps: { vision: true, tools: true } }
    ]

const settings: Settings = (() => {
  const s = defaultSettings('/home/corey/.cairn/models')
  s.onboardingDismissed = !onboarding
  s.remote.enabled = q.get('remote') === 'on'
  s.defaultModel = modelsAll[0]?.ref ?? ''
  s.agent.workspace = '/home/corey/projects/alpine-notes'
  s.providers.push(
    { id: 'ollama', name: 'Ollama', kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', enabled: true, preset: 'ollama', headers: {}, manualModels: [], capOverrides: {} },
    { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-demo', enabled: true, preset: 'openai', headers: {}, manualModels: [], capOverrides: {} }
  )
  s.image.localModels.push({ ...(JSON.parse(JSON.stringify({ id: 'sd_demo', name: 'SDXL Turbo', arch: 'sdxl', model: '/models/image/sd_xl_turbo_1.0_fp16.safetensors', diffusionModel: '', vae: '', clipL: '', clipG: '', t5xxl: '', llm: '', steps: 4, cfg: 1, sampler: 'euler_a', width: 1024, height: 1024, vaeTiling: true, offloadToCpu: false, clipOnCpu: false, flashAttn: false, extraArgs: '' })) as Settings['image']['localModels'][number]) })
  s.image.backends.push({ id: 'comfy', name: 'ComfyUI', kind: 'comfyui', enabled: true, baseUrl: 'http://127.0.0.1:8188', apiKey: '', comfyWorkflow: '', defaultModel: '' })
  const theme = q.get('theme')
  if (theme) s.appearance.theme = theme as Settings['appearance']['theme']
  return s
})()

const demoAssistant = (id: string, parts: Partial<ChatMessage>): ChatMessage => ({ id, role: 'assistant', createdAt: now - 12 * MIN, content: '', status: 'done', model: 'Qwen3-8B-Q4_K_M', ...parts })

const conversations = new Map<string, Conversation>()

const DEMO_COMPACTION: Compaction = {
  narrative:
    'Goal: Port the parser module from JavaScript to TypeScript, keeping the existing tests passing and not changing public behaviour.\nDone: Converted src/lexer.js and src/tokens.js to .ts with explicit types and created src/types.ts (Token and AstNode interfaces).\nLearned: src/parser.js builds nodes through a shared helper node(type, props); tests/parser.test.js imports from ../src/parser.js, so import paths must change last. The first npm test failed with TS2345 in src/lexer.ts line 88 (char typed as string | undefined).\nNext: fix that type, convert src/parser.js, update the test imports, run npm test and npm run build.',
  asks: ["Port the parser module to TypeScript and keep the tests green. Don't touch the CLI entry point yet."],
  ledger: [
    { k: 'read', t: 'src/lexer.js', n: 1 },
    { k: 'read', t: 'src/tokens.js', n: 1 },
    { k: 'wrote', t: 'src/types.ts', n: 1, note: 'written' },
    { k: 'cmd', t: 'npm test', n: 1, note: 'exit 1' }
  ],
  upToMessageId: 'pt4',
  messages: 8,
  toolCalls: 4,
  tokensBefore: 9_400,
  tokensAfter: 2_100,
  createdAt: now - 22 * MIN,
  source: 'model',
  rounds: 1
}
function seedConversations(): void {
  if (emptyScenario) return
  const mk = (id: string, title: string, ago: number, extra: Partial<Conversation> = {}): Conversation => ({
    id,
    title,
    createdAt: now - ago,
    updatedAt: now - ago,
    toolsEnabled: true,
    params: {},
    messages: [],
    ...extra
  })
  conversations.set(
    'c_demo0',
    mk('c_demo0', 'Tidy the trail-notes repo', 14 * MIN, {
      workspace: '/home/corey/projects/alpine-notes',
      contextUsage: { used: 3_120, window: 16_384, at: now - 14 * MIN },
      messages: [
        { id: 'm0', role: 'user', createdAt: now - 16 * MIN, content: 'The README is out of date and the sort script has a bug with accented names. Can you fix both?' },
        demoAssistant('m1', {
          reasoning: 'The user wants two changes. I should read the README and the sort script first, then make small targeted edits and run the tests.',
          content: 'I will start by reading both files.',
          toolCalls: [
            { id: 'call_a', name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
            { id: 'call_b', name: 'read_file', arguments: JSON.stringify({ path: 'scripts/sort_names.py' }) }
          ]
        }),
        { id: 'm2', role: 'tool', createdAt: now - 15 * MIN, toolCallId: 'call_a', toolName: 'read_file', content: '# Alpine Notes\n\nTrail notes, sorted by peak.\n\n## Usage\n\n    python sort.py notes/\n' },
        { id: 'm3', role: 'tool', createdAt: now - 15 * MIN, toolCallId: 'call_b', toolName: 'read_file', content: 'def sort_names(names):\n    return sorted(names)\n' },
        demoAssistant('m4', {
          content: 'Found it. `sorted()` compares raw code points, so “Écrins” lands after “Zermatt”. I will sort with a locale-aware key and update the README to match the real script name.',
          toolCalls: [{ id: 'call_c', name: 'edit_file', arguments: JSON.stringify({ path: 'scripts/sort_names.py', old_string: 'return sorted(names)', new_string: 'return sorted(names, key=lambda n: unicodedata.normalize("NFKD", n).casefold())' }) }]
        }),
        { id: 'm5', role: 'tool', createdAt: now - 14 * MIN, toolCallId: 'call_c', toolName: 'edit_file', content: 'Edited scripts/sort_names.py (1 replacement).' },
        demoAssistant('m6', {
          content: 'Both fixes are in:\n\n1. **Sorting** now ignores accents and case, so names order the way people expect.\n2. **README** points at `scripts/sort_names.py`.\n\n```python\nimport unicodedata\n\ndef sort_names(names):\n    return sorted(names, key=lambda n: unicodedata.normalize("NFKD", n).casefold())\n```\n\nWant me to add a test with a few accented peaks?',
          durationMs: 8400,
          usage: { completionTokens: 312, tokensPerSecond: 41.6 }
        })
      ]
    })
  )
  conversations.set(
    'c_demo1',
    mk('c_demo1', 'Poster ideas for the climbing club', 3 * HOUR, {
      messages: [
        { id: 'n0', role: 'user', createdAt: now - 3 * HOUR, content: 'Make me a calm poster image: a mountain range at dusk, layered silhouettes' },
        demoAssistant('n1', { model: 'Image generator', toolCalls: [{ id: 'call_i', name: 'generate_image', arguments: JSON.stringify({ prompt: PROMPTS[3] }) }], durationMs: 5200 }),
        { id: 'n2', role: 'tool', createdAt: now - 3 * HOUR, toolCallId: 'call_i', toolName: 'generate_image', content: `Generated 1 image for the prompt: ${PROMPTS[3]}`, images: [{ id: 'img_demo1', file: 'img_demo1.png', thumb: 'img_demo1.jpg', prompt: PROMPTS[3], width: 832, height: 1216 }] }
      ]
    })
  )
  conversations.set(
    'c_demo2',
    mk('c_demo2', 'Explain quantisation levels', 26 * HOUR, {
      pinned: true,
      messages: [
        { id: 'q0', role: 'user', createdAt: now - 26 * HOUR, content: 'Compare naive recursion, memoization and tabulation, and show the maths.' },
        demoAssistant('q1', {
          content:
            'The naive version recomputes values, so its cost follows $T(n) = T(n-1) + T(n-2) + 1$, which grows like $O(2^n)$. Memoization stores each result once.\n\nThe closed form is\n\n$$F_n = \\frac{\\varphi^n - \\psi^n}{\\sqrt{5}}$$\n\nand with \\( \\varphi = \\frac{1+\\sqrt{5}}{2} \\) it also says why 10 values cost about $5 less than 20 of them in the demo.\n\n### Summary Table: Comparison\n\n| Feature | Naive Recursion | Memoization (Top-Down) | Tabulation (Bottom-Up) |\n|---|---|---|---|\n| Strategy | Solve subproblems repeatedly | Solve subproblems as needed; save result | Solve all subproblems in order |\n| Efficiency | Very Slow ($O(2^n)$) | Fast ($O(n)$) | Fast ($O(n)$) |\n| Memory | Stack space | Table + Stack space | Table only |\n| Analogy | Re-reading a book every time you need a fact. | Reading a book and taking notes so you don\'t have to re-read. | Reading a book page by page and summarizing as you go. |\n'
        })
      ]
    })
  )
  const tc = (id: string, name: string, args: object) => ({ id, name, arguments: JSON.stringify(args) })
  const result = (id: string, callId: string, name: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'tool', createdAt: now - 20 * MIN, toolCallId: callId, toolName: name, content, ...extra })
  conversations.set(
    'c_demo5',
    mk('c_demo5', 'Port the parser to TypeScript', 6 * MIN, {
      workspace: '/home/corey/projects/alpine-notes',
      contextUsage: { used: 11_960, window: 16_384, at: now - 6 * MIN },
      compaction: DEMO_COMPACTION,
      messages: [
        { id: 'p0', role: 'user', createdAt: now - 40 * MIN, content: "Port the parser module to TypeScript and keep the tests green. Don't touch the CLI entry point yet." },
        demoAssistant('p1', { content: 'I will start with the lexer and the shared types.', toolCalls: [tc('pc1', 'read_file', { path: 'src/lexer.js' }), tc('pc2', 'read_file', { path: 'src/tokens.js' })] }),
        result('pt1', 'pc1', 'read_file', '     1\texport function lex(src) { /* … */ }'),
        result('pt2', 'pc2', 'read_file', '     1\texport const TOKENS = { /* … */ }'),
        demoAssistant('p2', { content: 'Creating the shared types first.', toolCalls: [tc('pc3', 'write_file', { path: 'src/types.ts' })] }),
        result('pt3', 'pc3', 'write_file', 'Created src/types.ts (38 lines).'),
        demoAssistant('p3', { toolCalls: [tc('pc4', 'run_command', { command: 'npm test' })] }),
        result('pt4', 'pc4', 'run_command', 'Exit code: 1\nFAIL tests/lexer.test.js\nTS2345: Argument of type string is not assignable…', { isError: true }),
        demoAssistant('p4', { content: 'The failing test is in the lexer. Let me look at around line 88.', toolCalls: [tc('pc5', 'read_file', { path: 'src/lexer.ts', offset: 70, limit: 40 })] }),
        result('pt5', 'pc5', 'read_file', '    70\t…'),
        demoAssistant('p5', { toolCalls: [tc('pc6', 'edit_file', { path: 'src/lexer.ts', old_string: 'const ch = src[i]', new_string: 'const ch: string = src[i]' })] }),
        result('pt6', 'pc6', 'edit_file', 'Edited src/lexer.ts (1 replacement).'),
        demoAssistant('p6', { content: 'Fixed the type. Running the tests again.', toolCalls: [tc('pc7', 'run_command', { command: 'npm test' })] }),
        result('pt7', 'pc7', 'run_command', 'Exit code: 0\n42 passed'),
        demoAssistant('p7', { content: 'The lexer and token files are converted and all 42 tests pass. Next I will convert `src/parser.js`, then update the test imports.', durationMs: 7300, usage: { promptTokens: 11_700, completionTokens: 260, tokensPerSecond: 36.1 } })
      ]
    })
  )
  conversations.set('c_demo3', mk('c_demo3', 'Weekend hut booking email', 3 * 24 * HOUR))
  conversations.set('c_demo4', mk('c_demo4', 'GGUF vs safetensors', 9 * 24 * HOUR))
}
seedConversations()

const summary = (c: Conversation): ConversationSummary => ({
  id: c.id,
  title: c.title,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  pinned: c.pinned,
  messageCount: c.messages.length,
  preview: c.messages.find((m) => m.role === 'user')?.content.slice(0, 80) ?? ''
})

const targets: ImageTargetOption[] = emptyScenario && onboarding
  ? []
  : [
      { backendId: 'builtin', backendName: 'Built-in (stable-diffusion.cpp)', kind: 'builtin', model: 'sd_demo', label: 'SDXL Turbo', supportsImg2Img: true, supportsMask: true, supportsNegative: true, supportsLora: true, defaults: { width: 512, height: 512, steps: 4, cfg: 1, sampler: 'euler_a' }, arch: 'sdxl', vaeTiling: false, available: true },
      { backendId: 'builtin', backendName: 'Built-in (stable-diffusion.cpp)', kind: 'builtin', model: 'sd_demo_15', label: 'Dreamshaper 8 (SD 1.5)', supportsImg2Img: true, supportsMask: true, supportsNegative: true, supportsLora: true, defaults: { width: 512, height: 512, steps: 25, cfg: 7, sampler: 'euler_a' }, arch: 'sd', vaeTiling: false, available: true },
      { backendId: 'comfy', backendName: 'ComfyUI', kind: 'comfyui', model: 'sd_xl_base_1.0.safetensors', label: 'sd_xl_base_1.0', supportsImg2Img: false, supportsNegative: true, available: false, unavailableReason: 'Cannot reach ComfyUI at http://127.0.0.1:8188. Is it running?' }
    ]


/** The parts of an image job as the real engine reports them, with a long decode at the end like a big image has. */
const IMAGE_STEPS: { stage: ImageStage; label: string; fraction: number; ms: number }[] = [
  { stage: 'loading', label: 'Loading model files…', fraction: 0.02, ms: 1800 },
  { stage: 'encoding', label: 'Reading your prompt…', fraction: 0.06, ms: 900 },
  ...[1, 2, 3, 4].map((n) => ({ stage: 'sampling' as const, label: `Sampling · step ${n} of 4${n < 4 ? ` · about ${(4 - n) * 3 + 6}s left` : ''}`, fraction: 0.1 + 0.8 * (n / 4), ms: 900 })),
  { stage: 'decoding', label: 'Decoding the finished image', fraction: 0.9, ms: 7000 },
  { stage: 'saving', label: 'Saving the image…', fraction: 0.99, ms: 400 }
]

const UPSCALE_STEP = { stage: 'upscaling' as ImageStage, label: 'Upscaling the finished image…', fraction: 0.95, ms: 3000 }

const llama: LlamaStatus = { state: 'running', modelPath: q.get('loaded') ? `/models/llm/${q.get('loaded')}.gguf` : '/models/llm/Qwen3-8B-Q4_K_M.gguf', memory: { gpuModelMB: 4980, gpuCacheMB: 1152, gpuComputeMB: 305, cpuModelMB: 290, cpuCacheMB: 0, cpuComputeMB: 17, layersOnGpu: 37, layersTotal: 37 }, speed: { generation: 38.4, prompt: 912, at: now - 2 * MIN }, port: 53211, pid: 4242, startedAt: now - 20 * MIN, log: ['llama_model_loader: loaded meta data with 28 key-value pairs', 'load_tensors: offloaded 37/37 layers to GPU', 'main: server is listening on http://127.0.0.1:53211'] }

/* ───────────── memory planner ───────────── */

const evenly = (n: number, total: number): number[] => Array.from({ length: n }, () => Math.round(total / n))
const flagsOk = { nCpuMoe: true, overrideTensor: true, noKvOffload: true, known: true }

/** The computer the planner sees: ?hw=small (8 GB card, 16 GB RAM), ?hw=cpu (no graphics card), ?hw=big (24 GB card, 64 GB RAM); otherwise a 16 GB card with 32 GB of RAM. */
function memoryHardware(): MemoryHardware {
  const kind = q.get('hw')
  if (kind === 'cpu') return { backend: 'cpu', gpuName: '', gpuCount: 0, vramMB: 0, ramMB: 16384, gpuBandwidthGBs: 0, gpuBandwidthKnown: false, ramBandwidthGBs: 36, ramDetail: 'assumed ordinary dual-channel DDR4', ramDetected: false, flags: flagsOk }
  if (kind === 'small') return { backend: 'vulkan', gpuName: 'NVIDIA GeForce RTX 3060', gpuCount: 1, vramMB: 8192, ramMB: 16384, gpuBandwidthGBs: 360, gpuBandwidthKnown: true, ramBandwidthGBs: 35.8, ramDetail: 'DDR4-3200, 2 sticks', ramDetected: true, flags: flagsOk }
  if (kind === 'big') return { backend: 'cuda', gpuName: 'NVIDIA GeForce RTX 3090', gpuCount: 1, vramMB: 24576, ramMB: 65536, gpuBandwidthGBs: 936, gpuBandwidthKnown: true, ramBandwidthGBs: 62.7, ramDetail: 'DDR5-5600, 2 sticks', ramDetected: true, flags: flagsOk }
  return { backend: 'vulkan', gpuName: 'AMD Radeon RX 6900 XT', gpuCount: 1, vramMB: 16384, ramMB: 32768, gpuBandwidthGBs: 512, gpuBandwidthKnown: true, ramBandwidthGBs: 35.8, ramDetail: 'DDR4-3200, 2 sticks', ramDetected: true, flags: flagsOk }
}

function modelShape(file: string): ModelShape {
  const dense = (layers: number, total: number, over: Partial<ModelShape> = {}): ModelShape => ({
    arch: 'llama', fileBytes: total, layers, embedding: 4096, heads: 32, kvHeads: 8, headDimK: 128, headDimV: 128, trainedContext: 131072, experts: 0, expertsUsed: 0, slidingWindow: 0, swaLayers: null,
    layerBytes: evenly(layers, total * 0.9), layerExpertBytes: new Array(layers).fill(0), embedBytes: total * 0.05, outputBytes: total * 0.05, outputTied: false, otherBytes: 1_000_000, rough: false, mmprojBytes: 0, ...over
  })
  if (/30B-A3B/i.test(file)) return dense(48, 18_600_000_000, { arch: 'qwen3moe', embedding: 2048, kvHeads: 4, trainedContext: 40960, experts: 128, expertsUsed: 8, layerBytes: evenly(48, 17_400_000_000), layerExpertBytes: evenly(48, 16_600_000_000), embedBytes: 350_000_000, outputBytes: 500_000_000 })
  if (/70B/i.test(file)) return dense(80, 42_500_000_000, { embedding: 8192, heads: 64 })
  if (/gemma/i.test(file)) return dense(48, 7_300_000_000, { arch: 'gemma3', embedding: 3840, heads: 16, headDimK: 256, headDimV: 256, slidingWindow: 1024, swaLayers: Array.from({ length: 48 }, (_, i) => i % 6 < 5), outputTied: true, mmprojBytes: 850_000_000 })
  return dense(36, 5_030_000_000, { arch: 'qwen3', embedding: 4096, heads: 32, kvHeads: 8, trainedContext: 40960 })
}

const downloads: DownloadItem[] = onboarding
  ? []
  : [
      { id: 'd1', spec: { url: 'x', subdir: 'llm', filename: 'Qwen3-8B-Q4_K_M.gguf', source: 'hf', label: 'Qwen3-8B-GGUF · Qwen3-8B-Q4_K_M.gguf' }, dest: '/models/llm/Qwen3-8B-Q4_K_M.gguf', status: 'done', received: 5_030_000_000, total: 5_030_000_000 },
      { id: 'd2', spec: { url: 'x', subdir: 'llm', filename: 'gemma-3-12b-it-Q4_K_M.gguf', source: 'hf', label: 'gemma-3-12b-it-GGUF · gemma-3-12b-it-Q4_K_M.gguf' }, dest: '/models/llm/gemma-3-12b-it-Q4_K_M.gguf', status: 'downloading', received: 3_100_000_000, total: 7_300_000_000, speedBps: 48_000_000 }
    ]

const builtinTools: ToolInfo[] = [
  ['list_directory', 'Files', 'List the files in a folder'],
  ['read_file', 'Files', 'Read a text file, optionally a range of lines'],
  ['search_files', 'Files', 'Search file contents with a regular expression'],
  ['find_files', 'Files', 'Find files by name pattern'],
  ['write_file', 'Files', 'Create or overwrite a file'],
  ['edit_file', 'Files', 'Replace an exact piece of text in a file'],
  ['move_path', 'Files', 'Move or rename a file or folder'],
  ['delete_path', 'Files', 'Delete a file or folder'],
  ['run_command', 'Shell', 'Run a shell command in the working folder'],
  ['fetch_url', 'Web', 'Download a web page as readable text'],
  ['web_search', 'Web', 'Search the web'],
  ['generate_image', 'Images', 'Make a picture from a description']
].map(([name, group, description]) => ({ name, group, description, source: 'builtin' as const, permission: BUILTIN_TOOL_DEFAULTS[name] ?? 'ask', defaultPermission: BUILTIN_TOOL_DEFAULTS[name] ?? 'ask', available: true }))

/* ───────────── event bus ───────────── */

const listeners = new Map<string, Set<(p: never) => void>>()
/** What the Serve tab shows: follows the Serve settings, with a few believable requests. */
function serverStatus(): ServerStatus {
  const sv = settings.server
  if (!sv.enabled) return { state: 'stopped', urls: [], active: 0, total: 0, recent: [] }
  const urls = sv.access === 'network' ? [`http://192.168.1.24:${sv.port}/v1`, `http://127.0.0.1:${sv.port}/v1`] : [`http://127.0.0.1:${sv.port}/v1`]
  const at = Date.now()
  return {
    state: 'running',
    port: sv.port,
    urls,
    active: 1,
    total: 3,
    startedAt: at - 8 * MIN,
    recent: [
      { id: 3, at: at - 4_000, method: 'POST', path: '/v1/chat/completions', model: 'Qwen3-8B-Q4_K_M', status: 200, ms: 6200, client: '127.0.0.1', tokens: 212 },
      { id: 2, at: at - 70_000, method: 'POST', path: '/v1/images/generations', model: 'SDXL-Turbo', status: 500, ms: 1800, client: '192.168.1.40', error: 'The image engine is not installed yet (Models → Engines).' },
      { id: 1, at: at - 300_000, method: 'GET', path: '/v1/models', status: 200, ms: 14, client: '127.0.0.1' }
    ]
  }
}

function emit<K extends EventChannel>(channel: K, payload: IpcEventMap[K]): void {
  listeners.get(channel)?.forEach((l) => (l as (p: IpcEventMap[K]) => void)(payload))
}

/* ───────────── phone companion ───────────── */

const remoteDevices: RemoteDevice[] = q.get('devices') === 'none' ? [] : [
  { id: 'd1', name: 'iPhone · Safari', createdAt: Date.now() - 9 * 86_400_000, lastSeenAt: Date.now() - 40_000, lastAddress: '192.168.1.41', scopes: { images: true, tools: false }, online: true },
  { id: 'd2', name: 'Pixel tablet', createdAt: Date.now() - 30 * 86_400_000, lastSeenAt: Date.now() - 3 * 3_600_000, lastAddress: '100.101.4.7', scopes: { images: true, tools: true }, online: false }
]
const remoteAddresses = () => [
  { label: 'Same Wi-Fi', url: `http://192.168.1.24:${settings.remote.port}`, kind: 'lan' as const },
  { label: 'Tailscale · anywhere', url: `http://100.88.12.5:${settings.remote.port}`, kind: 'tailscale' as const }
]
function remoteStatus(): RemoteStatus {
  const on = settings.remote.enabled
  return { state: on ? 'running' : 'stopped', port: on ? settings.remote.port : undefined, addresses: on ? remoteAddresses() : [], devices: remoteDevices.map((d) => ({ ...d })), awake: on && settings.remote.keepAwake, missingClient: false }
}
/** For screenshots: pretend a phone just used the code. */
;(window as unknown as { __demoPaired: () => void }).__demoPaired = () => {
  const d: RemoteDevice = { id: `d${remoteDevices.length + 1}`, name: 'Corey’s iPhone', createdAt: Date.now(), lastSeenAt: Date.now(), lastAddress: '192.168.1.57', scopes: { images: true, tools: false }, online: true }
  remoteDevices.unshift(d)
  emit('remote:paired', d)
  emit('remote:status', remoteStatus())
}
const chatEvent = (e: ChatEvent) => emit('chat:event', e)

/* ───────────── scripted chat runs ───────────── */

const aborts = new Map<string, AbortController>()
const pendingApprovals = new Map<string, (d: ApprovalDecision) => void>()

async function streamText(conv: Conversation, runId: string, msg: ChatMessage, text: string, signal: AbortSignal): Promise<void> {
  const words = text.split(/(?<=\s)/)
  for (let i = 0; i < words.length; i += 3) {
    if (signal.aborted) return
    const chunk = words.slice(i, i + 3).join('')
    chatEvent({ type: 'delta', runId, conversationId: conv.id, messageId: msg.id, content: chunk })
    await sleep(35)
  }
}

async function runChat(conv: Conversation, text: string, mode: 'chat' | 'image' | undefined): Promise<void> {
  const runId = newId('run_')
  const ctl = new AbortController()
  aborts.set(conv.id, ctl)
  chatEvent({ type: 'run-start', runId, conversationId: conv.id })
  const push = (m: ChatMessage) => {
    const i = conv.messages.findIndex((x) => x.id === m.id)
    if (i >= 0) conv.messages[i] = m
    else conv.messages.push(m)
    chatEvent({ type: 'message', runId, conversationId: conv.id, message: { ...m } })
  }
  try {
    const wantsImage = mode === 'image' || text.startsWith('/imagine') || /\b(draw|paint|picture of|image of)\b/i.test(text)
    const wantsFiles = conv.toolsEnabled && /\b(file|edit|fix|readme|script|folder)\b/i.test(text)
    if (wantsImage) {
      const prompt = text.replace(/^\/imagine\s*/, '')
      const callId = newId('call_')
      const a: ChatMessage = { id: newId('m_'), role: 'assistant', createdAt: Date.now(), content: '', status: 'streaming', model: 'Image generator', toolCalls: [{ id: callId, name: 'generate_image', arguments: JSON.stringify({ prompt }) }] }
      push(a)
      for (const step of IMAGE_STEPS) {
        if (ctl.signal.aborted) throw new Error('aborted')
        chatEvent({ type: 'tool-progress', runId, conversationId: conv.id, toolCallId: callId, progress: step.fraction, label: step.label, stage: step.stage })
        await sleep(step.ms)
      }
      const id = newId('img_')
      const rec: ImageRecord = { ...records[0], id, file: `${id}.png`, thumb: `${id}.jpg`, createdAt: Date.now(), prompt, source: 'chat', conversationId: conv.id, favorite: false }
      records.unshift(rec)
      emit('images:added', rec)
      push({ id: newId('m_'), role: 'tool', createdAt: Date.now(), toolCallId: callId, toolName: 'generate_image', content: `Generated 1 image for the prompt: ${prompt}`, images: [{ id, file: rec.file, thumb: rec.thumb, prompt, width: rec.width, height: rec.height }] })
      a.status = 'done'
      a.durationMs = 5100
      push({ ...a })
      return
    }
    if (wantsFiles) {
      const callId = newId('call_')
      const a1: ChatMessage = { id: newId('m_'), role: 'assistant', createdAt: Date.now(), content: '', status: 'streaming', model: 'Qwen3-8B-Q4_K_M', reasoning: '' }
      push(a1)
      chatEvent({ type: 'status', runId, conversationId: conv.id, status: 'Thinking…' })
      await streamText(conv, runId, a1, 'I will update the README so the usage section matches the script.', ctl.signal)
      a1.content = 'I will update the README so the usage section matches the script.'
      a1.toolCalls = [{ id: callId, name: 'edit_file', arguments: JSON.stringify({ path: 'README.md', old_string: 'python sort.py notes/', new_string: 'python scripts/sort_names.py notes/' }) }]
      a1.status = 'done'
      push({ ...a1 })
      const approval: ApprovalRequest = {
        id: newId('appr_'),
        toolCallId: callId,
        toolName: 'edit_file',
        source: 'builtin',
        kind: 'edit',
        title: 'Edit README.md',
        path: '/home/corey/projects/alpine-notes/README.md',
        diff: '@@ README.md @@\n  ## Usage\n \n-    python sort.py notes/\n+    python scripts/sort_names.py notes/',
        args: {}
      }
      chatEvent({ type: 'approval', runId, conversationId: conv.id, approval })
      const decision = await new Promise<ApprovalDecision>((resolve) => {
        pendingApprovals.set(approval.id, resolve)
        ctl.signal.addEventListener('abort', () => resolve('deny'))
      })
      chatEvent({ type: 'approval-resolved', runId, conversationId: conv.id, approvalId: approval.id })
      const denied = decision === 'deny'
      push({ id: newId('m_'), role: 'tool', createdAt: Date.now(), toolCallId: callId, toolName: 'edit_file', content: denied ? 'The user declined this action.' : 'Edited README.md (1 replacement).', isError: denied, denied })
      const a2: ChatMessage = { id: newId('m_'), role: 'assistant', createdAt: Date.now(), content: '', status: 'streaming', model: 'Qwen3-8B-Q4_K_M' }
      push(a2)
      const final = denied ? 'No problem, I left the README alone. Tell me if you would like a different change.' : 'Done. The README now points at `scripts/sort_names.py`.'
      await streamText(conv, runId, a2, final, ctl.signal)
      push({ ...a2, content: final, status: 'done', durationMs: 3100, usage: { completionTokens: 64, tokensPerSecond: 38.2 } })
      return
    }
    const a: ChatMessage = { id: newId('m_'), role: 'assistant', createdAt: Date.now(), content: '', status: 'streaming', model: 'Qwen3-8B-Q4_K_M' }
    push(a)
    const reply =
      'Quantisation stores each weight with fewer bits so a model fits in less memory.\n\n| Level | Bits | Typical use |\n| --- | --- | --- |\n| Q8_0 | 8 | Near-lossless |\n| Q5_K_M | 5 | Great balance |\n| Q4_K_M | 4 | The usual sweet spot |\n\nA quick estimate in Python:\n\n```python\ndef gigabytes(params_b, bits):\n    return params_b * bits / 8\n\nprint(gigabytes(8, 4.5))  # about 4.5 GB\n```\n\nPick the **largest** one that leaves room for the context.'
    await streamText(conv, runId, a, reply, ctl.signal)
    push({ ...a, content: reply, status: ctl.signal.aborted ? 'aborted' : 'done', durationMs: 4100, usage: { completionTokens: 148, tokensPerSecond: 40.3 } })
  } catch {
    /* aborted */
  } finally {
    aborts.delete(conv.id)
    conv.updatedAt = Date.now()
    chatEvent({ type: 'run-end', runId, conversationId: conv.id, outcome: ctl.signal.aborted ? 'aborted' : 'done' })
    emit('conversations:changed', summary(conv))
  }
}

/* ───────────── handlers ───────────── */

const handlers: Handlers = {
  'settings:get': () => settings,
  'settings:update': (patch) => {
    Object.assign(settings, patch)
    if (patch.server) emit('server:status', serverStatus())
    if (patch.remote) setTimeout(() => emit('remote:status', remoteStatus()), 350)
    return { ...settings }
  },
  'server:status': () => serverStatus(),
  'remote:status': () => remoteStatus(),
  'remote:pair': () => {
    const code = 'K7QM4TXD'
    return { code: 'K7QM-4TXD', expiresAt: Date.now() + (q.get('expiring') ? 6_000 : 5 * 60_000), links: remoteAddresses().map((a) => ({ label: a.label, kind: a.kind, url: `${a.url}/#pair=${code}` })) }
  },
  'remote:cancelPair': () => undefined,
  'remote:updateDevice': (id, patch) => {
    const d = remoteDevices.find((x) => x.id === id)
    if (!d) return null
    if (patch.name) d.name = patch.name
    if (patch.scopes) d.scopes = { ...d.scopes, ...patch.scopes }
    emit('remote:status', remoteStatus())
    return { ...d }
  },
  'remote:removeDevice': (id) => {
    const i = remoteDevices.findIndex((x) => x.id === id)
    if (i >= 0) remoteDevices.splice(i, 1)
    emit('remote:status', remoteStatus())
  },
  'server:models': () => {
    const sv = settings.server
    const row = (id: string, name: string, type: 'chat' | 'image', key: string, available = true, detail?: string) => ({ id, name, type, key, exposed: sv.exposeAll || (type === 'chat' ? sv.chatModels : sv.imageModels).includes(key), available, detail })
    return [
      row('Qwen3-8B-Q4_K_M', 'Qwen3 8B', 'chat', '/models/llm/Qwen3-8B-Q4_K_M.gguf', true, 'Q4_K_M'),
      row('Llama-3.2-3B-Instruct', 'Llama 3.2 3B Instruct', 'chat', '/models/llm/Llama-3.2-3B-Instruct-Q8_0.gguf', true, 'Q8_0'),
      row('Qwen2.5-VL-7B', 'Qwen2.5 VL 7B', 'chat', '/models/llm/Qwen2.5-VL-7B.gguf', true, 'Q4_K_M · vision'),
      row('SDXL-Turbo', 'SDXL Turbo', 'image', 'sdxl-turbo', true),
      row('FLUX.1-schnell', 'FLUX.1 schnell', 'image', 'flux-schnell', false, 'The model file is missing.')
    ]
  },
  'server:newKey': () => {
    const apiKey = `cairn-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
    settings.server = { ...settings.server, apiKey }
    emit('settings:changed', { ...settings })
    return apiKey
  },
  'system:info': () => ({ platform: (q.get('platform') ?? 'linux') as 'linux', arch: 'x64', appVersion: '1.0.0', dataDir: '/home/corey/.config/Cairn', modelsDir: settings.paths.modelsDir, home: '/home/corey', isPackaged: false }),
  'models:list': () => modelsAll,
  'models:test': (id) => ({ ok: id !== 'broken', count: modelsAll.filter((m) => m.providerId === id).length }),
  'providers:detect': () => (onboarding ? [{ presetId: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelCount: 4 }] : []),
  'conversations:list': () => [...conversations.values()].map(summary),
  'conversations:get': (id) => conversations.get(id) ?? null,
  'conversations:create': (init) => {
    const c: Conversation = { id: newId('c_'), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), toolsEnabled: true, params: {}, messages: [], ...init }
    conversations.set(c.id, c)
    return c
  },
  'conversations:update': (id, patch) => {
    const c = conversations.get(id)!
    Object.assign(c, patch)
    return c
  },
  'conversations:delete': (id) => void conversations.delete(id),
  'conversations:truncate': (id, from) => {
    const c = conversations.get(id)!
    const i = c.messages.findIndex((m) => m.id === from)
    if (i >= 0) c.messages.splice(i)
    return c
  },
  'conversations:search': (query) => [...conversations.values()].filter((c) => c.title.toLowerCase().includes(query.toLowerCase())).map(summary),
  'conversations:export': () => '/home/corey/Documents/chat.md',
  'chat:send': (req) => {
    const c = conversations.get(req.conversationId)!
    c.messages.push({ id: newId('m_'), role: 'user', createdAt: Date.now(), content: req.text })
    if (c.title === 'New chat') {
      c.title = req.text.slice(0, 40)
      emit('conversations:changed', summary(c))
    }
    void runChat(c, req.text, req.mode)
    return { runId: 'run' }
  },
  'chat:regenerate': () => ({ runId: 'run' }),
  'chat:compact': (id) => {
    const c = conversations.get(id)!
    if (c.messages.length < 4) throw new Error('There is not enough earlier conversation to summarize yet.')
    void (async () => {
      chatEvent({ type: 'run-start', runId: 'sum', conversationId: id })
      chatEvent({ type: 'status', runId: 'sum', conversationId: id, status: 'Summarizing the earlier conversation to free up memory…' })
      await sleep(1600)
      const upTo = c.messages[Math.max(0, c.messages.length - 5)]
      c.compaction = { ...DEMO_COMPACTION, upToMessageId: upTo.id, messages: c.messages.indexOf(upTo) + 1, createdAt: Date.now() }
      c.contextUsage = { used: 5_200, window: c.contextUsage?.window ?? 16_384, at: Date.now() }
      chatEvent({ type: 'status', runId: 'sum', conversationId: id, status: '' })
      chatEvent({ type: 'compaction', conversationId: id, compaction: c.compaction })
      chatEvent({ type: 'context', conversationId: id, usage: c.contextUsage })
      chatEvent({ type: 'run-end', runId: 'sum', conversationId: id, outcome: 'done' })
    })()
  },
  'chat:uncompact': (id) => {
    const c = conversations.get(id) ?? null
    if (c) {
      c.compaction = undefined
      chatEvent({ type: 'compaction', conversationId: id })
    }
    return c
  },
  'chat:abort': (id) => aborts.get(id)?.abort(),
  'chat:approve': (id, d) => pendingApprovals.get(id)?.(d),
  'chat:active': () => [],
  'chat:enhance': async (p) => {
    await sleep(500)
    return `${p}, dramatic volumetric light, intricate detail, soft atmospheric haze, 35mm photograph`
  },
  'tools:list': () => builtinTools,
  'mcp:status': () => [],
  'images:list': () => records,
  'images:jobs': () => [],
  'images:targets': () => targets,
  'images:loras': () => [
    { id: 'pixel_art_xl', name: 'Pixel Art XL', path: '/models/image/lora/pixel_art_xl.safetensors', sizeBytes: 170_000_000, base: 'sdxl', baseGuessed: false, triggers: ['pixel art'] },
    { id: 'styles/ink_wash', name: 'Ink wash landscapes', path: '/models/image/lora/styles/ink_wash.safetensors', sizeBytes: 144_000_000, base: 'sd', baseGuessed: true, triggers: [] },
    { id: 'detail_tweaker', name: 'detail_tweaker', path: '/models/image/lora/detail_tweaker.safetensors', sizeBytes: 9_600_000, triggers: [] }
  ],
  'images:upscalers': () => [
    { path: '/engines/esrgan/models/realesrgan-x4plus.param', name: 'realesrgan-x4plus', sizeBytes: 67_000_000, scale: 4, engine: 'esrgan', style: 'general', bundled: true },
    { path: '/engines/esrgan/models/realesrgan-x4plus-anime.param', name: 'realesrgan-x4plus-anime', sizeBytes: 17_900_000, scale: 4, engine: 'esrgan', style: 'anime', bundled: true },
    { path: '/models/image/upscale/4x-UltraSharp.pth', name: '4x-UltraSharp', sizeBytes: 67_000_000, scale: 4, engine: 'sd', style: 'general' },
    { path: '/models/image/upscale/RealESRGAN_x2plus.pth', name: 'RealESRGAN_x2plus', sizeBytes: 67_000_000, scale: 2, engine: 'sd', style: 'general' }
  ],
  'images:openFolder': (kind) => `/models/image/${kind}`,
  'images:generate': async (req) => {
    const job: ImageJob = { id: newId('job_'), status: 'running', request: { ...req }, progress: 0, resultIds: [], createdAt: Date.now() }
    emit('images:job', { ...job })
    void (async () => {
      const steps = req.upscaleOf ? [UPSCALE_STEP] : req.upscale ? [...IMAGE_STEPS.slice(0, -1), UPSCALE_STEP, IMAGE_STEPS[IMAGE_STEPS.length - 1]] : IMAGE_STEPS
      for (const step of steps) {
        emit('images:job', { ...job, progress: step.fraction, label: step.label, stage: step.stage })
        await sleep(step.ms)
      }
      const factor = req.upscale ? (/2x|x2/i.test(req.upscale.path) ? 2 : 4) ** (req.upscale.repeats ?? 1) : 1
      const from = req.initImageId ? records.find((r) => r.id === req.initImageId) : undefined
      // A repainted picture comes back the size of the original, with only the painted part changed.
      const region = req.inpaint && from ? await maskRegion(masks.get(req.inpaint.maskId) ?? new Uint8Array()).catch(() => null) : null
      const w = (region && from ? from.width : req.width || 1024) * factor
      const h = (region && from ? from.height : req.height || 1024) * factor
      const upscaler = req.upscale ? req.upscale.path.split('/').pop()!.replace(/\.[^.]+$/, '') : undefined
      const made: ImageRecord[] = []
      for (let i = 0; i < (req.upscaleOf ? 1 : Math.max(1, req.count || 1)); i++) {
        const id = newId('img_')
        const rec: ImageRecord = { ...records[0], id, file: `${id}.png`, thumb: `${id}.jpg`, createdAt: Date.now() + i, prompt: req.prompt, width: w, height: h, source: 'hub', favorite: false, seed: req.upscaleOf ? req.seed : Math.floor(Math.random() * 1e9), loras: req.loras, upscaler, upscaledFrom: req.upscaleOf, initImageId: req.initImageId, strength: req.initImageId ? req.strength : undefined }
        records.unshift(rec)
        if (region && from) repainted.set(id, { from: repainted.get(from.id)?.from ?? from.id, regions: [...(repainted.get(from.id)?.regions ?? []), region] })
        made.push(rec)
        emit('images:added', rec)
      }
      emit('images:job', { ...job, status: 'done', progress: 1, resultIds: made.map((r) => r.id) })
    })()
    return { jobId: job.id }
  },
  'images:cancel': () => undefined,
  'images:delete': (ids) => {
    for (const id of ids) {
      const i = records.findIndex((r) => r.id === id)
      if (i >= 0) records.splice(i, 1)
    }
    emit('images:removed', ids)
  },
  'images:favorite': () => undefined,
  'images:reveal': () => undefined,
  'images:saveAs': () => '/home/corey/Pictures/lake.png',
  'images:toAttachment': () => null,
  'images:setMask': (png) => {
    const maskId = newId('mask_')
    masks.set(maskId, png)
    return { maskId }
  },
  'images:import': (name) => {
    const id = newId('img_')
    const rec: ImageRecord = { ...records[0], id, file: `${id}.png`, thumb: `${id}.jpg`, createdAt: Date.now(), prompt: name, negativePrompt: '', backendId: 'import', backendName: 'Imported', model: '', seed: 0, durationMs: 0, favorite: false, imported: true, initImageId: undefined, strength: undefined, loras: undefined }
    records.unshift(rec)
    emit('images:added', rec)
    return rec
  },
  'images:testBackend': (id) => (id === 'comfy' ? { ok: false, message: 'Cannot reach ComfyUI at http://127.0.0.1:8188.' } : { ok: true, message: 'Ready' }),
  'engines:gpu': () => ({
    platform: 'linux',
    arch: 'x64',
    devices: [{ vendor: 'amd', name: 'AMD Radeon RX 6900 XT', vramMB: 16384, driver: 'Mesa 25.1' }],
    rocmRuntime: false,
    vulkanRuntime: true,
    recommended: 'vulkan',
    notes: ['An AMD GPU was found. The Vulkan build works with every recent Radeon without extra drivers.', 'ROCm was not found. Install the ROCm runtime to use HIP builds, which can be faster.'],
    cpuThreads: 24,
    totalRamMB: 65536
  }),
  'engines:status': (engine) =>
    engine === 'llama'
      ? { engine, builds: [{ id: 'llama-b6500-vulkan', engine, tag: 'b6500', backend: 'vulkan', dir: '/engines/llama', binary: '/engines/llama/llama-server', assetName: 'llama-b6500-bin-ubuntu-vulkan-x64.zip', installedAt: now - 5 * 24 * HOUR }], activeBuildId: 'llama-b6500-vulkan', resolvedBinary: '/engines/llama/llama-server', recommended: 'vulkan', available: ['rocm', 'vulkan', 'cpu'] }
      : engine === 'esrgan'
        ? { engine, builds: [{ id: 'esrgan-v0.2.5.0-vulkan', engine, tag: 'v0.2.5.0', backend: 'vulkan', dir: '/engines/esrgan', binary: '/engines/esrgan/realesrgan-ncnn-vulkan', assetName: 'realesrgan-ncnn-vulkan-20220424-ubuntu.zip', installedAt: now - 2 * HOUR }], activeBuildId: 'esrgan-v0.2.5.0-vulkan', resolvedBinary: '/engines/esrgan/realesrgan-ncnn-vulkan', recommended: 'vulkan', available: ['vulkan'] }
        : { engine, builds: [], recommended: 'vulkan', available: ['rocm', 'vulkan', 'cpu'] },
  'engines:install': () => undefined,
  'llama:status': () => llama,
  'llama:start': () => undefined,
  'llama:stop': () => undefined,
  'memory:hardware': () => memoryHardware(),
  'memory:inspect': (file) => modelShape(file),
  'library:setName': (p, name) => {
    const names = { ...(settings.local.modelNames ?? {}) }
    if (name.trim()) names[p] = name.trim()
    else delete names[p]
    settings.local = { ...settings.local, modelNames: names }
  },
  'library:gguf': () =>
    (onboarding
      ? []
      : [
          { path: '/models/llm/Qwen3-8B-Q4_K_M.gguf', name: 'Qwen3-8B-Q4_K_M', sizeBytes: 5_030_000_000, quant: 'Q4_K_M', root: '/models/llm' },
          { path: '/models/llm/gemma-3-12b-it-Q4_K_M.gguf', name: 'gemma-3-12b-it-Q4_K_M', sizeBytes: 7_300_000_000, quant: 'Q4_K_M', mmprojPath: '/models/llm/mmproj.gguf', root: '/models/llm' },
          { path: '/models/llm/model.gguf', name: 'model', sizeBytes: 4_680_000_000, quant: undefined, root: '/models/llm' },
          { path: '/models/llm/Qwen3-30B-A3B-Q4_K_M.gguf', name: 'Qwen3-30B-A3B-Q4_K_M', sizeBytes: 18_600_000_000, quant: 'Q4_K_M', root: '/models/llm' },
          { path: '/models/llm/Llama-3.3-70B-Instruct-Q4_K_M.gguf', name: 'Llama-3.3-70B-Instruct-Q4_K_M', sizeBytes: 42_500_000_000, quant: 'Q4_K_M', root: '/models/llm' }
        ]
    ).map((f) => ({ ...f, label: settings.local.modelNames?.[f.path] || undefined })),
  'library:imageWeights': () => [
    { path: '/models/image/sd_xl_turbo_1.0_fp16.safetensors', name: 'sd_xl_turbo_1.0_fp16.safetensors', sizeBytes: 6_940_000_000, root: '/models/image' },
    { path: '/models/image/juggernautXL_v9.safetensors', name: 'juggernautXL_v9.safetensors', sizeBytes: 6_620_000_000, root: '/models/image' }
  ],
  'hf:search': (query) => [
    { id: 'Qwen/Qwen3-8B-GGUF', downloads: 1_420_000, likes: 380, tags: ['gguf'] },
    { id: 'unsloth/Qwen3-8B-GGUF', downloads: 890_000, likes: 210, tags: ['gguf'] },
    { id: `bartowski/${query}-GGUF`, downloads: 120_000, likes: 64, tags: ['gguf'] }
  ],
  'hf:files': () => [
    { path: 'Qwen3-8B-Q4_K_M.gguf', size: 5_030_000_000, url: 'x' },
    { path: 'Qwen3-8B-Q5_K_M.gguf', size: 5_850_000_000, url: 'x' },
    { path: 'Qwen3-8B-Q8_0.gguf', size: 8_710_000_000, url: 'x' }
  ],
  'civitai:search': () => [],
  'downloads:start': () => ({ id: newId('d_') }),
  'downloads:cancel': () => undefined,
  'downloads:list': () => downloads,
  'downloads:clear': () => undefined,
  'system:selectFolder': () => '/home/corey/projects/alpine-notes',
  'system:selectFile': () => '/models/image/sd_xl_turbo_1.0_fp16.safetensors',
  'system:openPath': () => undefined,
  'system:showItem': () => undefined,
  'system:openExternal': () => undefined,
  'system:setTitleBar': () => undefined
}

export function installMock(): void {
  ;(window as unknown as { __cairnMedia: (kind: string, file: string) => string }).__cairnMedia = (kind, file) => {
    const base = file.replace(/\.[a-z]+$/, '')
    // Draw it in the shape the picture has, so the layouts can be judged with portrait and wide pictures too.
    const rec = records.find((r) => r.file === file || r.thumb === file)
    const aspect = rec ? rec.width / rec.height : 1
    const long = kind === 'thumb' ? 360 : 1024
    const dims: [number, number] = [Math.round(aspect >= 1 ? long : long * aspect), Math.round(aspect >= 1 ? long / aspect : long)]
    const edit = rec ? repainted.get(rec.id) : undefined
    return edit ? mountainArt(edit.from, ...dims, edit.regions) : mountainArt(base, ...dims)
  }
  window.cairn = {
    platform: (q.get('platform') ?? 'linux') as 'linux',
    async invoke(channel, ...args) {
      const h = handlers[channel] as ((...a: unknown[]) => unknown) | undefined
      if (!h) throw new Error(`"${channel}" is not available in the browser demo.`)
      await sleep(40)
      return (await h(...args)) as never
    },
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set()
      set.add(listener as (p: never) => void)
      listeners.set(channel, set)
      return () => set.delete(listener as (p: never) => void)
    }
  }
  // Animate the demo download so progress bars move.
  setInterval(() => {
    const d = downloads[1]
    if (d && d.status === 'downloading') {
      d.received = Math.min(d.total, d.received + 48_000_000 / 2)
      emit('downloads:update', { ...d })
    }
  }, 500)
  // ?platform=win32 draws stand-ins for the window buttons Windows puts over the top-right corner,
  // so the layout can be checked for anything that would end up underneath them.
  if (q.get('platform') === 'win32') {
    const style = document.createElement('style')
    style.textContent = `:root[data-platform='win32']{--caption-w:138px}
.fake-caption{position:fixed;top:0;right:0;width:138px;height:38px;z-index:9999;display:flex;background:#12171c;color:#c8d3d8;font:14px system-ui;pointer-events:none;outline:1px solid rgba(255,255,255,.12)}
.fake-caption span{flex:1;display:grid;place-items:center}.fake-caption span:last-child{background:#c42b1c;color:#fff}`
    document.head.append(style)
    const caption = document.createElement('div')
    caption.className = 'fake-caption'
    caption.innerHTML = '<span>&#8212;</span><span>&#9633;</span><span>&#10005;</span>'
    document.body.append(caption)
  }
  const view = q.get('view')
  const tab = q.get('tab')
  if (view) {
    void import('@/store/app').then(({ useApp }) => useApp.getState().setView(view as 'chat', tab as never))
  }
}
