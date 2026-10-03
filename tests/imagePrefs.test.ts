import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SettingsStore } from '../src/main/settings'
import {
  MAX_ALIASES,
  aliasKey,
  aliasProblem,
  applyLoraPreset,
  defaultUpscaler,
  expandAliases,
  sanitizeAliases,
  sanitizeLoraPresets,
  sanitizeModelDefaults
} from '../src/shared/imagePrefs'
import type { PromptAlias, UpscalerFile } from '../src/shared/types'

const a = (name: string, text: string, id = name): PromptAlias => ({ id, name, text })

describe('prompt aliases', () => {
  it('replaces a whole word, ignoring capitals, and says which were used', () => {
    const r = expandAliases('a Cabin at dawn', [a('cabin', 'a small log cabin with a stone chimney')])
    expect(r.text).toBe('a a small log cabin with a stone chimney at dawn')
    expect(r.used).toEqual(['cabin'])
  })

  it('does not touch parts of longer words', () => {
    const list = [a('cabin', 'LOG CABIN')]
    expect(expandAliases('cabins and cabinet', list).text).toBe('cabins and cabinet')
    expect(expandAliases('my_cabin', list).text).toBe('my_cabin')
    expect(expandAliases('cabin, cabin.', list).text).toBe('LOG CABIN, LOG CABIN.')
  })

  it('matches phrases, and the longest name wins where two overlap', () => {
    const list = [a('moody', 'dramatic lighting, fog'), a('moody forest', 'dark pine forest, mist'), a('forest', 'GREEN')]
    expect(expandAliases('moody forest at night', list).text).toBe('dark pine forest, mist at night')
    expect(expandAliases('moody lake, forest', list).text).toBe('dramatic lighting, fog lake, GREEN')
    expect(expandAliases('a MOODY   forest', list).text).toBe('a dramatic lighting, fog   GREEN') // the phrase needs the same spacing, so only the single words match
  })

  it('replaces once: text inside an expansion is never expanded again, so aliases cannot loop', () => {
    const list = [a('a', 'b c'), a('b', 'a a'), a('loop', 'loop loop')]
    expect(expandAliases('a', list).text).toBe('b c')
    expect(expandAliases('loop', list).text).toBe('loop loop')
  })

  it('works with markers, punctuation and non-English letters', () => {
    expect(expandAliases('@sunset over the sea', [a('@sunset', 'golden hour')]).text).toBe('golden hour over the sea')
    expect(expandAliases('Süden, süden', [a('süden', 'south')]).text).toBe('south, south')
    expect(expandAliases('c++ code', [a('c++', 'C PLUS PLUS')]).text).toBe('C PLUS PLUS code')
  })

  it('inserts the expansion as written, even with $ patterns, and leaves text alone when nothing matches', () => {
    expect(expandAliases('price', [a('price', 'costs $& and $1')]).text).toBe('costs $& and $1')
    expect(expandAliases('nothing here', [a('cabin', 'x')])).toEqual({ text: 'nothing here', used: [] })
    expect(expandAliases('cabin', undefined)).toEqual({ text: 'cabin', used: [] })
    expect(expandAliases('', [a('cabin', 'x')])).toEqual({ text: '', used: [] })
    expect(expandAliases('cabin', [a('cabin', '   ')]).text).toBe('cabin')
  })

  it('validates names and expansions for the editor', () => {
    const list = [a('moody', 'x', 'id1')]
    expect(aliasProblem('', 'x', list)).toMatch(/name/)
    expect(aliasProblem('   ', 'x', list)).toMatch(/name/)
    expect(aliasProblem('!!!', 'x', list)).toMatch(/letter or number/)
    expect(aliasProblem('x'.repeat(41), 'y', list)).toMatch(/under 40/)
    expect(aliasProblem('a\nb', 'y', list)).toMatch(/one line/)
    expect(aliasProblem('fog', '  ', list)).toMatch(/expand/)
    expect(aliasProblem('MOODY', 'y', list)).toMatch(/already/)
    expect(aliasProblem('moody', 'new text', list, 'id1')).toBeNull() // editing itself is fine
    expect(aliasProblem('fog', 'y', list)).toBeNull()
    expect(aliasKey('  Moody ')).toBe('moody')
  })

  it('cleans stored aliases: bad entries and repeated names are dropped, text is trimmed', () => {
    const out = sanitizeAliases([
      { id: 'one', name: ' moody ', text: '  fog  ' },
      { id: 'two', name: 'MOODY', text: 'duplicate' },
      { name: 'no text', text: '' },
      { name: '', text: 'no name' },
      { name: '???', text: 'no letters' },
      { name: 5, text: 'x' },
      null,
      'junk',
      { name: 'ok', text: 'fine' }
    ])
    expect(out.map((x) => [x.id, x.name, x.text])).toEqual([['one', 'moody', 'fog'], [expect.any(String), 'ok', 'fine']])
    expect(sanitizeAliases('nope')).toEqual([])
    expect(sanitizeAliases(Array.from({ length: MAX_ALIASES + 20 }, (_, i) => ({ name: `a${i}`, text: 'x' })))).toHaveLength(MAX_ALIASES)
  })
})

describe('LoRA presets', () => {
  it('cleans stored presets and the LoRAs inside them', () => {
    const out = sanitizeLoraPresets([
      { id: 'p1', name: ' Pixel fox ', loras: [{ id: 'pixel', strength: 9, trigger: ' pixelart ' }, { id: 'pixel', strength: 1 }, { id: 'ink', strength: 'x' }, { strength: 1 }] },
      { id: 'p2', name: 'pixel FOX', loras: [{ id: 'a', strength: 1 }] },
      { id: 'p3', name: 'empty', loras: [] },
      { id: 'p4', name: '', loras: [{ id: 'a', strength: 1 }] },
      'junk'
    ])
    expect(out).toEqual([{ id: 'p1', name: 'Pixel fox', loras: [{ id: 'pixel', strength: 2, trigger: 'pixelart' }, { id: 'ink', strength: 0.8 }] }])
    expect(sanitizeLoraPresets(undefined)).toEqual([])
  })

  it('applies a preset with the LoRAs that are still installed and names the ones that are gone', () => {
    const preset = { id: 'p', name: 'Look', loras: [{ id: 'pixel', strength: 0.7, trigger: 'pixelart' }, { id: 'gone', strength: 1 }] }
    const r = applyLoraPreset(preset, ['pixel', 'other'])
    expect(r.loras).toEqual([{ id: 'pixel', strength: 0.7, trigger: 'pixelart' }])
    expect(r.missing).toEqual(['gone'])
    r.loras[0].strength = 2
    expect(preset.loras[0].strength).toBe(0.7) // applying never changes the saved preset
  })
})

describe('saved steps and guidance', () => {
  it('keeps sensible values per model and drops the rest', () => {
    expect(
      sanitizeModelDefaults({
        'builtin::m1': { steps: 4.4, cfg: 1 },
        'builtin::m2': { steps: 9999, cfg: -3 },
        'builtin::m3': { steps: 'x' },
        'no-separator': { steps: 5 },
        'builtin::m4': 7,
        'builtin::m5': { cfg: 7.5 }
      })
    ).toEqual({ 'builtin::m1': { steps: 4, cfg: 1 }, 'builtin::m2': { steps: 150, cfg: 0 }, 'builtin::m5': { cfg: 7.5 } })
    expect(sanitizeModelDefaults(null)).toEqual({})
    expect(sanitizeModelDefaults([1])).toEqual({})
  })
})

describe('default upscaler', () => {
  const up = (name: string, engine: 'esrgan' | 'sd' = 'esrgan'): UpscalerFile => ({ path: `/u/${name}.param`, name, sizeBytes: 1, scale: 4, engine, style: 'general' })
  it('is realesrgan-x4plus from the Real-ESRGAN engine, and nothing otherwise', () => {
    expect(defaultUpscaler([up('realesrgan-x4plus-anime'), up('realesrgan-x4plus')])?.name).toBe('realesrgan-x4plus')
    expect(defaultUpscaler([up('RealESRGAN-x4plus')])?.name).toBe('RealESRGAN-x4plus')
    expect(defaultUpscaler([up('realesrgan-x4plus', 'sd')])).toBeUndefined()
    expect(defaultUpscaler([up('realesrgan-x4plus-anime'), up('4x-UltraSharp')])).toBeUndefined()
    expect(defaultUpscaler([])).toBeUndefined()
  })
})

describe('image preferences in the settings store', () => {
  it('cleans what is saved on every change and on load, and starts with the defaults', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cairn-prefs-'))
    try {
      const file = path.join(dir, 'settings.json')
      const store = new SettingsStore(file, dir)
      await store.load()
      expect(store.get().image).toMatchObject({ aliases: [], loraPresets: [], modelDefaults: {}, upscaleByDefault: true })

      const image = store.get().image
      store.update({
        image: {
          ...image,
          aliases: [a('moody', ' fog '), a('MOODY', 'dup'), a('', 'x')],
          loraPresets: [{ id: 'p', name: 'Look', loras: [{ id: 'pixel', strength: 5 }] }, { id: 'q', name: 'empty', loras: [] }],
          modelDefaults: { 'builtin::m1': { steps: 0, cfg: 99 }, bad: { steps: 4 } }
        }
      })
      expect(store.get().image.aliases).toEqual([{ id: 'moody', name: 'moody', text: 'fog' }])
      expect(store.get().image.loraPresets).toEqual([{ id: 'p', name: 'Look', loras: [{ id: 'pixel', strength: 2 }] }])
      expect(store.get().image.modelDefaults).toEqual({ 'builtin::m1': { steps: 1, cfg: 30 } })

      await store.saveNow()
      const again = new SettingsStore(file, dir)
      await again.load()
      expect(again.get().image.aliases).toHaveLength(1)
      expect(again.get().image.loraPresets?.[0].name).toBe('Look')

      // An older settings file without the new fields still loads, with the defaults filled in.
      const old = JSON.parse(await fsp.readFile(file, 'utf8'))
      for (const k of ['aliases', 'loraPresets', 'modelDefaults', 'upscaleByDefault']) delete old.image[k]
      await fsp.writeFile(file, JSON.stringify(old))
      const migrated = new SettingsStore(file, dir)
      await migrated.load()
      expect(migrated.get().image).toMatchObject({ aliases: [], loraPresets: [], modelDefaults: {}, upscaleByDefault: true })
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})
