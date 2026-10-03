import { Sparkles, Tags, Undo2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { AliasManager } from '@/components/AliasManager'
import { Button } from '@/components/ui'
import { invoke } from '@/lib/api'
import { errorText } from '@/lib/format'
import { useApp } from '@/store/app'
import { useImages } from '@/store/images'
import { expandAliases } from '@shared/imagePrefs'

/** The prompt, with aliases and "Enhance". It edits the Image Hub's one prompt, wherever it is shown. */
export function PromptBox({ rows = 4, placeholder, onSubmit, autoFocus }: { rows?: number; placeholder?: string; onSubmit(): void; autoFocus?: boolean }) {
  const settings = useApp((s) => s.settings)!
  const toast = useApp((s) => s.toast)
  const prompt = useImages((s) => s.form.prompt)
  const setForm = useImages((s) => s.setForm)
  const [enhancing, setEnhancing] = useState(false)
  const [before, setBefore] = useState<string | null>(null)
  const [aliasesOpen, setAliasesOpen] = useState(false)

  // Aliases the user typed, shown as they will be sent.
  const expanded = useMemo(() => expandAliases(prompt, settings.image.aliases), [prompt, settings.image.aliases])

  const enhance = async () => {
    const p = prompt.trim()
    if (!p) return
    setEnhancing(true)
    try {
      const out = await invoke('chat:enhance', p)
      if (out && out.trim()) {
        setBefore(prompt)
        setForm({ prompt: out.trim() })
      }
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setEnhancing(false)
    }
  }

  return (
    <>
      <div className="prompt-box">
        <textarea
          className="prompt-input"
          rows={rows}
          value={prompt}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onChange={(e) => setForm({ prompt: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              onSubmit()
            }
          }}
          spellCheck
        />
        <div className="prompt-tools">
          {before !== null && (
            <Button variant="ghost" size="sm" icon={<Undo2 size={14} />} onClick={() => { setForm({ prompt: before }); setBefore(null) }} title="Go back to what you wrote">
              Undo
            </Button>
          )}
          <Button variant="ghost" size="sm" icon={<Tags size={14} />} onClick={() => setAliasesOpen(true)} title="Words you type here that are replaced by longer text when the picture is made">
            Aliases{(settings.image.aliases?.length ?? 0) > 0 ? ` (${settings.image.aliases!.length})` : ''}
          </Button>
          <Button variant="ghost" size="sm" icon={<Sparkles size={14} />} busy={enhancing} disabled={!prompt.trim()} onClick={() => void enhance()} title="Let your chat model rewrite the prompt with more visual detail">
            Enhance
          </Button>
        </div>
      </div>
      {expanded.used.length > 0 && (
        <div className="alias-preview xs" title="This is the text the picture is made from">
          <span className="faint">Sent as ({expanded.used.join(', ')}): </span>
          {expanded.text}
        </div>
      )}
      <AliasManager open={aliasesOpen} onClose={() => setAliasesOpen(false)} />
    </>
  )
}
