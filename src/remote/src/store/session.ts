import { create } from 'zustand'
import { invoke } from '@/lib/api'
import { useApp } from '@/store/app'
import { useChat } from '@/store/chat'
import { useImages } from '@/store/images'
import { normalizePairCode, pairCodeFromText } from '@shared/remotePrefs'
import { createBridge } from '../lib/bridge'
import { RemoteTransport, type SessionInfo } from '../lib/transport'

type Phase = 'loading' | 'unpaired' | 'ready'

interface SessionState {
  phase: Phase
  session: SessionInfo | null
  /** The live channel to the computer is up. */
  live: boolean
  /** Could not reach the computer when starting (it is off, asleep or the address changed). */
  unreachable: string | null
  pairing: boolean
  pairError: string | null
  start(): Promise<void>
  pair(codeOrLink: string, name?: string): Promise<boolean>
  adopt(session: SessionInfo): Promise<void>
  retry(): void
  signOut(): Promise<void>
}

export const transport = new RemoteTransport({
  onEvent: (c, p) => bridge.dispatch(c, p),
  onLive: (again) => {
    useSession.setState({ live: true, unreachable: null })
    if (again) void resync()
  },
  onOffline: () => useSession.setState({ live: false }),
  // Pictures or tools were switched on or off on the computer: start over so every screen matches.
  onScopes: (scopes) => {
    const cur = useSession.getState().session?.device.scopes
    if (cur && (cur.images !== scopes.images || cur.tools !== scopes.tools)) location.reload()
  },
  onAuthLost: () => useSession.setState({ phase: 'unpaired', session: null, live: false, pairError: 'This phone was signed out from the computer. Scan the code again to reconnect.' })
})
export const bridge = createBridge(transport)

let started = false

/** Loads the chat and picture lists and wires up the live updates. Runs once per page load. */
async function startData(session: SessionInfo): Promise<void> {
  if (started) return
  started = true
  await useApp.getState().init()
  await Promise.all([useChat.getState().init(), session.device.scopes.images ? useImages.getState().init() : Promise.resolve()])
  transport.connect()
}

/** After the connection came back: pick up whatever happened while the phone could not hear. */
async function resync(): Promise<void> {
  try {
    const [, active] = await Promise.all([useChat.getState().refreshList(), invoke('chat:active')])
    useChat.setState({ running: Object.fromEntries(active.map((id) => [id, true])) })
    const id = useChat.getState().activeId
    if (id) {
      const conv = await invoke('conversations:get', id)
      if (conv) useChat.setState((s) => ({ cache: { ...s.cache, [id]: conv } }))
      else useChat.setState({ activeId: null })
    }
    if (useSession.getState().session?.device.scopes.images) {
      const [records, jobs] = await Promise.all([invoke('images:list'), invoke('images:jobs')])
      useImages.setState({ records: records.sort((a, b) => b.createdAt - a.createdAt), jobs: Object.fromEntries(jobs.map((j) => [j.id, j])) })
    }
  } catch {
    /* the next update brings it up to date */
  }
}

export const useSession = create<SessionState>()((set, get) => ({
  phase: 'loading',
  session: null,
  live: false,
  unreachable: null,
  pairing: false,
  pairError: null,

  async start() {
    set({ phase: 'loading', unreachable: null })
    // A link from the QR code carries the pairing code after the #.
    const fromLink = pairCodeFromText(location.hash)
    if (location.hash) history.replaceState(null, '', location.pathname + location.search)
    try {
      // Already signed in on this phone? Then the code in the link is not needed.
      const existing = await transport.session()
      if (existing) return void (await get().adopt(existing))
    } catch (e) {
      return void set({ phase: 'unpaired', unreachable: e instanceof Error ? e.message : String(e) })
    }
    set({ phase: 'unpaired' })
    if (fromLink) await get().pair(fromLink)
  },

  async pair(codeOrLink, name) {
    const code = pairCodeFromText(codeOrLink) ?? normalizePairCode(codeOrLink)
    if (!code) {
      set({ pairError: 'That does not look like a code. It has 8 letters and numbers, like K7QM-4TXD.' })
      return false
    }
    set({ pairing: true, pairError: null })
    const r = await transport.pair(code, name)
    if (!r.ok) {
      set({ pairing: false, pairError: r.error })
      return false
    }
    await get().adopt(r.session)
    set({ pairing: false })
    return true
  },

  async adopt(session) {
    set({ session, pairError: null })
    try {
      await startData(session)
      set({ phase: 'ready' })
    } catch (e) {
      // Paired, but the lists could not be read (the computer went away just now).
      set({ phase: 'ready', unreachable: e instanceof Error ? e.message : String(e) })
      transport.connect()
    }
  },

  retry() {
    if (get().phase === 'ready') transport.nudge()
    else void get().start()
  },

  async signOut() {
    await transport.logout()
    // A clean page: the stores forget everything from this computer.
    location.reload()
  }
}))
