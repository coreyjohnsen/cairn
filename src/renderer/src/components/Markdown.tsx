import { Check, Copy } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { invoke } from '@/lib/api'
import { prepareMath } from '@/lib/math'

interface HastNode {
  type?: string
  value?: string
  children?: HastNode[]
  properties?: { className?: string[] }
}

function nodeText(n: HastNode | undefined): string {
  if (!n) return ''
  if (n.type === 'text') return n.value ?? ''
  return (n.children ?? []).map(nodeText).join('')
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="copy-btn"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1400)
        })
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      <span>{done ? 'Copied' : label}</span>
    </button>
  )
}

function CodeBlock({ node, children }: { node?: HastNode; children?: React.ReactNode }) {
  const code = node?.children?.[0]
  const lang = (code?.properties?.className ?? []).find((c) => c.startsWith('language-'))?.slice(9) ?? ''
  const text = nodeText(code).replace(/\n$/, '')
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang || 'text'}</span>
        <CopyButton text={text} />
      </div>
      <pre>{children}</pre>
    </div>
  )
}

const components = {
  pre: CodeBlock as never,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault()
        if (href && /^(https?:|mailto:)/i.test(href)) void invoke('system:openExternal', href).catch(() => {})
      }}
    >
      {children}
    </a>
  ),
  // Remote images are blocked by the app's security policy: show the description instead of a broken box.
  img: ({ alt, src }: { alt?: string; src?: string }) => <span className="md-img-blocked">{alt || src}</span>,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  )
}

const remarkPlugins = [remarkGfm, remarkMath]
// Formulas first: they arrive as code elements that the highlighter would otherwise look at.
const rehypePlugins = [[rehypeKatex, { throwOnError: false, strict: false, output: 'html' }], [rehypeHighlight, { detect: false, ignoreMissing: true }]] as never

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const prepared = useMemo(() => prepareMath(text), [text])
  return (
    <div className="markdown selectable">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {prepared}
      </ReactMarkdown>
    </div>
  )
})
