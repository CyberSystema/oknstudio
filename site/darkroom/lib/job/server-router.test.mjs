/**
 * OKN Studio · Darkroom — Server router tests
 * ===========================================
 *   node --test site/darkroom/lib/job/server-router.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_THRESHOLD,
  ZONE_THRESHOLDS,
  effectiveThresholds,
  routeJob,
  summariseRouting
} from './server-router.js';

const MB = 1024 * 1024;

// Helpers to make tiny file records without needing a real File.
const f = (id, sizeMB) => ({ id, size: sizeMB * MB });
const many = (count, sizeMB) => Array.from({ length: count }, (_, i) => f(`f${i}`, sizeMB));

// ─── ZONE_THRESHOLDS sanity ─────────────────────────────────────────────

test('every zone in ZONE_THRESHOLDS has at least batchCount and batchSizeMB', () => {
  for (const [zoneId, th] of Object.entries(ZONE_THRESHOLDS)) {
    assert.ok(Number.isFinite(th.batchCount) || th.batchCount === NO_THRESHOLD, `${zoneId} batchCount`);
    assert.ok(Number.isFinite(th.batchSizeMB) || th.batchSizeMB === NO_THRESHOLD, `${zoneId} batchSizeMB`);
  }
});

test('batch-rename has NO_THRESHOLD fileSize (pixel-less)', () => {
  assert.equal(ZONE_THRESHOLDS['batch-rename'].fileSizeMB, NO_THRESHOLD);
});

test('raw-develop has the strictest batchCount', () => {
  const raw = ZONE_THRESHOLDS['raw-develop'].batchCount;
  for (const [zoneId, th] of Object.entries(ZONE_THRESHOLDS)) {
    if (zoneId === 'raw-develop') continue;
    if (th.batchCount === NO_THRESHOLD) continue;
    assert.ok(raw <= th.batchCount, `raw (${raw}) should be <= ${zoneId} (${th.batchCount})`);
  }
});

// ─── effectiveThresholds ────────────────────────────────────────────────

test('effectiveThresholds — defaults when no override', () => {
  const th = effectiveThresholds('web-ready', undefined);
  assert.equal(th.fileSizeMB, 80);
  assert.equal(th.batchCount, 250);
  assert.equal(th.batchSizeMB, 1500);
});

test('effectiveThresholds — partial override wins', () => {
  const th = effectiveThresholds('web-ready', { 'web-ready': { batchCount: 42 } });
  assert.equal(th.batchCount, 42);
  assert.equal(th.fileSizeMB, 80); // inherited
});

test('effectiveThresholds — ignores invalid override values', () => {
  // @ts-expect-error — intentional invalid input: we're asserting the runtime
  // coercion in effectiveThresholds falls back to defaults when a caller
  // (e.g. bad settings JSON, malformed user import) passes a non-number.
  const th = effectiveThresholds('web-ready', { 'web-ready': { batchCount: -10, fileSizeMB: 'nope' } });
  assert.equal(th.batchCount, 250);
  assert.equal(th.fileSizeMB, 80);
});

// ─── routeJob ───────────────────────────────────────────────────────────

test('routeJob — small browser batch stays browser', () => {
  const decision = routeJob(many(10, 2), 'web-ready');
  assert.equal(decision.job, 'browser');
  for (const [, t] of decision.perFile) assert.equal(t, 'browser');
  assert.equal(decision.explain.reason, null);
});

test('routeJob — batch count over threshold routes whole job', () => {
  const decision = routeJob(many(300, 2), 'web-ready'); // threshold 250
  assert.equal(decision.job, 'server-large-batch-soon');
  for (const [, t] of decision.perFile) assert.equal(t, 'server-large-batch-soon');
  assert.equal(decision.explain.reason, 'batch-count');
});

test('routeJob — batch size over threshold routes whole job', () => {
  // web-ready batchSizeMB = 1500, 100 files × 20 MB = 2000 MB
  const decision = routeJob(many(100, 20), 'web-ready');
  assert.equal(decision.job, 'server-large-batch-soon');
  assert.equal(decision.explain.reason, 'batch-size');
});

test('routeJob — per-file oversize routes just that file, job stays browser', () => {
  // web-ready fileSizeMB = 80. One 120 MB file + a few small ones.
  const decision = routeJob([f('big', 120), f('ok1', 2), f('ok2', 2)], 'web-ready');
  assert.equal(decision.job, 'browser');
  assert.equal(decision.perFile.get('big'), 'server-large-batch-soon');
  assert.equal(decision.perFile.get('ok1'), 'browser');
  assert.equal(decision.explain.reason, 'per-file-oversize');
});

test('routeJob — batch-rename never routes to server (pixel-less, NO_THRESHOLD)', () => {
  // 5000 × 500MB files — still all browser.
  const decision = routeJob(many(5000, 500), 'batch-rename');
  assert.equal(decision.job, 'browser');
  for (const [, t] of decision.perFile) assert.equal(t, 'browser');
});

test('routeJob — raw-develop threshold is strict', () => {
  const decision = routeJob(many(12, 2), 'raw-develop'); // batchCount = 10
  assert.equal(decision.job, 'server-large-batch-soon');
});

test('routeJob — per-user override lowers threshold', () => {
  const decision = routeJob(
    many(20, 2),
    'web-ready',
    { 'web-ready': { batchCount: 10 } }
  );
  assert.equal(decision.job, 'server-large-batch-soon');
  assert.equal(decision.explain.reason, 'batch-count');
});

// ─── summariseRouting ───────────────────────────────────────────────────

test('summariseRouting — all browser', () => {
  const s = summariseRouting(routeJob(many(10, 2), 'web-ready'));
  assert.equal(s.browser, 10);
  assert.equal(s.server, 0);
});

test('summariseRouting — mixed per-file', () => {
  const s = summariseRouting(routeJob([f('a', 120), f('b', 2), f('c', 2)], 'web-ready'));
  assert.equal(s.browser, 2);
  assert.equal(s.server, 1);
});

test('summariseRouting — whole job server-routed', () => {
  const s = summariseRouting(routeJob(many(300, 2), 'web-ready'));
  assert.equal(s.browser, 0);
  assert.equal(s.server, 300);
});
