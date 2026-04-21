/**
 * OKN Studio · Darkroom — Archive package zone
 * ============================================
 * Produces the structured ZIP described in the spec:
 *
 *   archive_{event}_{date}.zip
 *     ├── manifest.csv         (finalize hook — all files in one table)
 *     ├── README.txt           (finalize hook — human-readable provenance)
 *     ├── originals/{name}     (main entry — pixels untouched)
 *     └── sidecars/{stem}.xmp  (extra entry — XMP with attribution)
 *
 * Everything is browser-only: originals pass through as zero-copy Blob
 * slices, the sidecar XMP is a small hand-written RDF doc (no external
 * library), the manifest is a CSV string built in a finalize hook after
 * all files have been processed, and the README is a multiline string.
 *
 * No pixels are re-encoded in this zone — Archive's contract is
 * preservation. Contact-sheet PDF (optional per spec) is deferred here;
 * the README notes its absence so archivists aren't surprised.
 */

import { DispatchError }       from '@okn/job/dispatcher.js';
import { loadSettings }        from '../storage/settings.js';

// ─── Defaults ───────────────────────────────────────────────────────────

export function defaultSettings() {
  return {
    zoneId: 'archive',
    preset: 'keep-original',
    rename: {
      preset: 'keep-original',
      seqStart: 1,
      collision: 'suffix',
      case: 'keep'
    },
    metadata: {
      // Attribution goes into the XMP sidecar, not into the original bytes.
      mode: 'keep-all',
      injectOknAttribution: true,
      forceOverwriteBlankOnly: true
    },
    extra: {
      event: '',
      location: '',
      includeSidecars: true,
      includeManifest: true,
      includeReadme: true
    }
  };
}

// ─── Shared job state for the finalize hook ─────────────────────────────

/**
 * Per-job state the processor fills as each file completes. The finalize
 * hook reads it to build manifest.csv / README.txt.
 * @type {Map<string, {
 *   entries: Array<{
 *     originalName: string, archivedPath: string, size: number,
 *     sha256: string, captureDate?: string, camera?: string, lens?: string
 *   }>,
 *   event: string, location: string, createdAt: number, creatorName: string
 * }>}
 */
const jobState = new Map();

/**
 * Called by the dispatcher's onFinalize hook. Receives the zipper and the
 * finished job; adds manifest.csv / README.txt based on the state keyed
 * by `stateKey`.
 *
 * @param {string} stateKey
 * @param {{ add: (e: {name:string,input:string|Blob}) => void }} zipper
 * @param {object} settings
 */
export function finalizeArchive(stateKey, zipper, settings) {
  const st = jobState.get(stateKey);
  jobState.delete(stateKey);
  if (!st) return;

  if (settings.extra?.includeManifest !== false) {
    const csv = buildManifestCsv(st.entries);
    zipper.add({ name: 'manifest.csv', input: csv });
  }
  if (settings.extra?.includeReadme !== false) {
    const readme = buildReadme(st);
    zipper.add({ name: 'README.txt', input: readme });
  }
}

// ─── Processor factory ──────────────────────────────────────────────────

/**
 * @param {object} settings
 * @returns {Promise<{
 *   process: import('@okn/job/dispatcher.js').ProcessFn,
 *   finalize: (zipper:{add:(e:{name:string,input:string|Blob})=>void}) => void
 * }>}
 */
export async function createArchiveProcessor(settings) {
  const userSettings = await loadSettings();
  const event = String(settings.extra?.event ?? '').trim();
  if (!event) {
    // The archive zone insists on an event name — without it the manifest
    // and folder naming lose their point.
    throw new DispatchError('unsupported', 'Archive requires an event name');
  }

  const stateKey = 'archive_' + Math.random().toString(36).slice(2);
  jobState.set(stateKey, {
    entries: [],
    event,
    location: String(settings.extra?.location ?? '').trim(),
    createdAt: Date.now(),
    creatorName: userSettings.creator.name || 'OKN Team'
  });

  /** @type {import('@okn/job/dispatcher.js').ProcessFn} */
  const process = async function (row, _zoneSettings, signal) {
    if (!row.file) throw new DispatchError('corrupt', 'File bytes unavailable');
    if (signal.aborted) throw new DispatchError('cancelled', 'Cancelled');

    // Hash the original bytes for the manifest + sidecar provenance.
    const bytes = await row.file.arrayBuffer();
    if (signal.aborted) throw new DispatchError('cancelled', 'Cancelled');
    const sha256 = await sha256Hex(bytes);

    const archivedPath = 'originals/' + row.name;
    /** @type {Array<{name:string,input:string|Blob}>} */
    const extras = [];

    if (settings.extra?.includeSidecars !== false) {
      const stem = stemOf(row.name);
      const xmp = buildXmpSidecar({
        originalName: row.name,
        sha256,
        event,
        location: String(settings.extra?.location ?? '').trim(),
        captureDate: row.inputExif?.dateTimeOriginal,
        archivedAt: new Date().toISOString(),
        creator: userSettings.creator,
        attribution: userSettings.attribution
      });
      extras.push({ name: `sidecars/${stem}.xmp`, input: xmp });
    }

    // Record for the manifest / README finalize step.
    jobState.get(stateKey)?.entries.push({
      originalName: row.name,
      archivedPath,
      size: row.size,
      sha256,
      captureDate: row.inputExif?.dateTimeOriginal,
      camera: row.inputExif?.camera,
      lens: row.inputExif?.lens
    });

    return {
      blob: row.file.slice(0, row.file.size, row.file.type || 'application/octet-stream'),
      outputName: archivedPath,
      outputSize: row.size,
      extraEntries: extras
    };
  };

  /** @param {{ add: (e: {name:string,input:string|Blob}) => void }} zipper */
  const finalize = (zipper) => finalizeArchive(stateKey, zipper, settings);

  return { process, finalize };
}

// ─── Manifest, README, XMP builders ─────────────────────────────────────

/**
 * Minimal CSV writer — quotes fields that contain commas, quotes, or newlines.
 * @param {Array<Record<string,string|number|undefined>>} entries
 */
function buildManifestCsv(entries) {
  const columns = ['originalName', 'archivedPath', 'size', 'sha256', 'captureDate', 'camera', 'lens'];
  const rows = [columns.join(',')];
  for (const e of entries) {
    rows.push(columns.map((c) => csvCell(e[c])).join(','));
  }
  return rows.join('\n') + '\n';
}

function csvCell(v) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replaceAll('"', '""') + '"';
  return s;
}

/** @param {{event:string,location:string,createdAt:number,creatorName:string,entries:Array<any>}} st */
function buildReadme(st) {
  const totalBytes = st.entries.reduce((a, e) => a + (e.size ?? 0), 0);
  return [
    'OKN Studio · Darkroom — Archive Package',
    '='.repeat(44),
    '',
    `Event:      ${st.event}`,
    st.location ? `Location:   ${st.location}` : 'Location:   (not recorded)',
    `Archived:   ${new Date(st.createdAt).toISOString()}`,
    `Archived by:${st.creatorName}`,
    `Files:      ${st.entries.length}`,
    `Total size: ${formatBytes(totalBytes)}`,
    '',
    'Contents',
    '--------',
    '  originals/   — Every input file, untouched.',
    '  sidecars/    — One .xmp per original carrying event, capture date,',
    '                 creator attribution, and SHA-256 provenance hash.',
    '  manifest.csv — Tabular listing with filename, path, size, checksum,',
    '                 capture date, and camera/lens.',
    '  README.txt   — This file.',
    '',
    'Provenance',
    '----------',
    'Each manifest row carries a SHA-256 hash of the original bytes so an',
    'archivist can verify the pixel-perfect fidelity of anything in originals/.',
    '',
    'Contact sheet PDF is not generated in the current build; the manifest',
    'covers the indexing role for now.',
    ''
  ].join('\n');
}

/**
 * Build a small valid XMP packet. We intentionally keep this hand-written
 * so Archive has no large RDF dependency; the field set mirrors the spec.
 */
function buildXmpSidecar(o) {
  const year = new Date().getFullYear();
  const copyright = (o.attribution?.copyrightTemplate ?? '').replace('{year}', String(year));
  const rights    = o.attribution?.rights ?? '';
  const credit    = o.attribution?.credit ?? '';
  const creator   = o.creator?.name ?? '';

  const lines = [
    '<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '    <rdf:Description',
    '      xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '      xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    '      xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"',
    '      xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"',
    '      xmlns:okn="https://oknkorea.org/ns/darkroom/1.0/">',
    xmpLangAlt('dc:rights', copyright),
    xmpLangAlt('xmpRights:UsageTerms', rights),
    xmpSimple('photoshop:Credit', credit),
    xmpCreators(creator),
    xmpSimple('okn:Event', o.event ?? ''),
    xmpSimple('okn:Location', o.location ?? ''),
    xmpSimple('okn:OriginalFilename', o.originalName ?? ''),
    xmpSimple('okn:ProvenanceSha256', o.sha256 ?? ''),
    xmpSimple('okn:ArchivedAt', o.archivedAt ?? ''),
    o.captureDate ? xmpSimple('photoshop:DateCreated', o.captureDate) : '',
    '    </rdf:Description>',
    '  </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>'
  ].filter(Boolean);
  return lines.join('\n');
}

function xmpSimple(tag, value) {
  if (!value) return '';
  return `      <${tag}>${escapeXml(value)}</${tag}>`;
}
function xmpLangAlt(tag, value) {
  if (!value) return '';
  return [
    `      <${tag}>`,
    `        <rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(value)}</rdf:li></rdf:Alt>`,
    `      </${tag}>`
  ].join('\n');
}
function xmpCreators(name) {
  if (!name) return '';
  return [
    '      <dc:creator>',
    '        <rdf:Seq>',
    `          <rdf:li>${escapeXml(name)}</rdf:li>`,
    '        </rdf:Seq>',
    '      </dc:creator>'
  ].join('\n');
}
function escapeXml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// ─── Hashing / formatting helpers ───────────────────────────────────────

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function stemOf(name) {
  const i = name.lastIndexOf('.');
  return i <= 0 ? name : name.slice(0, i);
}

function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / 1024 ** i).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
}
