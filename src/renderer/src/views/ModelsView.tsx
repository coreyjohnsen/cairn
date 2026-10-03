import { Cpu, ImageIcon, Plug, Rocket, Server } from 'lucide-react'
import { Ridgeline } from '@/components/Ridgeline'
import { cx } from '@/lib/format'
import { type ModelsTab, useApp } from '@/store/app'
import { Connections } from './models/Connections'
import { Engines } from './models/Engines'
import { ImageModels } from './models/ImageModels'
import { LocalModels } from './models/LocalModels'
import { Serve } from './models/Serve'

const TABS: { id: ModelsTab; label: string; icon: typeof Plug }[] = [
  { id: 'connections', label: 'Connections', icon: Plug },
  { id: 'local', label: 'Local models', icon: Cpu },
  { id: 'image', label: 'Image models', icon: ImageIcon },
  { id: 'engines', label: 'Engines and GPU', icon: Rocket },
  { id: 'serve', label: 'Serve', icon: Server }
]

export function ModelsView() {
  const tab = useApp((s) => s.modelsTab)
  const setView = useApp((s) => s.setView)
  const ridges = useApp((s) => s.settings?.appearance.ridgelines)
  return (
    <div className="page">
      {ridges && (
        <div className="hero-ridge">
          <Ridgeline seed={5} layers={4} />
        </div>
      )}
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1>Models</h1>
            <p>Bring any model you like: run one on this computer, connect a server, or use a cloud API.</p>
          </div>
        </div>
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={cx('tab', tab === t.id && 'on')} onClick={() => setView('models', t.id)}>
              <t.icon size={16} />
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'connections' && <Connections />}
        {tab === 'local' && <LocalModels />}
        {tab === 'image' && <ImageModels />}
        {tab === 'engines' && <Engines />}
        {tab === 'serve' && <Serve />}
      </div>
    </div>
  )
}
