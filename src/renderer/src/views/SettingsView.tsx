import { FolderOpen, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { ThemeId } from '@shared/types'
import { Logo } from '@/components/Logo'
import { Ridgeline } from '@/components/Ridgeline'
import { Button, Card, Field, Notice, NumberField, Section, Segmented, Select, Slider, Switch, TextField } from '@/components/ui'
import { invoke } from '@/lib/api'
import { cx, errorText } from '@/lib/format'
import { type SettingsTab, useApp } from '@/store/app'
import { PathField } from './models/shared'

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'Appearance' },
  { id: 'chat', label: 'Chat' },
  { id: 'agent', label: 'Agent and files' },
  { id: 'storage', label: 'Storage' },
  { id: 'about', label: 'About' }
]

interface Swatch {
  id: ThemeId
  label: string
  note: string
  sky: [string, string]
  ridges: [string, string, string]
  accent: string
}

const SWATCHES: Swatch[] = [
  { id: 'alpenglow', label: 'Alpenglow', note: 'Dusk slate, rose and amber', sky: ['#151c25', '#2b2a38'], ridges: ['#34384a', '#272b3a', '#1c2029'], accent: '#f2a077' },
  { id: 'glacier', label: 'Glacier', note: 'Bright, cool and crisp', sky: ['#dbe9f1', '#f4f8fa'], ridges: ['#c3d6e2', '#a8c2d3', '#88a9be'], accent: '#2a7ca3' },
  { id: 'granite', label: 'Granite', note: 'Neutral charcoal and stone', sky: ['#151617', '#1f2123'], ridges: ['#34373a', '#2a2d30', '#212326'], accent: '#d9d2c4' },
  { id: 'timberline', label: 'Timberline', note: 'Deep pine and lichen', sky: ['#0f1a16', '#1b2a22'], ridges: ['#2c4237', '#213329', '#17261e'], accent: '#86c9a2' }
]

function SwatchArt({ s, uid }: { s: Swatch; uid: string }) {
  return (
    <svg viewBox="0 0 160 84" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id={`sky-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={s.sky[0]} />
          <stop offset="1" stopColor={s.sky[1]} />
        </linearGradient>
      </defs>
      <rect width="160" height="84" fill={`url(#sky-${uid})`} />
      <circle cx="116" cy="30" r="9" fill={s.accent} opacity="0.85" />
      <path d="M0 62 L24 34 L40 50 L62 22 L88 54 L108 38 L132 58 L160 40 V84 H0Z" fill={s.ridges[0]} />
      <path d="M0 72 L30 48 L52 64 L78 40 L104 66 L128 52 L160 70 V84 H0Z" fill={s.ridges[1]} />
      <path d="M0 80 L36 64 L70 76 L110 62 L160 78 V84 H0Z" fill={s.ridges[2]} />
    </svg>
  )
}

function General() {
  const a = useApp((s) => s.settings!.appearance)
  const update = useApp((s) => s.update)
  const set = (p: Partial<typeof a>) => update((s) => ({ appearance: { ...s.appearance, ...p } }))
  return (
    <>
      <Section title="Theme" subtitle="Four mountain palettes. Each changes the whole app, including the ridgeline art.">
        <div className="theme-grid">
          {SWATCHES.map((s) => (
            <button key={s.id} type="button" className={cx('theme-card', a.theme === s.id && 'on')} onClick={() => set({ theme: s.id })} aria-pressed={a.theme === s.id}>
              <div className="theme-art">
                <SwatchArt s={s} uid={s.id} />
              </div>
              <div className="theme-name">{s.label}</div>
              <div className="theme-note">{s.note}</div>
            </button>
          ))}
          <button type="button" className={cx('theme-card', a.theme === 'system' && 'on')} onClick={() => set({ theme: 'system' })} aria-pressed={a.theme === 'system'}>
            <div className="theme-art split">
              <div className="half l">
                <SwatchArt s={SWATCHES[0]} uid="sys-a" />
              </div>
              <div className="half r">
                <SwatchArt s={SWATCHES[1]} uid="sys-b" />
              </div>
            </div>
            <div className="theme-name">Match system</div>
            <div className="theme-note">Alpenglow at night, Glacier by day</div>
          </button>
        </div>
      </Section>
      <Section title="Interface">
        <Card>
          <div className="stack" style={{ gap: 20 }}>
            <Field row label="Text size" hint="Scales the whole interface.">
              <div style={{ width: 220 }}>
                <Slider value={a.fontScale} min={0.85} max={1.25} step={0.05} onChange={(v) => set({ fontScale: v })} format={(v) => `${Math.round(v * 100)}%`} />
              </div>
            </Field>
            <Field row label="Mountain backdrops" hint="Show the drawn ridgelines behind headings.">
              <Switch checked={a.ridgelines} onChange={(v) => set({ ridgelines: v })} />
            </Field>
            <Field row label="Reduce motion" hint="Turns off drifting and fading animations.">
              <Switch checked={a.reduceMotion} onChange={(v) => set({ reduceMotion: v })} />
            </Field>
          </div>
        </Card>
      </Section>
    </>
  )
}

function Chat() {
  const c = useApp((s) => s.settings!.chat)
  const update = useApp((s) => s.update)
  const set = (p: Partial<typeof c>) => update((s) => ({ chat: { ...s.chat, ...p } }))
  return (
    <>
      <Section title="Defaults for every chat" subtitle="You can still change these for a single chat from its settings button.">
        <Card>
          <div className="stack" style={{ gap: 20 }}>
            <Field label="System prompt" hint="Sets the assistant's character and rules.">
              <TextField multiline rows={5} value={c.systemPrompt} onCommit={(v) => set({ systemPrompt: v })} />
            </Field>
            <Field label="Temperature" hint="Lower is more focused, higher is more creative.">
              <Slider value={c.temperature} min={0} max={2} step={0.05} onChange={(v) => set({ temperature: v })} format={(v) => v.toFixed(2)} />
            </Field>
            <Field label="Top P">
              <Slider value={c.topP} min={0.05} max={1} step={0.05} onChange={(v) => set({ topP: v })} format={(v) => v.toFixed(2)} />
            </Field>
            <Field row label="Thinking" hint="Whether reasoning models think before answering. Auto leaves each model's own default alone. Each chat can override this from the message box. Works with models running in Cairn, Ollama and other servers on this network, and OpenRouter.">
              <Segmented value={c.thinking ?? 'auto'} onChange={(v) => set({ thinking: v })} options={[{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
            </Field>
            <Field row label="Longest reply" hint="0 lets the model decide.">
              <NumberField value={c.maxTokens} min={0} max={200000} suffix="tokens" onCommit={(v) => set({ maxTokens: v })} />
            </Field>
          </div>
        </Card>
      </Section>
      <Section title="Behavior">
        <Card>
          <div className="stack" style={{ gap: 20 }}>
            <Field row label="Enter sends the message" hint="Otherwise use Ctrl+Enter, and Enter adds a new line.">
              <Switch checked={c.sendOnEnter} onChange={(v) => set({ sendOnEnter: v })} />
            </Field>
            <Field row label="Name chats automatically" hint="Uses your model to write a short title after the first reply.">
              <Switch checked={c.autoTitle} onChange={(v) => set({ autoTitle: v })} />
            </Field>
            <Field row label="Turn tools on in new chats" hint="Lets the assistant use files, commands and the web, with your approval.">
              <Switch checked={c.toolsDefault} onChange={(v) => set({ toolsDefault: v })} />
            </Field>
            <Field row label="Notice when I ask for a picture" hint="Messages like “draw me a lake” go to the image model without typing /imagine.">
              <Switch checked={c.detectImageIntent} onChange={(v) => set({ detectImageIntent: v })} />
            </Field>
            <Field row label="Steps per request" hint="How many tool calls the assistant may chain before it stops and waits for you. 0 means no limit; you can always press Stop.">
              <NumberField value={c.maxAgentSteps} min={0} step={5} onCommit={(v) => set({ maxAgentSteps: v })} />
            </Field>
            <Field row label="Tool output limit" hint="Longest tool result sent back to the model, in characters. 0 means no limit: files, pages and command output are sent whole. Very long results use up the model's memory quickly.">
              <NumberField value={c.toolOutputLimit} min={0} step={1000} onCommit={(v) => set({ toolOutputLimit: v })} />
            </Field>
            <Field row label="Memory budget" hint="Older messages are trimmed to stay under this many tokens. 0 chooses automatically.">
              <NumberField value={c.contextBudget} min={0} max={2000000} step={1024} onCommit={(v) => set({ contextBudget: v })} />
            </Field>
          </div>
        </Card>
      </Section>
    </>
  )
}

function Agent() {
  const a = useApp((s) => s.settings!.agent)
  const update = useApp((s) => s.update)
  const set = (p: Partial<typeof a>) => update((s) => ({ agent: { ...s.agent, ...p } }))
  return (
    <>
      <Section title="Working folder" subtitle="The folder the assistant may read and change. It cannot touch files outside it unless you allow that below.">
        <Card>
          <div className="stack" style={{ gap: 20 }}>
            <Field label="Default folder" hint="Each chat can pick its own from the composer.">
              <PathField kind="folder" value={a.workspace} onCommit={(v) => set({ workspace: v })} title="Choose a default working folder" placeholder="Not set" />
            </Field>
            <Field row label="Allow files outside the folder" hint="Each access still asks for approval.">
              <Switch checked={a.allowOutsideWorkspace} onChange={(v) => set({ allowOutsideWorkspace: v })} />
            </Field>
          </div>
        </Card>
      </Section>
      <Section title="Approvals">
        <Card>
          <div className="stack" style={{ gap: 20 }}>
            <Field row label="Approve everything automatically" hint="The assistant will write files, delete files and run commands without asking. Only turn this on for work you could undo.">
              <Switch checked={a.autoApproveAll} onChange={(v) => set({ autoApproveAll: v })} />
            </Field>
            {a.autoApproveAll && <Notice tone="warn">Automatic approval is on. Commands and file changes run immediately.</Notice>}
          </div>
        </Card>
      </Section>
      <Section title="Shell and web">
        <Card>
          <div className="stack" style={{ gap: 20 }}>
            <Field row label="Command shell" hint="Used by the run-command tool.">
              <Select value={a.shell} onChange={(v) => set({ shell: v })} options={[{ value: 'auto', label: 'Automatic' }, { value: 'powershell', label: 'PowerShell' }, { value: 'cmd', label: 'Command Prompt' }, { value: 'bash', label: 'Bash' }, { value: 'sh', label: 'sh' }]} />
            </Field>
            <Field row label="Command time limit">
              <NumberField value={a.shellTimeoutSec} min={5} max={3600} suffix="s" onCommit={(v) => set({ shellTimeoutSec: v })} />
            </Field>
            <Field label="Web search server" hint="Optional address of your own SearXNG. Without one, a built-in search is used.">
              <TextField mono value={a.searxngUrl} onCommit={(v) => set({ searxngUrl: v.trim() })} placeholder="http://127.0.0.1:8888" />
            </Field>
          </div>
        </Card>
      </Section>
    </>
  )
}

function Storage() {
  const p = useApp((s) => s.settings!.paths)
  const system = useApp((s) => s.system)
  const update = useApp((s) => s.update)
  const toast = useApp((s) => s.toast)
  const set = (patch: Partial<typeof p>) => update((s) => ({ paths: { ...s.paths, ...patch } }))
  const [adding, setAdding] = useState(false)
  const addDir = async () => {
    setAdding(true)
    try {
      const dir = await invoke('system:selectFolder', 'Add a folder that contains models')
      if (dir && !p.extraModelDirs.includes(dir)) set({ extraModelDirs: [...p.extraModelDirs, dir] })
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setAdding(false)
    }
  }
  return (
    <>
      <Section title="Where models live" subtitle="Cairn reads GGUF chat models and image weights from these folders, and saves downloads into the first one.">
        <Card>
          <div className="stack" style={{ gap: 20 }}>
            <Field label="Models folder">
              <PathField kind="folder" value={p.modelsDir} onCommit={(v) => set({ modelsDir: v })} title="Choose the models folder" />
            </Field>
            <Field label="More folders to scan" hint="Handy if you already keep models from LM Studio, Ollama or ComfyUI somewhere.">
              <div className="stack" style={{ gap: 8 }}>
                {p.extraModelDirs.map((d) => (
                  <div key={d} className="row">
                    <span className="grow mono small ellipsis" title={d}>
                      {d}
                    </span>
                    <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => set({ extraModelDirs: p.extraModelDirs.filter((x) => x !== d) })}>
                      Remove
                    </Button>
                  </div>
                ))}
                <div>
                  <Button size="sm" icon={<Plus size={14} />} busy={adding} onClick={() => void addDir()}>
                    Add folder
                  </Button>
                </div>
              </div>
            </Field>
          </div>
        </Card>
      </Section>
      <Section title="Downloads" subtitle="Used when you search for or download models.">
        <Card>
          <div className="stack" style={{ gap: 20 }}>
            <Field label="Hugging Face address" hint="Change this to use a mirror if huggingface.co is slow or blocked where you are.">
              <TextField mono value={p.hfEndpoint} onCommit={(v) => set({ hfEndpoint: v.trim() })} placeholder="https://huggingface.co" />
            </Field>
            <Field label="Hugging Face token" hint="Optional. Needed for gated models and gives you higher download limits. Stored encrypted.">
              <TextField secret mono value={p.hfToken} onCommit={(v) => set({ hfToken: v.trim() })} placeholder="hf_…" />
            </Field>
            <Field label="Civitai API key" hint="Needed for many Civitai downloads. Stored encrypted.">
              <TextField secret mono value={p.civitaiToken} onCommit={(v) => set({ civitaiToken: v.trim() })} />
            </Field>
          </div>
        </Card>
      </Section>
      <Section title="App data" subtitle="Chats, pictures and settings are kept here.">
        <Card>
          <div className="row">
            <span className="grow mono small ellipsis selectable" title={system?.dataDir}>
              {system?.dataDir}
            </span>
            <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => system && void invoke('system:openPath', system.dataDir)}>
              Open
            </Button>
          </div>
        </Card>
      </Section>
    </>
  )
}

function About() {
  const system = useApp((s) => s.system)
  const platformName = system ? ({ win32: 'Windows', linux: 'Linux', darwin: 'macOS' } as Record<string, string>)[system.platform] ?? system.platform : ''
  return (
    <div className="about">
      <div className="about-art">
        <Ridgeline seed={3} layers={4} animate />
        <div className="about-logo">
          <Logo size={54} />
        </div>
      </div>
      <h2>Cairn</h2>
      <p className="dim">Chat with any model, give it tools, and make pictures. All on your own computer.</p>
      <div className="about-meta mono small">
        <span>Version {system?.appVersion}</span>
        <span>
          {platformName} · {system?.arch}
        </span>
      </div>
      <div className="row" style={{ justifyContent: 'center', marginTop: 18 }}>
        <Button onClick={() => system && void invoke('system:openPath', system.dataDir)}>Open data folder</Button>
        <Button onClick={() => system && void invoke('system:openPath', system.modelsDir)}>Open models folder</Button>
      </div>
    </div>
  )
}

export function SettingsView() {
  const tab = useApp((s) => s.settingsTab)
  const setView = useApp((s) => s.setView)
  const ridges = useApp((s) => s.settings?.appearance.ridgelines)
  return (
    <div className="page">
      {ridges && (
        <div className="hero-ridge">
          <Ridgeline seed={14} layers={4} />
        </div>
      )}
      <div className="page-inner narrow">
        <div className="page-head">
          <div>
            <h1>Settings</h1>
            <p>Everything is saved on this computer as you change it.</p>
          </div>
        </div>
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={cx('tab', tab === t.id && 'on')} onClick={() => setView('settings', t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'general' && <General />}
        {tab === 'chat' && <Chat />}
        {tab === 'agent' && <Agent />}
        {tab === 'storage' && <Storage />}
        {tab === 'about' && <About />}
      </div>
    </div>
  )
}

