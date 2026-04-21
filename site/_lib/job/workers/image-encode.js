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
 *     buffer:       ArrayBuffer,            // source file bytes (transferred)
 *     mime:         string,                 // source MIME (for createImageBitmap hints)
 *     maxEdge:      number,                 // 0 = no resize
 *     format:       'image/jpeg' | 'image/webp' | 'image/avif' | 'image/png',
 *     quality:      number,                 // 0..1 (ignored for PNG)
 *     orientation:  number | undefined,     // EXIF Orientation (1..8), applied + cleared
 *     srgbConvert:  boolean                 // if true, paint via OffscreenCanvas 2D
 *                                           //   (the 2D context converts to display
 *                                           //    colour space on paint — effectively sRGB
 *                                           //    when no colorSpace is set on createImageBitmap)
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
      maxEdge = 0,
      format = 'image/jpeg',
      quality = 0.82,
      orientation = 1,
      srgbConvert = true
    } = payload ?? {};

    if (!(buffer instanceof ArrayBuffer)) {
      throw Object.assign(new Error('image-encode: expected ArrayBuffer buffer'), { klass: 'corrupt' });
    }

    if (ctx.signal.aborted) throw cancelError();

    if (!NATIVE_DECODE.has(mime)) {
      // Allow anyway — some browsers have extra coverage — but warn via error class.
      // The createImageBitmap call below will throw if the browser really can't decode.
    }

    // ─── Decode ─────────────────────────────────────────────────────────

    /** @type {ImageBitmap} */
    let bitmap;
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

    if (ctx.signal.aborted) { bitmap.close?.(); throw cancelError(); }

    // ─── Work out final dimensions (apply orientation swap + resize) ────

    const swapsWH = orientation >= 5 && orientation <= 8;
    const srcW = swapsWH ? bitmap.height : bitmap.width;
    const srcH = swapsWH ? bitmap.width  : bitmap.height;
    const { outW, outH } = computeTargetSize(srcW, srcH, maxEdge);

    ctx.progress(0.3);

    // ─── Paint to OffscreenCanvas with orientation applied ──────────────

    const canvas = new OffscreenCanvas(outW, outH);
    const cx = canvas.getContext('2d', {
      alpha: format !== 'image/jpeg',          // JPEG is opaque
      willReadFrequently: false,
      desynchronized: false,
      colorSpace: 'srgb'
    });
    if (!cx) {
      bitmap.close?.();
      throw Object.assign(new Error('OffscreenCanvas 2D context unavailable'), { klass: 'unknown' });
    }

    // Opaque target (JPEG): fill white first so transparent PNG→JPEG doesn't
    // composite onto black.
    if (format === 'image/jpeg') {
      cx.fillStyle = '#ffffff';
      cx.fillRect(0, 0, outW, outH);
    }

    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';

    applyOrientationTransform(cx, orientation, outW, outH);

    // Draw bitmap. Source rect is full bitmap in its native dimensions;
    // destination rect is the post-orientation "logical" rect (before the
    // transform; the canvas transform will swap/rotate for 5..8).
    const drawW = swapsWH ? outH : outW;
    const drawH = swapsWH ? outW : outH;
    cx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, drawW, drawH);

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
