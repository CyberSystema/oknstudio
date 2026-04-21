/**
 * OKN Studio · Darkroom — Metadata Studio zone
 * ============================================
 * View, edit, strip EXIF / IPTC / XMP without re-encoding. Pixel-less: the
 * original bytes pass through untouched except for the EXIF segment, which
 * is rewritten according to the chosen policy.
 *
 * Phase 2 scope: JPEG only (piexifjs). PNG/TIFF/WebP/HEIC metadata writes
 * land with the processing server (exiftool) in a later phase and currently route
 * to "Needs attention" as the expected outcome.
 *
 * Shared with Web-ready / Bulk Compress:
 *   - engines/rename.js            (filename engine)
 *   - engines/metadata.js          (policy + attribution engine)
 *   - NO worker — piexifjs is sync, fast, and main-thread safe for JPEG.
 */

import { computeName }         from '@okn/engines/rename.js';
import { applyMetadataPolicy } from '@okn/engines/metadata.js';
import { DispatchError }       from '@okn/job/dispatcher.js';
import { loadSettings }        from '../storage/settings.js';

// ─── Defaults ───────────────────────────────────────────────────────────

export function defaultSettings() {
  return {
    zoneId: 'metadata-studio',
    preset: 'keep-original',          // Most users don't want to rename here
    rename: {
      preset: 'keep-original',
      seqStart: 1,
      collision: 'suffix',
      case: 'keep'
    },
    metadata: {
      mode: 'strip-private',          // Balanced default
      injectOknAttribution: false,
      forceOverwriteBlankOnly: true
    },
    extra: {
      event: '',
      normaliseOrientation: false     // Opt-in; not usually what you want in MS
    }
  };
}

// ─── Processor factory ──────────────────────────────────────────────────

/**
 * @param {object} settings
 * @returns {Promise<import('@okn/job/dispatcher.js').ProcessFn>}
 */
export async function createMetadataStudioProcessor(settings) {
  const userSettings = await loadSettings();
  const photographer = userSettings.creator.slug || userSettings.creator.name || undefined;

  let seq = settings.rename.seqStart;
  const seen = new Map();

  /** @type {import('@okn/job/dispatcher.js').ProcessFn} */
  return async function process(row, _settings, signal) {
    if (!row.file) throw new DispatchError('corrupt', 'File bytes unavailable');
    if (signal.aborted) throw cancel();

    // ─── Output name ──────────────────────────────────────────────────
    // Keep the original extension — no format change.
    const mySeq = seq++;
    const { outputName: baseName, stem } = computeName(
      {
        originalName: row.name,
        exif: row.inputExif,
        fileMtime: row.file.lastModified
      },
      settings.rename,
      mySeq,
      settings.extra?.event,
      photographer
    );
    const ext = extOf(baseName);
    const finalName = resolveCollisionLive(baseName, stem, ext, seen, settings.rename.collision);
    if (finalName === null) throw new DispatchError('collision-skip', 'Skipped duplicate', false, true);

    // ─── Apply metadata policy ─────────────────────────────────────────
    // For JPEG: piexifjs rewrites the EXIF segment losslessly. Pixels
    // untouched. For other formats: pixels pass through with a warning.
    const isJpeg = /^image\/jpe?g$/i.test(row.file.type) || /\.jpe?g$/i.test(row.name);

    let outBlob;
    if (isJpeg) {
      try {
        outBlob = await applyMetadataPolicy(row.file, settings.metadata, {
          creator: userSettings.creator,
          attribution: userSettings.attribution,
          clearOrientation: !!settings.extra.normaliseOrientation
        });
      } catch {
        // Policy failure is non-fatal — ship original bytes with a warning.
        row.warnings.push('metadata-write-failed');
        outBlob = row.file.slice();
      }
    } else {
      // Non-JPEG: pixels + metadata both pass through. Surface the fact
      // that we couldn't honour the policy here.
      row.warnings.push('metadata-policy-unavailable-for-format');
      outBlob = row.file.slice();
    }

    if (signal.aborted) throw cancel();

    return {
      blob: outBlob,
      outputName: finalName,
      outputSize: outBlob.size
    };
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function cancel() { return new DispatchError('cancelled', 'Cancelled'); }

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i);
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

// ─── EXIF summary formatter (used by the dry-run inspector) ────────────

/**
 * Produce a human-friendly summary of the ExifSummary attached to a row.
 * The UI uses this to show what a file "has" before the user picks a policy.
 *
 * @param {import('@okn/job/intake.js').ExifSummary | undefined} exif
 * @returns {Array<{label:string, value:string, sensitive?:boolean}>}
 */
export function summariseExif(exif) {
  /** @type {Array<{label:string, value:string, sensitive?:boolean}>} */
  const rows = [];
  if (!exif) {
    rows.push({ label: 'EXIF', value: 'not present' });
    return rows;
  }

  if (exif.dateTimeOriginal) rows.push({ label: 'Taken',      value: formatDate(exif.dateTimeOriginal) });
  if (exif.camera)           rows.push({ label: 'Camera',     value: exif.camera });
  if (exif.lens)             rows.push({ label: 'Lens',       value: exif.lens });
  if (exif.iso)              rows.push({ label: 'ISO',        value: String(exif.iso) });
  if (exif.fStop)            rows.push({ label: 'Aperture',   value: 'f/' + exif.fStop });
  if (exif.shutter)          rows.push({ label: 'Shutter',    value: exif.shutter + 's' });
  if (exif.focalLength)      rows.push({ label: 'Focal len.', value: exif.focalLength + 'mm' });
  if (exif.gps && typeof exif.gps.lat === 'number' && typeof exif.gps.lon === 'number') {
    rows.push({
      label: 'GPS',
      value: `${exif.gps.lat.toFixed(4)}, ${exif.gps.lon.toFixed(4)}`,
      sensitive: true   // flags this row for red-tint in the UI
    });
  }
  if (typeof exif.rating === 'number') rows.push({ label: 'Rating', value: '★'.repeat(exif.rating) + '☆'.repeat(5 - exif.rating) });
  if (exif.orientation && exif.orientation !== 1) {
    rows.push({ label: 'Orientation', value: 'EXIF #' + exif.orientation });
  }
  if (typeof exif.width === 'number' && typeof exif.height === 'number') {
    rows.push({ label: 'Dimensions', value: `${exif.width} × ${exif.height}` });
  }

  if (rows.length === 0) rows.push({ label: 'EXIF', value: 'present but minimal' });
  return rows;
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return iso;
  }
}
