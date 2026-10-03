/** Read pixel dimensions from PNG / JPEG / WebP headers without decoding the image. */
export function imageSize(d: Uint8Array): { width: number; height: number } | null {
  if (d.length < 24) return null
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength)

  // PNG: signature + IHDR
  if (d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) {
    const width = dv.getUint32(16)
    const height = dv.getUint32(20)
    return width > 0 && height > 0 ? { width, height } : null
  }

  // JPEG: walk segments until a start-of-frame marker
  if (d[0] === 0xff && d[1] === 0xd8) {
    let i = 2
    while (i + 9 < d.length) {
      if (d[i] !== 0xff) {
        i++
        continue
      }
      let marker = d[i + 1]
      while (marker === 0xff && i + 2 < d.length) {
        i++
        marker = d[i + 1]
      }
      i += 2
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (marker === 0xd9 || marker === 0xda) break
      const len = dv.getUint16(i)
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) {
        const height = dv.getUint16(i + 3)
        const width = dv.getUint16(i + 5)
        return width > 0 && height > 0 ? { width, height } : null
      }
      i += len
    }
    return null
  }

  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X
  if (d[0] === 0x52 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x46 && d[8] === 0x57 && d[9] === 0x45 && d[10] === 0x42 && d[11] === 0x50) {
    const fourcc = String.fromCharCode(d[12], d[13], d[14], d[15])
    if (fourcc === 'VP8X' && d.length >= 30) {
      return { width: 1 + (d[24] | (d[25] << 8) | (d[26] << 16)), height: 1 + (d[27] | (d[28] << 8) | (d[29] << 16)) }
    }
    if (fourcc === 'VP8 ' && d.length >= 30) {
      return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff }
    }
    if (fourcc === 'VP8L' && d.length >= 25) {
      const b = dv.getUint32(21, true)
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
    }
  }
  return null
}
