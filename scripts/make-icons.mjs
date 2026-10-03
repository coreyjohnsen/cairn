// Renders the Cairn mark into every icon file the packagers need.
// Runs inside Electron (it already ships a browser that can rasterise SVG):  npm run icons
// Outputs: build/icon.png (1024), build/icon.ico (Windows), build/icons/<n>x<n>.png (Linux), resources/icon.png (window icon)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (!process.versions.electron) {
  // Re-launch ourselves under Electron.
  const electron = (await import('electron')).default
  const args = [fileURLToPath(import.meta.url)]
  if (process.platform === 'linux') args.unshift('--no-sandbox')
  const r = spawnSync(electron, args, { stdio: 'inherit', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')) })
  process.exit(r.status ?? 1)
}

const { app, BrowserWindow, nativeImage } = await import('electron')

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b2230"/><stop offset="0.6" stop-color="#3a3345"/><stop offset="1" stop-color="#8a5a52"/>
    </linearGradient>
    <linearGradient id="stone" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffc59a"/><stop offset="1" stop-color="#ee8f6a"/>
    </linearGradient>
    <linearGradient id="far" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6a6482"/><stop offset="1" stop-color="#34324a"/>
    </linearGradient>
    <linearGradient id="near" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a2a3d"/><stop offset="1" stop-color="#14151f"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#sky)"/>
  <circle cx="738" cy="318" r="70" fill="#ffd9b8" opacity="0.92"/>
  <path d="M0 640 L190 430 L290 540 L360 480 L450 600 L574 600 L690 470 L790 560 L870 500 L1024 650 L1024 1024 L0 1024 Z" fill="url(#far)"/>
  <path d="M190 430 L150 476 L186 462 L206 486 L228 460 L250 478 Z" fill="#efe0da" opacity="0.85"/>
  <path d="M690 470 L650 512 L684 500 L704 522 L728 498 L752 516 Z" fill="#efe0da" opacity="0.85"/>
  <path d="M0 790 L170 726 L330 782 L512 716 L700 786 L860 730 L1024 790 L1024 1024 L0 1024 Z" fill="url(#near)"/>
  <ellipse cx="512" cy="768" rx="200" ry="70" fill="url(#stone)"/>
  <ellipse cx="496" cy="626" rx="144" ry="62" fill="url(#stone)" opacity="0.93"/>
  <ellipse cx="522" cy="508" rx="94" ry="50" fill="url(#stone)" opacity="0.88"/>
  <ellipse cx="510" cy="416" rx="50" ry="36" fill="url(#stone)" opacity="0.82"/>
</svg>`

/** Cut the square art into a rounded tile with real transparency (a window cannot give us alpha under X). */
function roundTile(img, inset, radius) {
  const { width: w, height: h } = img.getSize()
  const src = img.toBitmap()
  const out = Buffer.alloc(src.length)
  const cx = w / 2
  const cy = h / 2
  const half = w / 2 - inset
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = Math.max(Math.abs(x + 0.5 - cx) - (half - radius), 0)
      const dy = Math.max(Math.abs(y + 0.5 - cy) - (half - radius), 0)
      const d = Math.hypot(dx, dy) - radius
      const a = Math.min(1, Math.max(0, 0.5 - d))
      const i = (y * w + x) * 4
      out[i] = Math.round(src[i] * a)
      out[i + 1] = Math.round(src[i + 1] * a)
      out[i + 2] = Math.round(src[i + 2] * a)
      out[i + 3] = Math.round(255 * a)
    }
  }
  return nativeImage.createFromBitmap(out, { width: w, height: h })
}

function ico(images) {
  // images: [{ size, png: Buffer }] — PNG-compressed entries (Windows Vista and later).
  const head = Buffer.alloc(6)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(16 * images.length)
  let offset = head.length + dir.length
  images.forEach((im, i) => {
    const o = i * 16
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, o)
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, o + 1)
    dir.writeUInt8(0, o + 2)
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(im.png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += im.png.length
  })
  return Buffer.concat([head, dir, ...images.map((i) => i.png)])
}

app.disableHardwareAcceleration()

async function main() {
// Render once at 1024 on a transparent window, then scale down with nativeImage (high quality).
const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, webPreferences: { offscreen: true } })
win.webContents.setZoomFactor(1)
await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>html,body{margin:0;background:transparent;overflow:hidden}</style>${SVG}`))
await new Promise((r) => setTimeout(r, 400))
const full = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
const flat = full.getSize().width === 1024 ? full : full.resize({ width: 1024, height: 1024, quality: 'best' })
const master = roundTile(flat, 48, 210)

const out = (p) => {
  const f = path.join(root, p)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  return f
}
const png = (size) => (size === 1024 ? master : master.resize({ width: size, height: size, quality: 'best' })).toPNG()

fs.writeFileSync(out('build/icon.png'), png(1024))
fs.writeFileSync(out('resources/icon.png'), png(256))
for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) fs.writeFileSync(out(`build/icons/${s}x${s}.png`), png(s))
fs.writeFileSync(out('build/icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png(size) }))))
console.log('Icons written to build/ and resources/')
}

// Electron only emits 'ready' after the entry module finishes evaluating, so never await it at the top level.
app.whenReady().then(main).then(() => app.quit(), (e) => { console.error(e); app.exit(1) })
