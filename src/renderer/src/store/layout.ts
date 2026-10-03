import { create } from 'zustand'

/**
 * Where the person has put the dividers, which side panels are folded away, and how the Image Hub shows pictures.
 * Kept in this window's local storage: it is about this screen, not about the account.
 */

export const PANELS = {
  /** Chat list beside the conversation. */
  conversations: { def: 280, min: 200, max: 480, label: 'chat list' },
  /** Image Hub controls. */
  create: { def: 352, min: 300, max: 600, label: 'create panel' },
  /** Image Hub previous pictures, beside the big one. */
  history: { def: 188, min: 104, max: 420, label: 'previous pictures' },
  /** Details and actions in the full-screen picture viewer. */
  lightbox: { def: 360, min: 280, max: 600, label: 'picture details' }
} as const

export type PanelId = keyof typeof PANELS
export type HubMode = 'focus' | 'grid'

interface Persisted {
  widths: Partial<Record<PanelId, number>>
  collapsed: Partial<Record<PanelId, boolean>>
  hubMode: HubMode
  /** Collapsible sections the person has opened or closed, by id. */
  sections: Record<string, boolean>
}

const KEY = 'cairn.layout.v1'
const FALLBACK: Persisted = { widths: {}, collapsed: {}, hubMode: 'focus', sections: {} }

export const clampWidth = (id: PanelId, w: number): number => Math.round(Math.max(PANELS[id].min, Math.min(PANELS[id].max, w)))

function read(): Persisted {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Persisted> | null
    if (!raw || typeof raw !== 'object') return { ...FALLBACK }
    const widths: Persisted['widths'] = {}
    const collapsed: Persisted['collapsed'] = {}
    for (const id of Object.keys(PANELS) as PanelId[]) {
      const w = raw.widths?.[id]
      if (typeof w === 'number' && Number.isFinite(w)) widths[id] = clampWidth(id, w)
      if (raw.collapsed?.[id] === true) collapsed[id] = true
    }
    const sections: Persisted['sections'] = {}
    for (const [k, v] of Object.entries(raw.sections ?? {})) if (typeof v === 'boolean') sections[k] = v
    return { widths, collapsed, hubMode: raw.hubMode === 'grid' ? 'grid' : 'focus', sections }
  } catch {
    return { ...FALLBACK }
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function save(s: Persisted): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      localStorage.setItem(KEY, JSON.stringify(s))
    } catch {
      /* storage can be unavailable; the layout then simply is not remembered */
    }
  }, 150)
}

interface LayoutState extends Persisted {
  setWidth(id: PanelId, w: number): void
  resetWidth(id: PanelId): void
  setCollapsed(id: PanelId, v: boolean): void
  toggle(id: PanelId): void
  setHubMode(m: HubMode): void
  setSection(id: string, open: boolean): void
}

export const useLayout = create<LayoutState>()((set, get) => {
  const commit = (patch: Partial<Persisted>) => {
    set(patch)
    const { widths, collapsed, hubMode, sections } = get()
    save({ widths, collapsed, hubMode, sections })
  }
  return {
    ...read(),
    setWidth: (id, w) => commit({ widths: { ...get().widths, [id]: clampWidth(id, w) } }),
    resetWidth: (id) => {
      const widths = { ...get().widths }
      delete widths[id]
      commit({ widths })
    },
    setCollapsed: (id, v) => {
      const collapsed = { ...get().collapsed }
      if (v) collapsed[id] = true
      else delete collapsed[id]
      commit({ collapsed })
    },
    toggle: (id) => get().setCollapsed(id, !get().collapsed[id]),
    setHubMode: (hubMode) => commit({ hubMode }),
    setSection: (id, open) => commit({ sections: { ...get().sections, [id]: open } })
  }
})

/** The width a panel should have right now, and whether it is folded away. */
export function usePanel(id: PanelId): { width: number; collapsed: boolean } {
  const width = useLayout((s) => s.widths[id] ?? PANELS[id].def)
  const collapsed = useLayout((s) => !!s.collapsed[id])
  return { width, collapsed }
}

/** Whether a collapsible section is open, remembering what the person chose. */
export function useSection(id: string, defaultOpen = false): [boolean, (open: boolean) => void] {
  const open = useLayout((s) => s.sections[id] ?? defaultOpen)
  const setSection = useLayout((s) => s.setSection)
  return [open, (v) => setSection(id, v)]
}
