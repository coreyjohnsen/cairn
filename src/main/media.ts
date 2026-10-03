import path from 'node:path'
import type { AppPaths } from './paths'

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

export interface MediaTarget {
  /** Files to try in order (a missing thumbnail falls back to the original). */
  candidates: string[]
  mime: string
}

/**
 * Map a `cairn-media://<kind>/<file>` URL to files on disk. Only plain image file names inside the
 * three media folders are ever served: no path separators, no traversal, no index or settings files.
 */
export function resolveMedia(paths: Pick<AppPaths, 'images' | 'thumbs' | 'attachments'>, rawUrl: string): MediaTarget | null {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  if (u.protocol !== 'cairn-media:') return null

  let name: string
  try {
    name = decodeURIComponent(u.pathname.replace(/^\/+/, ''))
  } catch {
    return null
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*\.(png|jpe?g|webp|gif)$/i.test(name) || name.includes('..')) return null
  const mime = MIME[path.extname(name).slice(1).toLowerCase()]
  if (!mime) return null

  switch (u.hostname.toLowerCase()) {
    case 'image':
      return { candidates: [path.join(paths.images, name)], mime }
    case 'thumb':
      return { candidates: [path.join(paths.thumbs, name), path.join(paths.images, name)], mime }
    case 'attachment':
      return { candidates: [path.join(paths.attachments, name)], mime }
    default:
      return null
  }
}

export function mediaUrl(kind: 'image' | 'thumb' | 'attachment', file: string): string {
  return `cairn-media://${kind}/${encodeURIComponent(file)}`
}
