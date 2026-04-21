/**
 * OKN Studio · Shared — Metadata engine (JPEG focus for Phase 2)
 * ==============================================================
 * Three composable operations: read, strip, inject. All zones call the
 * same engine; they differ only in which ops they compose.
 *
 * Phase 2 scope: JPEG only. The Web-ready / Social / Bulk-compress /
 * HEIC→JPEG / Metadata Studio zones all write JPEG (or start from JPEG
 * for metadata edits), and piexifjs handles JPEG EXIF/GPS/0th/1st IFDs
 * losslessly in pure JS. PNG/TIFF/WebP writes land with the server
 * (exiftool) in a later phase — for now those outputs simply carry no
 * injected attribution and we note that in the Needs Attention panel.
 *
 * Library: piexifjs 1.0.6 from esm.sh, synchronous, ~80KB gzipped.
 */

import piexif from 'https://esm.sh/piexifjs@1.0.6?bundle';

/**
 * @typedef {'keep-all' | 'strip-private' | 'strip-all'} MetadataMode
 *
 * @typedef {Object} MetadataPolicy
 * @property {MetadataMode} mode
 * @property {boolean} injectOknAttribution
 * @property {boolean} forceOverwriteBlankOnly
 *
 * @typedef {Object} AttributionTemplate
 * @property {string} copyrightTemplate
 * @property {string} rights
 * @property {string} credit
 * @property {string=}  source
 *
 * @typedef {Object} CreatorIdentity
 * @property {string} name
 * @property {string} email
 * @property {string=}  slug
 *
 * @typedef {Object} ApplyContext
 * @property {CreatorIdentity=} creator
 * @property {AttributionTemplate=} attribution
 * @property {boolean=} clearOrientation    after physical auto-rotate on re-encode
 */

// ─── EXIF tag shortcuts (piexifjs IDs) ──────────────────────────────────

const Ifd0  = piexif.ImageIFD;
const Exif  = piexif.ExifIFD;
const GPS   = piexif.GPSIFD;

/** EXIF-level tag groups we call "private" and strip for public-bound zones. */
const PRIVATE_IFD0_TAGS = [
  // Identity / device uniqueness
  Ifd0.ImageUniqueID,
  // We keep Make/Model as useful context, but strip the serial numbers.
  Ifd0.CameraSerialNumber ?? 0xC62F,
  Ifd0.HostComputer       ?? 0x013C,
  Ifd0.Software           ?? 0x0131,
  Ifd0.Artist             ?? 0x013B,   // will be re-injected via Creator
  Ifd0.Copyright          ?? 0x8298,   // will be re-injected from template
  Ifd0.XPAuthor           ?? 0x9C9D,
  Ifd0.XPComment          ?? 0x9C9C,
  Ifd0.XPKeywords         ?? 0x9C9E,
  Ifd0.XPSubject          ?? 0x9C9F,
  Ifd0.XPTitle            ?? 0x9C9B
].filter((x) => typeof x === 'number');

const PRIVATE_EXIF_TAGS = [
  Exif.UserComment,
  Exif.LensSerialNumber,
  Exif.BodySerialNumber,
  Exif.CameraOwnerName,
  Exif.ImageUniqueID,
  Exif.MakerNote,
  Exif.OECF
].filter((x) => typeof x === 'number');

// ─── Public entrypoint ──────────────────────────────────────────────────

/**
 * Apply a metadata policy to a JPEG blob. Returns a new Blob with the
 * transformed EXIF. If the input isn't JPEG, returns the input unchanged.
 *
 * @param {Blob} jpegBlob
 * @param {MetadataPolicy} policy
 * @param {ApplyContext=} ctx
 * @returns {Promise<Blob>}
 */
export async function applyMetadataPolicy(jpegBlob, policy, ctx = {}) {
  if (!jpegBlob || jpegBlob.type !== 'image/jpeg') return jpegBlob;

  // piexifjs works on binary strings (Latin-1).
  const dataUrl = await blobToDataUrl(jpegBlob);

  let exif;
  try {
    exif = piexif.load(dataUrl);
  } catch {
    // No EXIF → start with an empty envelope.
    exif = { '0th': {}, 'Exif': {}, 'GPS': {}, 'Interop': {}, '1st': {}, thumbnail: null };
  }

  // ─── Strip ────────────────────────────────────────────────────────────

  if (policy.mode === 'strip-all') {
    exif = { '0th': {}, 'Exif': {}, 'GPS': {}, 'Interop': {}, '1st': {}, thumbnail: null };
  } else if (policy.mode === 'strip-private') {
    // Wipe GPS in full.
    exif['GPS'] = {};
    // Drop private tags from 0th + Exif IFDs.
    for (const tag of PRIVATE_IFD0_TAGS) delete exif['0th'][tag];
    for (const tag of PRIVATE_EXIF_TAGS) delete exif['Exif'][tag];
    // Drop thumbnail + 1st IFD (private-ish; can leak original content).
    exif['1st'] = {};
    exif.thumbnail = null;
  }
  // 'keep-all' → no-op.

  // ─── Orientation: when we've physically auto-rotated pixels on re-encode,
  //     the caller asks us to set the output tag to 1 so downstream apps
  //     don't double-rotate.

  if (ctx.clearOrientation) {
    exif['0th'][Ifd0.Orientation] = 1;
  }

  // ─── Inject OKN attribution ──────────────────────────────────────────

  if (policy.injectOknAttribution) {
    injectAttribution(exif, ctx, policy.forceOverwriteBlankOnly ?? true);
  }

  // ─── Dump back ───────────────────────────────────────────────────────

  try {
    const exifBytes = piexif.dump(exif);
    const newDataUrl = piexif.insert(exifBytes, dataUrl);
    return dataUrlToBlob(newDataUrl);
  } catch {
    // Write failure: hand back the original JPEG so we don't lose the pixels.
    return jpegBlob;
  }
}

/**
 * Write-only inject variant: skips strip semantics, just forces attribution
 * onto blank fields (or overwrites if forceOverwriteBlankOnly=false).
 * Used by Metadata Studio's "apply template" action.
 *
 * @param {Blob} jpegBlob
 * @param {ApplyContext} ctx
 * @param {boolean=} blankOnly
 */
export async function injectAttributionOnly(jpegBlob, ctx, blankOnly = true) {
  return applyMetadataPolicy(
    jpegBlob,
    { mode: 'keep-all', injectOknAttribution: true, forceOverwriteBlankOnly: blankOnly },
    ctx
  );
}

// ─── Internals ──────────────────────────────────────────────────────────

function injectAttribution(exif, ctx, blankOnly) {
  const attr = ctx.attribution;
  const creator = ctx.creator;
  if (!attr || !creator) return;

  const year = new Date().getFullYear();
  const copyright = (attr.copyrightTemplate ?? '').replace('{year}', String(year));

  setIfBlankOrForce(exif['0th'], Ifd0.Copyright,      copyright,       blankOnly);
  setIfBlankOrForce(exif['0th'], Ifd0.Artist,         creator.name,    blankOnly);
  // XP* fields are UCS-2 on Windows; piexifjs handles this when we pass a
  // byte array, but in practice these tags are rarely read — leave them
  // unset in favour of the standard Artist/Copyright.
  setIfBlankOrForce(exif['Exif'], Exif.UserComment,   encodeAscii(attr.credit ?? ''), blankOnly);
}

function setIfBlankOrForce(group, tag, value, blankOnly) {
  if (!value) return;
  if (blankOnly && group[tag] !== undefined && group[tag] !== '') return;
  group[tag] = value;
}

/** EXIF UserComment is 8 bytes header + text. Produce the ASCII variant. */
function encodeAscii(text) {
  // 0x41, 0x53, 0x43, 0x49, 0x49, 0x00, 0x00, 0x00  ("ASCII\0\0\0")
  const header = String.fromCharCode(65, 83, 67, 73, 73, 0, 0, 0);
  return header + text;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(/** @type {string} */ (r.result));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const body   = dataUrl.slice(comma + 1);
  const mimeMatch = header.match(/data:([^;]+)/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const bin  = atob(body);
  const buf  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}
