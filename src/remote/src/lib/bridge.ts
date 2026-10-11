import type { CairnApi, EventChannel, InvokeChannel, IpcEventMap, IpcInvokeMap } from '@shared/ipc'
import type { Settings } from '@shared/types'
import { type LocalPrefs, applyPrefs, cleanPrefs, prefsFromPatch } from './prefs'
import { RemoteTransport } from './transport'

/**
 * Makes the computer look like `window.cairn` to the interface's stores, so the phone reuses the same chat and picture
 * logic as the desktop window. Requests go over the network; a few that only make sense on a computer (opening
 * folders, the title bar, settings) are answered here.
 */

const PREFS_KEY = 'cairn-remote-prefs'

function loadPrefs(): LocalPrefs {
  try {
    return cleanPrefs(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}'))
  } catch {
    return {}
  }
}

function savePrefs(p: LocalPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    /* private mode: the choice lasts until the page closes */
  }
}

type Listener = (payload: never) => void

export interface Bridge {
  api: CairnApi
  /** Hands an update from the computer to whoever listens for it. */
  dispatch<K extends EventChannel>(channel: K, payload: IpcEventMap[K]): void
}

export function createBridge(transport: RemoteTransport): Bridge {
  const listeners = new Map<string, Set<Listener>>()
  let prefs = loadPrefs()
  let host: Settings | null = null

  const merged = (): Settings => applyPrefs(host as Settings, prefs)

  const api: CairnApi = {
    platform: 'linux',
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set<Listener>()
      set.add(listener as Listener)
      listeners.set(channel, set)
      return () => set.delete(listener as Listener)
    },
    async invoke<K extends InvokeChannel>(channel: K, ...args: IpcInvokeMap[K]['args']): Promise<IpcInvokeMap[K]['result']> {
      const out = await (async (): Promise<unknown> => {
        switch (channel) {
          case 'settings:get':
            host = (await transport.invoke(channel, [])) as Settings
            return merged()
          case 'settings:update': {
            if (!host) host = (await transport.invoke('settings:get', [])) as Settings
            prefs = prefsFromPatch(args[0] as Partial<Settings>, prefs)
            savePrefs(prefs)
            return merged()
          }
          case 'system:openExternal':
            window.open(String(args[0]), '_blank', 'noopener,noreferrer')
            return undefined
          case 'system:setTitleBar':
            return undefined
          default:
            return transport.invoke(channel, args)
        }
      })()
      return out as IpcInvokeMap[K]['result']
    }
  }

  return {
    api,
    dispatch(channel, payload) {
      for (const l of listeners.get(channel) ?? []) {
        try {
          ;(l as (p: unknown) => void)(payload)
        } catch (e) {
          console.error(`Listener for ${channel} failed`, e)
        }
      }
    }
  }
}
