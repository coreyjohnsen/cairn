import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Settings } from '@shared/types'
import {
  BUILTIN_IMAGE_BACKEND_ID,
  LOCAL_PROVIDER_ID,
  SETTINGS_VERSION,
  defaultImageBackends,
  defaultLocalProvider,
  defaultSettings
} from '@shared/defaults'
import { emit } from './events'
import { mapSecrets, seal, unseal } from './secrets'
import { sanitizeAliases, sanitizeLoraPresets, sanitizeModelDefaults } from '@shared/imagePrefs'
import { sanitizeRemote } from '@shared/remotePrefs'
import { sanitizeServer } from '@shared/serverPrefs'
import { mergeDefaults, writeFileAtomic } from './util/fsx'

export class SettingsStore {
  private current: Settings
  private saveTimer: NodeJS.Timeout | null = null
  private listeners = new Set<(s: Settings) => void>()

  constructor(
    private file: string,
    private defaultModelsDir: string
  ) {
    this.current = this.normalize(defaultSettings(defaultModelsDir))
  }

  async load(): Promise<Settings> {
    let loaded: unknown = null
    try {
      loaded = JSON.parse(await fsp.readFile(this.file, 'utf8'))
    } catch {
      loaded = null
    }
    const base = defaultSettings(this.defaultModelsDir)
    const merged = mergeDefaults(base, loaded)
    this.current = this.normalize(mapSecrets(merged, unseal))
    if (!loaded) await this.saveNow()
    return this.current
  }

  get(): Settings {
    return this.current
  }

  onChange(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  update(patch: Partial<Settings>): Settings {
    this.current = this.normalize({ ...this.current, ...patch })
    this.scheduleSave()
    for (const l of this.listeners) l(this.current)
    emit('settings:changed', this.current)
    return this.current
  }

  /** Models directory, falling back to the default when blank. */
  modelsDir(): string {
    return this.current.paths.modelsDir || this.defaultModelsDir
  }

  private normalize(s: Settings): Settings {
    s.version = SETTINGS_VERSION
    // The built-in local provider always exists exactly once.
    const providers = s.providers.filter((p) => p.id !== LOCAL_PROVIDER_ID)
    const local = s.providers.find((p) => p.id === LOCAL_PROVIDER_ID) ?? defaultLocalProvider()
    local.kind = 'local'
    s.providers = [local, ...providers]
    // The built-in image backend always exists exactly once.
    if (!s.image.backends.some((b) => b.id === BUILTIN_IMAGE_BACKEND_ID)) {
      s.image.backends = [...defaultImageBackends(), ...s.image.backends]
    }
    if (!s.paths.modelsDir) s.paths.modelsDir = this.defaultModelsDir
    // What the user saved for images is cleaned on every change, so a bad entry cannot reach the engines.
    s.image.aliases = sanitizeAliases(s.image.aliases)
    s.image.loraPresets = sanitizeLoraPresets(s.image.loraPresets)
    s.image.modelDefaults = sanitizeModelDefaults(s.image.modelDefaults)
    s.server = sanitizeServer(s.server)
    s.remote = sanitizeRemote(s.remote)
    return s
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.saveNow(), 300)
  }

  async saveNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      const sealed = mapSecrets(this.current, seal)
      await writeFileAtomic(this.file, JSON.stringify(sealed, null, 2))
    } catch (err) {
      console.error('Failed to save settings', err)
    }
  }
}

export function settingsFileFor(dataDir: string): string {
  return path.join(dataDir, 'settings.json')
}
