import fsp from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, nativeImage, powerSaveBlocker, protocol, safeStorage, shell } from 'electron'
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import { INVOKE_CHANNELS } from '../shared/ipc'
import { setEventSink } from './events'
import { type Handlers, type PlatformApi, buildHandlers } from './ipc'
import { resolveMedia } from './media'
import type { Cipher } from './secrets'
import { type Services, createServices } from './services'

const isDev = !app.isPackaged
const DEV_URL = process.env['ELECTRON_RENDERER_URL']

/* ───────────────────────────── process-level setup ───────────────────────────── */

// AppImages cannot ship a setuid chrome-sandbox helper, so Chromium's SUID sandbox is unavailable there.
if (process.platform === 'linux' && (process.env.APPIMAGE || process.env.CAIRN_NO_SANDBOX)) {
  app.commandLine.appendSwitch('no-sandbox')
}
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform-hint', 'auto')

// A portable Windows build keeps its data next to the executable.
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
const dataDir = process.env.CAIRN_DATA_DIR || (portableDir ? path.join(portableDir, 'Cairn-data') : app.getPath('userData'))
if (portableDir || process.env.CAIRN_DATA_DIR) app.setPath('userData', dataDir)

protocol.registerSchemesAsPrivileged([{ scheme: 'cairn-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void boot()
}

/* ───────────────────────────── helpers ───────────────────────────── */

let services: Services | null = null
let mainWindow: BrowserWindow | null = null
let quitting = false

const BG = '#0e1215'

function makeCipher(): Cipher {
  const usable = () => {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false
      // On Linux without a keyring Electron falls back to a hard-coded key, which is not real protection.
      if (process.platform === 'linux') return safeStorage.getSelectedStorageBackend() !== 'basic_text'
      return true
    } catch {
      return false
    }
  }
  return {
    available: usable,
    encrypt: (plain) => new Uint8Array(safeStorage.encryptString(plain)),
    decrypt: (data) => safeStorage.decryptString(Buffer.from(data))
  }
}

function makeThumb(data: Uint8Array, maxEdge: number): Uint8Array | null {
  try {
    let img = nativeImage.createFromBuffer(Buffer.from(data))
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    const scale = maxEdge / Math.max(width, height)
    if (scale < 1) img = img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' })
    return new Uint8Array(img.toJPEG(84))
  } catch {
    return null
  }
}

/** Keep attached images to a size vision models accept comfortably. */
function prepareImage(data: Uint8Array, mime: string): { data: Uint8Array; mime: string } | null {
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(data))
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    const longest = Math.max(width, height)
    if (longest <= 2048 && data.length <= 6 * 1024 * 1024) return null
    const scale = Math.min(1, 2048 / longest)
    const out = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }) : img
    return /png/i.test(mime) ? { data: new Uint8Array(out.toPNG()), mime: 'image/png' } : { data: new Uint8Array(out.toJPEG(90)), mime: 'image/jpeg' }
  } catch {
    return null
  }
}

function platformApi(): PlatformApi {
  const parent = () => mainWindow ?? undefined
  return {
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    home: app.getPath('home'),
    async selectFolder(title) {
      const r = await dialog.showOpenDialog(parent()!, { title: title ?? 'Choose a folder', properties: ['openDirectory', 'createDirectory'] })
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
    async selectFile(title, extensions, defaultPath) {
      const r = await dialog.showOpenDialog(parent()!, {
        title: title ?? 'Choose a file',
        defaultPath,
        properties: ['openFile'],
        filters: extensions?.length ? [{ name: 'Files', extensions }, { name: 'All files', extensions: ['*'] }] : undefined
      })
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
    async saveFile(defaultName, extensions) {
      const r = await dialog.showSaveDialog(parent()!, { defaultPath: path.join(app.getPath('downloads'), defaultName), filters: [{ name: extensions.join(', ').toUpperCase(), extensions }] })
      return r.canceled ? null : (r.filePath ?? null)
    },
    async openPath(p) {
      const err = await shell.openPath(p)
      if (err) throw new Error(err)
    },
    showItem: (p) => shell.showItemInFolder(p),
    openExternal: (url) => shell.openExternal(url),
    setTitleBar(colors) {
      if (process.platform === 'win32') {
        try {
          mainWindow?.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor, height: 38 })
          mainWindow?.setBackgroundColor(colors.color)
        } catch {
          /* window may be closing */
        }
      } else {
        mainWindow?.setBackgroundColor(colors.color)
      }
    }
  }
}

function isTrusted(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  if (DEV_URL && url.startsWith(DEV_URL)) return true
  return url.startsWith('file://') && url.endsWith('index.html')
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { label: 'File', submenu: [{ role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(isDev ? ([{ type: 'separator' }, { role: 'toggleDevTools' }, { role: 'reload' }] as MenuItemConstructorOptions[]) : [])]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Cairn',
    backgroundColor: BG,
    icon: nativeImage.createFromPath(path.join(app.getAppPath(), 'resources/icon.png')),
    autoHideMenuBar: true,
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: BG, symbolColor: '#c8d3d8', height: 38 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  })

  win.once('ready-to-show', () => win.show())

  // Links never navigate the app window; web links open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const inApp = (DEV_URL && url.startsWith(DEV_URL)) || url.startsWith('file://')
    if (!inApp) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  // Right-click menu for text fields and selections.
  win.webContents.on('context-menu', (_e, params) => {
    const items: MenuItemConstructorOptions[] = []
    if (params.isEditable) {
      for (const s of params.dictionarySuggestions.slice(0, 4)) items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) })
      if (params.dictionarySuggestions.length) items.push({ type: 'separator' })
      items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' })
    } else if (params.selectionText) {
      items.push({ role: 'copy' }, { role: 'selectAll' })
    }
    if (params.linkURL && /^https?:\/\//i.test(params.linkURL)) {
      if (items.length) items.push({ type: 'separator' })
      items.push({ label: 'Open link in browser', click: () => void shell.openExternal(params.linkURL) }, { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) })
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
  })

  if (isDev) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) win.webContents.toggleDevTools()
    })
  }

  if (DEV_URL) void win.loadURL(DEV_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  return win
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, payload)
  }
}

/* ───────────────────────────── boot ───────────────────────────── */

async function boot(): Promise<void> {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  await app.whenReady()
  app.setAppUserModelId('app.cairn.desktop')

  setEventSink((channel, payload) => broadcast(channel, payload))
  services = await createServices({
    dataDir,
    cipher: makeCipher(),
    makeThumb,
    prepareImage,
    appVersion: app.getVersion(),
    // The phone companion web app is built next to the interface (out/remote).
    remoteClientDir: path.join(__dirname, '../remote'),
    // Keeps the computer awake (the screen may still turn off) while phones can connect.
    keepAwake: { start: () => powerSaveBlocker.start('prevent-app-suspension'), stop: (id) => powerSaveBlocker.stop(id) }
  })
  const handlers: Handlers = buildHandlers(services, platformApi())

  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrusted(event)) throw new Error('Blocked: request did not come from the app window.')
      return (handlers[channel] as (...a: unknown[]) => unknown)(...args)
    })
  }

  // Generated images, thumbnails and attachments are served from disk through a locked-down scheme.
  const paths = services.paths
  protocol.handle('cairn-media', async (request) => {
    const target = resolveMedia(paths, request.url)
    if (!target) return new Response('Not found', { status: 404 })
    for (const file of target.candidates) {
      try {
        const data = await fsp.readFile(file)
        return new Response(data, { headers: { 'Content-Type': target.mime, 'Cache-Control': 'max-age=31536000, immutable' } })
      } catch {
        /* try the next candidate */
      }
    }
    return new Response('Not found', { status: 404 })
  })

  buildMenu()
  mainWindow = createWindow()
  mainWindow.on('closed', () => (mainWindow = null))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (e) => {
    if (quitting || !services) return
    e.preventDefault()
    quitting = true
    const done = services.shutdown().catch(() => {})
    // Never hang on exit: give background processes a few seconds to stop.
    void Promise.race([done, new Promise((r) => setTimeout(r, 6000))]).then(() => app.exit(0))
  })
}
