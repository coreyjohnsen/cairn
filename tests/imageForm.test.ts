import { describe, expect, it } from 'vitest'
import { DEFAULT_FORM, formAfterPatch, startModeFor } from '../src/renderer/src/lib/imageForm'

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
