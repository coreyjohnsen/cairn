import { describe, expect, it } from 'vitest'
import { containBox } from '../src/renderer/src/lib/fit'
import { jobKey, resolveFocus } from '../src/renderer/src/lib/focus'
import { PANELS, clampWidth, useLayout } from '../src/renderer/src/store/layout'
import type { ImageJob, ImageRecord } from '../src/shared/types'

const rec = (id: string): ImageRecord => ({ id, file: `${id}.png`, thumb: `${id}.jpg`, createdAt: 1, prompt: id, backendId: 'b', backendName: 'B', model: 'm', width: 512, height: 512, steps: 4, cfgScale: 1, seed: 1, durationMs: 1, source: 'hub', favorite: false }) as ImageRecord
const job = (id: string, over: Partial<ImageJob> = {}): ImageJob => ({ id, status: 'running', request: { prompt: 'p', width: 0, height: 0, seed: -1, count: 1, target: { backendId: 'b', model: 'm' } }, progress: 0, resultIds: [], createdAt: 1, ...over }) as ImageJob

describe('containBox', () => {
  it('fits the largest box of a shape inside an area', () => {
    expect(containBox(1, 800, 600)).toEqual({ width: 600, height: 600 })
    expect(containBox(2, 800, 600)).toEqual({ width: 800, height: 400 })
    expect(containBox(0.5, 800, 600)).toEqual({ width: 300, height: 600 })
  })
  it('gives nothing for an area or shape that makes no sense', () => {
    expect(containBox(1, 0, 600)).toEqual({ width: 0, height: 0 })
    expect(containBox(0, 800, 600)).toEqual({ width: 0, height: 0 })
    expect(containBox(Number.NaN, 800, 600)).toEqual({ width: 0, height: 0 })
  })
})

describe('what the Image Hub shows big', () => {
  const records = [rec('c'), rec('b'), rec('a')]
  it('shows the picture that was picked', () => {
    expect(resolveFocus('b', records, {}, 'c')).toMatchObject({ kind: 'record', rec: { id: 'b' } })
  })
  it('falls back to the newest when nothing, or something that is gone, was picked', () => {
    expect(resolveFocus(null, records, {}, 'c')).toMatchObject({ rec: { id: 'c' } })
    expect(resolveFocus('deleted', records, {}, 'c')).toMatchObject({ rec: { id: 'c' } })
    expect(resolveFocus(null, [], {}, undefined)).toBeNull()
  })
  it('shows a job while it is made, then the picture it made, by itself', () => {
    const running = job('j1')
    expect(resolveFocus(jobKey('j1'), records, { j1: running }, 'c')).toMatchObject({ kind: 'job', job: { id: 'j1' } })
    const done = job('j1', { status: 'done', resultIds: ['a', 'b'] })
    // Of a batch, the newest picture (made last, first in the history).
    expect(resolveFocus(jobKey('j1'), records, { j1: done }, 'c')).toMatchObject({ kind: 'record', rec: { id: 'b' } })
  })
  it('keeps showing the job in the moment before its picture arrives', () => {
    const done = job('j1', { status: 'done', resultIds: ['not-yet'] })
    expect(resolveFocus(jobKey('j1'), records, { j1: done }, 'c')).toMatchObject({ kind: 'job' })
  })
  it('shows a failed job so its error can be read, and ignores a cancelled one', () => {
    expect(resolveFocus(jobKey('j2'), records, { j2: job('j2', { status: 'error', error: 'boom' }) }, 'c')).toMatchObject({ kind: 'job' })
    expect(resolveFocus(jobKey('j3'), records, { j3: job('j3', { status: 'cancelled' }) }, 'c')).toMatchObject({ rec: { id: 'c' } })
  })
})

describe('panel widths', () => {
  it('stay between the smallest and largest a panel may have', () => {
    expect(clampWidth('conversations', 10)).toBe(PANELS.conversations.min)
    expect(clampWidth('conversations', 5000)).toBe(PANELS.conversations.max)
    expect(clampWidth('create', 401.6)).toBe(402)
  })
  it('are set, reset and folded through the store', () => {
    const s = useLayout.getState()
    s.setWidth('create', 9999)
    expect(useLayout.getState().widths.create).toBe(PANELS.create.max)
    s.resetWidth('create')
    expect(useLayout.getState().widths.create).toBeUndefined()
    s.toggle('conversations')
    expect(useLayout.getState().collapsed.conversations).toBe(true)
    s.toggle('conversations')
    expect(useLayout.getState().collapsed.conversations).toBeUndefined()
    s.setSection('disc:size', true)
    expect(useLayout.getState().sections['disc:size']).toBe(true)
  })
})
