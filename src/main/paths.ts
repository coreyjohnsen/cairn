import path from 'node:path'
import { ensureDirSync } from './util/fsx'

export interface AppPaths {
  data: string
  settingsFile: string
  conversations: string
  images: string
  thumbs: string
  attachments: string
  imageIndex: string
  engines: string
  enginesIndex: string
  logs: string
  tmp: string
  /** Default models directory (settings can override). */
  defaultModels: string
}

let current: AppPaths | null = null

export function initPaths(dataDir: string): AppPaths {
  const p: AppPaths = {
    data: dataDir,
    settingsFile: path.join(dataDir, 'settings.json'),
    conversations: path.join(dataDir, 'conversations'),
    images: path.join(dataDir, 'images'),
    thumbs: path.join(dataDir, 'thumbs'),
    attachments: path.join(dataDir, 'attachments'),
    imageIndex: path.join(dataDir, 'images', 'index.json'),
    engines: path.join(dataDir, 'engines'),
    enginesIndex: path.join(dataDir, 'engines', 'installed.json'),
    logs: path.join(dataDir, 'logs'),
    tmp: path.join(dataDir, 'tmp'),
    defaultModels: path.join(dataDir, 'models')
  }
  for (const d of [p.data, p.conversations, p.images, p.thumbs, p.attachments, p.engines, p.logs, p.tmp, p.defaultModels]) {
    ensureDirSync(d)
  }
  current = p
  return p
}

export function paths(): AppPaths {
  if (!current) throw new Error('Paths not initialised')
  return current
}
