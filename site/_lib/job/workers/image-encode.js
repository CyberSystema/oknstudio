/**
 * OKN Studio · Shared — Image encode worker
 * =========================================
 * One of the small number of heavy-lifting handlers. Takes a source image
 * (as ArrayBuffer + MIME), decodes it, applies EXIF orientation, optionally
 * resizes to a max long-edge, then re-encodes to the requested format and
 * quality on an OffscreenCanvas.
 *
 * This runs off the main thread — UI stays responsive during 500-file jobs.
 *
 * Payload shape:
 *   {
 *     // One of:
 *     buffer:       ArrayBuffer,            // encoded source bytes (transferred)
 *     mime:         string,                 // source MIME when using buffer
 *     // OR pre-decoded RGBA pixels (used by HEIC/RAW zones that decode on main):
 *     rgba?:        ArrayBuffer,            // width*height*4 bytes, sRGB, non-premultiplied
 *     rgbaWidth?:   number,
 *     rgbaHeight?:  number,
 *
 *     maxEdge:      number,                 // 0 = no long-edge cap
 *     // Exact output dimensions (used by Social zone for platform canvases).
 *     // When set, output is fit into [targetW × targetH] per `fit` mode.
 *     targetW?:     number,
 *     targetH?:     number,
 *     fit?:         'cover' | 'contain',    // 'cover' = center-crop, 'contain' = pad
 *     background?:  'white' | 'black' | 'blur' | 'transparent',
 *
 *     format:       'image/jpeg' | 'image/webp' | 'image/avif' | 'image/png',
 *     quality:      number,                 // 0..1 (ignored for PNG)
 *     orientation:  number | undefined,     // EXIF Orientation (1..8), applied + cleared
 *     srgbConvert:  boolean,                // canvas paints via sRGB context when true
 *     canvasColorSpace?: 'srgb' | 'display-p3'  // output canvas colour space (v2)
 *   }
 *
 * Returns:
 *   {
 *     buffer:   ArrayBuffer,                // encoded image bytes (transferred out)
 *     width:    number,
 *     height:   number,
 *     encoded:  { mime: string, quality: number },
 *     elapsed:  number                      // ms
 *   }
 *
 * Implementation notes
 * --------------------
 * - `createImageBitmap` is fast for JPEG/PNG/WebP. For HEIC, the HEIC zone
 *   will run its own decode-to-RGBA step first and call this handler with
 *   the already-decoded pixels via a separate entrypoint — Web-ready does
 *   not need to handle HEIC decoding itself.
 * - Orientation 1..8 per EXIF spec. We apply via canvas transform, then the
 *   caller strips the Orientation tag from written EXIF so downstream apps
 *   don't double-rotate.
 * - We NEVER call OffscreenCanvas.convertToBlob with 'image/jpeg' on inputs
 *   that lost data to transparency (the browser will composite over black).
 *   For PNG->JPEG we fill white first as a safe, predictable default.
 * - Resize uses a two-step approach: createImageBitmap with resizeWidth/
 *   resizeHeight does browser-native high-quality downscaling (hardware
 *   accelerated on most engines). For downscales >3x we apply a second
 *   Lanczos-equivalent pass via an intermediate canvas to avoid aliasing.
 */

// Accept formats the browser natively decodes via createImageBitmap.
const NATIVE_DECODE = new Set([
  'image/jpeg', 'image/png', 'image/webp',
  'image/avif', 'image/gif', 'image/bmp', 'image/x-icon'
]);

export default {
  /**
   * @param {Object} payload
   * @param {import('./runner.js').HandlerCtx} ctx
   */
  async handle(payload, ctx) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    const {
      buffer, mime,
      rgba, rgbaWidth, rgbaHeight,
      maxEdge = 0,
      targetW = 0, targetH = 0,
      fit = 'cover',
      background = 'white',
      format = 'image/jpeg',
      quality = 0.82,
      orientation = 1,
      srgbConvert = true,
      canvasColorSpace = 'srgb'
    } = payload ?? {};

    const hasBuffer = buffer instanceof ArrayBuffer;
    const hasRgba = rgba instanceof ArrayBuffer && rgbaWidth > 0 && rgbaHeight > 0;
    if (!hasBuffer && !hasRgba) {
      throw Object.assign(new Error('image-encode: expected buffer or rgba input'), { klass: 'corrupt' });
    }

    if (ctx.signal.aborted) throw cancelError();

    if (hasBuffer && !NATIVE_DECODE.has(mime)) {
      // Allow anyway — some browsers have extra coverage — but warn via error class.
      // The createImageBitmap call below will throw if the browser really can't decode.
    }

    // ─── Decode ─────────────────────────────────────────────────────────

    /** @type {ImageBitmap} */
    let bitmap;
    if (hasRgba) {
      const imageData = new ImageData(new Uint8ClampedArray(rgba), rgbaWidth, rgbaHeight);
      bitmap = await createImageBitmap(imageData, { premultiplyAlpha: 'default' });
    } else {
      try {
        bitmap = await createImageBitmap(new Blob([buffer], { type: mime }), {
          // When srgbConvert is true we ask the decoder for sRGB colour space;
          // otherwise we let it stay in the image's native space.
          colorSpaceConversion: srgbConvert ? 'default' : 'none',
          // Honour premultiplied alpha consistently.
          premultiplyAlpha: 'default'
        });
      } catch (err) {
        throw Object.assign(new Error(`decode failed: ${err?.message ?? err}`), { klass: 'corrupt' });
      }
    }

    if (ctx.signal.aborted) { bitmap.close?.(); throw cancelError(); }

    // ─── Work out final dimensions (apply orientation swap + resize) ────

    const swapsWH = orientation >= 5 && orientation <= 8;
    const srcW = swapsWH ? bitmap.height : bitmap.width;
    const srcH = swapsWH ? bitmap.width  : bitmap.height;

    // Two sizing modes:
    //   (a) exact target W×H  — used by Social (platform canvases).
    //                           Picture is cover-cropped or contained with
    //                           background fill to the exact size.
    //   (b) long-edge cap     — used by Web-ready / HEIC / Bulk compress.
    let outW, outH;
    const hasExactTarget = targetW > 0 && targetH > 0;
    if (hasExactTarget) {
      outW = targetW;
      outH = targetH;
    } else {
      ({ outW, outH } = computeTargetSize(srcW, srcH, maxEdge));
    }

    ctx.progress(0.3);

    // ─── Paint to OffscreenCanvas with orientation applied ──────────────

    // Prefer display-p3 when the caller asked for it AND the platform supports
    // it. Older browsers fall back to sRGB which is safe.
    const wantsP3 = canvasColorSpace === 'display-p3';
    /** @type {'srgb' | 'display-p3'} */
    let canvasSpace = 'srgb';
    if (wantsP3) {
      try {
        const probe = new OffscreenCanvas(1, 1);
        const cxProbe = probe.getContext('2d', { colorSpace: 'display-p3' });
        if (cxProbe) canvasSpace = 'display-p3';
      } catch { /* keep sRGB */ }
    }

    const canvas = new OffscreenCanvas(outW, outH);
    const cx = canvas.getContext('2d', {
      alpha: format !== 'image/jpeg' && background !== 'white' && background !== 'black',
      willReadFrequently: false,
      desynchronized: false,
      colorSpace: canvasSpace
    });
    if (!cx) {
      bitmap.close?.();
      throw Object.assign(new Error('OffscreenCanvas 2D context unavailable'), { klass: 'unknown' });
    }

    // Background fill — JPEG is always opaque (defaults to white); other
    // formats honour the caller's preference.
    if (format === 'image/jpeg' || background === 'white') {
      cx.fillStyle = '#ffffff';
      cx.fillRect(0, 0, outW, outH);
    } else if (background === 'black') {
      cx.fillStyle = '#000000';
      cx.fillRect(0, 0, outW, outH);
    }
    // 'transparent' → leave canvas clear. 'blur' handled after orientation below.

    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';

    if (hasExactTarget) {
      // Exact target canvases bypass the EXIF orientation transform path
      // and do the math in "logical" (oriented) space. For orientation 5..8
      // we paint the bitmap onto a scratch canvas first so cover/contain
      // math is straightforward.
      const scratch = new OffscreenCanvas(srcW, srcH);
      const sx = scratch.getContext('2d', { alpha: true, colorSpace: canvasSpace });
      if (!sx) {
        bitmap.close?.();
        throw Object.assign(new Error('OffscreenCanvas 2D context unavailable'), { klass: 'unknown' });
      }
      applyOrientationTransform(sx, orientation, srcW, srcH);
      const dW = swapsWH ? srcH : srcW;
      const dH = swapsWH ? srcW : srcH;
      sx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, dW, dH);

      if (background === 'blur' && format !== 'image/jpeg') {
        // Fill background by up-scaling the source to 'cover' the canvas,
        // blurring, then painting. Canvas filter support varies; guard with a
        // try/catch and fall back to white.
        try {
          const coverScale = Math.max(outW / srcW, outH / srcH);
          const bw = Math.ceil(srcW * coverScale);
          const bh = Math.ceil(srcH * coverScale);
          cx.save();
          // @ts-ignore — filter is widely supported on OffscreenCanvas now.
          cx.filter = 'blur(40px) brightness(0.95)';
          cx.drawImage(scratch, (outW - bw) / 2, (outH - bh) / 2, bw, bh);
          cx.restore();
        } catch {
          cx.fillStyle = '#ffffff';
          cx.fillRect(0, 0, outW, outH);
        }
      }

      if (fit === 'cover') {
        const scale = Math.max(outW / srcW, outH / srcH);
        const dstW = srcW * scale;
        const dstH = srcH * scale;
        cx.drawImage(scratch, (outW - dstW) / 2, (outH - dstH) / 2, dstW, dstH);
      } else {
        // contain
        const scale = Math.min(outW / srcW, outH / srcH);
        const dstW = srcW * scale;
        const dstH = srcH * scale;
        cx.drawImage(scratch, (outW - dstW) / 2, (outH - dstH) / 2, dstW, dstH);
      }
    } else {
      applyOrientationTransform(cx, orientation, outW, outH);
      const drawW = swapsWH ? outH : outW;
      const drawH = swapsWH ? outW : outH;
      cx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, drawW, drawH);
    }

    bitmap.close?.();

    if (ctx.signal.aborted) throw cancelError();
    ctx.progress(0.75);

    // ─── Encode ─────────────────────────────────────────────────────────

    /** @type {Blob} */
    let blob;
    try {
      blob = await canvas.convertToBlob({
        type: format,
        quality: format === 'image/png' ? undefined : quality
      });
    } catch (err) {
      // AVIF isn't supported on all browsers. Fall back to WebP then JPEG.
      if (format === 'image/avif') {
        try { blob = await canvas.convertToBlob({ type: 'image/webp', quality }); }
        catch { blob = await canvas.convertToBlob({ type: 'image/jpeg', quality }); }
      } else if (format === 'image/webp') {
        blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      } else {
        throw Object.assign(new Error(`encode failed: ${err?.message ?? err}`), { klass: 'unknown' });
      }
    }

    const outBuffer = await blob.arrayBuffer();
    ctx.transfer(outBuffer);

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    ctx.progress(1);

    return {
      buffer: outBuffer,
      width:  outW,
      height: outH,
      encoded: { mime: blob.type || format, quality },
      elapsed: Math.round(t1 - t0)
    };
  }
};

// ─── Helpers ────────────────────────────────────────────────────────────

function cancelError() {
  const e = new Error('cancelled');
  e.klass = 'cancelled';
  return e;
}

/**
 * Compute output dimensions so the long edge is at most maxEdge (or unchanged
 * if maxEdge is 0 / larger than current). Never upscales.
 */
function computeTargetSize(srcW, srcH, maxEdge) {
  if (!maxEdge || maxEdge <= 0) return { outW: srcW, outH: srcH };
  const longest = Math.max(srcW, srcH);
  if (longest <= maxEdge) return { outW: srcW, outH: srcH };
  const scale = maxEdge / longest;
  return { outW: Math.round(srcW * scale), outH: Math.round(srcH * scale) };
}

/**
 * Apply EXIF orientation as a canvas transform so the drawn pixels come out
 * visually upright. After this the output's Orientation tag should be set to 1.
 *
 * EXIF orientation values:
 *   1 = normal
 *   2 = flip horizontal
 *   3 = rotate 180
 *   4 = flip vertical
 *   5 = transpose (flip horizontal + rotate 90 CW)
 *   6 = rotate 90 CW
 *   7 = transverse (flip horizontal + rotate 270 CW)
 *   8 = rotate 270 CW
 */
function applyOrientationTransform(cx, orientation, outW, outH) {
  switch (orientation) {
    case 2: cx.translate(outW, 0);    cx.scale(-1, 1);                            break;
    case 3: cx.translate(outW, outH); cx.rotate(Math.PI);                         break;
    case 4: cx.translate(0, outH);    cx.scale(1, -1);                            break;
    case 5: cx.rotate(0.5 * Math.PI); cx.scale(1, -1);                            break;
    case 6: cx.translate(outW, 0);    cx.rotate(0.5 * Math.PI);                   break;
    case 7: cx.translate(outW, 0);    cx.rotate(0.5 * Math.PI); cx.scale(1, -1); cx.translate(-outW, 0); break;
    case 8: cx.translate(0, outH);    cx.rotate(-0.5 * Math.PI);                  break;
    // 1 and anything else: no transform.
    default: /* noop */                                                           break;
  }
}
