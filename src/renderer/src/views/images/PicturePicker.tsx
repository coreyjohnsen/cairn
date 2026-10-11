import { useMemo, useState } from 'react'
import type { ImageRecord } from '@shared/types'
import { Modal, EmptyState } from '@/components/ui'
import { mediaUrl } from '@/lib/api'
import { useImages } from '@/store/images'
import { Images, Search } from 'lucide-react'

/** Choose one of the pictures already made as the starting picture. */
export function PicturePicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (rec: ImageRecord) => void }) {
  const records = useImages((s) => s.records)
  const [query, setQuery] = useState('')
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return records.filter((r) => !q || r.prompt.toLowerCase().includes(q)).slice(0, 80)
  }, [records, query])

  return (
    <Modal open={open} onClose={onClose} title="Choose a starting picture" width={680}>
      <div className="conv-search pick-search">
        <Search size={14} />
        <input placeholder="Search prompts" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} autoFocus />
      </div>
      {shown.length === 0 ? (
        <EmptyState icon={<Images size={22} />} title={records.length === 0 ? 'No pictures yet' : 'Nothing matches'}>
          {records.length === 0 ? 'Pictures you make appear here.' : 'Try another word.'}
        </EmptyState>
      ) : (
        <div className="pick-grid">
          {shown.map((r) => (
            <button key={r.id} type="button" className="pick-item" title={r.prompt} onClick={() => { onPick(r); onClose() }}>
              <img src={mediaUrl('thumb', r.thumb)} alt={r.prompt} loading="lazy" draggable={false} />
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}
