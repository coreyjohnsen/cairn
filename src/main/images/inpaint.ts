/**
 * Getting a starting picture and a mask ready for an engine, and blending the engine's result back over the
 * original. Two ways to work:
 *  - "whole": the engine sees the whole picture; only the masked part of its result is used.
 *  - "masked": the engine sees only the masked part plus some margin, enlarged to the model's usual size, so a small
 *    area gets as many pixels as a whole picture would. The result is shrunk back and pasted in.
 * Either way, everything outside the mask (and its soft edge) stays exactly as in the original.
 */
import { sizeLikePicture } from '@shared/img2img'
import { type Box, PixelError, type Raster, binarize, blend, blurGray, boundingBox, cropRaster, decodePng, encodePng, maxGray, resizeRaster, toGray } from './pixels'

export type InpaintArea = 'whole' | 'masked'

export interface InpaintOptions {
  /** The starting picture and the mask, both PNG. The mask may be any size with the picture's shape; white is repainted. */
  init: Uint8Array
  mask: Uint8Array
  area: InpaintArea
  /** Width of the soft edge, in pixels of the original picture. */
  feather: number
  /** Margin kept around the mask when only the masked area is sent, in pixels of the original picture. */
  padding: number
  /** The size to ask the engine for. In "whole" mode exactly this; in "masked" mode the pixel count is kept and the shape follows the area. */
  width: number
  height: number
  /** Width and height must be a multiple of this. */
  multiple: number
}

export interface PreparedInpaint {
  /** What to send the engine, all at `width` × `height`. */
  init: Uint8Array
  mask: Uint8Array
  width: number
  height: number
  /** The part of the original the engine is working on. */
  region: Box
  /** Blend an engine result (any size) back over the original; returns a PNG the size of the original. */
  finish(result: Uint8Array): Uint8Array
}

export class InpaintError extends Error {}

/** A box around `b`, grown by `pad`, kept inside the picture and at least `minSide` on its longer side where the picture allows. */
export function growBox(b: Box, pad: number, width: number, height: number, minSide = 384): Box {
  let x0 = Math.max(0, b.x - pad)
  let y0 = Math.max(0, b.y - pad)
  let x1 = Math.min(width, b.x + b.w + pad)
  let y1 = Math.min(height, b.y + b.h + pad)
  const want = Math.min(minSide, Math.max(width, height))
  for (const axis of ['x', 'y'] as const) {
    const lo = axis === 'x' ? x0 : y0
    const hi = axis === 'x' ? x1 : y1
    const limit = axis === 'x' ? width : height
    const side = Math.min(want, limit)
    if (hi - lo < side) {
      const mid = (lo + hi) / 2
      let a = Math.round(mid - side / 2)
      a = Math.max(0, Math.min(limit - side, a))
      if (axis === 'x') [x0, x1] = [a, a + side]
      else [y0, y1] = [a, a + side]
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

function readPicture(png: Uint8Array): Raster {
  try {
    return decodePng(png, 255)
  } catch (e) {
    if (e instanceof PixelError) throw new InpaintError(`${e.message} Painting a mask needs a PNG starting picture; bring the picture in again with "Start from a picture", which converts it.`)
    throw e
  }
}

export function prepareInpaint(o: InpaintOptions): PreparedInpaint {
  const orig = readPicture(o.init)
  let maskRaster: Raster
  try {
    maskRaster = toGray(decodePng(o.mask, 0))
  } catch (e) {
    throw new InpaintError(e instanceof PixelError ? `The mask could not be read. ${e.message}` : String(e))
  }
  // The mask is stored at the picture's shape but maybe a different size; bring it to the picture's size.
  const full = toGray(resizeRaster(maskRaster, orig.width, orig.height))
  const box = boundingBox(full, 16)
  if (!box) throw new InpaintError('The mask is empty. Paint over the part of the picture you want to change.')

  const feather = Math.max(0, Math.min(256, Math.round(o.feather)))
  const padding = Math.max(0, Math.min(1024, Math.round(o.padding)))

  let region: Box = { x: 0, y: 0, w: orig.width, h: orig.height }
  if (o.area === 'masked') {
    region = growBox(box, padding + feather, orig.width, orig.height)
    // Nearly the whole picture anyway: send all of it.
    if (region.w * region.h >= 0.9 * orig.width * orig.height) region = { x: 0, y: 0, w: orig.width, h: orig.height }
  }
  const wholePicture = region.w === orig.width && region.h === orig.height

  // "Whole" asks for exactly the size given. When only the masked area is sent, the pixel count is kept and the shape follows the area.
  const size = o.area === 'whole' ? { width: o.width, height: o.height } : sizeLikePicture({ width: region.w, height: region.h }, o.width * o.height, o.multiple)

  const cropMask = wholePicture ? full : cropRaster(full, region)
  const cropInit = wholePicture ? orig : cropRaster(orig, region)
  const initOut = encodePng(resizeRaster(cropInit, size.width, size.height))
  // Engines expect a hard black-and-white mask; the soft edge is applied when blending back.
  const maskOut = encodePng(binarize(resizeRaster(cropMask, size.width, size.height)))
  // The area that is replaced: the whole mask, fading out past its edge over `feather` pixels.
  const soft = feather >= 1 ? maxGray(cropMask, blurGray(cropMask, feather)) : cropMask

  return {
    init: initOut,
    mask: maskOut,
    width: size.width,
    height: size.height,
    region,
    finish(result: Uint8Array): Uint8Array {
      let patch: Raster
      try {
        patch = decodePng(result, 255)
      } catch (e) {
        if (e instanceof PixelError) throw new InpaintError(`The engine's picture could not be blended with the original. ${e.message}`)
        throw e
      }
      const fitted = resizeRaster(patch, region.w, region.h)
      return encodePng(blend(orig, fitted, soft, region.x, region.y))
    }
  }
}
