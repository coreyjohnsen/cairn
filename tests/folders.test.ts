import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dialogStart } from '../src/main/ipc'

describe('where file dialogs open', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cairn-dlg-'))
  })
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('opens in the models folder when no sub-folder is asked for', async () => {
    expect(await dialogStart(dir)).toBe(dir)
  })

  it('opens in the requested sub-folder, creating it so the user lands there', async () => {
    const d = await dialogStart(dir, 'image/vae')
    expect(d).toBe(path.join(dir, 'image', 'vae'))
    expect((await fsp.stat(d!)).isDirectory()).toBe(true)
  })

  it('cannot be steered out of the models folder', async () => {
    expect(await dialogStart(dir, '../../etc')).toBe(path.join(dir, 'etc'))
  })

  it('does nothing without a models folder', async () => {
    expect(await dialogStart('', 'image')).toBeUndefined()
  })
})
