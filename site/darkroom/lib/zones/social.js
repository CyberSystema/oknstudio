/**
 * OKN Studio · Darkroom — Social media zone
 * =========================================
 * Crop, resize, strip, name — for Instagram / Facebook posts.
 *
 * Browser-only: center-crop (or contain-with-background) using the shared
 * image-encode worker's `targetW/H + fit + background` path. Face-aware
 * smart crop routes to the processing server in a later phase; for now we
 * center-crop and trust the photographer to frame sensibly.
 *
 * Pipeline per file:
 *   1. Rename engine  → output name
 *   2. Worker pool    → decode + orient + resize-to-platform + re-encode
 *   3. Metadata engine→ apply policy (default strip-all for social)
 *   4. Emit { blob, outputName, outputSize }
 */

import { computeName }         from '@okn/engines/rename.js';
import { applyMetadataPolicy } from '@okn/engines/metadata.js';
import { DispatchError }       from '@okn/job/dispatcher.js';
import { getPool }             from '@okn/job/worker-pool.js';
import { loadSettings }        from '../storage/settings.js';

// ─── Constants ──────────────────────────────────────────────────────────

const FORMAT_EXT = {
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/png':  '.png'
};

/** Platform canvas presets: dimensions in pixels (W × H). */
export const SOCIAL_PRESETS = {
  'instagram-square':    { w: 1080, h: 1080 },
  'instagram-portrait':  { w: 1080, h: 1350 },
  'instagram-story':     { w: 1080, h: 1920 },
  'facebook-post':       { w: 1200, h: 630  },
  'facebook-cover':      { w: 820,  h: 312  }
};

// ─── Defaults ───────────────────────────────────────────────────────────

export function defaultSettings() {
  return {
    zoneId: 'social',
    preset: 'okn-event',
    rename: {
      preset: 'okn-event',
      seqStart: 1,
      collision: 'suffix',
      case: 'keep'
    },
    metadata: {
      // Strip everything by default — social posts shouldn't carry GPS,
      // device serials, or workflow metadata.
      mode: 'strip-all',
      injectOknAttribution: false,
      forceOverwriteBlankOnly: true
    },
    extra: {
      event: '',
      platform: 'instagram-square',      // key into SOCIAL_PRESETS or 'custom'
      customW: 1080,
      customH: 1080,
      fit: 'cover',                      // 'cover' | 'contain'
      background: 'blur',                // 'blur' | 'white' | 'black' | 'transparent'
      format: 'image/jpeg',
      quality: 0.85
    }
  };
}

// ─── Processor factory ──────────────────────────────────────────────────

/**
 * @param {object} settings
 * @returns {Promise<import('@okn/job/dispatcher.js').ProcessFn>}
 */
export async function createSocialProcessor(settings) {
  const userSettings = await loadSettings();
  const photographer = userSettings.creator.slug || userSettings.creator.name || undefined;

  let seq = settings.rename.seqStart;
  const seen = new Map();
  const pool = getPool();

  // Resolve platform dimensions once per job.
  const platform = settings.extra.platform ?? 'instagram-square';
  const preset = platform === 'custom'
    ? { w: clampPx(settings.extra.customW ?? 1080), h: clampPx(settings.extra.customH ?? 1080) }
    : (SOCIAL_PRESETS[platform] ?? SOCIAL_PRESETS['instagram-square']);

  /** @type {import('@okn/job/dispatcher.js').ProcessFn} */
  return async function process(row, _zoneSettings, signal) {
    if (!row.file) throw new DispatchError('corrupt', 'File bytes unavailable');
    if (signal.aborted) throw new DispatchError('cancelled', 'Cancelled');

    const mySeq = seq++;
    const outFormat = settings.extra.format || 'image/jpeg';
    const desiredExt = FORMAT_EXT[outFormat] ?? '.jpg';

    // Insert a platform slug into {platform} templates via the rename engine
    // by re-using {event} is confusing; instead we suffix the platform tag
    // onto the stem after rename.
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

    const platformSlug = slugify(platform);
    const taggedStem = `${stem}_${platformSlug}`;
    const taggedName = taggedStem + desiredExt;

    const finalName = resolveCollisionLive(
      taggedName, taggedStem, desiredExt, seen, settings.rename.collision
    );
    if (finalName === null) {
      throw new DispatchError('collision-skip', 'Skipped duplicate', false, true);
    }

    if (signal.aborted) throw new DispatchError('cancelled', 'Cancelled');

    // ─── Decode + crop/resize + encode via worker ──────────────────────

    const buffer = await row.file.arrayBuffer();
    const encoded = /** @type {{buffer:ArrayBuffer,width:number,height:number,encoded:{mime:string,quality:number},elapsed:number,warnings?:string[]}} */ (
      await pool.run({
        kind: 'image-encode',
        payload: {
          buffer,
          mime: row.file.type || 'image/jpeg',
          targetW: preset.w,
          targetH: preset.h,
          fit: settings.extra.fit || 'cover',
          background: settings.extra.background || 'blur',
          format: outFormat,
          quality: clamp01(settings.extra.quality ?? 0.85),
          orientation: row.inputExif?.orientation ?? 1,
          srgbConvert: true
        },
        transfer: [buffer],
        signal
      })
    );

    if (signal.aborted) throw new DispatchError('cancelled', 'Cancelled');
    if (Array.isArray(encoded.warnings)) {
      for (const w of encoded.warnings) row.warnings.push(w);
    }
    // ─── Metadata policy ───────────────────────────────────────────────

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
    } else if (settings.metadata.mode !== 'keep-all' || settings.metadata.injectOknAttribution) {
      // Non-JPEG: we can't rewrite metadata in the browser. Pixels are
      // shipped clean; note the limitation.
      row.warnings.push('metadata-policy-unavailable-for-format');
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
  if (!Number.isFinite(x)) return 0.85;
  return Math.max(0, Math.min(1, x));
}

function clampPx(n) {
  const x = parseInt(n, 10);
  if (!Number.isFinite(x)) return 1080;
  return Math.max(16, Math.min(8192, x));
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
