/** Minimal byte sequences with valid headers, enough for code that sniffs type and size. */
export function fakePng(width: number, height: number, tag = 0): Uint8Array {
  const b = Buffer.alloc(64)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  b[24] = 8
  b[25] = 6
  b[40] = tag & 0xff // makes otherwise-identical images distinguishable
  return new Uint8Array(b)
}

export function fakeJpeg(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(40)
  b[0] = 0xff
  b[1] = 0xd8
  // APP0 segment
  b[2] = 0xff
  b[3] = 0xe0
  b.writeUInt16BE(6, 4)
  // SOF0 segment
  b[10] = 0xff
  b[11] = 0xc0
  b.writeUInt16BE(11, 12)
  b[14] = 8
  b.writeUInt16BE(height, 15)
  b.writeUInt16BE(width, 17)
  return new Uint8Array(b)
}

export function fakeWebpVp8x(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(40)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(32, 4)
  b.write('WEBP', 8, 'ascii')
  b.write('VP8X', 12, 'ascii')
  b.writeUInt32LE(10, 16)
  b.writeUIntLE(width - 1, 24, 3)
  b.writeUIntLE(height - 1, 27, 3)
  return new Uint8Array(b)
}
