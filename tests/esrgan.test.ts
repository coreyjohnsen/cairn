import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  EsrganUpscaler,
  esrganArgs,
  esrganModelArgs,
  explainEsrganFailure,
  isNcnnModel,
  parseEsrganPercent,
  tooLargeMessage,
  upscaledSize
} from '../src/main/images/esrgan'
import { imageSize } from '../src/main/images/size'
import type { ImageStage } from '../src/shared/types'
import { BackendError, type BackendHooks } from '../src/main/images/types'
import { fakeJpeg, fakePng } from './helpers/png'

const hooks = (signal = new AbortController().signal): BackendHooks & { log: [number, string | undefined, ImageStage | undefined][] } => {
  const log: [number, string | undefined, ImageStage | undefined][] = []
  return { signal, log, onProgress: (f, l, st) => log.push([f, l, st]) }
}

describe('Real-ESRGAN command line and output', () => {
  it('splits a .param path into the folder and model name the program wants', () => {
    expect(esrganModelArgs(path.join('/m', 'up', 'realesrgan-x4plus.param'))).toEqual(['-m', path.join('/m', 'up'), '-n', 'realesrgan-x4plus'])
    expect(isNcnnModel('a.PARAM')).toBe(true)
    expect(isNcnnModel('a.pth')).toBe(false)
  })

  it('builds one pass, adding a tile size only when asked', () => {
    const base = { input: '/t/in.png', output: '/t/out.png', modelPath: '/m/realesr-animevideov3-x2.param', scale: 2 }
    expect(esrganArgs(base)).toEqual(['-i', '/t/in.png', '-o', '/t/out.png', '-m', '/m', '-n', 'realesr-animevideov3-x2', '-s', '2', '-f', 'png'])
    expect(esrganArgs({ ...base, tile: 0 })).not.toContain('-t')
    expect(esrganArgs({ ...base, tile: 128 }).slice(-2)).toEqual(['-t', '128'])
  })

  it('reads progress percentages and ignores other lines', () => {
    expect(parseEsrganPercent('37.50%')).toBeCloseTo(0.375)
    expect(parseEsrganPercent('100.00%')).toBe(1)
    expect(parseEsrganPercent('0.00%')).toBe(0)
    expect(parseEsrganPercent('[0 AMD Radeon RX 6900 XT]  queueC=2[2]  queueG=0[2]')).toBeNull()
    expect(parseEsrganPercent('250%')).toBeNull()
  })

  it('works out the final size and refuses pictures that would be enormous', () => {
    expect(upscaledSize(512, 768, 4, 2)).toEqual({ width: 8192, height: 12288 })
    expect(tooLargeMessage(1024, 1024, 4, 1)).toBeNull()
    expect(tooLargeMessage(2500, 2500, 4, 1)).toBeNull() // 10000 × 10000 is 100 million pixels, still allowed
    expect(tooLargeMessage(3000, 3000, 4, 1)).toMatch(/12000 × 12000/) // too many pixels
    expect(tooLargeMessage(5000, 100, 4, 1)).toMatch(/20000 × 400/) // too long a side
    expect(tooLargeMessage(1024, 1024, 4, 2)).toMatch(/16384 × 16384/)
  })

  it('explains the usual failures in plain words', () => {
    expect(explainEsrganFailure(1, ['vkAllocateMemory failed -2'])).toMatch(/ran out of memory/)
    expect(explainEsrganFailure(1, ['invalid gpu device'])).toMatch(/Vulkan/)
    expect(explainEsrganFailure(3221225477, [])).toMatch(/driver/)
    expect(explainEsrganFailure(1, ['whatever'])).toMatch(/exit code 1/)
  })
})

describe.skipIf(process.platform === 'win32')('EsrganUpscaler with a fake realesrgan-ncnn-vulkan', () => {
  let dir: string
  let bin: string
  let installed = true
  let tmp: string

  const model = async (name: string) => {
    const p = path.join(dir, `${name}.param`)
    await fsp.writeFile(p, 'param')
    await fsp.writeFile(path.join(dir, `${name}.bin`), 'bin')
    return p
  }
  const upscaler = () =>
    new EsrganUpscaler({
      engines: { resolveBinary: () => (installed ? bin : null), spawnEnv: () => process.env, esrganModelsDir: () => null } as never,
      tmpDir: tmp
    })
  const calls = async (): Promise<string[][]> =>
    (await fsp.readFile(path.join(dir, 'calls.jsonl'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cairn-esrgan-'))
    tmp = path.join(dir, 'tmp')
    await fsp.mkdir(tmp)
    bin = path.join(dir, 'realesrgan-ncnn-vulkan')
    await fsp.writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const a = process.argv.slice(2)
const get = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined)
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(a) + '\\n')
const name = get('-n') || '', out = get('-o'), tile = get('-t'), scale = Number(get('-s') || 4)
const png = (w, h) => { const b = Buffer.alloc(64); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6; return b }
if (name.includes('OOM') && !tile) { console.error('vkAllocateMemory failed -2'); process.exit(1) }
if (name.includes('FAIL')) { console.error('invalid gpu device'); process.exit(1) }
console.error('[0 AMD Radeon RX 6900 XT]  queueC=2[2]  queueG=0[2]  queueT=1[2]')
const finish = () => {
  for (const p of ['0.00%', '50.00%', '100.00%']) process.stderr.write(p + '\\n')
  if (name.includes('NOOUT')) process.exit(0)
  const inp = fs.readFileSync(get('-i'))
  const isPng = inp[0] === 0x89
  const w = isPng ? inp.readUInt32BE(16) : 100, h = isPng ? inp.readUInt32BE(20) : 80
  const f = name.includes('SAME') ? 1 : scale
  fs.writeFileSync(out, png(w * f, h * f))
  process.exit(0)
}
if (name.includes('SLOW')) setTimeout(finish, 6000)
else finish()
`,
      { mode: 0o755 }
    )
  })
  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    installed = true
    await fsp.rm(path.join(dir, 'calls.jsonl'), { force: true })
  })

  it('makes a picture 4 times bigger with the model it was given and reports the upscaling stage', async () => {
    const h = hooks()
    const m = await model('realesrgan-x4plus')
    const out = await upscaler().upscale(fakePng(64, 48), { path: m, repeats: 1 }, h)
    expect(imageSize(out[0].data)).toEqual({ width: 256, height: 192 })
    const [call] = await calls()
    expect(call.slice(call.indexOf('-m'), call.indexOf('-m') + 4)).toEqual(['-m', dir, '-n', 'realesrgan-x4plus'])
    expect(call[call.indexOf('-s') + 1]).toBe('4')
    expect(call[call.indexOf('-f') + 1]).toBe('png')
    expect(call).not.toContain('-t')
    const stages = new Set(h.log.map(([, , s]) => s))
    expect(stages).toEqual(new Set(['upscaling']))
    const fractions = h.log.map(([f]) => f)
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b))
    expect(fractions.at(-1)).toBe(1)
    expect(await fsp.readdir(tmp)).toEqual([]) // working folder is cleaned up
  })

  it('runs again on its own result for extra passes', async () => {
    const m = await model('realesrgan-x4plus')
    const h = hooks()
    const out = await upscaler().upscale(fakePng(32, 32), { path: m, repeats: 2 }, h)
    expect(imageSize(out[0].data)).toEqual({ width: 512, height: 512 })
    expect(await calls()).toHaveLength(2)
    expect(h.log.some(([, l]) => /pass 2 of 2/.test(l ?? ''))).toBe(true)
  })

  it('takes the scale from the model name and accepts JPEG input', async () => {
    const m = await model('realesr-animevideov3-x2')
    const out = await upscaler().upscale(fakeJpeg(100, 80), { path: m, repeats: 1 }, hooks())
    expect(imageSize(out[0].data)).toEqual({ width: 200, height: 160 })
    const [call] = await calls()
    expect(call[call.indexOf('-s') + 1]).toBe('2')
    expect(call[call.indexOf('-i') + 1]).toMatch(/in\.jpg$/)
  })

  it('retries with small tiles when the graphics card runs out of memory', async () => {
    const m = await model('OOM-x4')
    const out = await upscaler().upscale(fakePng(64, 64), { path: m, repeats: 1 }, hooks())
    expect(imageSize(out[0].data)).toEqual({ width: 256, height: 256 })
    const all = await calls()
    expect(all).toHaveLength(2)
    expect(all[0]).not.toContain('-t')
    expect(all[1].slice(-2)).toEqual(['-t', '128'])
  })

  it('explains a failure and does not retry it', async () => {
    const m = await model('FAIL')
    const err = await upscaler().upscale(fakePng(64, 64), { path: m, repeats: 1 }, hooks()).catch((e) => e)
    expect(err).toBeInstanceOf(BackendError)
    expect(err.message).toMatch(/No usable Vulkan graphics device/)
    expect(await calls()).toHaveLength(1)
  })

  it('does not hand back a missing or unchanged picture', async () => {
    const none = await model('NOOUT')
    expect((await upscaler().upscale(fakePng(64, 64), { path: none, repeats: 1 }, hooks()).catch((e) => e)).message).toMatch(/produced no picture/)
    const same = await model('SAME')
    expect((await upscaler().upscale(fakePng(64, 64), { path: same, repeats: 1 }, hooks()).catch((e) => e)).message).toMatch(/not bigger/)
  })

  it('checks the model and the size before starting the program', async () => {
    const lonely = path.join(dir, 'lonely.param')
    await fsp.writeFile(lonely, 'p')
    expect((await upscaler().upscale(fakePng(64, 64), { path: lonely, repeats: 1 }, hooks()).catch((e) => e)).message).toMatch(/missing a file/)
    expect((await upscaler().upscale(fakePng(64, 64), { path: path.join(dir, 'x.pth'), repeats: 1 }, hooks()).catch((e) => e)).message).toMatch(/not a Real-ESRGAN/)
    const m = await model('realesrgan-x4plus')
    expect((await upscaler().upscale(fakePng(8000, 8000), { path: m, repeats: 1 }, hooks()).catch((e) => e)).message).toMatch(/more than the upscaler can save/)
    expect(await calls()).toHaveLength(0)
  })

  it('says how to install it when it is missing', async () => {
    installed = false
    const m = await model('realesrgan-x4plus')
    const err = await upscaler().upscale(fakePng(64, 64), { path: m, repeats: 1 }, hooks()).catch((e) => e)
    expect(err.message).toMatch(/not installed/)
  })

  it('stops the program when cancelled', async () => {
    const m = await model('SLOW-x4')
    const ac = new AbortController()
    const started = Date.now()
    const p = upscaler().upscale(fakePng(64, 64), { path: m, repeats: 1 }, hooks(ac.signal)).catch((e) => e)
    setTimeout(() => ac.abort(), 300)
    const err = await p
    expect(err.message).toBe('Cancelled')
    expect(Date.now() - started).toBeLessThan(4000)
  })
})
