import path from 'node:path'
import type { Settings, ToolPermission } from '@shared/types'
import { ApprovalManager } from './agent/approvals'
import { ChatRunner } from './agent/runner'
import { AttachmentStore } from './attachments'
import { ConversationStore } from './conversations'
import { DownloadManager } from './engines/downloads'
import { EngineManager } from './engines/manager'
import { LlamaManager } from './engines/llama-server'
import { LocalProvider } from './engines/local-provider'
import { emit } from './events'
import { ImageService } from './images/service'
import { ImageStore } from './images/store'
import { ModelService } from './models'
import { RemoteService, type KeepAwake } from './remote/service'
import { ApiServer, generateApiKey } from './server/api'
import { initPaths, type AppPaths } from './paths'
import { type Cipher, setCipher } from './secrets'
import { SettingsStore } from './settings'
import { McpManager } from './tools/mcp'
import { ToolRegistry } from './tools/registry'

export interface ServiceOptions {
  dataDir: string
  cipher?: Cipher | null
  /** JPEG thumbnail maker (Electron nativeImage in the app). */
  makeThumb?: (data: Uint8Array, maxEdge: number) => Uint8Array | null
  /** Downscaler for attached images (Electron nativeImage in the app). */
  prepareImage?: (data: Uint8Array, mime: string) => { data: Uint8Array; mime: string } | null
  /** Connect configured MCP servers at startup (disabled in tests). */
  startMcp?: boolean
  /** Start the API server when the settings turn it on (disabled in tests). */
  startServer?: boolean
  /** Start the phone companion when the settings turn it on (disabled in tests). */
  startRemote?: boolean
  /** Folder with the built companion web app. */
  remoteClientDir?: string
  appVersion?: string
  /** Stops the computer from sleeping while the companion is on (Electron in the app). */
  keepAwake?: KeepAwake
}

export interface Services {
  paths: AppPaths
  settings: SettingsStore
  conversations: ConversationStore
  models: ModelService
  mcp: McpManager
  tools: ToolRegistry
  approvals: ApprovalManager
  engines: EngineManager
  llama: LlamaManager
  localProvider: LocalProvider
  downloads: DownloadManager
  imageStore: ImageStore
  images: ImageService
  attachments: AttachmentStore
  runner: ChatRunner
  /** Shares the local models with other programs. */
  api: ApiServer
  /** Pairs phones and tablets and serves them the companion web app. */
  remote: RemoteService
  shutdown(): Promise<void>
}

export async function createServices(opts: ServiceOptions): Promise<Services> {
  const paths = initPaths(opts.dataDir)
  setCipher(opts.cipher ?? null)

  const settings = new SettingsStore(paths.settingsFile, paths.defaultModels)
  await settings.load()
  const get = (): Settings => settings.get()

  const conversations = new ConversationStore(paths.conversations)
  await conversations.init()

  // Services reference each other through late-bound closures.
  const ref: { images?: ImageService; models?: ModelService; local?: LocalProvider } = {}

  const engines = new EngineManager({
    getSettings: get,
    updateSettings: (patch) => settings.update(patch),
    paths,
    onProgress: (p) => emit('engines:progress', p),
    onChanged: (id) => {
      emit('engines:changed', id)
      ref.images?.invalidate()
      ref.models?.invalidate()
    }
  })
  await engines.init()

  const llama = new LlamaManager({ getSettings: get, engines })
  const localProvider = new LocalProvider({ getSettings: get, modelsDir: () => settings.modelsDir(), llama })
  ref.local = localProvider
  const models = new ModelService(get, localProvider)
  ref.models = models

  const mcp = new McpManager(get)
  const tools = new ToolRegistry(get, mcp)
  const approvals = new ApprovalManager()

  const imageStore = new ImageStore({ imagesDir: paths.images, thumbsDir: paths.thumbs, indexFile: paths.imageIndex, makeThumb: opts.makeThumb })
  await imageStore.load()
  const images = new ImageService({ getSettings: get, store: imageStore, engines, llama, tmpDir: paths.tmp, modelsDir: () => settings.modelsDir() })
  ref.images = images

  const attachments = new AttachmentStore({ dir: paths.attachments, prepareImage: opts.prepareImage })

  const downloads = new DownloadManager({
    getSettings: get,
    modelsDir: () => settings.modelsDir(),
    onUpdate: (item) => {
      if (item.status === 'done') {
        // Name the model before announcing the download, so the lists the interface reloads already show it.
        const wanted = item.spec.modelName?.trim()
        const cur = get().local
        if (wanted && item.spec.subdir === 'llm' && !cur.modelNames?.[item.dest]) {
          settings.update({ local: { ...cur, modelNames: { ...(cur.modelNames ?? {}), [item.dest]: wanted } } })
        }
        localProvider.invalidate()
        models.invalidate('local')
      }
      emit('downloads:update', item)
    }
  })

  const runner = new ChatRunner({
    getSettings: get,
    setToolPermission: (name: string, permission: ToolPermission) => {
      const s = get()
      settings.update({ agent: { ...s.agent, toolPermissions: { ...s.agent.toolPermissions, [name]: permission } } })
    },
    conversations,
    models,
    tools,
    approvals,
    images,
    attachments,
    emit: (e) => emit('chat:event', e)
  })

  const api = new ApiServer({ getSettings: get, llama, local: localProvider, images, imageStore })
  const remote = new RemoteService({
    paths,
    getSettings: () => get().remote,
    clientDir: opts.remoteClientDir ?? path.join(paths.data, 'remote-client'),
    appVersion: opts.appVersion ?? '',
    keepAwake: opts.keepAwake
  })
  const serving = opts.startServer !== false
  const pairing = opts.startRemote !== false
  /** Turning the server on with a key required needs a key; make one so it is never open by accident. */
  const needsKey = (s: Settings) => s.server.enabled && s.server.requireKey && !s.server.apiKey

  // React to the parts of settings that have live side effects, ignoring unrelated edits.
  const sig = (s: Settings) => ({ names: JSON.stringify([s.local.modelNames ?? {}, s.local.contextSize, s.local.modelOverrides]), providers: JSON.stringify(s.providers), mcp: JSON.stringify(s.mcpServers), image: JSON.stringify(s.image), paths: JSON.stringify([s.paths.modelsDir, s.paths.extraModelDirs]), server: JSON.stringify(s.server), remote: JSON.stringify(s.remote) })
  let last = sig(get())
  settings.onChange((s) => {
    if (serving && needsKey(s)) {
      settings.update({ server: { ...s.server, apiKey: generateApiKey() } }) // this runs the listener again with the key
      return
    }
    const now = sig(s)
    if (now.providers !== last.providers) models.invalidate()
    if (now.names !== last.names) {
      localProvider.invalidate()
      models.invalidate('local')
    }
    if (now.image !== last.image) images.invalidate()
    if (now.paths !== last.paths) {
      localProvider.invalidate()
      models.invalidate('local')
    }
    if (now.server !== last.server && serving) void api.apply()
    if (now.remote !== last.remote && pairing) void remote.apply()
    if (now.mcp !== last.mcp) void mcp.sync().catch(() => {})
    last = now
  })
  if (opts.startMcp !== false) void mcp.sync().catch(() => {})
  if (serving && get().server.enabled) {
    if (needsKey(get())) settings.update({ server: { ...get().server, apiKey: generateApiKey() } })
    void api.apply()
  }
  await remote.load()
  if (pairing && get().remote.enabled) void remote.apply()

  return {
    paths,
    settings,
    conversations,
    models,
    mcp,
    tools,
    approvals,
    engines,
    llama,
    localProvider,
    downloads,
    imageStore,
    images,
    attachments,
    runner,
    api,
    remote,
    async shutdown() {
      await api.close()
      await remote.shutdown()
      runner.abortAll()
      downloads.cancelAll()
      await Promise.allSettled([mcp.closeAll(), llama.stop()])
      await Promise.allSettled([settings.saveNow(), conversations.flush(), imageStore.flush()])
    }
  }
}
