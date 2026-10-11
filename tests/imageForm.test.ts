import { describe, expect, it } from 'vitest'
import { DEFAULT_FORM, clearedForm, formAfterPatch, isClear, startModeFor } from '../src/renderer/src/lib/imageForm'

const mask = { png: new Uint8Array([1, 2, 3]), preview: 'data:', coverage: 0.2 }
const records = [{ id: 'a' }, { id: 'b' }]

describe('editing a picture in the Image Hub', () => {
  it('starts as words only', () => {
    expect(DEFAULT_FORM.startMode).toBe('text')
  })

  it('a different picture to edit drops the paint, and says the old edit session is over', () => {
    const editing = { ...DEFAULT_FORM, startMode: 'edit' as const, initImageId: 'a', mask }
    // Changing the strength, or painting more, on the same picture keeps the paint.
    const same = formAfterPatch(editing, { strength: 0.9 })
    expect(same.newBase).toBe(false)
    expect(same.form.mask).toBe(mask)
    expect(formAfterPatch(editing, { initImageId: 'a' }).newBase).toBe(false)
    // Carrying on from another picture starts clean.
    const other = formAfterPatch(editing, { initImageId: 'b' })
    expect(other.newBase).toBe(true)
    expect(other.form.mask).toBeUndefined()
    expect(other.form.initImageId).toBe('b')
  })

  it('keeps a mask that arrives together with its picture', () => {
    const r = formAfterPatch(DEFAULT_FORM, { initImageId: 'a', mask })
    expect(r.newBase).toBe(true)
    expect(r.form.mask).toBe(mask)
  })

  it('"Edit picture" opens the editor, whatever the picture was made from', () => {
    expect(startModeFor({}, records, true)).toBe('edit')
  })

  it('reusing the settings of a picture made from another one goes back to editing, if that one is still there', () => {
    expect(startModeFor({ initImageId: 'a' }, records)).toBe('edit')
    expect(startModeFor({ initImageId: 'deleted' }, records)).toBe('text')
  })

  it('reusing the settings of an ordinary picture is words only', () => {
    expect(startModeFor({}, records)).toBe('text')
  })
})

describe('clearing the create panel', () => {
  const filled = {
    ...DEFAULT_FORM,
    prompt: 'a cabin',
    negative: 'blurry',
    targetKey: 'sd::sdxl',
    ratio: '16:9' as const,
    scale: 1.5,
    steps: 30,
    cfg: 9,
    sampler: 'euler_a',
    seed: 42,
    count: 4,
    startMode: 'edit' as const,
    initImageId: 'a',
    mask,
    loras: [{ id: 'pixel_art', strength: 0.8 }],
    upscale: { path: '/u.pth', repeats: 1 }
  }

  it('puts every box back to its default and keeps the model and how many', () => {
    const c = clearedForm(filled)
    expect(c).toEqual({ ...DEFAULT_FORM, targetKey: 'sd::sdxl', count: 4 })
    expect(c.mask).toBeUndefined()
    expect(c.initImageId).toBeUndefined()
    expect(c.upscale).toBeUndefined()
  })

  it('knows when there is nothing to clear', () => {
    expect(isClear(DEFAULT_FORM)).toBe(true)
    // The model and the count are choices, not boxes.
    expect(isClear({ ...DEFAULT_FORM, targetKey: 'sd::sdxl', count: 8 })).toBe(true)
    expect(isClear(clearedForm(filled))).toBe(true)
    for (const patch of [{ prompt: 'x' }, { negative: '' }, { steps: 20 }, { seed: 5 }, { ratio: '1:1' as const }, { loras: filled.loras }, { upscaleOff: true }, { mask }, { initImageId: 'a' }]) {
      expect(isClear({ ...DEFAULT_FORM, ...patch })).toBe(false)
    }
    // A setting that was changed and then reset to "default" (undefined) counts as clear.
    expect(isClear({ ...DEFAULT_FORM, steps: undefined, cfg: undefined })).toBe(true)
  })
})
