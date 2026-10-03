import { contextBridge, ipcRenderer } from 'electron'
import { EVENT_CHANNELS, INVOKE_CHANNELS, type CairnApi, type EventChannel } from '../shared/ipc'

const invokeAllowed = new Set<string>(INVOKE_CHANNELS)
const eventAllowed = new Set<string>(EVENT_CHANNELS)

/** Electron wraps thrown errors as "Error invoking remote method 'x': Error: message"; show only the message. */
function cleanError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err)
  const m = /^Error invoking remote method '[^']+': (?:\w*Error: )?([\s\S]*)$/.exec(raw)
  return new Error(m ? m[1] : raw)
}

const api: CairnApi = {
  platform: process.platform,
  invoke(channel, ...args) {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`Unknown channel: ${channel}`))
    return ipcRenderer.invoke(channel, ...args).catch((e: unknown) => {
      throw cleanError(e)
    }) as never
  },
  on(channel: EventChannel, listener) {
    if (!eventAllowed.has(channel)) throw new Error(`Unknown channel: ${channel}`)
    const wrapped = (_e: unknown, payload: unknown) => listener(payload as never)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('cairn', api)

