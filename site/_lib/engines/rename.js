/**
 * OKN Studio · Shared — Rename engine
 * ===================================
 * Pure functions. No DOM, no network, no side effects. Runs in Node for
 * tests and in the browser as an ES module.
 *
 * Token grammar:
 *   {originalname}             stem without extension
 *   {date[:FORMAT]}            EXIF DateTimeOriginal, falling back to file mtime
 *   {time[:FORMAT]}            default HHmmss
 *   {event}                    per-job user text (slugified)
 *   {seq[:NNN]}                running counter, zero-padded (default width 3)
 *   {camera}, {lens}           EXIF model/lens (slugified)
 *   {iso}, {fstop}, {shutter}  technical EXIF
 *   {photographer}             user's creator slug
 *   {hash[:N]}                 first N chars of content SHA-256 (default 8)
 *
 * @typedef {Object} ExifSummary
 * @property {string=} dateTimeOriginal   ISO string
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
 * @typedef {'date-seq'|'okn-event'|'photographer-date'|'keep-original'|'timestamped-backup'|'custom'} RenamePreset
 * @typedef {'suffix'|'skip'|'error'} CollisionStrategy
 * @typedef {'keep'|'lower'|'upper'} CaseStrategy
 *
 * @typedef {Object} RenameSettings
 * @property {RenamePreset} preset
 * @property {string=} template
 * @property {string=} event
 * @property {number} seqStart
 * @property {CollisionStrategy} collision
 * @property {CaseStrategy} case
 *
 * @typedef {Object} RenameContext
 * @property {string} originalName
 * @property {ExifSummary=} exif
 * @property {number=} fileMtime                  epoch ms
 * @property {string=} event
 * @property {string=} photographer
 * @property {number} seq
 * @property {string=} contentHash
 *
 * @typedef {Object} RenameInput
 * @property {string} originalName
 * @property {ExifSummary=} exif
 * @property {number=} fileMtime
 * @property {string=} contentHash
 *
 * @typedef {Object} RenameOutput
 * @property {string} outputName
 * @property {string} stem
 */

// ─── Date formatting ────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const pad4 = (n) => String(n).padStart(4, '0');

/** @param {Date} date @param {string} format */
function formatDate(date, format) {
  const tokens = {
    YYYY: pad4(date.getFullYear()),
    YY:   pad2(date.getFullYear() % 100),
    MM:   pad2(date.getMonth() + 1),
    DD:   pad2(date.getDate()),
    HH:   pad2(date.getHours()),
    mm:   pad2(date.getMinutes()),
    ss:   pad2(date.getSeconds())
  };
  return format.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (m) => tokens[m] ?? m);
}

// ─── Slugify ────────────────────────────────────────────────────────────

/** @param {string} input */
export function slugify(input) {
  return input
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// ─── Filename sanitising ────────────────────────────────────────────────

const FS_INVALID = /[\/\\:*?"<>|\x00-\x1f]/g;

/** @param {string} name */
export function sanitiseFilename(name) {
  let out = name.replace(FS_INVALID, '_');
  out = out.replace(/^[.\s]+|[.\s]+$/g, '');
  if (!out) out = 'file';
  return out.slice(0, 240);
}

/** @param {string} filename */
export function splitExtension(filename) {
  const i = filename.lastIndexOf('.');
  if (i <= 0) return { stem: filename, ext: '' };
  return { stem: filename.slice(0, i), ext: filename.slice(i) };
}

/** @param {string} value @param {CaseStrategy} strategy */
export function applyCase(value, strategy) {
  if (strategy === 'lower') return value.toLowerCase();
  if (strategy === 'upper') return value.toUpperCase();
  return value;
}

// ─── Preset dictionary ──────────────────────────────────────────────────

export const PRESET_TEMPLATES = {
  'date-seq':           '{date:YYYY-MM-DD}_{seq:03d}',
  'okn-event':          '{event}_{date:YYYY-MM-DD}_{seq:03d}',
  'photographer-date':  '{photographer}_{date:YYYY-MM-DD}_{seq:03d}',
  'keep-original':      '{originalname}',
  'timestamped-backup': '{originalname}_{date:YYYYMMDDHHmmss}'
};

/** @param {RenameSettings} settings */
export function resolveTemplate(settings) {
  if (settings.preset === 'custom') return settings.template ?? '{originalname}';
  return PRESET_TEMPLATES[settings.preset];
}

// ─── Template expansion ─────────────────────────────────────────────────

const TOKEN_RE = /\{([a-zA-Z_]+)(?::([^}]+))?\}/g;

/**
 * Expand a template against a context. Missing token sources degrade
 * gracefully rather than throw.
 * @param {string} template
 * @param {RenameContext} ctx
 */
export function expandTemplate(template, ctx) {
  return template.replace(TOKEN_RE, (_, name, arg) => resolveToken(name, arg, ctx));
}

/** @param {string} name @param {string|undefined} arg @param {RenameContext} ctx */
function resolveToken(name, arg, ctx) {
  switch (name) {
    case 'originalname':
      return splitExtension(ctx.originalName).stem;

    case 'date': {
      const d = pickDate(ctx);
      return d ? formatDate(d, arg ?? 'YYYY-MM-DD') : 'unknown-date';
    }
    case 'time': {
      const d = pickDate(ctx);
      return d ? formatDate(d, arg ?? 'HHmmss') : 'unknown-time';
    }

    case 'event':
      return ctx.event && ctx.event.trim() ? slugify(ctx.event) : 'event';

    case 'seq': {
      const width = parseSeqWidth(arg) ?? 3;
      return String(ctx.seq).padStart(width, '0');
    }

    case 'camera':
      return ctx.exif?.camera ? slugify(ctx.exif.camera) : 'unknown';
    case 'lens':
      return ctx.exif?.lens ? slugify(ctx.exif.lens) : 'unknown';

    case 'iso':
      return ctx.exif?.iso ? `iso${ctx.exif.iso}` : 'iso0';
    case 'fstop':
      return ctx.exif?.fStop ? `f${ctx.exif.fStop.toString().replace('.', '')}` : 'f0';
    case 'shutter':
      return ctx.exif?.shutter ? ctx.exif.shutter.replace('/', '-') : 'shutter';

    case 'photographer':
      return ctx.photographer ? slugify(ctx.photographer) : 'unknown';

    case 'hash': {
      const n = arg ? Math.max(1, Math.min(64, parseInt(arg, 10) || 8)) : 8;
      return ctx.contentHash ? ctx.contentHash.slice(0, n) : '0'.repeat(n);
    }

    default:
      return `_${name}_`;
  }
}

/** @param {RenameContext} ctx */
function pickDate(ctx) {
  if (ctx.exif?.dateTimeOriginal) {
    const d = new Date(ctx.exif.dateTimeOriginal);
    if (!isNaN(d.getTime())) return d;
  }
  if (ctx.fileMtime) return new Date(ctx.fileMtime);
  return null;
}

/** @param {string|undefined} arg */
function parseSeqWidth(arg) {
  if (!arg) return null;
  const m = arg.match(/^(\d+)d?$/);
  return m ? parseInt(m[1], 10) : null;
}

// ─── Full-filename computation ──────────────────────────────────────────

/**
 * @param {RenameInput} input
 * @param {RenameSettings} settings
 * @param {number} seq
 * @param {string=} event
 * @param {string=} photographer
 * @returns {RenameOutput}
 */
export function computeName(input, settings, seq, event, photographer) {
  const template = resolveTemplate(settings);
  const ctx = {
    originalName: input.originalName,
    exif: input.exif,
    fileMtime: input.fileMtime,
    event,
    photographer,
    seq,
    contentHash: input.contentHash
  };
  const rawStem  = expandTemplate(template, ctx);
  const casedStem = applyCase(rawStem, settings.case);
  const safeStem  = sanitiseFilename(casedStem);
  const { ext } = splitExtension(input.originalName);
  return { outputName: safeStem + ext, stem: safeStem };
}

// ─── Batch with collision resolution ────────────────────────────────────

/**
 * @typedef {Object} BatchRenameInput
 * @property {RenameInput[]} items
 * @property {RenameSettings} settings
 * @property {string=} event
 * @property {string=} photographer
 *
 * @typedef {{ status: 'ok', outputName: string }
 *         | { status: 'skipped', reason: string }
 *         | { status: 'error', message: string }} BatchResult
 *
 * @param {BatchRenameInput} input
 * @returns {BatchResult[]}
 */
export function computeBatch(input) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {BatchResult[]} */
  const out = [];

  input.items.forEach((item, i) => {
    try {
      const seq = input.settings.seqStart + i;
      const { outputName, stem } = computeName(
        item,
        input.settings,
        seq,
        input.event,
        input.photographer
      );
      const { ext } = splitExtension(outputName);
      out.push(resolveCollision({ outputName, stem, ext, seen, strategy: input.settings.collision }));
    } catch (e) {
      out.push({ status: 'error', message: e instanceof Error ? e.message : 'rename failed' });
    }
  });

  return out;
}

/** @returns {BatchResult} */
function resolveCollision(args) {
  const key = args.outputName.toLowerCase();
  const prior = args.seen.get(key);

  if (prior === undefined) {
    args.seen.set(key, 1);
    return { status: 'ok', outputName: args.outputName };
  }

  if (args.strategy === 'skip') {
    return { status: 'skipped', reason: 'name-collision' };
  }
  if (args.strategy === 'error') {
    return { status: 'error', message: `name collision on ${args.outputName}` };
  }

  let n = prior;
  let candidate = '';
  let candidateKey = '';
  do {
    candidate = `${args.stem}_${n}${args.ext}`;
    candidateKey = candidate.toLowerCase();
    n += 1;
  } while (args.seen.has(candidateKey));
  args.seen.set(key, n);
  args.seen.set(candidateKey, 1);
  return { status: 'ok', outputName: candidate };
}

// ─── Live preview (used by Custom template input) ───────────────────────

/**
 * @param {RenameInput[]} items
 * @param {RenameSettings} settings
 * @param {string=} event
 * @param {string=} photographer
 * @param {number=} n
 */
export function previewFirst(items, settings, event, photographer, n = 3) {
  const results = computeBatch({ items: items.slice(0, n), settings, event, photographer });
  return results.map((r) => {
    if (r.status === 'ok') return r.outputName;
    if (r.status === 'skipped') return '— skipped (collision) —';
    return '— error —';
  });
}
