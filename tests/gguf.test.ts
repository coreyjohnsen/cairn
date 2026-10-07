import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readGgufHeader, readModelShape, shapeFromHeaders, splitParts } from '../src/main/engines/gguf'
import { type GgufSpec, buildGguf } from './helpers/gguf'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-gguf-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const write = (name: string, spec: GgufSpec): string => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, buildGguf(spec))
  return file
}

/** A tiny dense model: 4 layers, embedding 64, 8 heads, 2 key/value heads. */
const dense = (extra: GgufSpec['kv'] = [], tied = false): GgufSpec => ({
  kv: [
    ['general.architecture', 'str', 'llama'],
    ['general.name', 'str', 'Tiny'],
    ['llama.block_count', 'u32', 4],
    ['llama.embedding_length', 'u32', 64],
    ['llama.attention.head_count', 'u32', 8],
    ['llama.attention.head_count_kv', 'u32', 2],
    ['llama.context_length', 'u32', 4096],
    ...extra
  ],
  tensors: [
    { name: 'token_embd.weight', bytes: 6400 },
    ...[0, 1, 2, 3].flatMap((i) => [
      { name: `blk.${i}.attn_q.weight`, bytes: 1000 + i * 100 },
      { name: `blk.${i}.ffn_down.weight`, bytes: 2000 },
      { name: `blk.${i}.attn_norm.weight`, bytes: 64 }
    ]),
    { name: 'output_norm.weight', bytes: 64 },
    ...(tied ? [] : [{ name: 'output.weight', bytes: 6400 }])
  ]
})

describe('reading a GGUF header', () => {
  it('reads settings of every kind and the sizes of the tensors', async () => {
    const f = write('a.gguf', {
      kv: [
        ['general.architecture', 'str', 'llama'],
        ['a.u32', 'u32', 7],
        ['a.u64', 'u64', 2 ** 40],
        ['a.f32', 'f32', 1.5],
        ['a.bool', 'bool', true],
        ['a.neg', 'i32', -3],
        ['a.list', 'arr', 'u32', [1, 2, 3]],
        ['a.words', 'arr', 'str', ['x', 'yy']]
      ],
      tensors: [
        { name: 'one', bytes: 100 },
        { name: 'two', bytes: 4000 },
        { name: 'three', bytes: 10 }
      ]
    })
    const h = await readGgufHeader(f)
    expect(h.version).toBe(3)
    expect(h.kv.get('general.architecture')).toBe('llama')
    expect(h.kv.get('a.u32')).toBe(7)
    expect(h.kv.get('a.u64')).toBe(2 ** 40)
    expect(h.kv.get('a.f32')).toBe(1.5)
    expect(h.kv.get('a.bool')).toBe(true)
    expect(h.kv.get('a.neg')).toBe(-3)
    expect(h.kv.get('a.list')).toEqual({ length: 3, items: [1, 2, 3] })
    expect(h.kv.get('a.words')).toEqual({ length: 2, items: ['x', 'yy'] })
    // Each tensor runs to the next one, padded to the file's alignment; the last runs to the end of the file.
    expect(h.tensors.map((t) => [t.name, t.size])).toEqual([['one', 128], ['two', 4000], ['three', 10]])
    expect(h.fileBytes).toBe(fs.statSync(f).size)
  })

  it('only counts a very long list, such as the vocabulary, and carries on correctly past it', async () => {
    const words = Array.from({ length: 150_000 }, (_, i) => `token${i}`)
    const f = write('vocab.gguf', {
      kv: [
        ['general.architecture', 'str', 'llama'],
        ['tokenizer.ggml.tokens', 'arr', 'str', words],
        ['tokenizer.ggml.scores', 'arr', 'i32', Array.from({ length: 9000 }, (_, i) => i)],
        ['llama.block_count', 'u32', 9]
      ],
      tensors: [{ name: 'blk.0.x', bytes: 256 }]
    })
    expect(fs.statSync(f).size).toBeGreaterThan(1_500_000)
    const h = await readGgufHeader(f)
    expect(h.kv.get('tokenizer.ggml.tokens')).toEqual({ length: 150_000, items: null })
    expect(h.kv.get('tokenizer.ggml.scores')).toEqual({ length: 9000, items: null })
    expect(h.kv.get('llama.block_count')).toBe(9)
    expect(h.tensors[0]).toMatchObject({ name: 'blk.0.x', size: 256 })
  })

  it('reads the older version 1 layout', async () => {
    const f = write('v1.gguf', { version: 1, kv: [['general.architecture', 'str', 'llama'], ['llama.block_count', 'u32', 2]], tensors: [{ name: 'blk.0.a', bytes: 64 }] })
    const h = await readGgufHeader(f)
    expect(h.version).toBe(1)
    expect(h.kv.get('llama.block_count')).toBe(2)
    expect(h.tensors[0].size).toBe(64)
  })

  it('refuses files that are not models, or are cut short', async () => {
    const bad = path.join(dir, 'bad.gguf')
    fs.writeFileSync(bad, 'this is not a model file at all')
    await expect(readGgufHeader(bad)).rejects.toThrow(/not a GGUF/)
    const whole = buildGguf(dense())
    const cut = path.join(dir, 'cut.gguf')
    fs.writeFileSync(cut, whole.subarray(0, 120))
    await expect(readGgufHeader(cut)).rejects.toThrow(/ends in the middle|damaged/)
    const future = path.join(dir, 'future.gguf')
    const b = Buffer.from(whole)
    b.writeUInt32LE(9, 4)
    fs.writeFileSync(future, b)
    await expect(readGgufHeader(future)).rejects.toThrow(/version 9/)
  })
})

describe('the shape of a model', () => {
  it('works out layers, heads and the weight of each part', async () => {
    const h = await readGgufHeader(write('d.gguf', dense()))
    const s = shapeFromHeaders([h])
    expect(s).toMatchObject({ arch: 'llama', name: 'Tiny', layers: 4, embedding: 64, heads: 8, kvHeads: 2, headDimK: 8, headDimV: 8, trainedContext: 4096, experts: 0, rough: false, outputTied: false })
    expect(s.layerBytes.length).toBe(4)
    expect(s.layerBytes[0]).toBeGreaterThanOrEqual(1000 + 2000 + 64)
    expect(s.layerBytes[3]).toBeGreaterThan(s.layerBytes[0])
    expect(s.layerExpertBytes.every((b) => b === 0)).toBe(true)
    expect(s.embedBytes).toBeGreaterThanOrEqual(6400)
    expect(s.outputBytes).toBeGreaterThanOrEqual(6400)
    expect(s.swaLayers).toBeNull()
  })

  it('treats a model without its own output layer as tied to the embeddings', async () => {
    const s = shapeFromHeaders([await readGgufHeader(write('t.gguf', dense([], true)))])
    expect(s.outputTied).toBe(true)
    expect(s.outputBytes).toBeGreaterThanOrEqual(s.embedBytes)
  })

  it('separates the routed experts of a mixture-of-experts model from the rest', async () => {
    const spec = dense([['llama.expert_count', 'u32', 8], ['llama.expert_used_count', 'u32', 2]])
    spec.tensors = [
      { name: 'token_embd.weight', bytes: 640 },
      ...[0, 1, 2, 3].flatMap((i) => [
        { name: `blk.${i}.attn_q.weight`, bytes: 512 },
        { name: `blk.${i}.ffn_gate_inp.weight`, bytes: 64 },
        { name: `blk.${i}.ffn_gate_exps.weight`, bytes: 4096 },
        { name: `blk.${i}.ffn_up_exps.weight`, bytes: 4096 },
        { name: `blk.${i}.ffn_down_exps.weight`, bytes: 4096 },
        { name: `blk.${i}.ffn_up_shexp.weight`, bytes: 256 }
      ]),
      { name: 'output.weight', bytes: 640 }
    ]
    const s = shapeFromHeaders([await readGgufHeader(write('m.gguf', spec))])
    expect(s.experts).toBe(8)
    expect(s.expertsUsed).toBe(2)
    expect(s.layerExpertBytes[1]).toBe(3 * 4096)
    expect(s.layerBytes[1] - s.layerExpertBytes[1]).toBeGreaterThanOrEqual(512 + 64 + 256)
    expect(s.layerBytes[1] - s.layerExpertBytes[1]).toBeLessThan(512 + 64 + 256 + 100)
  })

  it('knows which layers of a sliding-window family only see recent text', async () => {
    const spec = dense([['gemma3.attention.sliding_window', 'u32', 1024]])
    spec.kv = spec.kv.map((e) => (e[0] === 'general.architecture' ? ['general.architecture', 'str', 'gemma3'] : e[0].startsWith('llama.') ? ([e[0].replace('llama.', 'gemma3.'), ...e.slice(1)] as typeof e) : e))
    spec.kv = spec.kv.map((e) => (e[0] === 'gemma3.block_count' ? ['gemma3.block_count', 'u32', 12] : e))
    spec.tensors = [{ name: 'token_embd.weight', bytes: 64 }, ...Array.from({ length: 12 }, (_, i) => ({ name: `blk.${i}.attn_q.weight`, bytes: 128 }))]
    const s = shapeFromHeaders([await readGgufHeader(write('g.gguf', spec))])
    expect(s.swaLayers).toEqual(Array.from({ length: 12 }, (_, i) => i % 6 < 5))
    expect(s.swaLayers!.filter((x) => !x)).toHaveLength(2)
    expect(s.rough).toBe(false)
  })

  it('uses the model file’s own list of sliding-window layers when it has one', async () => {
    const spec = dense([['llama.attention.sliding_window', 'u32', 512], ['llama.attention.sliding_window_pattern', 'arr', 'bool', [true, false, true, false]]])
    const s = shapeFromHeaders([await readGgufHeader(write('p.gguf', spec))])
    expect(s.swaLayers).toEqual([true, false, true, false])
  })

  it('assumes the safe side, and says so, for a sliding-window family it does not know', async () => {
    const s = shapeFromHeaders([await readGgufHeader(write('u.gguf', dense([['llama.attention.sliding_window', 'u32', 512]])))])
    expect(s.swaLayers).toBeNull()
    expect(s.rough).toBe(true)
  })

  it('averages key/value heads that differ from layer to layer', async () => {
    const spec = dense()
    spec.kv = spec.kv.map((e) => (e[0] === 'llama.attention.head_count_kv' ? ['llama.attention.head_count_kv', 'arr', 'u32', [8, 8, 0, 0]] : e))
    const s = shapeFromHeaders([await readGgufHeader(write('v.gguf', spec))])
    expect(s.kvHeads).toBe(4)
  })

  it('reads the compressed cache of models that use one', async () => {
    const spec = dense([['llama.attention.kv_lora_rank', 'u32', 512], ['llama.rope.dimension_count', 'u32', 64]])
    const s = shapeFromHeaders([await readGgufHeader(write('mla.gguf', spec))])
    expect(s.mlaDim).toBe(576)
  })

  it('marks models that keep a running state as rough', async () => {
    const spec = dense()
    spec.kv = spec.kv.map((e) => (e[0] === 'general.architecture' ? ['general.architecture', 'str', 'mamba2'] : e[0].startsWith('llama.') ? ([e[0].replace('llama.', 'mamba2.'), ...e.slice(1)] as typeof e) : e))
    const s = shapeFromHeaders([await readGgufHeader(write('mamba.gguf', spec))])
    expect(s.rough).toBe(true)
  })

  it('refuses a file that is not a language model', async () => {
    const f = write('x.gguf', { kv: [['general.architecture', 'str', 'clip']], tensors: [{ name: 'v.a', bytes: 32 }] })
    const h = await readGgufHeader(f)
    expect(() => shapeFromHeaders([h])).toThrow(/does not describe a language model/)
  })
})

describe('models in several files', () => {
  it('finds the other parts from the first', () => {
    expect(splitParts('/m/Big-00001-of-00003.gguf')).toEqual(['/m/Big-00001-of-00003.gguf', '/m/Big-00002-of-00003.gguf', '/m/Big-00003-of-00003.gguf'])
    expect(splitParts('/m/Small.gguf')).toEqual(['/m/Small.gguf'])
  })

  it('adds up the weights of every part and the picture file', async () => {
    const kv: GgufSpec['kv'] = dense().kv
    const p1 = write('Big-00001-of-00002.gguf', { kv, tensors: [{ name: 'token_embd.weight', bytes: 640 }, { name: 'blk.0.attn_q.weight', bytes: 1024 }, { name: 'blk.1.attn_q.weight', bytes: 1024 }] })
    write('Big-00002-of-00002.gguf', { kv: [['general.architecture', 'str', 'llama']], tensors: [{ name: 'blk.2.attn_q.weight', bytes: 1024 }, { name: 'blk.3.attn_q.weight', bytes: 1024 }, { name: 'output.weight', bytes: 640 }] })
    const proj = path.join(dir, 'mmproj.gguf')
    fs.writeFileSync(proj, Buffer.alloc(5000))
    const s = await readModelShape(p1, proj)
    expect(s.layerBytes).toEqual([1024, 1024, 1024, 1024])
    expect(s.outputBytes).toBe(640)
    expect(s.embedBytes).toBe(640)
    expect(s.mmprojBytes).toBe(5000)
    expect(s.fileBytes).toBe(fs.statSync(p1).size + fs.statSync(path.join(dir, 'Big-00002-of-00002.gguf')).size)
  })
})
