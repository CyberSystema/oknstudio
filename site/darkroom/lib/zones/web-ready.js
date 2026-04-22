/**
 * OKN Studio · Darkroom — Web-ready zone
 * ======================================
 * Resize, optimise, strip private metadata, smart rename — ready for
 * oknkorea.org, okn-hub, newsletters.
 *
 * Pipeline per file:
 *   1. Rename engine  → output name (shared collision counter)
 *   2. Worker pool    → resize + re-encode (OffscreenCanvas + quality)
 *   3. Metadata engine→ apply policy + inject OKN attribution (main thread)
 *   4. Emit { blob, outputName, outputSize }
 *
 * Worker handles: decode, orientation auto-apply, resize, re-encode.
 * Main thread handles: rename, metadata (EXIF writes need a sync library).
 */

import { computeName }       from '@okn/engines/rename.js';
import { applyMetadataPolicy } from '@okn/engines/metadata.js';
import { DispatchError }     from '@okn/job/dispatcher.js';
import { getPool }           from '@okn/job/worker-pool.js';
import { loadSettings }      from '../storage/settings.js';

// ─── Defaults ───────────────────────────────────────────────────────────

/** Format → extension mapping for output filenames. */
const FORMAT_EXT = {
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/png':  '.png'
};

export function defaultSettings() {
  return {
    zoneId: 'web-ready',
    preset: 'okn-event',
    rename: {
      preset: 'okn-event',
      seqStart: 1,
      collision: 'suffix',
      case: 'keep'
    },
    metadata: {
      mode: 'strip-private',             // balanced default
      injectOknAttribution: true,
      forceOverwriteBlankOnly: true
    },
    extra: {
      event: '',
      maxEdge: 2048,                     // px
      format: 'image/jpeg',
      quality: 0.82,                     // 0..1
      srgbConvert: true
    }
  };
}

/**
 * Build a process function bound to shared job state. The dispatcher calls
 * this concurrency-many times in parallel; shared state (sequence counter,
 * collision map) is captured in the closure.
 *
 * @param {object} settings   zone settings
 * @returns {Promise<import('@okn/job/dispatcher.js').ProcessFn>}
 */
export async function createWebReadyProcessor(settings) {
  const userSettings = await loadSettings();
  const photographer = userSettings.creator.slug || userSettings.creator.name || undefined;

  let seq = settings.rename.seqStart;
  const seen = new Map();
  const pool = getPool();

  /** @type {import('@okn/job/dispatcher.js').ProcessFn} */
  return async function process(row, _zoneSettings, signal) {
    if (!row.file) throw new DispatchError('corrupt', 'File bytes unavailable');

    // ─── 1. Output name ────────────────────────────────────────────────

    const mySeq = seq++;
    const desiredExt = FORMAT_EXT[settings.extra.format] ?? '.jpg';

    const { outputName: baseName, stem } = computeName(
      {
        originalName: replaceExt(row.name, desiredExt),  // rename engine keeps ext from here
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

    if (signal.aborted) throw cancelError();

    // ─── 2. Decode / orient / resize / re-encode via worker pool ───────

    const buffer = await row.file.arrayBuffer();  // main-thread read; small cost
    const encodedResult = /** @type {{buffer:ArrayBuffer,width:number,height:number,encoded:{mime:string,quality:number},elapsed:number}} */ (
      await pool.run({
        kind: 'image-encode',
        payload: {
          buffer,
          mime: row.file.type || 'image/jpeg',
          maxEdge: settings.extra.maxEdge || 0,
          format: settings.extra.format || 'image/jpeg',
          quality: clamp01(settings.extra.quality ?? 0.82),
          orientation: row.inputExif?.orientation ?? 1,
          srgbConvert: !!settings.extra.srgbConvert
        },
        transfer: [buffer],
        signal
      })
    );

    if (signal.aborted) throw cancelError();
    if (Array.isArray(encodedResult.warnings)) {
      for (const w of encodedResult.warnings) row.warnings.push(w);
    }
    // ─── 3. Metadata policy + attribution injection ────────────────────

    const encodedMime = encodedResult.encoded?.mime || settings.extra.format;
    let outBlob = new Blob([encodedResult.buffer], { type: encodedMime });

    // Currently metadata writes are JPEG-only (piexifjs). For WebP/AVIF/PNG
    // we hand back the re-encoded blob with no injected attribution; the
    // dispatcher records this with a soft warning and carries on.
    if (encodedMime === 'image/jpeg') {
      try {
        outBlob = await applyMetadataPolicy(outBlob, settings.metadata, {
          creator: userSettings.creator,
          attribution: userSettings.attribution,
          clearOrientation: true
        });
      } catch (err) {
        // Metadata step never fails the file — worst case we ship clean pixels.
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

// ─── Helpers ────────────────────────────────────────────────────────────

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0.82;
  return Math.max(0, Math.min(1, x));
}

function cancelError() {
  const e = new DispatchError('cancelled', 'Cancelled');
  return e;
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
