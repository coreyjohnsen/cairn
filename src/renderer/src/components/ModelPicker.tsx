import { Brain, ChevronDown, Eye, Search, Settings2, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ModelOption } from '@shared/types'
import { cx, truncate } from '@/lib/format'
import { useApp } from '@/store/app'
import { MenuLabel, Popover } from './ui'

export function CapIcons({ caps }: { caps: ModelOption['caps'] }) {
  return (
    <span className="caps">
      {caps.vision && (
        <span title="Understands images">
          <Eye size={13} />
        </span>
      )}
      {caps.tools !== false && (
        <span title="Can use tools">
          <Wrench size={12} />
        </span>
      )}
      {caps.reasoning && (
        <span title="Reasoning model">
          <Brain size={13} />
        </span>
      )}
    </span>
  )
}

export function useModelName(ref: string | undefined): { option?: ModelOption; label: string } {
  const models = useApp((s) => s.models)
  const option = models.find((m) => m.ref === ref)
  return { option, label: option ? option.name : ref ? (ref.split('::')[1] ?? ref) : 'Choose a model' }
}

export function ModelPicker({ value, onChange, compact }: { value: string | undefined; onChange: (ref: string) => void; compact?: boolean }) {
  const models = useApp((s) => s.models)
  const setView = useApp((s) => s.setView)
  const refresh = useApp((s) => s.refreshModels)
  const loading = useApp((s) => s.modelsLoading)
  const { option, label } = useModelName(value)
  const [q, setQ] = useState('')

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const map = new Map<string, ModelOption[]>()
    for (const m of models) {
      if (needle && !`${m.name} ${m.id} ${m.providerName}`.toLowerCase().includes(needle)) continue
      const g = map.get(m.providerName) ?? []
      g.push(m)
      map.set(m.providerName, g)
    }
    return [...map.entries()]
  }, [models, q])

  return (
    <Popover
      placement="top"
      width={360}
      className="model-pop"
      trigger={({ open, toggle, ref }) => (
        <button ref={ref} type="button" className={cx('chip-btn', open && 'open', !option && 'empty')} onClick={() => { toggle(); if (!open) void refresh() }}>
          <span className="chip-main">{truncate(label, compact ? 22 : 34)}</span>
          {option && <CapIcons caps={option.caps} />}
          <ChevronDown size={14} />
        </button>
      )}
    >
      {(close) => (
        <div className="model-list">
          <div className="model-search">
            <Search size={14} />
            <input autoFocus placeholder="Search models" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="model-scroll">
            {groups.length === 0 && (
              <div className="model-empty">
                {loading ? 'Looking for models…' : models.length === 0 ? 'No models found yet. Add a connection or download a local model.' : 'No matches.'}
              </div>
            )}
            {groups.map(([name, list]) => (
              <div key={name}>
                <MenuLabel>{name}</MenuLabel>
                {list.map((m) => (
                  <button
                    key={m.ref}
                    type="button"
                    className={cx('model-row', m.ref === value && 'on')}
                    onClick={() => {
                      onChange(m.ref)
                      close()
                    }}
                  >
                    <span className="ellipsis grow">{m.name}</span>
                    <CapIcons caps={m.caps} />
                  </button>
                ))}
              </div>
            ))}
          </div>
          <button
            type="button"
            className="model-manage"
            onClick={() => {
              close()
              setView('models', 'connections')
            }}
          >
            <Settings2 size={14} /> Manage models and connections
          </button>
        </div>
      )}
    </Popover>
  )
}
