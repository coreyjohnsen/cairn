import { ChevronRight, Download, ExternalLink, Eye, Heart, Search } from 'lucide-react'
import { useState } from 'react'
import { type ImageFolder, guessImageFolder, suggestModelName } from '@shared/naming'
import type { CivitaiHit, HfFile, HfModelHit } from '@shared/types'
import { Badge, Button, EmptyState, Spinner } from '@/components/ui'
import { invoke } from '@/lib/api'
import { baseName, cx, errorText, formatBytes, formatCount } from '@/lib/format'
import { useApp } from '@/store/app'
import { startDownload } from './shared'

const REPO_RE = /^[\w.-]+\/[\w.-]+$/
const SPLIT_RE = /-\d{5}-of-\d{5}/

function hfPage(repo: string): string {
  const base = (useApp.getState().settings?.paths.hfEndpoint || 'https://huggingface.co').replace(/\/+$/, '')
  return `${base}/${repo}`
}

function parseRepo(q: string): string | null {
  const s = q.trim()
  const m = s.match(/^https?:\/\/(?:www\.)?huggingface\.co\/([\w.-]+\/[\w.-]+)/i)
  if (m) return m[1]
  return REPO_RE.test(s) && !s.includes(' ') ? s : null
}

const FOLDER_NAME: Record<string, string> = { 'image/vae': 'VAE', 'image/lora': 'LoRA', 'image/upscale': 'upscaler', 'image/text-encoders': 'text encoder', 'image/embeddings': 'embedding' }
const CIVITAI_FOLDER: Record<string, ImageFolder> = { Checkpoint: 'image', LORA: 'image/lora', VAE: 'image/vae', Upscaler: 'image/upscale', TextualInversion: 'image/embeddings' }

interface Props {
  kind: 'llm' | 'image'
  subdir: string
  accept: (path: string) => boolean
  placeholder: string
  suggestions?: string[]
}

/** Search Hugging Face, or paste a repo / link, then pick files to download. */
export function HfBrowser({ kind, subdir, accept, placeholder, suggestions }: Props) {
  const toast = useApp((s) => s.toast)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [hits, setHits] = useState<HfModelHit[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [files, setFiles] = useState<Record<string, HfFile[] | 'loading' | string>>({})
  // Image files go in different folders depending on what they are; "auto" goes by the file name.
  const [saveAs, setSaveAs] = useState<'auto' | ImageFolder>('auto')
  const folderFor = (repo: string, f: HfFile): string => (kind !== 'image' ? subdir : saveAs === 'auto' ? guessImageFolder(f.path, repo, f.size) : saveAs)

  const loadFiles = async (repo: string) => {
    setFiles((f) => ({ ...f, [repo]: 'loading' }))
    try {
      const list = await invoke('hf:files', repo)
      setFiles((f) => ({ ...f, [repo]: list }))
    } catch (e) {
      setFiles((f) => ({ ...f, [repo]: errorText(e) }))
    }
  }

  const toggle = (repo: string) => {
    setOpen((o) => (o === repo ? null : repo))
    if (!files[repo] || typeof files[repo] === 'string') void loadFiles(repo)
  }

  const search = async (text = q) => {
    const query = text.trim()
    if (!query) return
    const direct = parseRepo(query)
    setBusy(true)
    try {
      if (direct) {
        setHits([{ id: direct, downloads: 0, likes: 0, tags: [] }])
        setOpen(direct)
        void loadFiles(direct)
      } else {
        const res = await invoke('hf:search', query, kind)
        setHits(res)
        setOpen(null)
      }
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const download = async (repo: string, f: HfFile, all: HfFile[]) => {
    // Split GGUFs (-00001-of-00003) only load when every part is present.
    const group = SPLIT_RE.test(f.path) ? all.filter((x) => x.path.replace(SPLIT_RE, '') === f.path.replace(SPLIT_RE, '')) : [f]
    // Only the first part of a split model is listed and loaded, so it carries the name.
    const modelName = kind === 'llm' ? suggestModelName(repo, f.path) : undefined
    for (const part of group) {
      const lead = !SPLIT_RE.test(part.path) || /-00001-of-/.test(part.path)
      await startDownload({ url: part.url, subdir: folderFor(repo, part), filename: baseName(part.path), source: 'hf', label: `${repo.split('/')[1] ?? repo} · ${baseName(part.path)}`, ...(modelName && lead ? { modelName } : {}) })
    }
  }

  const openPage = (url: string) => {
    void invoke('system:openExternal', url).catch((e) => toast('error', errorText(e)))
  }

  return (
    <div className="stack">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          void search()
        }}
      >
        <div className="conv-search grow" style={{ margin: 0, height: 38 }}>
          <Search size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} spellCheck={false} />
        </div>
        <Button type="submit" busy={busy} disabled={!q.trim()}>
          Search
        </Button>
      </form>
      {kind === 'image' && (
        <div className="row small">
          <span className="faint">Save files to</span>
          <div className="select" style={{ width: 230 }}>
            <select value={saveAs} onChange={(e) => setSaveAs(e.target.value as 'auto' | ImageFolder)} aria-label="Folder for downloaded files">
              <option value="auto">Automatic, by file name</option>
              <option value="image">Models (image)</option>
              <option value="image/vae">VAE</option>
              <option value="image/lora">LoRA</option>
              <option value="image/upscale">Upscaler</option>
              <option value="image/text-encoders">Text encoders</option>
            </select>
            <svg className="select-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      )}
      {suggestions && !hits && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="faint small">Try:</span>
          {suggestions.map((s) => (
            <button key={s} type="button" className="chip-pill" onClick={() => { setQ(s); void search(s) }}>
              {s}
            </button>
          ))}
        </div>
      )}
      {hits && hits.length === 0 && (
        <EmptyState title="No matches">Try fewer words, or paste a Hugging Face link such as huggingface.co/owner/model.</EmptyState>
      )}
      {hits && hits.length > 0 && (
        <div className="result-list">
          {hits.map((h) => {
            const isOpen = open === h.id
            const list = files[h.id]
            return (
              <div key={h.id} className={cx('result', isOpen && 'open')}>
                <div className="result-top">
                  <button type="button" className="result-head" onClick={() => toggle(h.id)} aria-expanded={isOpen}>
                    <ChevronRight size={15} className="result-chev" />
                    <span className="grow ellipsis">{h.id}</span>
                    {h.downloads > 0 && (
                      <span className="faint xs">
                        <Download size={11} /> {formatCount(h.downloads)}
                      </span>
                    )}
                    {h.likes > 0 && (
                      <span className="faint xs">
                        <Heart size={11} /> {formatCount(h.likes)}
                      </span>
                    )}
                  </button>
                  <Button size="sm" variant="ghost" className="result-link" icon={<ExternalLink size={13} />} title={`Open ${h.id} on the Hugging Face website`} onClick={() => openPage(hfPage(h.id))}>
                    Open page
                  </Button>
                </div>
                {isOpen && (
                  <div className="result-body">
                    {list === 'loading' && (
                      <div className="faint small row">
                        <Spinner size={14} /> Reading file list…
                      </div>
                    )}
                    {typeof list === 'string' && list !== 'loading' && <div className="dl-err selectable">{list}</div>}
                    {Array.isArray(list) &&
                      (list.filter((f) => accept(f.path)).length === 0 ? (
                        <div className="faint small">No matching files in this repository.</div>
                      ) : (
                        list
                          .filter((f) => accept(f.path))
                          .map((f) => {
                            const isMm = /mmproj/i.test(f.path)
                            const split = SPLIT_RE.test(f.path)
                            return (
                              <div key={f.path} className="file-row">
                                <span className="grow ellipsis mono small" title={f.path}>
                                  {f.path}
                                </span>
                                {isMm && (
                                  <Badge tone="info" title="Vision projector: download it next to a vision-capable model">
                                    <Eye size={11} /> vision
                                  </Badge>
                                )}
                                {split && <Badge title="Split into several files; all parts are downloaded together">split</Badge>}
                                {kind === 'image' && folderFor(h.id, f) !== 'image' && <Badge title={`Will be saved in the ${folderFor(h.id, f).replace('image/', '')} folder`}>{FOLDER_NAME[folderFor(h.id, f)] ?? folderFor(h.id, f)}</Badge>}
                                <span className="faint xs mono">{formatBytes(f.size)}</span>
                                <Button size="sm" icon={<Download size={14} />} onClick={() => void download(h.id, f, list)}>
                                  Get
                                </Button>
                              </div>
                            )
                          })
                      ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ───────────── Civitai ───────────── */

export function CivitaiBrowser({ hasToken }: { hasToken: boolean }) {
  const toast = useApp((s) => s.toast)
  const [q, setQ] = useState('')
  const [type, setType] = useState('Checkpoint')
  const [busy, setBusy] = useState(false)
  const [hits, setHits] = useState<CivitaiHit[] | null>(null)
  const [open, setOpen] = useState<number | null>(null)

  const search = async () => {
    if (!q.trim()) return
    setBusy(true)
    try {
      setHits(await invoke('civitai:search', q.trim(), type))
      setOpen(null)
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          void search()
        }}
      >
        <div className="conv-search grow" style={{ margin: 0, height: 38 }}>
          <Search size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Civitai checkpoints" spellCheck={false} />
        </div>
        <div className="select" style={{ width: 150 }}>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option>Checkpoint</option>
            <option>LORA</option>
            <option>VAE</option>
            <option>Upscaler</option>
            <option>TextualInversion</option>
          </select>
          <svg className="select-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <Button type="submit" busy={busy} disabled={!q.trim()}>
          Search
        </Button>
      </form>
      {!hasToken && <div className="faint small">Many files need a Civitai API key. Add yours in Settings, then Storage.</div>}
      {hits && hits.length === 0 && <EmptyState title="No matches">Try different words.</EmptyState>}
      {hits && hits.length > 0 && (
        <div className="result-list">
          {hits.map((h) => {
            const isOpen = open === h.id
            return (
              <div key={h.id} className={cx('result', isOpen && 'open')}>
                <div className="result-top">
                  <button type="button" className="result-head" onClick={() => setOpen(isOpen ? null : h.id)} aria-expanded={isOpen}>
                    <ChevronRight size={15} className="result-chev" />
                    <span className="grow ellipsis">{h.name}</span>
                    {h.creator && <span className="faint xs">{h.creator}</span>}
                    {h.downloads ? (
                      <span className="faint xs">
                        <Download size={11} /> {formatCount(h.downloads)}
                      </span>
                    ) : null}
                  </button>
                  <Button size="sm" variant="ghost" className="result-link" icon={<ExternalLink size={13} />} title={`Open ${h.name} on the Civitai website`} onClick={() => void invoke('system:openExternal', `https://civitai.com/models/${h.id}`).catch((e) => toast('error', errorText(e)))}>
                    Open page
                  </Button>
                </div>
                {isOpen && (
                  <div className="result-body">
                    {h.versions.slice(0, 4).map((v) => (
                      <div key={v.id} className="stack" style={{ gap: 4 }}>
                        <div className="small">
                          <b>{v.name}</b> {v.baseModel && <Badge>{v.baseModel}</Badge>}
                        </div>
                        {v.files.map((f) => (
                          <div key={f.id} className="file-row">
                            <span className="grow ellipsis mono small" title={f.name}>
                              {f.name}
                            </span>
                            {f.format && <Badge>{f.format}</Badge>}
                            <span className="faint xs mono">{formatBytes(f.sizeKB * 1024)}</span>
                            <Button size="sm" icon={<Download size={14} />} onClick={() => void startDownload({ url: f.downloadUrl, subdir: CIVITAI_FOLDER[type] ?? 'image', filename: f.name, source: 'civitai', label: `${h.name} · ${f.name}` })}>
                              Get
                            </Button>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
