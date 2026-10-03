import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'

export async function extractArchive(file: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true })
  const lower = file.toLowerCase()
  if (lower.endsWith('.zip')) {
    await extractZip(file, destDir)
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    const tar = await import('tar')
    // node-tar drops absolute paths, `..` segments and links that would escape `cwd`.
    await tar.x({ file, cwd: destDir })
  } else {
    throw new Error(`Unsupported archive type: ${path.basename(file)}`)
  }
}

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
/** Declared uncompressed size we are willing to unpack from one archive (the largest GPU runtimes are around 1 GB). */
const MAX_UNPACKED = 16 * 1024 ** 3

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/**
 * Unpack a zip into `destDir`, refusing anything that could write outside it.
 *
 * This replaces the `extract-zip` package, which follows symlink entries and so can be used to write
 * arbitrary files (GHSA-jmr9-qjv8-65gv, GHSA-7pqw-9j4j-h8q3; no patched release exists). Rules:
 * absolute paths and `..` segments are rejected; every file is written only after its real parent
 * directory is confirmed to be inside `destDir`; symlink entries are allowed only when they point at a
 * plain relative path with no `..` (so a link can only ever lead further down the tree, e.g.
 * `libfoo.so -> libfoo.so.1`) and are skipped on Windows, where the engine archives do not use them.
 */
export async function extractZip(file: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true })
  const root = await fsp.realpath(destDir)
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (err, z) => (err || !z ? reject(err ?? new Error('Could not open the zip file.')) : resolve(z)))
  })

  const openStream = (entry: yauzl.Entry) =>
    new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      zip.openReadStream(entry, (err, stream) => (err || !stream ? reject(err ?? new Error('Could not read a zip entry.')) : resolve(stream)))
    })

  const readText = async (entry: yauzl.Entry): Promise<string> => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of await openStream(entry)) {
      const buf = Buffer.from(chunk as Buffer)
      size += buf.length
      if (size > 4096) throw new Error(`Unsafe link in archive: ${entry.fileName}`)
      chunks.push(buf)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  let unpacked = 0
  const handle = async (entry: yauzl.Entry): Promise<void> => {
    const raw = entry.fileName
    const name = raw.replace(/\\/g, '/')
    if (name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new Error(`Unsafe path in archive: ${raw}`)
    const parts = name.split('/').filter((p) => p && p !== '.')
    if (!parts.length) return
    if (parts.includes('..')) throw new Error(`Unsafe path in archive: ${raw}`)
    const dest = path.join(root, ...parts)
    if (!isInside(root, dest)) throw new Error(`Unsafe path in archive: ${raw}`)

    unpacked += entry.uncompressedSize
    if (unpacked > MAX_UNPACKED) throw new Error('The archive is unreasonably large; refusing to unpack it.')

    const unix = entry.versionMadeBy >> 8 === 3
    const mode = unix ? (entry.externalFileAttributes >>> 16) & 0xffff : 0
    const type = mode & S_IFMT

    if (name.endsWith('/') || type === S_IFDIR) {
      await fsp.mkdir(dest, { recursive: true })
      if (!isInside(root, await fsp.realpath(dest))) throw new Error(`Unsafe path in archive: ${raw}`)
      return
    }

    // The parent must really be inside the destination (a symlink already on disk could point elsewhere).
    const parent = path.dirname(dest)
    await fsp.mkdir(parent, { recursive: true })
    if (!isInside(root, await fsp.realpath(parent))) throw new Error(`Unsafe path in archive: ${raw}`)
    await fsp.rm(dest, { force: true, recursive: false }).catch(() => {})

    if (type === S_IFLNK) {
      const target = (await readText(entry)).trim()
      const targetParts = target.replace(/\\/g, '/').split('/')
      if (!target || target.includes('\0') || target.startsWith('/') || target.startsWith('\\') || /^[a-zA-Z]:/.test(target) || targetParts.includes('..')) {
        throw new Error(`Unsafe link in archive: ${raw}`)
      }
      if (process.platform !== 'win32') await fsp.symlink(target, dest)
      return
    }

    const executable = (mode & 0o111) !== 0
    const stream = await openStream(entry)
    await pipeline(stream, fs.createWriteStream(dest, { flags: 'wx', mode: executable ? 0o755 : 0o644 }))
  }

  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject)
      zip.on('end', resolve)
      zip.on('entry', (entry: yauzl.Entry) => {
        handle(entry).then(() => zip.readEntry(), reject)
      })
      zip.readEntry()
    })
  } finally {
    zip.close()
  }
}

/** Find the first file whose name (case-insensitive) is in `names`, searching breadth-first up to `maxDepth`. */
export async function findFile(root: string, names: string[], maxDepth = 4): Promise<string | null> {
  const wanted = names.map((n) => n.toLowerCase())
  let level = [root]
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next: string[] = []
    for (const dir of level) {
      let entries: fs.Dirent[]
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      // Preserve the caller's preference order of names.
      for (const want of wanted) {
        const hit = entries.find((e) => e.isFile() && e.name.toLowerCase() === want)
        if (hit) return path.join(dir, hit.name)
      }
      for (const e of entries) if (e.isDirectory()) next.push(path.join(dir, e.name))
    }
    level = next
  }
  return null
}
