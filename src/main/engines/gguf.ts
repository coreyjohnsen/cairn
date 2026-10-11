import fsp from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { ModelShape } from '@shared/types'

/**
 * Reads the header of a GGUF model file (its settings and the list of its tensors, never the weights themselves) to learn
 * how big the model's parts are. The memory planner uses that to work out what fits in video memory and what has to go to RAM.
 * Format: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
 */

const CHUNK = 1 << 20
const MAX_ITEMS_KEPT = 4096

export interface GgufArray {
  length: number
  /** The values, when the array is short enough to keep (per-layer lists); long ones (the vocabulary) are only counted. */
  items: (number | string | boolean)[] | null
}
export type GgufValue = number | string | boolean | GgufArray

export interface GgufTensor {
  name: string
  offset: number
  /** Bytes of weights, worked out from where the next tensor starts. */
  size: number
}

export interface GgufHeader {
  version: number
  kv: Map<string, GgufValue>
  tensors: GgufTensor[]
  fileBytes: number
}

class Reader {
  private buf: Buffer = Buffer.alloc(0)
  private off = 0
  /** Position in the file of the next byte to read. */
  pos = 0

  constructor(
    private fd: FileHandle,
    private size: number
  ) {}

  private async fill(n: number): Promise<void> {
    let have = this.buf.length - this.off
    if (have >= n) return
    const parts: Buffer[] = [this.buf.subarray(this.off)]
    let at = this.pos + have
    while (have < n) {
      if (at >= this.size) throw new Error('The file ends in the middle of its header. It is probably damaged or not fully downloaded.')
      const len = Math.min(Math.max(CHUNK, n - have), this.size - at)
      const chunk = Buffer.allocUnsafe(len)
      const { bytesRead } = await this.fd.read(chunk, 0, len, at)
      if (!bytesRead) throw new Error('Could not read the model file.')
      parts.push(chunk.subarray(0, bytesRead))
      at += bytesRead
      have += bytesRead
    }
    this.buf = Buffer.concat(parts)
    this.off = 0
  }

  async u8(): Promise<number> {
    await this.fill(1)
    const v = this.buf.readUInt8(this.off)
    this.off += 1
    this.pos += 1
    return v
  }
  async u16(): Promise<number> {
    await this.fill(2)
    const v = this.buf.readUInt16LE(this.off)
    this.off += 2
    this.pos += 2
    return v
  }
  async u32(): Promise<number> {
    await this.fill(4)
    const v = this.buf.readUInt32LE(this.off)
    this.off += 4
    this.pos += 4
    return v
  }
  async i32(): Promise<number> {
    await this.fill(4)
    const v = this.buf.readInt32LE(this.off)
    this.off += 4
    this.pos += 4
    return v
  }
  async f32(): Promise<number> {
    await this.fill(4)
    const v = this.buf.readFloatLE(this.off)
    this.off += 4
    this.pos += 4
    return v
  }
  async f64(): Promise<number> {
    await this.fill(8)
    const v = this.buf.readDoubleLE(this.off)
    this.off += 8
    this.pos += 8
    return v
  }
  async u64(): Promise<number> {
    await this.fill(8)
    const v = this.buf.readBigUInt64LE(this.off)
    this.off += 8
    this.pos += 8
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('A number in the model file is too large to read.')
    return Number(v)
  }
  async i64(): Promise<number> {
    await this.fill(8)
    const v = this.buf.readBigInt64LE(this.off)
    this.off += 8
    this.pos += 8
    return Number(v)
  }

  async skip(n: number): Promise<void> {
    const have = this.buf.length - this.off
    if (n <= have) {
      this.off += n
      this.pos += n
      return
    }
    if (this.pos + n > this.size) throw new Error('The file ends in the middle of its header.')
    // Past the buffer: jump straight there.
    this.pos += n
    this.buf = Buffer.alloc(0)
    this.off = 0
  }

  async str(wide: boolean, max = 1 << 20): Promise<string> {
    const len = wide ? await this.u64() : await this.u32()
    if (len > max) throw new Error('A name in the model file is far too long, so the file is probably damaged.')
    await this.fill(len)
    const s = this.buf.toString('utf8', this.off, this.off + len)
    this.off += len
    this.pos += len
    return s
  }

  async skipStr(wide: boolean): Promise<void> {
    const len = wide ? await this.u64() : await this.u32()
    await this.skip(len)
  }
}

/** Value types, by number. */
const FIXED_SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }

async function scalar(r: Reader, type: number, wide: boolean): Promise<number | string | boolean> {
  switch (type) {
    case 0:
      return r.u8()
    case 1: {
      const v = await r.u8()
      return v > 127 ? v - 256 : v
    }
    case 2:
      return r.u16()
    case 3: {
      const v = await r.u16()
      return v > 32767 ? v - 65536 : v
    }
    case 4:
      return r.u32()
    case 5:
      return r.i32()
    case 6:
      return r.f32()
    case 7:
      return (await r.u8()) !== 0
    case 8:
      return r.str(wide)
    case 10:
      return r.u64()
    case 11:
      return r.i64()
    case 12:
      return r.f64()
    default:
      throw new Error(`The model file uses a value type (${type}) this version of Cairn does not know.`)
  }
}

async function value(r: Reader, type: number, wide: boolean): Promise<GgufValue> {
  if (type !== 9) return scalar(r, type, wide)
  const inner = await r.u32()
  const length = wide ? await r.u64() : await r.u32()
  if (inner === 9) throw new Error('Nested lists in a model file are not supported.')
  if (length > MAX_ITEMS_KEPT) {
    // The vocabulary and the merge list: only the count matters.
    if (inner === 8) for (let i = 0; i < length; i++) await r.skipStr(wide)
    else await r.skip(length * (FIXED_SIZE[inner] ?? 0))
    return { length, items: null }
  }
  const items: (number | string | boolean)[] = []
  for (let i = 0; i < length; i++) items.push(await scalar(r, inner, wide))
  return { length, items }
}

/** Reads one GGUF file's header. */
export async function readGgufHeader(file: string): Promise<GgufHeader> {
  const fh = await fsp.open(file, 'r')
  try {
    const size = (await fh.stat()).size
    const r = new Reader(fh, size)
    const magic = Buffer.from([await r.u8(), await r.u8(), await r.u8(), await r.u8()]).toString('latin1')
    if (magic !== 'GGUF') throw new Error('This is not a GGUF model file.')
    const version = await r.u32()
    if (version < 1 || version > 3) throw new Error(`This model file is version ${version}, which this version of Cairn does not know.`)
    const wide = version >= 2
    const tensorCount = wide ? await r.u64() : await r.u32()
    const kvCount = wide ? await r.u64() : await r.u32()
    if (tensorCount > 1_000_000 || kvCount > 1_000_000) throw new Error('The header of this model file looks damaged.')

    const kv = new Map<string, GgufValue>()
    for (let i = 0; i < kvCount; i++) {
      const key = await r.str(wide, 4096)
      const type = await r.u32()
      kv.set(key, await value(r, type, wide))
    }

    const infos: { name: string; offset: number }[] = []
    for (let i = 0; i < tensorCount; i++) {
      const name = await r.str(wide, 4096)
      const dims = await r.u32()
      if (dims > 8) throw new Error('A tensor in the model file has an impossible shape.')
      for (let d = 0; d < dims; d++) wide ? await r.u64() : await r.u32()
      await r.u32() // type
      const offset = await r.u64()
      infos.push({ name, offset })
    }

    const alignRaw = kv.get('general.alignment')
    const align = typeof alignRaw === 'number' && alignRaw > 0 ? alignRaw : 32
    const dataStart = Math.ceil(r.pos / align) * align
    const dataBytes = Math.max(0, size - dataStart)
    // A tensor runs to the start of the next one (the last one to the end of the file).
    const order = [...infos].sort((a, b) => a.offset - b.offset)
    const sizes = new Map<string, number>()
    order.forEach((t, i) => sizes.set(t.name, Math.max(0, (order[i + 1]?.offset ?? dataBytes) - t.offset)))
    return { version, kv, tensors: infos.map((t) => ({ name: t.name, offset: t.offset, size: sizes.get(t.name) ?? 0 })), fileBytes: size }
  } finally {
    await fh.close()
  }
}

/* ───────────── from header to the shape the planner uses ───────────── */

/** How often a layer looks at everything (the others only at a window of recent text): every Nth layer, by model family. */
const SWA_PERIOD: Record<string, number> = { gemma2: 2, gemma3: 6, gemma3n: 5, cohere2: 4, 'gpt-oss': 2, exaone4: 4 }

/** Designs that keep a running state instead of (or as well as) a cache, which the estimate does not cover. */
const NOT_PLAIN = /mamba|rwkv|jamba|nemotron_h|granitehybrid|lfm2|falcon-h1|falcon_h1|qwen3next|bamba|plamo2|delta|xlstm/i

const num = (v: GgufValue | undefined): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** A setting that is one number for the model or a list with one per layer: the average and the largest. */
function perLayer(v: GgufValue | undefined, layers: number): { avg: number; max: number } | undefined {
  const n = num(v)
  if (n !== undefined) return { avg: n, max: n }
  if (v && typeof v === 'object' && v.items && v.items.length) {
    const items = v.items.filter((x): x is number => typeof x === 'number')
    if (!items.length) return undefined
    const used = items.slice(0, layers)
    return { avg: used.reduce((a, b) => a + b, 0) / Math.max(1, used.length), max: Math.max(...used) }
  }
  return undefined
}

const BLOCK = /^blk\.(\d+)\.(.+)$/
const EXPERT = /(?:^|\.)ffn_(?:gate|up|down|gate_up)_exps(?:\.|$)|^ffn_(?:gate|up|down)\.\d+\.weight$/

export function shapeFromHeaders(headers: GgufHeader[], mmprojBytes = 0): ModelShape {
  const first = headers[0]
  const kv = first.kv
  const arch = typeof kv.get('general.architecture') === 'string' ? (kv.get('general.architecture') as string) : ''
  const key = (k: string) => kv.get(`${arch}.${k}`)
  const layers = num(key('block_count'))
  const embedding = num(key('embedding_length'))
  if (!arch || !layers || !embedding) throw new Error('This GGUF file does not describe a language model (it has no layer count), so its memory use cannot be worked out.')
  let rough = NOT_PLAIN.test(arch)

  const headsInfo = perLayer(key('attention.head_count'), layers)
  const heads = Math.max(1, Math.round(headsInfo?.max ?? 1))
  if (!headsInfo) rough = true
  const kvInfo = perLayer(key('attention.head_count_kv'), layers)
  const kvHeads = kvInfo ? kvInfo.avg : heads
  const headDimK = num(key('attention.key_length')) ?? Math.round(embedding / heads)
  const headDimV = num(key('attention.value_length')) ?? headDimK
  const loraRank = num(key('attention.kv_lora_rank'))
  const ropeDim = num(key('rope.dimension_count'))
  const mlaDim = loraRank ? loraRank + (ropeDim ?? 64) : undefined

  const experts = num(key('expert_count')) ?? 0
  const expertsUsed = num(key('expert_used_count')) ?? (experts ? 1 : 0)
  const slidingWindow = num(key('attention.sliding_window')) ?? 0

  // Which layers keep only a window of recent text: the model file says so, or the family is known, or we assume none (the safe side).
  let swaLayers: boolean[] | null = null
  const pattern = key('attention.sliding_window_pattern')
  if (slidingWindow > 0) {
    if (pattern && typeof pattern === 'object' && pattern.items && pattern.items.length >= layers) swaLayers = pattern.items.slice(0, layers).map((x) => Boolean(x))
    else if (typeof pattern === 'number' && pattern > 1) swaLayers = Array.from({ length: layers }, (_, i) => i % pattern < pattern - 1)
    else if (SWA_PERIOD[arch]) swaLayers = Array.from({ length: layers }, (_, i) => i % SWA_PERIOD[arch] < SWA_PERIOD[arch] - 1)
    else rough = true
  }

  const layerBytes = new Array<number>(layers).fill(0)
  const layerExpertBytes = new Array<number>(layers).fill(0)
  let embedBytes = 0
  let outputWeight = 0
  let outputNorm = 0
  let otherBytes = 0
  for (const h of headers) {
    for (const t of h.tensors) {
      const m = BLOCK.exec(t.name)
      if (m) {
        const i = Number(m[1])
        if (i < layers) {
          layerBytes[i] += t.size
          if (EXPERT.test(m[2])) layerExpertBytes[i] += t.size
        } else otherBytes += t.size
      } else if (t.name === 'token_embd.weight' || t.name.startsWith('per_layer_token_embd')) embedBytes += t.size
      else if (t.name === 'output.weight') outputWeight += t.size
      else if (t.name === 'output_norm.weight' || t.name === 'output_norm.bias') outputNorm += t.size
      else otherBytes += t.size
    }
  }
  const outputTied = outputWeight === 0
  const fileBytes = headers.reduce((a, h) => a + h.fileBytes, 0)
  return {
    arch,
    name: typeof kv.get('general.name') === 'string' ? (kv.get('general.name') as string) : undefined,
    fileBytes,
    layers,
    embedding,
    heads,
    kvHeads,
    headDimK,
    headDimV,
    mlaDim,
    trainedContext: num(key('context_length')) ?? 0,
    experts,
    expertsUsed,
    slidingWindow,
    swaLayers,
    layerBytes,
    layerExpertBytes,
    embedBytes,
    outputBytes: outputTied ? embedBytes + outputNorm : outputWeight + outputNorm,
    outputTied,
    otherBytes,
    rough,
    mmprojBytes
  }
}

/** The other parts of a model that is split over several files (`-00001-of-00004.gguf`), starting from the first. */
export function splitParts(file: string): string[] {
  const m = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i.exec(file)
  if (!m) return [file]
  const total = Number(m[3])
  if (!(total > 1 && total <= 999)) return [file]
  return Array.from({ length: total }, (_, i) => `${m[1]}-${String(i + 1).padStart(5, '0')}-of-${m[3]}.gguf`)
}

/** Reads a model (all its parts) and the size of its vision projector, if it has one. */
export async function readModelShape(file: string, mmproj?: string | null): Promise<ModelShape> {
  const headers: GgufHeader[] = []
  for (const part of splitParts(file)) headers.push(await readGgufHeader(part))
  let mmprojBytes = 0
  if (mmproj) {
    try {
      mmprojBytes = (await fsp.stat(mmproj)).size
    } catch {
      /* the projector is missing; the model still loads without it */
    }
  }
  return shapeFromHeaders(headers, mmprojBytes)
}
