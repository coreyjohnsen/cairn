import { IMPORT_MAX_BYTES, fitWithin } from '@shared/img2img'

/** Pictures larger than this on their longest side are scaled down when brought in; no model works at more. */
const WORKING_SIDE = 2048

/**
 * Turn any picture the browser can read (PNG, JPEG, WebP, GIF, BMP, AVIF…) into a PNG of a sensible size.
 * Transparent areas become white, because the engines take pictures without transparency.
 */
export async function pictureToPng(file: Blob): Promise<{ data: Uint8Array; width: number; height: number }> {
  if (file.size > IMPORT_MAX_BYTES) throw new Error(`That picture is too big (${Math.round(file.size / 1048576)} MB). The limit is ${Math.round(IMPORT_MAX_BYTES / 1048576)} MB.`)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('That file could not be read as a picture.')
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, WORKING_SIDE)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not prepare the picture.')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Could not prepare the picture.')
    return { data: new Uint8Array(await blob.arrayBuffer()), width, height }
  } finally {
    bitmap.close()
  }
}

/** The first picture in a list of files (a drop, a paste or a file chooser), if any. */
export function firstPicture(files: ArrayLike<File> | null | undefined): File | null {
  for (let i = 0; i < (files?.length ?? 0); i++) {
    const f = files![i]
    if (f.type.startsWith('image/')) return f
  }
  return null
}
