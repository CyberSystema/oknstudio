/**
 * OKN Studio · Darkroom — HEIC → JPEG zone
 * ========================================
 * Converts HEIC/HEIF from iPhone to JPEG (or WebP) for non-Apple recipients.
 *
 * Why main-thread decode:
 *   libheif-js is a ~1.5 MB WASM bundle that wants a Module init in the
 *   same realm as the caller. We lazy-load it once per session on the main
 *   thread, decode each file to RGBA, then hand the raw pixels to the
 *   shared image-encode worker via its `rgba` path. This keeps the encode
 *   step parallel while the decode stays in one place.
 *
 * Exif carry-over:
 *   libheif doesn't hand us EXIF in the decoded frame; intake's exifr pass
 *   already read Orientation + DateTimeOriginal from the source. We pass
 *   orientation to the encoder so the decoded pixels come out upright, then
 *   (for JPEG outputs) piexifjs re-inserts a minimal EXIF envelope with
 *   the attribution policy applied.
 */

import { computeName }         from '@okn/engines/rename.js';
import { applyMetadataPolicy } from '@okn/engines/metadata.js';
import { DispatchError }       from '@okn/job/dispatcher.js';
import { getPool }             from '@okn/job/worker-pool.js';
import { loadSettings }        from '../storage/settings.js';

const FORMAT_EXT = {
  'image/jpeg': '.jpg',
  'image/webp': '.webp'
};

// ─── Lazy libheif loader ────────────────────────────────────────────────

/** @type {Promise<any> | null} */
let heifInitPromise = null;

async function getHeif() {
  if (heifInitPromise) return heifInitPromise;
  heifInitPromise = (async () => {
    const mod = await import('https://esm.sh/libheif-js@1.17.1?bundle');
    const init = /** @type {any} */ (mod).default ?? mod;
    // libheif-js exports a factory that returns a decoder module. Some
    // builds expose HeifDecoder directly; support both shapes.
    if (typeof init === 'function') return init();
    return init;
  })();
  return heifInitPromise;
}

// ─── Defaults ───────────────────────────────────────────────────────────

export function defaultSettings() {
  return {
    zoneId: 'heic-to-jpeg',
    preset: 'keep-original',
    rename: {
      preset: 'keep-original',
      seqStart: 1,
      collision: 'suffix',
      case: 'keep'
    },
    metadata: {
      mode: 'keep-all',
      injectOknAttribution: false,
      forceOverwriteBlankOnly: true
    },
    extra: {
      event: '',
      format: 'image/jpeg',
      quality: 0.90,
      maxEdge: 0,          // 0 = keep original
      srgbConvert: false   // HEIC is typically Display P3; keep unless asked
    }
  };
}

// ─── Processor factory ──────────────────────────────────────────────────

/**
 * @param {object} settings
 * @returns {Promise<import('@okn/job/dispatcher.js').ProcessFn>}
 */
export async function createHeicToJpegProcessor(settings) {
  const userSettings = await loadSettings();
  const photographer = userSettings.creator.slug || userSettings.creator.name || undefined;

  let seq = settings.rename.seqStart;
  const seen = new Map();
  const pool = getPool();

  // Warm the decoder once per job (rather than per file).
  const heif = await getHeif().catch((err) => {
    throw new DispatchError('unsupported', `HEIC decoder failed to load: ${err?.message ?? err}`);
  });

  /** @type {import('@okn/job/dispatcher.js').ProcessFn} */
  return async function process(row, _zoneSettings, signal) {
    if (!row.file) throw new DispatchError('corrupt', 'File bytes unavailable');
    if (signal.aborted) throw new DispatchError('cancelled', 'Cancelled');

    const mySeq = seq++;
    const outFormat = settings.extra.format || 'image/jpeg';
    const desiredExt = FORMAT_EXT[outFormat] ?? '.jpg';

    const { outputName: baseName, stem } = computeName(
      {
        originalName: replaceExt(row.name, desiredExt),
        exif: row.inputExif,
        fileMtime: row.file.lastModified
      },
      settings.rename,
      mySeq,
      settings.extra?.event,
      photographer
    );

    const finalName = resolveCollisionLive(
      baseName, stem, desiredExt, seen, settings.rename.collision
    );
    if (finalName === null) {
      throw new DispatchError('collision-skip', 'Skipped duplicate', false, true);
    }

    // ─── Decode HEIC → RGBA on main thread ─────────────────────────────

    const heicBytes = new Uint8Array(await row.file.arrayBuffer());
    if (signal.aborted) throw new DispatchError('cancelled', 'Cancelled');

    const { rgba, width, height } = await decodeHeic(heif, heicBytes).catch((err) => {
      throw new DispatchError('corrupt', `HEIC decode failed: ${err?.message ?? err}`);
    });

    if (signal.aborted) throw new DispatchError('cancelled', 'Cancelled');

    // ─── Encode via worker (rgba path) ─────────────────────────────────

    const rgbaBuf = rgba.buffer.slice(0); // detachable copy for transfer
    const encoded = /** @type {{buffer:ArrayBuffer,encoded:{mime:string}}} */ (
      await pool.run({
        kind: 'image-encode',
        payload: {
          rgba: rgbaBuf,
          rgbaWidth: width,
          rgbaHeight: height,
          maxEdge: settings.extra.maxEdge || 0,
          format: outFormat,
          quality: clamp01(settings.extra.quality ?? 0.90),
          orientation: row.inputExif?.orientation ?? 1,
          srgbConvert: !!settings.extra.srgbConvert
        },
        transfer: [rgbaBuf],
        signal
      })
    );

    if (signal.aborted) throw new DispatchError('cancelled', 'Cancelled');

    const encodedMime = encoded.encoded?.mime || outFormat;
    let outBlob = new Blob([encoded.buffer], { type: encodedMime });

    if (encodedMime === 'image/jpeg') {
      try {
        outBlob = await applyMetadataPolicy(outBlob, settings.metadata, {
          creator: userSettings.creator,
          attribution: userSettings.attribution,
          clearOrientation: true
        });
      } catch {
        row.warnings.push('metadata-write-failed');
      }
    } else if (settings.metadata.injectOknAttribution) {
      row.warnings.push('attribution-unavailable-for-format');
    }

    return {
      blob: outBlob,
      outputName: finalName,
      outputSize: outBlob.size
    };
  };
}

// ─── HEIC decode helper ─────────────────────────────────────────────────

/**
 * Decode the primary image of a HEIC/HEIF file to RGBA.
 * libheif-js has gone through a few API variants; this helper tries the
 * common shapes in order.
 *
 * @param {any} heif
 * @param {Uint8Array} bytes
 * @returns {Promise<{rgba: Uint8Array, width: number, height: number}>}
 */
async function decodeHeic(heif, bytes) {
  // Modern API: heif.HeifDecoder + decoder.decode(bytes) → [{display: {...}}]
  if (heif && typeof heif.HeifDecoder === 'function') {
    const decoder = new heif.HeifDecoder();
    const images = decoder.decode(bytes);
    if (!images || images.length === 0) throw new Error('no images found in HEIC');
    const primary = images[0];
    const w = primary.get_width();
    const h = primary.get_height();
    return await new Promise((resolve, reject) => {
      primary.display({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }, (imageData) => {
        if (!imageData) reject(new Error('display returned null'));
        else resolve({ rgba: new Uint8Array(imageData.data.buffer), width: imageData.width, height: imageData.height });
      });
    });
  }
  // Fallback: some bundles expose decode() directly.
  if (heif && typeof heif.decode === 'function') {
    const result = await heif.decode(bytes);
    if (!result) throw new Error('decode returned null');
    return { rgba: new Uint8Array(result.data), width: result.width, height: result.height };
  }
  throw new Error('libheif API not recognised');
}

// ─── Helpers ────────────────────────────────────────────────────────────

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0.90;
  return Math.max(0, Math.min(1, x));
}

function replaceExt(name, ext) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return name + ext;
  return name.slice(0, i) + ext;
}

function resolveCollisionLive(outputName, stem, ext, seen, strategy) {
  const key = outputName.toLowerCase();
  const prior = seen.get(key);
  if (prior === undefined) { seen.set(key, 1); return outputName; }
  if (strategy === 'skip')  return null;
  if (strategy === 'error') throw new DispatchError('unknown', `name collision: ${outputName}`);

  let n = prior;
  let candidate = '';
  let candidateKey = '';
  do {
    candidate = `${stem}_${n}${ext}`;
    candidateKey = candidate.toLowerCase();
    n += 1;
  } while (seen.has(candidateKey));
  seen.set(key, n);
  seen.set(candidateKey, 1);
  return candidate;
}
