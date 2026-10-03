import { Cpu, ImageIcon, Plug } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DetectedServer } from '@shared/types'
import { PROVIDER_PRESETS, makeProvider } from '@shared/defaults'
import { invoke } from '@/lib/api'
import { useApp } from '@/store/app'
import { useLibrary } from '@/store/library'
import { Ridgeline } from './Ridgeline'
import { Button, Spinner } from './ui'

/** First-run welcome. Shown once, until the person picks a path or skips. */
export function Onboarding() {
  const settings = useApp((s) => s.settings)
  const models = useApp((s) => s.models)
  const loadingModels = useApp((s) => s.modelsLoading)
  const update = useApp((s) => s.update)
  const setView = useApp((s) => s.setView)
  const gpu = useLibrary((s) => s.gpu)
  const [found, setFound] = useState<DetectedServer[] | null>(null)
  const open = !!settings && !settings.onboardingDismissed

  useEffect(() => {
    if (!open) return
    invoke('providers:detect')
      .then(setFound)
      .catch(() => setFound([]))
  }, [open])

  // Anyone who already has models (an upgrade, or a restored config) does not need the tour.
  useEffect(() => {
    if (open && !loadingModels && models.length > 0) update({ onboardingDismissed: true })
  }, [open, loadingModels, models.length, update])

  if (!open) return null

  const done = (view?: 'local' | 'connections' | 'image') => {
    update({ onboardingDismissed: true })
    if (view) setView('models', view)
  }

  const addFound = (d: DetectedServer) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === d.presetId) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]
    const p = { ...makeProvider(preset), name: d.name, baseUrl: d.baseUrl }
    update((s) => ({ providers: [...s.providers, p], onboardingDismissed: true }))
    setTimeout(() => void useApp.getState().refreshModels(true), 400)
  }

  const primary = gpu?.devices[0]

  return (
    <div className="welcome-backdrop">
      <div className="welcome" role="dialog" aria-modal="true" aria-label="Welcome">
        <div className="welcome-art">
          <Ridgeline seed={42} layers={4} animate />
          <div className="welcome-title">
            <h1>Welcome to Cairn</h1>
            <p>A quiet place to chat with AI, put it to work on your files, and make pictures. Everything runs where you choose.</p>
          </div>
        </div>
        <div className="welcome-body">
          {found && found.length > 0 && (
            <div className="found">
              {found.map((d) => (
                <div key={d.baseUrl} className="found-row">
                  <span className="dot-pulse" style={{ animation: 'none', background: 'var(--ok)' }} />
                  <span className="grow">
                    Found <b>{d.name}</b> running here with {d.modelCount} model{d.modelCount === 1 ? '' : 's'}
                  </span>
                  <Button size="sm" variant="primary" onClick={() => addFound(d)}>
                    Use it
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="welcome-choices">
            <button type="button" className="choice" onClick={() => done('local')}>
              <span className="choice-icon">
                <Cpu size={20} />
              </span>
              <span className="choice-title">Run a model on this computer</span>
              <span className="choice-text">
                {primary ? `Cairn found ${primary.name}. It will fetch the right engine and help you pick a model.` : gpu ? 'Cairn will fetch the right engine for your hardware and help you pick a model.' : 'Download an engine and a model, then chat offline.'}
              </span>
            </button>
            <button type="button" className="choice" onClick={() => done('connections')}>
              <span className="choice-icon">
                <Plug size={20} />
              </span>
              <span className="choice-title">Connect a server or API</span>
              <span className="choice-text">Ollama, LM Studio, OpenAI, Anthropic, OpenRouter or any OpenAI-compatible address.</span>
            </button>
            <button type="button" className="choice" onClick={() => done('image')}>
              <span className="choice-icon">
                <ImageIcon size={20} />
              </span>
              <span className="choice-title">Set up image generation</span>
              <span className="choice-text">Use the built-in engine, or connect ComfyUI, AUTOMATIC1111 or an image API.</span>
            </button>
          </div>
          <div className="welcome-foot">
            {found === null && (
              <span className="faint small row">
                <Spinner size={13} /> Looking for models on this computer…
              </span>
            )}
            <span className="grow" />
            <Button variant="ghost" onClick={() => done()}>
              Skip for now
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
