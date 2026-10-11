import type { SlashCommand } from '@shared/commands'
import { cx } from '@/lib/format'

/** The commands that match what is being typed, above the message box. Picking one fills it in. */
export function SlashMenu({ items, index, onPick, onHover }: { items: SlashCommand[]; index: number; onPick: (c: SlashCommand) => void; onHover?: (i: number) => void }) {
  if (items.length === 0) return null
  return (
    <div className="slash-menu" role="listbox" aria-label="Commands">
      {items.map((c, i) => (
        <button
          key={c.id}
          type="button"
          role="option"
          aria-selected={i === index}
          className={cx('slash-item', i === index && 'on')}
          // Pressing must not take focus from the message box.
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover?.(i)}
          onClick={() => onPick(c)}
        >
          <span className="slash-name mono">{c.name}</span>
          {c.arg !== 'none' && <span className="slash-hint faint xs">{c.arg === 'optional' ? `[${c.hint}]` : `<${c.hint}>`}</span>}
          <span className="slash-desc small dim">{c.description}</span>
        </button>
      ))}
    </div>
  )
}
