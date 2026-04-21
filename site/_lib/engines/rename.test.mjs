/**
 * OKN Studio · Shared — Rename engine tests
 * =========================================
 * Pure Node, zero dependencies.
 *   node --test site/_lib/engines/rename.test.mjs
 *
 * JSDoc casts on DEFAULTS and EXIF below are needed because tsc widens
 * bare string literals to `string`, but RenameSettings declares union
 * types (e.g. RenamePreset, CollisionStrategy, CaseStrategy). The cast
 * preserves the literal types through object spreads without forcing
 * every test call site to repeat an inline type cast. Same story for
 * EXIF — `rating: 5` widens to `number`, but ExifSummary.rating is
 * `0|1|2|3|4|5`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCase,
  computeBatch,
  computeName,
  expandTemplate,
  previewFirst,
  PRESET_TEMPLATES,
  resolveTemplate,
  sanitiseFilename,
  slugify,
  splitExtension
} from './rename.js';

/** @type {import('./rename.js').RenameSettings} */
const DEFAULTS = { preset: 'date-seq', seqStart: 1, collision: 'suffix', case: 'keep' };

/** @type {import('./rename.js').ExifSummary} */
const EXIF = {
  dateTimeOriginal: '2026-03-14T11:22:33Z',
  camera: 'Canon EOS R5',
  lens: 'RF 24-70mm F2.8 L IS USM',
  iso: 400,
  fStop: 2.8,
  shutter: '1/250',
  rating: 5,
  orientation: 1
};

// ─── slugify ────────────────────────────────────────────────────────────

test('slugify — lowercases and dashes', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});
test('slugify — strips diacritics (Latin)', () => {
  assert.equal(slugify('Café Résumé'), 'cafe-resume');
});
test('slugify — non-Latin characters strip to empty', () => {
  assert.equal(slugify('Νίκος'), '');
});
test('slugify — collapses spaces and punctuation', () => {
  assert.equal(slugify('Canon EOS R5'), 'canon-eos-r5');
  assert.equal(slugify('  foo!!!bar  '), 'foo-bar');
});
test('slugify — trims dashes', () => {
  assert.equal(slugify('---foo---'), 'foo');
});
test('slugify — caps at 64 chars', () => {
  assert.ok(slugify('a'.repeat(200)).length <= 64);
});

// ─── sanitiseFilename ───────────────────────────────────────────────────

test('sanitiseFilename — replaces fs-invalid chars', () => {
  assert.equal(sanitiseFilename('foo/bar\\baz:qux*?"<>|.jpg'), 'foo_bar_baz_qux______.jpg');
});
test('sanitiseFilename — removes control chars', () => {
  assert.equal(sanitiseFilename('bad\x01name\x1f.jpg'), 'bad_name_.jpg');
});
test('sanitiseFilename — trims trailing dots/spaces', () => {
  assert.equal(sanitiseFilename('name. '), 'name');
});
test('sanitiseFilename — never empty', () => {
  assert.equal(sanitiseFilename(''), 'file');
  assert.equal(sanitiseFilename('. .'), 'file');
});
test('sanitiseFilename — caps at 240 chars', () => {
  assert.equal(sanitiseFilename('a'.repeat(300)).length, 240);
});

// ─── splitExtension ─────────────────────────────────────────────────────

test('splitExtension — normal', () => {
  assert.deepEqual(splitExtension('photo.jpg'), { stem: 'photo', ext: '.jpg' });
});
test('splitExtension — multi-dot', () => {
  assert.deepEqual(splitExtension('photo.something.jpg'), { stem: 'photo.something', ext: '.jpg' });
});
test('splitExtension — dotfile', () => {
  assert.deepEqual(splitExtension('.hidden'), { stem: '.hidden', ext: '' });
});
test('splitExtension — no ext', () => {
  assert.deepEqual(splitExtension('README'), { stem: 'README', ext: '' });
});

// ─── applyCase ──────────────────────────────────────────────────────────

test('applyCase — lower', () => { assert.equal(applyCase('ABC', 'lower'), 'abc'); });
test('applyCase — upper', () => { assert.equal(applyCase('abc', 'upper'), 'ABC'); });
test('applyCase — keep', () => { assert.equal(applyCase('aBc', 'keep'), 'aBc'); });

// ─── resolveTemplate ────────────────────────────────────────────────────

test('resolveTemplate — preset', () => {
  assert.equal(resolveTemplate({ ...DEFAULTS, preset: 'okn-event' }), PRESET_TEMPLATES['okn-event']);
});
test('resolveTemplate — custom falls back to {originalname}', () => {
  assert.equal(resolveTemplate({ ...DEFAULTS, preset: 'custom' }), '{originalname}');
});
test('resolveTemplate — custom honours template', () => {
  assert.equal(resolveTemplate({ ...DEFAULTS, preset: 'custom', template: 'FOO' }), 'FOO');
});

// ─── expandTemplate ─────────────────────────────────────────────────────

const baseCtx = {
  originalName: 'IMG_0001.jpg',
  exif: EXIF,
  seq: 1,
  event: 'Theophany 2026',
  photographer: 'Nikos Pinatsis'
};

test('expandTemplate — default date-seq preset', () => {
  assert.equal(expandTemplate(PRESET_TEMPLATES['date-seq'], baseCtx), '2026-03-14_001');
});
test('expandTemplate — OKN event preset', () => {
  assert.equal(
    expandTemplate(PRESET_TEMPLATES['okn-event'], baseCtx),
    'theophany-2026_2026-03-14_001'
  );
});
test('expandTemplate — custom date format', () => {
  assert.equal(expandTemplate('{date:YYYYMMDD}_{seq:04d}', baseCtx), '20260314_0001');
});
test('expandTemplate — slugifies camera and lens', () => {
  assert.equal(
    expandTemplate('{camera}_{lens}', baseCtx),
    'canon-eos-r5_rf-24-70mm-f2-8-l-is-usm'
  );
});
test('expandTemplate — iso and fstop prefix tokens', () => {
  assert.equal(expandTemplate('{iso}_{fstop}', baseCtx), 'iso400_f28');
});
test('expandTemplate — shutter slash becomes dash', () => {
  assert.equal(expandTemplate('{shutter}', baseCtx), '1-250');
});
test('expandTemplate — missing EXIF degrades', () => {
  assert.equal(
    expandTemplate('{camera}_{date:YYYY-MM-DD}', { ...baseCtx, exif: undefined }),
    'unknown_unknown-date'
  );
});
test('expandTemplate — fileMtime fallback for date', () => {
  const d = new Date('2024-01-15T12:00:00Z');
  const result = expandTemplate('{date:YYYY-MM-DD}', {
    originalName: 'x.jpg',
    seq: 1,
    fileMtime: d.getTime()
  });
  // Allow TZ drift in CI
  assert.match(result, /^2024-01-1[45]$/);
});
test('expandTemplate — hash width', () => {
  assert.equal(
    expandTemplate('{hash:12}', {
      originalName: 'x.jpg',
      seq: 1,
      contentHash: 'abcdef0123456789abcdef0123456789'
    }),
    'abcdef012345'
  );
});
test('expandTemplate — unknown token safe', () => {
  assert.equal(expandTemplate('{nonsense}', { originalName: 'x.jpg', seq: 1 }), '_nonsense_');
});

// ─── computeName ────────────────────────────────────────────────────────

test('computeName — full filename with ext', () => {
  const out = computeName({ originalName: 'IMG_0001.jpg', exif: EXIF }, DEFAULTS, 1, 'Theophany');
  assert.equal(out.outputName, '2026-03-14_001.jpg');
});
test('computeName — case upper on already-upper stem', () => {
  const out = computeName(
    { originalName: 'IMG_0001.JPG', exif: EXIF },
    { ...DEFAULTS, preset: 'keep-original', case: 'upper' },
    1
  );
  assert.equal(out.outputName, 'IMG_0001.JPG');
});
test('computeName — lower-cases stem', () => {
  const out = computeName(
    { originalName: 'PHOTO.JPG', exif: EXIF },
    { ...DEFAULTS, preset: 'keep-original', case: 'lower' },
    1
  );
  assert.equal(out.outputName, 'photo.JPG');
});
test('computeName — custom template', () => {
  const out = computeName(
    { originalName: 'IMG.jpg', exif: EXIF },
    { ...DEFAULTS, preset: 'custom', template: '{event}_{camera}_{seq:02d}' },
    5,
    'Pascha'
  );
  assert.equal(out.outputName, 'pascha_canon-eos-r5_05.jpg');
});

// ─── computeBatch / collisions ──────────────────────────────────────────

test('computeBatch — suffix collisions (date-seq preset with same-date EXIF)', () => {
  const items = [
    { originalName: 'a.jpg', exif: EXIF },
    { originalName: 'b.jpg', exif: EXIF },
    { originalName: 'c.jpg', exif: EXIF }
  ];
  const out = computeBatch({ items, settings: DEFAULTS });
  // date stays constant; seq increments → no actual collision in this case
  assert.deepEqual(out, [
    { status: 'ok', outputName: '2026-03-14_001.jpg' },
    { status: 'ok', outputName: '2026-03-14_002.jpg' },
    { status: 'ok', outputName: '2026-03-14_003.jpg' }
  ]);
});

test('computeBatch — true collisions (keep-original, identical inputs)', () => {
  const items = [
    { originalName: 'IMG_1.jpg' },
    { originalName: 'IMG_1.jpg' },
    { originalName: 'IMG_1.jpg' }
  ];
  const out = computeBatch({ items, settings: { ...DEFAULTS, preset: 'keep-original' } });
  assert.deepEqual(
    out.map((r) => (r.status === 'ok' ? r.outputName : 'x')),
    ['IMG_1.jpg', 'IMG_1_1.jpg', 'IMG_1_2.jpg']
  );
});

test('computeBatch — skip strategy', () => {
  const out = computeBatch({
    items: [{ originalName: 'x.jpg' }, { originalName: 'x.jpg' }],
    settings: { ...DEFAULTS, preset: 'keep-original', collision: 'skip' }
  });
  assert.deepEqual(out[0], { status: 'ok', outputName: 'x.jpg' });
  assert.deepEqual(out[1], { status: 'skipped', reason: 'name-collision' });
});

test('computeBatch — error strategy', () => {
  const out = computeBatch({
    items: [{ originalName: 'x.jpg' }, { originalName: 'x.jpg' }],
    settings: { ...DEFAULTS, preset: 'keep-original', collision: 'error' }
  });
  assert.equal(out[1].status, 'error');
});

test('computeBatch — seqStart respected', () => {
  const out = computeBatch({
    items: [{ originalName: 'a.jpg', exif: EXIF }],
    settings: { ...DEFAULTS, seqStart: 42 }
  });
  assert.deepEqual(out[0], { status: 'ok', outputName: '2026-03-14_042.jpg' });
});

// ─── previewFirst ───────────────────────────────────────────────────────

test('previewFirst — returns at most N', () => {
  const names = previewFirst(
    Array.from({ length: 10 }, (_, i) => ({ originalName: `x${i}.jpg` })),
    DEFAULTS,
    undefined,
    undefined,
    3
  );
  assert.equal(names.length, 3);
});
