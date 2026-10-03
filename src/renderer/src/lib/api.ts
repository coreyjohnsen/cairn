import type { OsPlatform } from '@shared/types'
import type { EventChannel, InvokeChannel, IpcEventMap, IpcInvokeMap } from '@shared/ipc'

export function invoke<K extends InvokeChannel>(channel: K, ...args: IpcInvokeMap[K]['args']): Promise<IpcInvokeMap[K]['result']> {
  return window.cairn.invoke(channel, ...args)
}

export function on<K extends EventChannel>(channel: K, listener: (payload: IpcEventMap[K]) => void): () => void {
  return window.cairn.on(channel, listener)
}

/** Disk-backed media served by the main process (or generated placeholders when running without Electron). */
export function mediaUrl(kind: 'image' | 'thumb' | 'attachment', file: string): string {
  const override = (window as unknown as { __cairnMedia?: (kind: string, file: string) => string }).__cairnMedia
  if (override) return override(kind, file)
  return `cairn-media://${kind}/${encodeURIComponent(file)}`
}

export const platform = (): OsPlatform => window.cairn?.platform ?? 'linux'
