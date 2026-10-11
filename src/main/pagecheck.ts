import { randomUUID } from 'node:crypto'
import type { PageOptions, PageReport } from './tools/types'

const LOAD_TIMEOUT_MS = 20000
const MAX_TEXT = 600
const MAX_LIST = 25

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type Level = 'error' | 'warning' | 'info'

/** Electron reports the console level as a number (older) or a word (newer). */
function levelOf(v: unknown): Level {
  if (v === 3 || v === 'error') return 'error'
  if (v === 2 || v === 'warning') return 'warning'
  return 'info'
}

/**
 * Open a page in a hidden, sandboxed browser window with its own throw-away storage, let it run, and collect what went wrong:
 * console errors and uncaught exceptions, files that did not load, and what the page shows. The page cannot reach Node.
 */
export async function runPageInBrowser(url: string, opts: PageOptions): Promise<PageReport> {
  const { BrowserWindow, session } = await import('electron')
  const ses = session.fromPartition(`cairn-page-check-${randomUUID()}`)
  const report: PageReport = { url, title: '', errors: [], warnings: [], failedRequests: [], text: '', clicks: [], expected: [] }
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses, backgroundThrottling: false }
  })
  const wc = win.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('console-message', (...a: unknown[]) => {
    const first = a[0] as { level?: unknown; message?: unknown; lineNumber?: unknown; sourceId?: unknown }
    const d = typeof first?.message === 'string' ? first : { level: a[1], message: a[2], lineNumber: a[3], sourceId: a[4] }
    const where = d.sourceId ? ` (${String(d.sourceId).replace(/^file:\/\/\/?/, '').split('/').slice(-2).join('/')}:${String(d.lineNumber ?? '')})` : ''
    const text = `${String(d.message)}${where}`
    const level = levelOf(d.level)
    if (/Electron Security Warning/.test(text)) return // Electron's own notice about the test window, not the page's
    if (level === 'error') report.errors.push(text)
    else if (level === 'warning') report.warnings.push(text)
  })
  wc.on('render-process-gone', (_e, details) => {
    report.crashed = true
    report.errors.push(`The page crashed (${(details as { reason?: string }).reason ?? 'unknown'}).`)
  })
  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (code === -3) return // aborted by a redirect or navigation
    const msg = `${desc} (${code}): ${failedUrl}`
    if (isMainFrame) report.loadError = msg
    else report.failedRequests.push(msg)
  })
  ses.webRequest.onErrorOccurred((d) => report.failedRequests.push(`${d.error}: ${d.url}`))
  ses.webRequest.onCompleted((d) => {
    if (d.statusCode >= 400) report.failedRequests.push(`HTTP ${d.statusCode}: ${d.url}`)
  })

  const abort = () => win.destroy()
  opts.signal.addEventListener('abort', abort, { once: true })
  try {
    await Promise.race([wc.loadURL(url), sleep(LOAD_TIMEOUT_MS).then(() => Promise.reject(new Error('The page did not finish loading in 20 seconds.')))]).catch((e) => {
      if (!report.loadError) report.loadError = e instanceof Error ? e.message : String(e)
    })
    if (win.isDestroyed()) throw new Error('Cancelled.')
    if (!report.loadError) {
      await sleep(Math.max(0, Math.min(15000, opts.waitMs)))
      const exec = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
      for (const selector of opts.expect) {
        const found = await exec<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`).catch(() => false)
        report.expected.push({ selector, found })
      }
      for (const selector of opts.click) {
        const found = await exec<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`).catch(() => false)
        report.clicks.push({ selector, found })
        await sleep(400)
      }
      report.title = await exec<string>('document.title').catch(() => '')
      report.text = (await exec<string>('(document.body && document.body.innerText) || ""').catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
    }
  } finally {
    opts.signal.removeEventListener('abort', abort)
    if (!win.isDestroyed()) win.destroy()
    report.errors = [...new Set(report.errors)].slice(0, MAX_LIST)
    report.warnings = [...new Set(report.warnings)].slice(0, MAX_LIST)
    report.failedRequests = [...new Set(report.failedRequests)].slice(0, MAX_LIST)
  }
  return report
}
