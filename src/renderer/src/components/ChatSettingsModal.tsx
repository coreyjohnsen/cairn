import type { ConversationParams, ThinkingMode } from '@shared/types'
import { useApp } from '@/store/app'
import { useChat } from '@/store/chat'
import { Button, Field, Modal, Segmented, Slider, TextField } from './ui'

export function ChatSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useApp((s) => s.settings)!
  const conv = useChat((s) => (s.activeId ? s.cache[s.activeId] : undefined))
  const draft = useChat((s) => s.draft)
  const patchActive = useChat((s) => s.patchActive)
  const params: ConversationParams = conv?.params ?? draft.params ?? {}
  const systemPrompt = conv?.systemPrompt ?? draft.systemPrompt ?? ''

  const setParam = (key: 'temperature' | 'topP' | 'maxTokens', value: number | undefined) => {
    const next = { ...params }
    if (value === undefined) delete next[key]
    else next[key] = value
    patchActive({ params: next })
  }
  const thinking: ThinkingMode = params.thinking ?? settings.chat.thinking ?? 'auto'
  // Always stored explicitly, so "Auto" in one chat still beats a different default in Settings.
  const setThinking = (m: ThinkingMode) => patchActive({ params: { ...params, thinking: m } })
  const temperature = params.temperature ?? settings.chat.temperature
  const topP = params.topP ?? settings.chat.topP

  return (
    <Modal open={open} onClose={onClose} title="Chat settings" width={560} footer={<Button onClick={onClose}>Done</Button>}>
      <div className="stack" style={{ gap: 20, paddingTop: 6 }}>
        <Field label="System prompt" hint="Instructions for this chat only. Leave empty to use the default from Settings → Chat.">
          <TextField multiline rows={6} value={systemPrompt} onCommit={(v) => patchActive({ systemPrompt: v })} placeholder={settings.chat.systemPrompt.slice(0, 120) || 'You are a helpful assistant.'} />
        </Field>
        <Field label="Thinking" hint="Whether a reasoning model thinks before it answers. Auto leaves the model's own default alone. Works with models running in Cairn, Ollama and other servers on this network, and OpenRouter; other connections ignore it.">
          <Segmented value={thinking} onChange={setThinking} options={[{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
        </Field>
        <Field label="Temperature" hint="Lower is more focused, higher is more creative.">
          <div className="row">
            <Slider value={temperature} min={0} max={2} step={0.05} onChange={(v) => setParam('temperature', v)} format={(v) => v.toFixed(2)} />
            {params.temperature !== undefined && (
              <Button variant="ghost" size="sm" onClick={() => setParam('temperature', undefined)}>
                Reset
              </Button>
            )}
          </div>
        </Field>
        <Field label="Top P">
          <div className="row">
            <Slider value={topP} min={0.05} max={1} step={0.05} onChange={(v) => setParam('topP', v)} format={(v) => v.toFixed(2)} />
            {params.topP !== undefined && (
              <Button variant="ghost" size="sm" onClick={() => setParam('topP', undefined)}>
                Reset
              </Button>
            )}
          </div>
        </Field>
        <Field label="Max response tokens" hint="0 lets the model decide.">
          <Slider value={params.maxTokens ?? settings.chat.maxTokens} min={0} max={32768} step={256} onChange={(v) => setParam('maxTokens', v || undefined)} format={(v) => (v === 0 ? 'auto' : String(v))} />
        </Field>
      </div>
    </Modal>
  )
}
