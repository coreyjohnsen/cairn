import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { PromptAlias } from '@shared/types'
import { newId } from '@shared/defaults'
import { aliasProblem } from '@shared/imagePrefs'
import { useApp } from '@/store/app'
import { Button, IconButton, Modal, TextField } from './ui'

function AliasRow({ alias, all, onSave, onDelete }: { alias: PromptAlias; all: PromptAlias[]; onSave: (a: PromptAlias) => void; onDelete: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const commit = (patch: Partial<PromptAlias>) => {
    const next = { ...alias, ...patch }
    const problem = aliasProblem(next.name, next.text, all, alias.id)
    setError(problem)
    if (!problem) onSave(next)
  }
  return (
    <div className="alias-row">
      <div className="alias-head">
        <TextField className="grow" mono value={alias.name} onCommit={(v) => commit({ name: v.trim() })} ariaLabel="Alias name" />
        <IconButton label="Delete alias" size="sm" danger onClick={onDelete}>
          <Trash2 size={14} />
        </IconButton>
      </div>
      <TextField multiline rows={2} value={alias.text} onCommit={(v) => commit({ text: v.trim() })} ariaLabel="Expands to" spellCheck />
      {error && <div className="xs lora-warn">{error}</div>}
    </div>
  )
}

/** Create, edit and delete prompt aliases: a short word or phrase that is replaced by a longer text when a picture is made. */
export function AliasManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const aliases = useApp((s) => s.settings?.image.aliases) ?? []
  const update = useApp((s) => s.update)
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const save = (next: PromptAlias[]) => update((s) => ({ image: { ...s.image, aliases: next } }))
  const add = () => {
    const problem = aliasProblem(name, text, aliases)
    setError(problem)
    if (problem) return
    save([...aliases, { id: newId('alias-'), name: name.trim(), text: text.trim() }])
    setName('')
    setText('')
  }

  return (
    <Modal open={open} onClose={onClose} title="Prompt aliases" width={620} tall>
      <div className="stack" style={{ gap: 14 }}>
        <div className="small dim">
          Type an alias in an image prompt and it is replaced by the longer text when the picture is made. It works as a whole word or phrase and ignores capitals, so an alias called <code>cabin</code> changes
          "a Cabin at dawn" but not "cabins". An alias is replaced once: other aliases inside its text are left alone. It is used in the prompt and the "Avoid" text, for pictures made from the Image Hub, from chat, and by tools.
        </div>

        <div className="alias-row">
          <div className="small" style={{ fontWeight: 600 }}>New alias</div>
          <TextField value={name} onDraft={setName} onCommit={setName} placeholder="What you type, for example: moody" ariaLabel="New alias name" mono onEnter={add} />
          <TextField multiline rows={3} value={text} onDraft={setText} onCommit={setText} placeholder="What it becomes, for example: dramatic lighting, volumetric fog, muted colours, film grain" ariaLabel="New alias text" spellCheck />
          {error && <div className="xs lora-warn">{error}</div>}
          <div>
            <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={add}>
              Add alias
            </Button>
          </div>
        </div>

        {aliases.length === 0 ? (
          <div className="small faint">No aliases yet.</div>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            <strong className="small">Your aliases ({aliases.length})</strong>
            {aliases.map((a) => (
              <AliasRow key={a.id} alias={a} all={aliases} onSave={(next) => save(aliases.map((x) => (x.id === a.id ? next : x)))} onDelete={() => save(aliases.filter((x) => x.id !== a.id))} />
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
