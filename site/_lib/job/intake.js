/**
 * OKN Studio · Shared — Intake
 * ============================
 * Turn raw File objects into FileRows with EXIF read, type validation, and
 * stable ids. Uses exifr from esm.sh (no npm step — matches the rest of
 * this project's "static deploy only" convention).
 */

import exifr from 'https://esm.sh/exifr@7.1.3?bundle';

/**
 * @typedef {Object} ExifSummary
 * @property {string=} dateTimeOriginal
 * @property {string=} camera
 * @property {string=} lens
 * @property {number=} iso
 * @property {number=} fStop
 * @property {string=} shutter
 * @property {number=} focalLength
 * @property {{lat:number,lon:number}|null=} gps
 * @property {0|1|2|3|4|5=} rating
 * @property {number=} orientation
 * @property {number=} width
 * @property {number=} height
 *
 * @typedef {Object} FileRow
 * @property {string} id
 * @property {string} name
 * @property {number} size
 * @property {string} type
 * @property {'queued'|'reading'|'processing'|'writing'|'done'|'warning'|'error'|'filtered'|'cancelled'} status
 * @property {number} progress
 * @property {File=} file
 * @property {ExifSummary=} inputExif
 * @property {string=} outputName
 * @property {number=} outputSize
 * @property {string[]} warnings
 * @property {{class:string,message:string,retryable:boolean}=} error
 */

/**
 * Minimal shape the intake layer needs from a zone manifest. Kept local to
 * `_lib/` so this module doesn't reach back into any tool's registry.
 *
 * @typedef {Object} ZoneAcceptSpec
 * @property {string[]} accept   MIME types or ".ext" patterns; 'image/*' also matches.
 */

/** @param {File} file @param {ZoneAcceptSpec} zone */
export function isAccepted(file, zone) {
  const mime = (file.type || '').toLowerCase();
  const name = file.name.toLowerCase();
  for (const pattern of zone.accept) {
    if (pattern === 'image/*' && mime.startsWith('image/')) return true;
    if (pattern.startsWith('.') && name.endsWith(pattern)) return true;
    if (pattern === mime) return true;
  }
  return false;
}

function rid(prefix = 'f') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

/** @param {File} file @returns {Promise<ExifSummary|undefined>} */
async function readExif(file) {
  try {
    const raw = await exifr.parse(file, {
      tiff: true, ifd0: true, exif: true, gps: true,
      iptc: false, xmp: ['Rating'], interop: false, icc: false,
      pick: [
        'DateTimeOriginal', 'Make', 'Model', 'LensModel',
        'ISO', 'FNumber', 'ExposureTime', 'FocalLength',
        'Orientation', 'ExifImageWidth', 'ExifImageHeight',
        'PixelXDimension', 'PixelYDimension', 'latitude', 'longitude', 'Rating'
      ]
    });
    if (!raw) return undefined;

    const dt = raw.DateTimeOriginal instanceof Date ? raw.DateTimeOriginal.toISOString() : undefined;
    const make = typeof raw.Make === 'string' ? raw.Make.trim() : '';
    const model = typeof raw.Model === 'string' ? raw.Model.trim() : '';
    const camera = [make, model].filter(Boolean).join(' ');
    const shutter = exposureToShutter(raw.ExposureTime);
    const gps = typeof raw.latitude === 'number' && typeof raw.longitude === 'number'
      ? { lat: raw.latitude, lon: raw.longitude } : null;

    return {
      dateTimeOriginal: dt,
      camera: camera || undefined,
      lens: typeof raw.LensModel === 'string' ? raw.LensModel : undefined,
      iso: typeof raw.ISO === 'number' ? raw.ISO : undefined,
      fStop: typeof raw.FNumber === 'number' ? raw.FNumber : undefined,
      shutter,
      focalLength: typeof raw.FocalLength === 'number' ? raw.FocalLength : undefined,
      gps,
      rating: clampRating(raw.Rating),
      orientation: typeof raw.Orientation === 'number' ? raw.Orientation : undefined,
      width:  raw.ExifImageWidth  ?? raw.PixelXDimension,
      height: raw.ExifImageHeight ?? raw.PixelYDimension
    };
  } catch {
    return undefined;
  }
}

function exposureToShutter(et) {
  if (typeof et !== 'number' || !isFinite(et) || et <= 0) return undefined;
  if (et >= 1) return String(et);
  return `1/${Math.round(1 / et)}`;
}

/**
 * Clamp an unknown input to the 0–5 rating scale used by ExifSummary.
 * JSDoc return-type narrowing lets the call site — `rating: clampRating(raw.Rating)`
 * — type-check against the strict `0|1|2|3|4|5 | undefined` field, which
 * TypeScript wouldn't infer from `Math.max(...)` (which returns `number`).
 *
 * @param {unknown} r
 * @returns {0|1|2|3|4|5 | undefined}
 */
function clampRating(r) {
  if (typeof r !== 'number') return undefined;
  const n = Math.max(0, Math.min(5, Math.round(r)));
  return /** @type {0|1|2|3|4|5} */ (n);
}

/**
 * @param {File[]} files
 * @param {ZoneAcceptSpec} zone
 * @returns {Promise<{accepted: FileRow[], rejected: {name:string, reason:string}[]}>}
 */
export async function intake(files, zone) {
  /** @type {FileRow[]} */ const accepted = [];
  /** @type {{name:string,reason:string}[]} */ const rejected = [];

  /** @type {File[]} */ const toRead = [];
  for (const f of files) {
    if (!isAccepted(f, zone)) { rejected.push({ name: f.name, reason: 'unsupported-type' }); continue; }
    toRead.push(f);
  }

  const CONCURRENCY = 6;
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < toRead.length) {
      const i = cursor++;
      const file = toRead[i];
      const exif = await readExif(file);
      accepted.push({
        id: rid('f'),
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        status: 'queued',
        progress: 0,
        file,
        inputExif: exif,
        warnings: []
      });
    }
  });
  await Promise.all(workers);

  accepted.sort((a, b) => a.name.localeCompare(b.name));
  return { accepted, rejected };
}
