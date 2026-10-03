import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { mediaUrl, resolveMedia } from '../src/main/media'

const paths = { images: path.resolve('/data/images'), thumbs: path.resolve('/data/thumbs'), attachments: path.resolve('/data/attachments') }

describe('cairn-media protocol resolution', () => {
  it('serves images, thumbnails (with fallback to the original) and attachments', () => {
    expect(resolveMedia(paths, 'cairn-media://image/img_abc123.png')).toEqual({ candidates: [path.join(paths.images, 'img_abc123.png')], mime: 'image/png' })
    expect(resolveMedia(paths, 'cairn-media://thumb/img_abc123.jpg')).toEqual({
      candidates: [path.join(paths.thumbs, 'img_abc123.jpg'), path.join(paths.images, 'img_abc123.jpg')],
      mime: 'image/jpeg'
    })
    expect(resolveMedia(paths, 'cairn-media://attachment/att_1.webp')?.candidates).toEqual([path.join(paths.attachments, 'att_1.webp')])
  })

  it('round-trips names produced by mediaUrl', () => {
    const r = resolveMedia(paths, mediaUrl('image', 'img_x1y2.png'))
    expect(r?.candidates[0]).toBe(path.join(paths.images, 'img_x1y2.png'))
  })

  it('rejects traversal in every encoding', () => {
    const bad = [
      'cairn-media://image/..%2F..%2Fsettings.json',
      'cairn-media://image/..%2f..%2fsecret.png',
      'cairn-media://image/%2e%2e%2fsecret.png',
      'cairn-media://image/..\\secret.png',
      'cairn-media://image/%5C..%5Csecret.png',
      'cairn-media://image//etc/passwd.png',
      'cairn-media://image/C:%5Cwindows%5Cwin.png',
      'cairn-media://image/x..y.png',
      'cairn-media://image/%00.png',
      'cairn-media://image/%E0%A4%A.png' // malformed escape
    ]
    for (const url of bad) expect(resolveMedia(paths, url), url).toBeNull()
  })

  it('keeps URL-normalised paths inside the media folder', () => {
    // The URL parser collapses dot segments before we see them; whatever remains must stay confined.
    const r = resolveMedia(paths, 'cairn-media://image/a/../../../b.png')
    if (r) for (const f of r.candidates) expect(path.relative(paths.images, f).startsWith('..')).toBe(false)
  })

  it('serves only plain image file names', () => {
    for (const url of ['cairn-media://image/index.json', 'cairn-media://image/settings.json', 'cairn-media://image/run.exe', 'cairn-media://image/.png', 'cairn-media://image/', 'cairn-media://image/noext']) {
      expect(resolveMedia(paths, url), url).toBeNull()
    }
  })

  it('rejects unknown kinds and other schemes', () => {
    expect(resolveMedia(paths, 'cairn-media://models/x.png')).toBeNull()
    expect(resolveMedia(paths, 'cairn-media://settings/x.png')).toBeNull()
    expect(resolveMedia(paths, 'https://image/x.png')).toBeNull()
    expect(resolveMedia(paths, 'file:///etc/passwd')).toBeNull()
    expect(resolveMedia(paths, 'not a url')).toBeNull()
  })
})
