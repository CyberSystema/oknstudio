/**
 * OKN Studio · Darkroom — Colour space zone
 * =========================================
 * Convert ICC colour profiles. Browser-side coverage:
 *   - target sRGB        → universal (Canvas always paints sRGB by default)
 *   - target Display P3  → supported where OffscreenCanvas accepts the
 *                          `colorSpace: 'display-p3'` option (Chromium,
 *                          Safari 16+); falls back to sRGB otherwise with
 *                          a soft warning.
 *   - Adobe RGB 1998     → routes to processing server (not reachable in
 *                          a browser-only build). Currently surfaces as
 *                          "server required" to keep the contract honest.
 *   - ProPhoto RGB       → same as Adobe RGB (server only).
 *
 * Under the hood this is just a format-preserving re-encode through the
 * shared image-encode worker with the `canvasColorSpace` hint. ICC
 * profile embedding is left to the target format's defaults — browsers
 * tag Canvas output with the canvas colour space they actually painted in.
 */

import { computeName }         from '@okn/engines/rename.js';
import { applyMetadataPolicy } from '@okn/engines/metadata.js';
import { DispatchError }       from '@okn/job/dispatcher.js';
import { getPool }             from '@okn/job/worker-pool.js';
import { loadSettings }        from '../storage/settings.js';

const FORMAT_EXT = {
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/png':  '.png'
};

/** Target profile → canvas colour space hint. Server-side targets produce
 *  a DispatchError so the row lands in Needs Attention. */
const TARGET_CANVAS_SPACE = {
  'srgb':       'srgb',
  'display-p3': 'display-p3',
  'adobe-rgb':  null,        // server only
  'prophoto':   null         // server only
};

// ─── Defaults ───────────────────────────────────────────────────────────

export function defaultSettings() {
  return {
    zoneId: 'colour-space',
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
      targetProfile: 'srgb',      // see TARGET_CANVAS_SPACE
      format: 'image/jpeg',
      quality: 0.92,
      tagOutputWithProfileSlug: true
    }
  };
}

// ─── Processor factory ──────────────────────────────────────────────────

/**
 * @param {object} settings
 * @returns {Promise<import('@okn/job/dispatcher.js').ProcessFn>}
 */
export async function createColourSpaceProcessor(settings) {
  const userSettings = await loadSettings();
  const photographer = userSettings.creator.slug || userSettings.creator.name || undefined;

  let seq = settings.rename.seqStart;
  const seen = new Map();
  const pool = getPool();

  const target = settings.extra.targetProfile ?? 'srgb';
  const canvasSpace = TARGET_CANVAS_SPACE[target];
  const targetSlug = slugify(target);

  /** @type {import('@okn/job/dispatcher.js').ProcessFn} */
  return async function process(row, _zoneSettings, signal) {
    if (!row.file) throw new DispatchError('corrupt', 'File bytes unavailable');
    if (signal.aborted) throw new DispatchError('cancelled', 'Cancelled');

    if (canvasSpace === null) {
      // Wide-gamut → narrow output in browser is fine; narrow → wide needs
      // profile-accurate conversion which lcms-on-server does correctly.
      // Keep the contract honest rather than shipping a wrong colour cast.
      throw new DispatchError(
        'server-required',
        `Conversion to ${target} requires the processing server`,
        false
      );
    }

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

    const finalStem = settings.extra.tagOutputWithProfileSlug ? `${stem}_${targetSlug}` : stem;
    const finalBase = finalStem + desiredExt;
    const finalName = resolveCollisionLive(
      finalBase, finalStem, desiredExt, seen, settings.rename.collision
    );
    if (finalName === null) {
      throw new DispatchError('collision-skip', 'Skipped duplicate', false, true);
    }

    if (signal.aborted) throw new DispatchError('cancelled', 'Cancelled');

    const buffer = await row.file.arrayBuffer();
    const encoded = /** @type {{buffer:ArrayBuffer,encoded:{mime:string}}} */ (
      await pool.run({
        kind: 'image-encode',
        payload: {
          buffer,
          mime: row.file.type || 'image/jpeg',
          maxEdge: 0,                      // colour-space conversion never resizes
          format: outFormat,
          quality: clamp01(settings.extra.quality ?? 0.92),
          orientation: row.inputExif?.orientation ?? 1,
          // For 'srgb' target, ask the decoder to flatten into sRGB.
          // For 'display-p3', keep source space on decode so the canvas
          // can actually paint in P3.
          srgbConvert: target === 'srgb',
          canvasColorSpace: canvasSpace
        },
        transfer: [buffer],
        signal
      })
    );

    if (signal.aborted) throw new DispatchError('cancelled', 'Cancelled');

    if (Array.isArray(encoded.warnings)) {
      for (const w of encoded.warnings) row.warnings.push(w);
    }

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
  if (!Number.isFinite(x)) return 0.92;
  return Math.max(0, Math.min(1, x));
}

function replaceExt(name, ext) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return name + ext;
  return name.slice(0, i) + ext;
}

function slugify(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
