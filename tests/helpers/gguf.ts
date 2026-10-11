/** Builds small GGUF files for tests: real headers (settings and tensor list) with zeroed weights. */
export type GgufKV =
  | ['u32' | 'u64' | 'i32' | 'f32' | 'bool', unknown]
  | ['str', string]
  | ['arr', 'u32' | 'i32' | 'str' | 'bool', unknown[]]

export interface GgufSpec {
  kv: [string, ...GgufKV][]
  /** Weights in bytes per tensor, in the order they are listed. */
  tensors: { name: string; bytes: number }[]
  version?: 1 | 2 | 3
  alignment?: number
}

const TYPE: Record<string, number> = { u32: 4, i32: 5, f32: 6, bool: 7, str: 8, arr: 9, u64: 10 }

export function buildGguf(spec: GgufSpec): Buffer {
  const version = spec.version ?? 3
  const wide = version >= 2
  const align = spec.alignment ?? 32
  const parts: Buffer[] = []
  const u32 = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(n)
    return b
  }
  const i32 = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeInt32LE(n)
    return b
  }
  const u64 = (n: number) => {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(BigInt(n))
    return b
  }
  const count = (n: number) => (wide ? u64(n) : u32(n))
  const str = (s: string) => Buffer.concat([count(Buffer.byteLength(s)), Buffer.from(s, 'utf8')])
  const scalar = (t: string, v: unknown): Buffer => {
    switch (t) {
      case 'u32':
        return u32(v as number)
      case 'i32':
        return i32(v as number)
      case 'u64':
        return u64(v as number)
      case 'f32': {
        const b = Buffer.alloc(4)
        b.writeFloatLE(v as number)
        return b
      }
      case 'bool':
        return Buffer.from([v ? 1 : 0])
      default:
        return str(v as string)
    }
  }

  parts.push(Buffer.from('GGUF'), u32(version), count(spec.tensors.length), count(spec.kv.length))
  for (const [key, ...rest] of spec.kv) {
    parts.push(str(key))
    if (rest[0] === 'arr') {
      const [, inner, items] = rest as ['arr', string, unknown[]]
      parts.push(u32(TYPE.arr), u32(TYPE[inner]), count(items.length))
      for (const x of items) parts.push(scalar(inner, x))
    } else {
      const [t, v] = rest as [string, unknown]
      parts.push(u32(TYPE[t]), scalar(t, v))
    }
  }
  let offset = 0
  const offsets: number[] = []
  for (const t of spec.tensors) {
    parts.push(str(t.name), u32(1), count(Math.max(1, Math.floor(t.bytes / 4))), u32(0), u64(offset))
    offsets.push(offset)
    offset += Math.ceil(t.bytes / align) * align
  }
  const head = Buffer.concat(parts)
  const pad = Buffer.alloc(Math.ceil(head.length / align) * align - head.length)
  // The last tensor runs to the end of the file, so it is not padded.
  const last = spec.tensors[spec.tensors.length - 1]
  const dataBytes = last ? offsets[offsets.length - 1] + last.bytes : 0
  return Buffer.concat([head, pad, Buffer.alloc(dataBytes)])
}
