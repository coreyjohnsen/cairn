import { create } from 'zustand'

export type Tab = 'chats' | 'pictures' | 'you'
/** Screens that open on top of a tab. The phone's Back button closes the top one. */
export type Layer = 'chat' | 'viewer' | 'create' | 'models' | 'chatMenu'

interface NavState {
  tab: Tab
  layers: Layer[]
  /** The picture open in the viewer, and the pictures it can step through. */
  viewing: string | null
  siblings: string[]
  go(tab: Tab): void
  open(layer: Layer): void
  /** Closes the top screen (or a specific one) the way the Back button would. */
  close(layer?: Layer): void
  view(id: string | null, siblings?: string[]): void
}

export const useNav = create<NavState>()((set, get) => ({
  tab: 'chats',
  layers: [],
  viewing: null,
  siblings: [],

  go(tab) {
    // Switching tabs leaves whatever was open on the old one.
    const { layers } = get()
    if (layers.length) history.go(-layers.length)
    set({ tab, layers: [], viewing: null })
  },

  open(layer) {
    const { layers } = get()
    if (layers[layers.length - 1] === layer) return
    history.pushState({ cairn: layers.length + 1 }, '')
    set({ layers: [...layers, layer] })
  },

  close(layer) {
    const { layers } = get()
    if (!layers.length) return
    // Closing a screen closes everything that opened on top of it too: one step back for each.
    const at = layer ? layers.lastIndexOf(layer) : layers.length - 1
    if (at < 0) return
    history.go(-(layers.length - at))
  },

  view(id, siblings) {
    if (id) {
      set({ viewing: id, siblings: siblings && siblings.includes(id) ? siblings : [id] })
      get().open('viewer')
    } else {
      set({ viewing: null, siblings: [] })
      get().close('viewer')
    }
  }
}))

/** Keeps the screens in step with the browser's Back button (and the swipe-back gesture on phones). */
export function listenForBack(): () => void {
  // A reload keeps the browser's old marker on this page; start from a clean one.
  history.replaceState({ cairn: 0 }, '')
  const onPop = (e: PopStateEvent) => {
    const depth = typeof e.state?.cairn === 'number' ? e.state.cairn : 0
    const { layers } = useNav.getState()
    if (depth >= layers.length) return
    const next = layers.slice(0, depth)
    useNav.setState({ layers: next, ...(next.includes('viewer') ? {} : { viewing: null }) })
  }
  window.addEventListener('popstate', onPop)
  return () => window.removeEventListener('popstate', onPop)
}
