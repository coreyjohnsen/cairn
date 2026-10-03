import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractArchive, extractZip } from '../src/main/engines/extract'
import { makeZip, type ZipEntry } from './helpers/zip'

const posix = process.platform !== 'win32'
let tmp: string
let dest: string
let outside: string

async function zipOf(entries: ZipEntry[]): Promise<string> {
  const file = path.join(tmp, 'a.zip')
  await fsp.writeFile(file, makeZip(entries))
  return file
}

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cairn-zip-'))
  dest = path.join(tmp, 'dest')
  outside = path.join(tmp, 'outside')
  await fsp.mkdir(outside)
})
afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true })
})

describe('zip extraction', () => {
  it('unpacks files and folders, keeping the executable bit on Unix', async () => {
    const file = await zipOf([
      { name: 'bin/', dir: true },
      { name: 'bin/llama-server', data: 'binary', mode: 0o755 },
      { name: 'README.txt', data: 'hello' },
      { name: 'deep/er/file.dll', data: 'dll' }
    ])
    await extractZip(file, dest)
    expect(await fsp.readFile(path.join(dest, 'README.txt'), 'utf8')).toBe('hello')
    expect(await fsp.readFile(path.join(dest, 'deep/er/file.dll'), 'utf8')).toBe('dll')
    if (posix) expect(fs.statSync(path.join(dest, 'bin/llama-server')).mode & 0o111).not.toBe(0)
  })

  it('dispatches by file extension and rejects unknown formats', async () => {
    const file = await zipOf([{ name: 'x.txt', data: 'x' }])
    await extractArchive(file, dest)
    expect(fs.existsSync(path.join(dest, 'x.txt'))).toBe(true)
    await expect(extractArchive(path.join(tmp, 'thing.rar'), dest)).rejects.toThrow(/Unsupported archive/)
  })

  it('refuses entries that climb out of the destination', async () => {
    const file = await zipOf([{ name: '../evil.txt', data: 'x' }])
    await expect(extractZip(file, dest)).rejects.toThrow()
    expect(fs.existsSync(path.join(tmp, 'evil.txt'))).toBe(false)
    const nested = await zipOf([{ name: 'a/../../evil2.txt', data: 'x' }])
    await expect(extractZip(nested, dest)).rejects.toThrow()
    expect(fs.existsSync(path.join(tmp, 'evil2.txt'))).toBe(false)
  })

  it('refuses absolute paths', async () => {
    const target = path.join(outside, 'abs.txt')
    const file = await zipOf([{ name: target, data: 'x' }])
    await expect(extractZip(file, dest)).rejects.toThrow()
    expect(fs.existsSync(target)).toBe(false)
  })

  it.skipIf(!posix)('refuses symlinks that point upwards or at absolute paths', async () => {
    await expect(extractZip(await zipOf([{ name: 'link', symlink: true, data: '../outside' }]), dest)).rejects.toThrow(/Unsafe link/)
    await expect(extractZip(await zipOf([{ name: 'link2', symlink: true, data: outside }]), dest)).rejects.toThrow(/Unsafe link/)
    expect(fs.existsSync(path.join(dest, 'link'))).toBe(false)
    expect(fs.existsSync(path.join(dest, 'link2'))).toBe(false)
  })

  it.skipIf(!posix)('cannot be tricked into writing through a symlink entry', async () => {
    // The classic attack: a link that points outside, then a file "inside" it.
    const file = await zipOf([
      { name: 'sneaky', symlink: true, data: '../outside' },
      { name: 'sneaky/payload.txt', data: 'owned' }
    ])
    await expect(extractZip(file, dest)).rejects.toThrow()
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it.skipIf(!posix)('does not write through a link that already exists on disk', async () => {
    await fsp.mkdir(dest, { recursive: true })
    await fsp.symlink(outside, path.join(dest, 'preexisting'))
    const file = await zipOf([{ name: 'preexisting/payload.txt', data: 'owned' }])
    await expect(extractZip(file, dest)).rejects.toThrow()
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it.skipIf(!posix)('keeps harmless same-folder symlinks such as versioned libraries', async () => {
    const file = await zipOf([
      { name: 'lib/libggml.so.1', data: 'lib' },
      { name: 'lib/libggml.so', symlink: true, data: 'libggml.so.1' }
    ])
    await extractZip(file, dest)
    expect(fs.lstatSync(path.join(dest, 'lib/libggml.so')).isSymbolicLink()).toBe(true)
    expect(await fsp.readFile(path.join(dest, 'lib/libggml.so'), 'utf8')).toBe('lib')
  })

  it('replaces a file that is already there instead of writing through it', async () => {
    await fsp.mkdir(dest, { recursive: true })
    await fsp.writeFile(path.join(dest, 'a.txt'), 'old')
    await extractZip(await zipOf([{ name: 'a.txt', data: 'new' }]), dest)
    expect(await fsp.readFile(path.join(dest, 'a.txt'), 'utf8')).toBe('new')
  })
})
