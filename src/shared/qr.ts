import qrcode from 'qrcode-generator'

/**
 * Turns text into the squares of a QR code, so a phone's own camera can read a link off the computer's screen.
 * The drawing is a single SVG path, which stays sharp at any size.
 */

export type QrLevel = 'L' | 'M' | 'Q' | 'H'

/** The squares of the code, row by row; true is a dark one. Medium error correction survives a smudge or a screen glare. */
export function qrModules(text: string, level: QrLevel = 'M'): boolean[][] {
  const qr = qrcode(0, level)
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const rows: boolean[][] = []
  for (let r = 0; r < n; r++) {
    const row: boolean[] = []
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c))
    rows.push(row)
  }
  return rows
}

/** An SVG path covering every dark square, runs merged so a code of 40 × 40 squares stays a few kilobytes. `size` includes the quiet zone. */
export function qrSvgPath(modules: boolean[][], margin = 4): { path: string; size: number } {
  const n = modules.length
  const parts: string[] = []
  for (let y = 0; y < n; y++) {
    let x = 0
    while (x < n) {
      if (!modules[y][x]) {
        x++
        continue
      }
      let end = x
      while (end < n && modules[y][end]) end++
      parts.push(`M${x + margin} ${y + margin}h${end - x}v1h${x - end}z`)
      x = end
    }
  }
  return { path: parts.join(''), size: n + margin * 2 }
}
