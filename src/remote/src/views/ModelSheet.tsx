import { Check, Eye } from 'lucide-react'
import { useMemo } from 'react'
import { useApp } from '@/store/app'
import { useChat } from '@/store/chat'
import { Sheet } from '../components/Sheet'
import { useNav } from '../store/nav'

/** Picks the model for the open chat (or for the next new chat). The list is whatever is set up on the computer. */
export function ModelSheet() {
  const open = useNav((s) => s.layers.includes('models'))
  const close = useNav((s) => s.close)
  const models = useApp((s) => s.models)
  const loading = useApp((s) => s.modelsLoading)
  const refresh = useApp((s) => s.refreshModels)
  const defaultModel = useApp((s) => s.settings?.defaultModel)
  const current = useChat((s) => (s.activeId ? s.cache[s.activeId]?.modelRef : s.draft.modelRef) || undefined)
  const patchActive = useChat((s) => s.patchActive)
  const groups = useMemo(() => {
    const out: { name: string; items: typeof models }[] = []
    for (const m of models) {
      const g = out.find((x) => x.name === m.providerName)
      if (g) g.items.push(m)
      else out.push({ name: m.providerName, items: [m] })
    }
    return out
  }, [models])
  const selected = current || defaultModel

  return (
    <Sheet open={open} onClose={() => close('models')} title="Choose a model" tall>
      {groups.map((g) => (
        <div key={g.name} className="model-group">
          <div className="group-label">{g.name}</div>
          {g.items.map((m) => (
            <button
              key={m.ref}
              type="button"
              className="sheet-item"
              onClick={() => {
                patchActive({ modelRef: m.ref })
                close('models')
              }}
            >
              <span className="sheet-item-main">
                <span className="ellipsis">{m.name}</span>
                <span className="faint xs">
                  {m.caps.vision ? <Eye size={11} className="inline-icon" /> : null}
                  {m.caps.vision ? ' Can see pictures' : m.contextLength ? `${Math.round(m.contextLength / 1024)}k memory` : ''}
                </span>
              </span>
              {selected === m.ref && <Check size={18} className="sheet-check" />}
            </button>
          ))}
        </div>
      ))}
      {!groups.length && <p className="dim sheet-empty">{loading ? 'Looking for models…' : 'No models are ready on your computer yet. Open Cairn there and add or start one.'}</p>}
      <button type="button" className="link-btn sheet-refresh" onClick={() => void refresh(true)}>
        Look again
      </button>
    </Sheet>
  )
}
