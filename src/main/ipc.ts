import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { IpcInvokeMap, InvokeChannel } from '@shared/ipc'
import type { Conversation } from '@shared/types'
import { cleanEnhanced, ENHANCE_SYSTEM } from './agent/enhance'
import { completeText } from './agent/complete'
import { detectGpus } from './engines/gpu'
import { civitaiSearch, hfFiles, hfSearch } from './engines/hub'
import { llmRoots } from './engines/local-provider'
import { scanImageWeights } from './engines/library'
import type { Services } from './services'
import { runCustomTool } from './tools/custom'
import { isInside } from './tools/sandbox'
import type { ToolContext } from './tools/types'
import { emit } from './events'
import { generateApiKey } from './server/api'
import { safeFileName } from './util/fsx'

/** Everything the handlers need from the host shell (Electron in the app, stubs in tests). */
export interface PlatformApi {
  appVersion: string
  isPackaged: boolean
  home: string
  selectFolder(title?: string): Promise<string | null>
  selectFile(title?: string, extensions?: string[], defaultPath?: string): Promise<string | null>
  saveFile(defaultName: string, extensions: string[]): Promise<string | null>
  openPath(p: string): Promise<void>
  showItem(p: string): void
  openExternal(url: string): Promise<void>
  setTitleBar(colors: { color: string; symbolColor: string }): void
}

export type Handlers = {
  [K in InvokeChannel]: (...args: IpcInvokeMap[K]['args']) => Promise<IpcInvokeMap[K]['result']> | IpcInvokeMap[K]['result']
}

const MODEL_FILE_EXT = /\.(gguf|safetensors|ckpt|sft|pt|bin)$/i
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }

/**
 * The folder a file dialog should open in: `hint` under the models directory, made if it is missing
 * (so the user lands there and can drop files in), or the models directory itself.
 */
export async function dialogStart(modelsDir: string, hint?: string): Promise<string | undefined> {
  if (!modelsDir) return undefined
  const parts = (hint ?? '').split(/[\\/]+/).filter((p) => p && p !== '.' && p !== '..')
  for (let n = parts.length; n >= 0; n--) {
    const dir = path.join(modelsDir, ...parts.slice(0, n))
    try {
      await fsp.mkdir(dir, { recursive: true })
      return dir
    } catch {
      /* try the parent */
    }
  }
  return undefined
}

export function buildHandlers(s: Services, platform: PlatformApi): Handlers {
  const settings = () => s.settings.get()

  const modelRoots = () => llmRoots(s.settings.modelsDir(), settings().paths.extraModelDirs)

  /** True when `target` is a model weight file that lives under one of the model folders. */
  const isDeletableModelFile = async (target: string): Promise<boolean> => {
    if (!path.isAbsolute(target) || !MODEL_FILE_EXT.test(target)) return false
    let real: string
    try {
      real = await fsp.realpath(target)
    } catch {
      return false
    }
    for (const root of modelRoots()) {
      let rr = root
      try {
        rr = await fsp.realpath(root)
      } catch {
        continue
      }
      if (real !== rr && isInside(rr, real)) return true
    }
    return false
  }

  const handlers: Handlers = {
    'settings:get': () => settings(),
    'settings:update': (patch) => s.settings.update(patch),

    'models:list': (force) => s.models.list(force),
    'models:test': (id) => s.models.test(id),
    'providers:detect': () => s.models.detectLocalServers(),

    'conversations:list': () => s.conversations.list(),
    'conversations:get': (id) => s.conversations.get(id),
    'conversations:create': (init) => {
      const conv = s.conversations.create({ toolsEnabled: settings().chat.toolsDefault, ...(init ?? {}) })
      emit('conversations:changed', s.conversations.summary(conv))
      return conv
    },
    'conversations:update': (id, patch) => {
      const conv = s.conversations.update(id, patch)
      emit('conversations:changed', s.conversations.summary(conv))
      return conv
    },
    'conversations:delete': async (id) => {
      s.runner.abort(id)
      await s.conversations.delete(id)
    },
    'conversations:truncate': (id, fromMessageId) => {
      if (s.runner.isRunning(id)) throw new Error('Stop the current response first.')
      return s.conversations.truncateFrom(id, fromMessageId)
    },
    'conversations:search': (q) => s.conversations.search(q),
    'conversations:export': async (id) => {
      const conv = s.conversations.get(id)
      if (!conv) return null
      const dest = await platform.saveFile(`${safeFileName(conv.title) || 'chat'}.md`, ['md'])
      if (!dest) return null
      await fsp.writeFile(dest, s.conversations.exportMarkdown(id), 'utf8')
      return dest
    },

    'chat:send': (req) => s.runner.send(req),
    'chat:regenerate': (id) => s.runner.regenerate(id),
    'chat:abort': (id) => s.runner.abort(id),
    'chat:compact': (id) => s.runner.compactNow(id),
    'chat:uncompact': (id) => s.runner.uncompact(id),
    'chat:approve': (approvalId, decision) => {
      s.approvals.resolve(approvalId, decision)
    },
    'chat:active': () => s.runner.activeIds(),
    'chat:enhance': async (prompt) => {
      const text = prompt.trim()
      if (!text) return prompt
      const resolved = await s.models.resolve(settings().defaultModel)
      if (!resolved) throw new Error('Choose a chat model first (the one in the composer) so it can rewrite your prompt.')
      const raw = await completeText(resolved.provider, resolved.option.id, ENHANCE_SYSTEM, text.slice(0, 2000), { maxTokens: 220, temperature: 0.7, timeoutMs: 90_000 })
      return cleanEnhanced(raw, text)
    },

    'tools:list': () => s.tools.entries(s.images.available()).map((e) => e.info),
    'tools:test': async (tool, args) => {
      const st = settings()
      const conversation: Conversation = { id: 'tool-test', title: 'Tool test', createdAt: 0, updatedAt: 0, toolsEnabled: true, params: {}, messages: [] }
      const ctx: ToolContext = {
        conversationId: conversation.id,
        runId: 'tool-test',
        toolCallId: 'tool-test',
        workspace: st.agent.workspace || null,
        settings: st,
        signal: AbortSignal.timeout(120_000),
        conversation,
        services: { imageAvailable: () => false, generateImage: async () => [] },
        progress() {}
      }
      const started = Date.now()
      const res = await runCustomTool(tool, args, ctx).catch((e: unknown) => ({ content: e instanceof Error ? e.message : String(e), isError: true }))
      return { ok: !res.isError, output: res.content, durationMs: Date.now() - started }
    },
    'mcp:status': () => s.mcp.status(),
    'mcp:reconnect': (id) => s.mcp.reconnect(id),

    'server:status': () => s.api.status(),
    'server:models': () => s.api.describeModels(),
    'server:newKey': () => {
      const apiKey = generateApiKey()
      s.settings.update({ server: { ...settings().server, apiKey } })
      return apiKey
    },
    'images:list': () => s.imageStore.list(),
    'images:jobs': () => s.images.listJobs(),
    'images:targets': (force) => s.images.targets(force),
    'images:loras': () => s.images.listLoras(),
    'images:upscalers': () => s.images.listUpscalers(),
    'images:openFolder': async (kind) => {
      const dir = await dialogStart(s.settings.modelsDir(), kind === 'lora' ? 'image/lora' : 'image/upscale')
      if (!dir) throw new Error('The models folder is not set up yet.')
      await platform.openPath(dir)
      return dir
    },
    'images:generate': (req) => ({ jobId: s.images.submit({ ...req, source: 'hub' }).id }),
    'images:cancel': (jobId) => s.images.cancel(jobId),
    'images:delete': (ids) => s.imageStore.remove(ids),
    'images:favorite': (id, fav) => s.imageStore.setFavorite(id, fav),
    'images:reveal': (id) => {
      const rec = s.imageStore.get(id)
      if (rec) platform.showItem(s.imageStore.filePath(rec))
    },
    'images:saveAs': async (id) => {
      const rec = s.imageStore.get(id)
      if (!rec) return null
      const ext = path.extname(rec.file).slice(1)
      const dest = await platform.saveFile(`${safeFileName(rec.prompt).slice(0, 48) || 'image'}.${ext}`, [ext])
      if (!dest) return null
      await fsp.copyFile(s.imageStore.filePath(rec), dest)
      return dest
    },
    'images:toAttachment': async (id) => {
      const rec = s.imageStore.get(id)
      const data = rec ? await s.imageStore.readBytes(id) : null
      if (!rec || !data) return null
      const ext = path.extname(rec.file).slice(1)
      return { name: `${safeFileName(rec.prompt).slice(0, 40) || 'image'}.${ext}`, mime: IMAGE_MIME[ext] ?? 'image/png', data }
    },
    'images:import': (name, data) => s.images.importPicture(name, data),
    'images:setMask': (png) => ({ maskId: s.images.setMask(png) }),
    'images:testBackend': (id) => s.images.testBackend(id),

    'engines:gpu': (force) => detectGpus(force),
    'engines:status': (engine) => s.engines.status(engine),
    'engines:install': (engine, backend) => {
      if (s.engines.isInstalling(engine)) throw new Error('This engine is already being installed.')
      // Long running: progress and failures are reported through 'engines:progress'.
      void s.engines.install(engine, backend).catch(() => {})
    },
    'engines:cancelInstall': (engine) => s.engines.cancelInstall(engine),
    'engines:uninstall': async (engine, buildId) => {
      if (engine === 'llama') await s.llama.stop()
      await s.engines.uninstall(engine, buildId)
    },
    'engines:activate': async (engine, buildId) => {
      if (engine === 'llama') await s.llama.stop()
      s.engines.activate(engine, buildId)
    },
    'llama:status': () => s.llama.status(),
    'llama:start': async (modelPath) => {
      await s.llama.ensure(modelPath)
    },
    'llama:stop': () => s.llama.stop(),

    'library:gguf': () => s.localProvider.scan(true),
    'library:imageWeights': () => scanImageWeights(modelRoots()),
    'library:delete': async (target) => {
      if (!(await isDeletableModelFile(target))) throw new Error('That file is not inside your models folders, so it was left alone.')
      if (s.llama.status().modelPath === target) await s.llama.stop()
      await fsp.rm(target, { force: true })
      const names = settings().local.modelNames ?? {}
      if (target in names) {
        const { [target]: _gone, ...rest } = names
        s.settings.update({ local: { ...settings().local, modelNames: rest } })
      }
      s.localProvider.invalidate()
      s.models.invalidate('local')
    },
    'library:setName': async (target, name) => {
      if (!(await isDeletableModelFile(target))) throw new Error('That file is not inside your models folders.')
      const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
      const names = { ...(settings().local.modelNames ?? {}) }
      if (clean) names[target] = clean
      else delete names[target]
      s.settings.update({ local: { ...settings().local, modelNames: names } })
      s.localProvider.invalidate()
      s.models.invalidate('local')
    },
    'hf:search': (query, kind) => hfSearch(settings(), query, kind),
    'hf:files': (repo) => hfFiles(settings(), repo),
    'civitai:search': (query, type) => civitaiSearch(settings(), query, type),
    'downloads:start': (spec) => s.downloads.start(spec),
    'downloads:cancel': (id) => s.downloads.cancel(id),
    'downloads:list': () => s.downloads.list(),
    'downloads:clear': () => s.downloads.clearFinished(),

    'system:info': () => ({
      platform: process.platform,
      arch: process.arch,
      appVersion: platform.appVersion,
      dataDir: s.paths.data,
      modelsDir: s.settings.modelsDir(),
      home: platform.home,
      isPackaged: platform.isPackaged
    }),
    'system:selectFolder': (title) => platform.selectFolder(title),
    'system:selectFile': async (title, ext, startIn) => platform.selectFile(title, ext, await dialogStart(s.settings.modelsDir(), startIn)),
    'system:openPath': async (p) => {
      // Never launch files (an .exe would run); folders open, files are revealed instead.
      let st: fs.Stats
      try {
        st = await fsp.stat(p)
      } catch {
        throw new Error('That path does not exist.')
      }
      if (st.isDirectory()) await platform.openPath(p)
      else platform.showItem(p)
    },
    'system:showItem': (p) => platform.showItem(p),
    'system:openExternal': async (url) => {
      let u: URL
      try {
        u = new URL(url)
      } catch {
        throw new Error('That is not a valid link.')
      }
      if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) throw new Error('Only web and email links can be opened.')
      await platform.openExternal(u.toString())
    },
    'system:setTitleBar': (colors) => platform.setTitleBar(colors)
  }
  return handlers
}

