/**
 * OKN Studio · Darkroom — Main app controller
 * ===========================================
 * Wires the pure logic modules (engines, storage, job, zones) to the DOM.
 * Kept deliberately framework-free to match the rest of oknstudio's
 * static-HTML convention — vanilla ESM, event delegation, template
 * literals for rendering.
 *
 * State model:
 *   state.activeTab       : 'publish' | 'convert' | 'archive' | 'organize'
 *   state.activeJob       : null | { zone, dispatcher, rows, settings }
 *   state.zoneSettings    : map of zoneId → ZoneSettings (remembered per zone)
 *   state.user            : UserSettings (identity + attribution + dryRunSkip)
 *
 * Render is cheap (small DOM) so we re-render affected regions on every
 * state change — no dirty-checking, no virtual DOM. Event handlers use
 * delegation on the root so dynamically-rendered controls keep working.
 */

import { t, hasMessage, getLocale, setLocale, onLocaleChange } from './i18n.js';
import { CURRENT_PHASE, ZONES, ZONES_BY_TAB, WIRED_ZONES, isShipped } from './zones/registry.js';
import { intake } from '@okn/job/intake.js';
import { createDispatcher } from '@okn/job/dispatcher.js';
import { routeJob, summariseRouting } from './job/server-router.js';
import {
  loadSettings, saveSettings, updateCreator, updateAttribution,
  setDryRunSkip, exportSettings, importSettings
} from './storage/settings.js';
import { listHistory, removeHistoryEntry, recordJob } from './storage/history.js';
import { db } from '@okn/storage/db.js';
import { destroyPool } from '@okn/job/worker-pool.js';

import { defaultSettings as batchRenameDefaults, createBatchRenameProcessor } from './zones/batch-rename.js';
import { defaultSettings as webReadyDefaults,   createWebReadyProcessor }   from './zones/web-ready.js';
import { defaultSettings as bulkCompressDefaults, createBulkCompressProcessor } from './zones/bulk-compress.js';
import {
  defaultSettings as metadataStudioDefaults,
  createMetadataStudioProcessor,
  summariseExif
} from './zones/metadata-studio.js';
import { defaultSettings as socialDefaults,       createSocialProcessor }       from './zones/social.js';
import { defaultSettings as heicDefaults,         createHeicToJpegProcessor }   from './zones/heic-to-jpeg.js';
import { defaultSettings as colourSpaceDefaults,  createColourSpaceProcessor }  from './zones/colour-space.js';
import { defaultSettings as archiveDefaults,      createArchiveProcessor }      from './zones/archive.js';
import { defaultSettings as rawDevelopDefaults,   createRawDevelopProcessor }   from './zones/raw-develop.js';
import { computeBatch, previewFirst } from '@okn/engines/rename.js';

// ─── Module map: zoneId → { defaults(), makeProcessor(settings) } ───────
// Each zone ships a processor with the same two-function interface.

const ZONE_IMPL = {
  'batch-rename': {
    defaults: batchRenameDefaults,
    makeProcessor: createBatchRenameProcessor
  },
  'web-ready': {
    defaults: webReadyDefaults,
    makeProcessor: createWebReadyProcessor
  },
  'bulk-compress': {
    defaults: bulkCompressDefaults,
    makeProcessor: createBulkCompressProcessor
  },
  'social': {
    defaults: socialDefaults,
    makeProcessor: createSocialProcessor
  },
  'heic-to-jpeg': {
    defaults: heicDefaults,
    makeProcessor: createHeicToJpegProcessor
  },
  'colour-space': {
    defaults: colourSpaceDefaults,
    makeProcessor: createColourSpaceProcessor
  },
  'archive': {
    defaults: archiveDefaults,
    // Archive returns { process, finalize } — startProcessing() detects
    // that shape and wires the finalize hook into the dispatcher.
    makeProcessor: createArchiveProcessor
  },
  'raw-develop': {
    defaults: rawDevelopDefaults,
    makeProcessor: createRawDevelopProcessor
  },
  'metadata-studio': {
    defaults: metadataStudioDefaults,
    makeProcessor: createMetadataStudioProcessor,
    dryRunInspector: true    // opt-in: dry-run table adds an EXIF inspector
  }
};

const PARTIAL_LIVE_ZONES = new Set([
  'colour-space',
  // metadata-studio can only rewrite EXIF on JPEG; PNG/TIFF/WebP/HEIC
  // metadata writes need exiftool on the processing server, so the zone is
  // only partially live in-browser.
  'metadata-studio'
]);

const SERVER_ONLY_ZONES = new Set([
  'raw-develop'
]);

const SERVER_ONLY_COLOUR_TARGETS = new Set([
  'adobe-rgb',
  'prophoto'
]);

function zoneAvailability(zoneId) {
  if (SERVER_ONLY_ZONES.has(zoneId)) {
    return {
      tone: 'off',
      label: t('zone.status.serverOnly'),
      title: t('zone.status.serverOnly.title')
    };
  }
  if (PARTIAL_LIVE_ZONES.has(zoneId)) {
    return {
      tone: 'partial',
      label: t('zone.status.partial'),
      title: t('zone.status.partial.title')
    };
  }
  return {
    tone: 'live',
    label: t('zone.status.live'),
    title: ''
  };
}

function isZoneServerOnly(zoneId) {
  return SERVER_ONLY_ZONES.has(zoneId);
}

function isRawDevelopLocked(zoneId) {
  return isZoneServerOnly(zoneId);
}

function isServerOnlyColourTarget(targetProfile) {
  return SERVER_ONLY_COLOUR_TARGETS.has(String(targetProfile ?? ''));
}

function normaliseZoneSettingsForClient(zoneId, settings) {
  if (!settings) return settings;
  if (zoneId === 'colour-space' && isServerOnlyColourTarget(settings.extra?.targetProfile)) {
    settings.extra.targetProfile = 'srgb';
  }
  return settings;
}

// ─── Utilities ──────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * Narrow an EventTarget to Element so we can call closest()/matches().
 * Returns null if it isn't an Element (e.g. window, document nodes).
 * Used by every delegated event handler below so TypeScript sees a
 * concrete Element and we don't have to scatter casts everywhere.
 * @param {EventTarget | null} t
 * @returns {Element | null}
 */
const asEl = (t) => (t instanceof Element ? t : null);

/** HTML-escape for template strings. */
const esc = (v) => String(v ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / 1024 ** i).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
}

function formatDuration(ms) {
  if (!ms) return '0s';
  if (ms < 1000) return ms + 'ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

/**
 * Rough-estimate total output bytes for a zone + settings + rows combo.
 * Used purely for a sanity-check line in the dry-run summary, never for
 * any enforcement. Returns null if the zone has no meaningful estimate
 * (e.g. Archive, which preserves originals byte-for-byte).
 *
 * The coefficients below are calibrated from typical real-world batches:
 *   JPEG @ Q82  ≈ 0.28 × source for 24-MP photos
 *   WebP @ Q82  ≈ 0.22 × source
 *   AVIF @ Q82  ≈ 0.18 × source
 *   PNG (lossless) — roughly 2× JPEG source, so we approximate with ×1.0
 *   TIFF — we report source bytes (no lossy compression).
 *
 * Plus a `edgeFactor` scaling when the zone downscales via maxEdge or an
 * exact target canvas — assumes ~2:1 reduction per halving of long-edge.
 *
 * @param {string} zoneId
 * @param {any} settings
 * @param {Array<{ size: number }>} rows
 * @returns {number | null}
 */
function estimateOutputBytes(zoneId, settings, rows) {
  if (!rows || rows.length === 0) return 0;
  const totalIn = rows.reduce((a, r) => a + (r.size ?? 0), 0);

  // Passthrough zones — no meaningful output delta worth reporting.
  if (zoneId === 'archive' || zoneId === 'batch-rename' || zoneId === 'metadata-studio') {
    return null;
  }

  const ex = settings?.extra || {};
  const format = ex.format || 'image/jpeg';
  const quality = typeof ex.quality === 'number' ? ex.quality : 0.82;

  // Format coefficient relative to source bytes.
  let formatK;
  switch (format) {
    case 'image/avif': formatK = 0.20; break;
    case 'image/webp': formatK = 0.26; break;
    case 'image/jpeg': formatK = 0.32; break;
    case 'image/png':  formatK = 1.10; break;  // lossless; often bigger than JPEG source
    case 'image/tiff': return totalIn;         // uncompressed TIFF
    default:           formatK = 0.32;
  }

  // Quality adjustment — we calibrate formatK at Q=0.82 and linearly flex
  // between Q=0.6 (×0.7) and Q=0.95 (×1.2). Rough but consistent.
  const qAdj = Math.max(0.7, Math.min(1.2, 0.7 + ((quality - 0.6) / 0.35) * 0.5));

  // Resize heuristic — compare target long-edge to a typical 4000px source.
  // Exact-target (Social) uses the larger of W/H as the "edge".
  let longEdge = 0;
  if (zoneId === 'social') {
    longEdge = Math.max(ex.customW || 0, ex.customH || 0);
    if (!longEdge) {
      // Walk the platform presets.
      const m = {
        'instagram-square': 1080, 'instagram-portrait': 1350,
        'instagram-story': 1920, 'facebook-post': 1200, 'facebook-cover': 820
      };
      longEdge = m[ex.platform] ?? 1080;
    }
  } else {
    longEdge = ex.maxEdge || 0;  // 0 means "no cap"
  }
  // Source assumed ~4000 px long-edge (24 MP class). Ratio squared
  // because resizing scales pixels quadratically.
  const edgeFactor = longEdge > 0
    ? Math.min(1, Math.pow(longEdge / 4000, 2))
    : 1;

  // Bulk-compress has an explicit target — trust it when available.
  if (zoneId === 'bulk-compress' && ex.targetSizeMB) {
    return Math.min(totalIn, ex.targetSizeMB * 1024 * 1024);
  }

  return Math.round(totalIn * formatK * qAdj * edgeFactor);
}

// ─── State ──────────────────────────────────────────────────────────────

const state = {
  activeTab: 'publish',    // Web-ready lives here — open publish tab on load
  activeJob: null,
  /** @type {import('@okn/job/dispatcher.js').Job | null} */
  lastFinishedJob: null,
  zoneSettings: {},
  // Per-zone pending-file queue. Files drop into this list and wait
  // for the user to click the zone's Process button — that's when the
  // dry-run / processing flow fires. Keeps the drop action cheap and
  // non-modal so users can keep tweaking settings before committing.
  /** @type {Record<string, { rows: any[], rejected: {name:string,reason:string}[] }>} */
  zoneQueues: {},
  user: null,
  history: []
};

// ─── Boot ───────────────────────────────────────────────────────────────

export async function boot() {
  state.user = await loadSettings();
  state.history = await listHistory();

  for (const zone of ZONES) {
    if (!ZONE_IMPL[zone.id]) continue;
    const defaults = ZONE_IMPL[zone.id].defaults();
    const remembered = state.user.zoneDefaults?.[zone.id];
    state.zoneSettings[zone.id] = normaliseZoneSettingsForClient(
      zone.id,
      mergeSettings(defaults, remembered)
    );
  }

  renderAll();
  applyStaticI18n();
  bindGlobalEvents();

  // Terminate web workers when the tab is hidden/closed so they don't
  // linger in memory across navigations. `pagehide` fires in more cases
  // than `beforeunload` (BFCache, iOS Safari).
  window.addEventListener('pagehide', () => {
    try { destroyPool(); } catch { /* ignore */ }
  });

  // Re-render whenever the locale changes (sync <html lang> already done by i18n).
  onLocaleChange(() => {
    try { renderAll(); applyStaticI18n(); }
    catch (e) { console.error('re-render on locale change failed:', e); }
  });
}

/**
 * Walk the DOM once and apply every data-i18n* hook in place. Static
 * chrome (hero, settings drawer, shortcut overlay, panel headings) uses
 * this so the authoring-default English strings in index.html don't
 * leak past the first paint when the user's locale is Korean.
 *
 *   data-i18n="key"                 replace textContent with t(key)
 *   data-i18n-html="key"            replace innerHTML with t(key)
 *   data-i18n-attr="attr:key[,...]" set attribute to t(key)
 */
function applyStaticI18n() {
  try {
    for (const el of document.querySelectorAll('[data-i18n]')) {
      const k = /** @type {HTMLElement} */ (el).dataset.i18n;
      if (k && hasMessage(k)) el.textContent = t(k);
    }
    for (const el of document.querySelectorAll('[data-i18n-html]')) {
      const k = /** @type {HTMLElement} */ (el).dataset.i18nHtml;
      if (k && hasMessage(k)) el.innerHTML = t(k);
    }
    for (const el of document.querySelectorAll('[data-i18n-attr]')) {
      const spec = /** @type {HTMLElement} */ (el).dataset.i18nAttr;
      if (!spec) continue;
      for (const pair of spec.split(',')) {
        const [attr, key] = pair.split(':').map((s) => s.trim());
        if (attr && key && hasMessage(key)) el.setAttribute(attr, t(key));
      }
    }
  } catch (e) {
    console.error('applyStaticI18n failed:', e);
  }
}

function mergeSettings(defaults, overrides) {
  if (!overrides) return defaults;
  return {
    ...defaults,
    ...overrides,
    rename:   { ...defaults.rename,   ...(overrides.rename   || {}) },
    metadata: { ...defaults.metadata, ...(overrides.metadata || {}) },
    extra:    { ...defaults.extra,    ...(overrides.extra    || {}) }
  };
}

// ─── Render: top-level ──────────────────────────────────────────────────

function renderAll() {
  renderTabs();
  renderZones();
  renderHistory();
}

function renderTabs() {
  const bar = $('#dr-tabs');
  if (!bar) return;

  const tabs = [
    { id: 'publish',  label: t('tabs.publish'),  blurb: t('tabs.publish.blurb')  },
    { id: 'convert',  label: t('tabs.convert'),  blurb: t('tabs.convert.blurb')  },
    { id: 'archive',  label: t('tabs.archive'),  blurb: t('tabs.archive.blurb')  },
    { id: 'organize', label: t('tabs.organize'), blurb: t('tabs.organize.blurb') }
  ];

  bar.innerHTML = tabs.map((tab, i) => `
    <button type="button"
      class="dr-tab ${tab.id === state.activeTab ? 'is-active' : ''}"
      data-tab="${tab.id}"
      aria-selected="${tab.id === state.activeTab}"
      role="tab">
      <span class="dr-tab-idx">${String(i + 1).padStart(2, '0')}</span>
      <span class="dr-tab-label">${esc(tab.label)}</span>
      <span class="dr-tab-blurb">${esc(tab.blurb)}</span>
    </button>
  `).join('');
}

function renderZones() {
  const grid = $('#dr-zones');
  if (!grid) return;
  const zones = ZONES_BY_TAB[state.activeTab] ?? [];
  grid.innerHTML = zones.map(renderZoneCard).join('');
}

function renderZoneCard(zone) {
  // WIRED_ZONES is the hard signal — a zone can be registry-shipped but
  // not yet have a processor wired in app.js. Those show as "coming soon".
  const live  = WIRED_ZONES.has(zone.id);
  const title = t(zone.title);
  const desc  = t(zone.description);

  if (!live) {
    const comingLabel = isShipped(zone, CURRENT_PHASE)
      ? t('zone.coming.fallback')
      : t('zone.coming.tag', { n: zone.shipsIn });
    return `
      <article class="dr-zone is-coming" data-zone="${zone.id}" aria-disabled="true">
        <div class="dr-zone-head">
          <div class="dr-zone-glyph">${zone.glyph}</div>
          <div class="dr-zone-meta">
            <h3 class="dr-zone-title">${esc(title)}</h3>
            <p class="dr-zone-desc">${esc(desc)}</p>
          </div>
          <div class="dr-zone-status is-coming">
            <span class="dr-dot"></span>${esc(comingLabel)}
          </div>
        </div>
        <div class="dr-zone-coming"><p>${esc(t('zone.coming.sub'))}</p></div>
      </article>
    `;
  }

  const renderFn = ZONE_RENDERERS[zone.id];
  if (!renderFn) {
    return `<article class="dr-zone" data-zone="${zone.id}">
      <div class="dr-zone-head">
        <div class="dr-zone-glyph">${zone.glyph}</div>
        <div class="dr-zone-meta">
          <h3 class="dr-zone-title">${esc(title)}</h3>
          <p class="dr-zone-desc">${esc(desc)}</p>
        </div>
      </div>
      <div class="dr-zone-body"><p class="dr-muted">No renderer registered for this zone.</p></div>
    </article>`;
  }
  // Each renderer returns a full <article>. Splice the shared per-zone
  // queue UI in just before the closing tag so every wired zone gets
  // the drop → list → Process flow without touching each template.
  const html = renderFn(zone, title, desc);
  return html.replace(/<\/article>\s*$/, `${buildZoneQueue(zone)}</article>`);
}

// ─── Shared renderer helpers ────────────────────────────────────────────
// Builders used by multiple zones. Each writes consistent
// data-zone / data-control attributes so handleZoneControl can route
// change events back into state.

function buildDropzone(zone, options = {}) {
  const disabled = !!options.disabled;
  const prompt = disabled ? t('dropzone.serverLocked') : t('dropzone.instructions');
  return `
    <div class="dr-dropzone${disabled ? ' is-disabled' : ''}"
      data-zone="${zone.id}" ${disabled ? '' : 'data-dropzone'}
      tabindex="${disabled ? '-1' : '0'}" role="button"
      aria-disabled="${disabled ? 'true' : 'false'}"
      aria-label="${esc(prompt)}"
      ${disabled ? `title="${esc(options.disabledTitle ?? prompt)}"` : ''}>
      <div class="dr-dropzone-inner">
        <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" class="dr-dropzone-glyph">
          <path d="M24 32 L24 12"/><path d="M16 20 L24 12 L32 20"/><path d="M12 36 L36 36"/>
        </svg>
        <p class="dr-dropzone-prompt">${esc(prompt)}</p>
        <p class="dr-dropzone-accepted">${esc(t('dropzone.accepted', { formats: 'JPEG · PNG · HEIC · TIFF · WebP · RAW' }))}</p>
      </div>
      <input type="file" multiple class="dr-file-input" data-zone="${zone.id}"
        accept="image/*,.cr2,.cr3,.nef,.arw,.dng,.raf,.orf,.rw2,.pef" hidden ${disabled ? 'disabled' : ''} />
    </div>
  `;
}

// ─── Per-zone queue (drop → list → Process button) ───────────────────
// Files dropped into a zone land in state.zoneQueues[zone.id]. The UI
// below renders that list plus a Process button that stays disabled
// until the queue has at least one accepted file. This is what
// triggers the dry-run flow — drops alone never open a modal.

function buildZoneQueue(zone) {
  return `
    <div class="dr-zone-queue" data-zone-queue="${zone.id}">
      ${buildZoneQueueInner(zone.id)}
    </div>
  `;
}

function buildZoneQueueInner(zoneId) {
  const q = state.zoneQueues[zoneId] ?? { rows: [], rejected: [] };
  const n = q.rows.length;
  const processLocked = isRawDevelopLocked(zoneId);
  const processLockTitle = processLocked ? t('zone.raw-develop.unavailable') : '';
  if (n === 0) {
    return `
      <p class="dr-queue-empty">${esc(t('zone.queue.empty'))}</p>
      <div class="dr-queue-actions">
        <button type="button" class="dr-btn dr-btn-primary dr-queue-process"
          data-action="zone-process" data-zone="${zoneId}" disabled
          aria-disabled="true"
          ${processLockTitle ? `title="${esc(processLockTitle)}"` : ''}>
          ${esc(t('zone.queue.process', { n: 0 }))}
        </button>
      </div>
    `;
  }
  const totalBytes = q.rows.reduce((a, r) => a + (r.size || 0), 0);
  const items = q.rows.map((r) => `
    <li class="dr-queue-item" data-row-id="${esc(r.id)}">
      <span class="dr-queue-item-name" title="${esc(r.name)}">${esc(r.name)}</span>
      <span class="dr-queue-item-size">${esc(formatBytes(r.size))}</span>
      <button type="button" class="dr-btn dr-btn-subtle dr-btn-xs dr-queue-remove"
        data-action="zone-remove" data-zone="${zoneId}" data-row="${esc(r.id)}"
        aria-label="${esc(t('zone.queue.remove'))} ${esc(r.name)}">×</button>
    </li>
  `).join('');
  return `
    <div class="dr-queue-head">
      <span class="dr-queue-count">${esc(t('zone.queue.count', { n, size: formatBytes(totalBytes) }))}</span>
      <button type="button" class="dr-btn dr-btn-subtle dr-btn-xs"
        data-action="zone-clear" data-zone="${zoneId}">${esc(t('zone.queue.clear'))}</button>
    </div>
    <ul class="dr-queue-list">${items}</ul>
    <div class="dr-queue-actions">
      <button type="button" class="dr-btn dr-btn-primary dr-queue-process"
        data-action="zone-process" data-zone="${zoneId}"
        ${processLocked ? 'disabled aria-disabled="true"' : ''}
        ${processLockTitle ? `title="${esc(processLockTitle)}"` : ''}>
        ${esc(t('zone.queue.process', { n }))}
      </button>
    </div>
  `;
}

function renderZoneQueue(zoneId) {
  const el = document.querySelector(`[data-zone-queue="${zoneId}"]`);
  if (!el) return;
  el.innerHTML = buildZoneQueueInner(zoneId);
}

function enqueueZoneFiles(zoneId, accepted, rejected) {
  const q = state.zoneQueues[zoneId] ?? (state.zoneQueues[zoneId] = { rows: [], rejected: [] });
  // Dedupe by (name+size+lastModified) so repeated drops of the same
  // file don't silently double up.
  const seen = new Set(q.rows.map((r) => `${r.name}|${r.size}|${r.file?.lastModified ?? 0}`));
  for (const row of accepted) {
    const key = `${row.name}|${row.size}|${row.file?.lastModified ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    q.rows.push(row);
  }
  if (rejected && rejected.length) q.rejected.push(...rejected);
  renderZoneQueue(zoneId);
}

function removeQueuedFile(zoneId, rowId) {
  const q = state.zoneQueues[zoneId];
  if (!q) return;
  q.rows = q.rows.filter((r) => r.id !== rowId);
  renderZoneQueue(zoneId);
}

function clearZoneQueue(zoneId) {
  state.zoneQueues[zoneId] = { rows: [], rejected: [] };
  renderZoneQueue(zoneId);
}

function buildRenameSelect(zone, rename) {
  return `
    <label class="dr-field">
      <span class="dr-field-label">${esc(t('preset.label'))}</span>
      <select data-zone="${zone.id}" data-control="preset" class="dr-select">
        <option value="date-seq"           ${rename.preset === 'date-seq' ? 'selected' : ''}>${esc(t('rename.preset.date-seq'))}</option>
        <option value="okn-event"          ${rename.preset === 'okn-event' ? 'selected' : ''}>${esc(t('rename.preset.okn-event'))}</option>
        <option value="photographer-date"  ${rename.preset === 'photographer-date' ? 'selected' : ''}>${esc(t('rename.preset.photographer-date'))}</option>
        <option value="keep-original"      ${rename.preset === 'keep-original' ? 'selected' : ''}>${esc(t('rename.preset.keep-original'))}</option>
        <option value="timestamped-backup" ${rename.preset === 'timestamped-backup' ? 'selected' : ''}>${esc(t('rename.preset.timestamped-backup'))}</option>
        <option value="custom"             ${rename.preset === 'custom' ? 'selected' : ''}>${esc(t('rename.preset.custom'))}</option>
      </select>
    </label>
  `;
}

function buildEventField(zone, settings) {
  return `
    <label class="dr-field">
      <span class="dr-field-label">${esc(t('rename.event.label'))}</span>
      <input type="text" class="dr-input"
        data-zone="${zone.id}" data-control="event"
        value="${esc(settings.extra.event ?? '')}"
        placeholder="${esc(t('rename.event.placeholder'))}" />
    </label>
  `;
}

function buildCustomTemplateField(zone, rename) {
  return `
    <label class="dr-field dr-field-wide">
      <span class="dr-field-label">${esc(t('rename.custom.label'))}</span>
      <input type="text" class="dr-input dr-input-mono"
        data-zone="${zone.id}" data-control="template"
        value="${esc(rename.template ?? '')}"
        placeholder="${esc(t('rename.custom.placeholder'))}" />
      <span class="dr-field-preview" data-zone="${zone.id}" data-preview></span>
    </label>
  `;
}

function buildRenameAdvanced(zone, rename) {
  return `
    <label class="dr-field">
      <span class="dr-field-label">${esc(t('rename.seqStart'))}</span>
      <input type="number" min="0" class="dr-input dr-input-small"
        data-zone="${zone.id}" data-control="seqStart" value="${rename.seqStart}" />
    </label>
    <label class="dr-field">
      <span class="dr-field-label">${esc(t('rename.collision'))}</span>
      <select class="dr-select" data-zone="${zone.id}" data-control="collision">
        <option value="suffix" ${rename.collision === 'suffix' ? 'selected' : ''}>${esc(t('rename.collision.suffix'))}</option>
        <option value="skip"   ${rename.collision === 'skip'   ? 'selected' : ''}>${esc(t('rename.collision.skip'))}</option>
        <option value="error"  ${rename.collision === 'error'  ? 'selected' : ''}>${esc(t('rename.collision.error'))}</option>
      </select>
    </label>
    <label class="dr-field">
      <span class="dr-field-label">${esc(t('rename.case'))}</span>
      <select class="dr-select" data-zone="${zone.id}" data-control="case">
        <option value="keep"  ${rename.case === 'keep'  ? 'selected' : ''}>${esc(t('rename.case.keep'))}</option>
        <option value="lower" ${rename.case === 'lower' ? 'selected' : ''}>${esc(t('rename.case.lower'))}</option>
        <option value="upper" ${rename.case === 'upper' ? 'selected' : ''}>${esc(t('rename.case.upper'))}</option>
      </select>
    </label>
  `;
}

function zoneHead(zone, title, desc) {
  const availability = zoneAvailability(zone.id);
  return `
    <div class="dr-zone-head">
      <div class="dr-zone-glyph">${zone.glyph}</div>
      <div class="dr-zone-meta">
        <h3 class="dr-zone-title">${esc(title)}</h3>
        <p class="dr-zone-desc">${esc(desc)}</p>
      </div>
      <div class="dr-zone-status is-${availability.tone}"${availability.title ? ` title="${esc(availability.title)}"` : ''}>
        <span class="dr-dot"></span>${esc(availability.label)}
      </div>
    </div>
  `;
}

// ─── Zone renderers ─────────────────────────────────────────────────────

const ZONE_RENDERERS = {
  'batch-rename': (zone, title, desc) => {
    const settings = state.zoneSettings[zone.id];
    const rename = settings.rename;
    const showCustom = rename.preset === 'custom';
    const showEvent  = needsEventToken(rename);

    return `
      <article class="dr-zone" data-zone="${zone.id}">
        ${zoneHead(zone, title, desc)}
        ${buildDropzone(zone)}
        <div class="dr-zone-controls">
          ${buildRenameSelect(zone, rename)}
          ${showEvent  ? buildEventField(zone, settings) : ''}
          ${showCustom ? buildCustomTemplateField(zone, rename) : ''}
        </div>
        <details class="dr-advanced">
          <summary class="dr-advanced-summary">${esc(t('rename.advanced'))}</summary>
          <div class="dr-advanced-body">${buildRenameAdvanced(zone, rename)}</div>
        </details>
      </article>
    `;
  },

  'web-ready': (zone, title, desc) => {
    const settings = state.zoneSettings[zone.id];
    const rename = settings.rename;
    const ex = settings.extra;
    const meta = settings.metadata;
    const maxEdge = ex.maxEdge;
    const format = ex.format;
    const qPct = Math.round((ex.quality ?? 0.82) * 100);

    const edgePresets = [1600, 2048, 2560, 3840];
    const isCustomEdge = !edgePresets.includes(maxEdge);
    const showCustom = rename.preset === 'custom';
    const showEvent  = needsEventToken(rename);
    return `
      <article class="dr-zone" data-zone="${zone.id}">
        ${zoneHead(zone, title, desc)}
        ${buildDropzone(zone)}

        <div class="dr-zone-controls">
          <label class="dr-field">
            <span class="dr-field-label">${esc(t('zone.web-ready.maxEdge'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="maxEdge">
              <option value="1600" ${maxEdge === 1600 ? 'selected' : ''}>1600 px (small web)</option>
              <option value="2048" ${maxEdge === 2048 ? 'selected' : ''}>2048 px (standard)</option>
              <option value="2560" ${maxEdge === 2560 ? 'selected' : ''}>2560 px (large)</option>
              <option value="3840" ${maxEdge === 3840 ? 'selected' : ''}>3840 px (4K edge)</option>
              <option value="custom" ${isCustomEdge ? 'selected' : ''}>Custom…</option>
            </select>
          </label>

          ${isCustomEdge ? `
            <label class="dr-field">
              <span class="dr-field-label">Custom edge (px)</span>
              <input type="number" min="100" max="10000" step="10" class="dr-input dr-input-small"
                data-zone="${zone.id}" data-control="maxEdgeCustom" value="${maxEdge}" />
            </label>
          ` : ''}

          <label class="dr-field">
            <span class="dr-field-label">${esc(t('zone.web-ready.format'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="format">
              <option value="image/jpeg" ${format === 'image/jpeg' ? 'selected' : ''}>JPEG</option>
              <option value="image/webp" ${format === 'image/webp' ? 'selected' : ''}>WebP</option>
              <option value="image/avif" ${format === 'image/avif' ? 'selected' : ''}>AVIF</option>
              <option value="image/png"  ${format === 'image/png'  ? 'selected' : ''}>PNG (lossless)</option>
            </select>
          </label>

          <label class="dr-field dr-field-wide">
            <span class="dr-field-label">
              ${esc(t('zone.web-ready.quality'))}
              <span class="dr-field-value" data-zone="${zone.id}" data-qv>${qPct}%</span>
            </span>
            <input type="range" min="60" max="95" step="1" class="dr-range"
              data-zone="${zone.id}" data-control="quality"
              value="${qPct}"
              ${format === 'image/png' ? 'disabled' : ''} />
          </label>

          <label class="dr-field dr-field-wide">
            <span class="dr-field-label">${esc(t('zone.web-ready.metadata'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="metadataMode">
              <option value="keep-all"      ${meta.mode === 'keep-all'      ? 'selected' : ''}>${esc(t('zone.web-ready.metadata.keep-all'))}</option>
              <option value="strip-private" ${meta.mode === 'strip-private' ? 'selected' : ''}>${esc(t('zone.web-ready.metadata.strip-private'))}</option>
              <option value="strip-all"     ${meta.mode === 'strip-all'     ? 'selected' : ''}>${esc(t('zone.web-ready.metadata.strip-all'))}</option>
            </select>
          </label>

          <label class="dr-checkbox dr-field-wide">
            <input type="checkbox" data-zone="${zone.id}" data-control="injectAttr" ${meta.injectOknAttribution ? 'checked' : ''} />
            <span class="dr-checkbox-label">
              ${esc(t('zone.web-ready.inject'))}
              <span class="dr-hint">${esc(t('zone.web-ready.inject.hint'))}</span>
            </span>
          </label>

          <label class="dr-checkbox dr-field-wide">
            <input type="checkbox" data-zone="${zone.id}" data-control="srgbConvert" ${ex.srgbConvert ? 'checked' : ''} />
            <span class="dr-checkbox-label">
              ${esc(t('zone.web-ready.srgb'))}
              <span class="dr-hint">${esc(t('zone.web-ready.srgb.hint'))}</span>
            </span>
          </label>
        </div>

        <details class="dr-advanced">
          <summary class="dr-advanced-summary">Rename & advanced</summary>
          <div class="dr-zone-controls" style="padding-top:14px">
            ${buildRenameSelect(zone, rename)}
            ${showEvent  ? buildEventField(zone, settings) : ''}
            ${showCustom ? buildCustomTemplateField(zone, rename) : ''}
          </div>
          <div class="dr-advanced-body" style="padding-top:14px">
            ${buildRenameAdvanced(zone, rename)}
          </div>
        </details>
      </article>
    `;
  },

  'bulk-compress': (zone, title, desc) => {
    const settings = state.zoneSettings[zone.id];
    const rename = settings.rename;
    const ex = settings.extra;
    const meta = settings.metadata;
    const showCustom = rename.preset === 'custom';
    const showEvent  = needsEventToken(rename);
    const minQPct = Math.round((ex.minQuality ?? 0.60) * 100);

    return `
      <article class="dr-zone" data-zone="${zone.id}">
        ${zoneHead(zone, title, desc)}
        ${buildDropzone(zone)}

        <div class="dr-zone-controls">
          <label class="dr-field">
            <span class="dr-field-label">
              ${esc(t('zone.bulk-compress.targetSize'))}
              <span class="dr-field-value" data-zone="${zone.id}" data-tv>${ex.targetSizeMB} MB</span>
            </span>
            <input type="range" min="5" max="2000" step="5" class="dr-range"
              data-zone="${zone.id}" data-control="targetSize"
              value="${ex.targetSizeMB}" />
            <span class="dr-hint">${esc(t('zone.bulk-compress.targetSize.hint'))}</span>
          </label>

          <label class="dr-field">
            <span class="dr-field-label">${esc(t('zone.bulk-compress.maxEdge'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="maxEdge">
              <option value="0"    ${ex.maxEdge === 0    ? 'selected' : ''}>${esc(t('zone.bulk-compress.maxEdge.off'))}</option>
              <option value="1600" ${ex.maxEdge === 1600 ? 'selected' : ''}>1600 px</option>
              <option value="2048" ${ex.maxEdge === 2048 ? 'selected' : ''}>2048 px</option>
              <option value="2560" ${ex.maxEdge === 2560 ? 'selected' : ''}>2560 px</option>
              <option value="3840" ${ex.maxEdge === 3840 ? 'selected' : ''}>3840 px</option>
            </select>
          </label>

          <label class="dr-field">
            <span class="dr-field-label">${esc(t('zone.bulk-compress.format'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="format">
              <option value="image/jpeg" ${ex.format === 'image/jpeg' ? 'selected' : ''}>JPEG</option>
              <option value="image/webp" ${ex.format === 'image/webp' ? 'selected' : ''}>WebP (smaller)</option>
            </select>
          </label>

          <label class="dr-field">
            <span class="dr-field-label">
              ${esc(t('zone.bulk-compress.minQuality'))}
              <span class="dr-field-value" data-zone="${zone.id}" data-mqv>${minQPct}%</span>
            </span>
            <input type="range" min="30" max="90" step="5" class="dr-range"
              data-zone="${zone.id}" data-control="minQuality"
              value="${minQPct}" />
            <span class="dr-hint">${esc(t('zone.bulk-compress.minQuality.hint'))}</span>
          </label>

          <label class="dr-field dr-field-wide">
            <span class="dr-field-label">${esc(t('zone.bulk-compress.metadata'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="metadataMode">
              <option value="keep-all"      ${meta.mode === 'keep-all'      ? 'selected' : ''}>${esc(t('zone.web-ready.metadata.keep-all'))}</option>
              <option value="strip-private" ${meta.mode === 'strip-private' ? 'selected' : ''}>${esc(t('zone.web-ready.metadata.strip-private'))}</option>
              <option value="strip-all"     ${meta.mode === 'strip-all'     ? 'selected' : ''}>${esc(t('zone.web-ready.metadata.strip-all'))}</option>
            </select>
          </label>

          <label class="dr-checkbox dr-field-wide">
            <input type="checkbox" data-zone="${zone.id}" data-control="injectAttr" ${meta.injectOknAttribution ? 'checked' : ''} />
            <span class="dr-checkbox-label">
              ${esc(t('zone.web-ready.inject'))}
              <span class="dr-hint">${esc(t('zone.web-ready.inject.hint'))}</span>
            </span>
          </label>

          <label class="dr-checkbox dr-field-wide">
            <input type="checkbox" data-zone="${zone.id}" data-control="srgbConvert" ${ex.srgbConvert ? 'checked' : ''} />
            <span class="dr-checkbox-label">
              ${esc(t('zone.web-ready.srgb'))}
              <span class="dr-hint">${esc(t('zone.web-ready.srgb.hint'))}</span>
            </span>
          </label>
        </div>

        <details class="dr-advanced">
          <summary class="dr-advanced-summary">Rename & advanced</summary>
          <div class="dr-zone-controls" style="padding-top:14px">
            ${buildRenameSelect(zone, rename)}
            ${showEvent  ? buildEventField(zone, settings) : ''}
            ${showCustom ? buildCustomTemplateField(zone, rename) : ''}
          </div>
          <div class="dr-advanced-body" style="padding-top:14px">
            ${buildRenameAdvanced(zone, rename)}
          </div>
        </details>
      </article>
    `;
  },

  'metadata-studio': (zone, title, desc) => {
    const settings = state.zoneSettings[zone.id];
    const rename = settings.rename;
    const ex = settings.extra;
    const meta = settings.metadata;
    const showCustom = rename.preset === 'custom';
    const showEvent  = needsEventToken(rename);

    return `
      <article class="dr-zone" data-zone="${zone.id}">
        ${zoneHead(zone, title, desc)}
        ${buildDropzone(zone)}

        <div class="dr-zone-controls">
          <label class="dr-field dr-field-wide">
            <span class="dr-field-label">${esc(t('zone.metadata-studio.policy'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="metadataMode">
              <option value="keep-all"      ${meta.mode === 'keep-all'      ? 'selected' : ''}>${esc(t('zone.metadata-studio.policy.keep-all'))}</option>
              <option value="strip-private" ${meta.mode === 'strip-private' ? 'selected' : ''}>${esc(t('zone.metadata-studio.policy.strip-private'))}</option>
              <option value="strip-all"     ${meta.mode === 'strip-all'     ? 'selected' : ''}>${esc(t('zone.metadata-studio.policy.strip-all'))}</option>
            </select>
          </label>

          <label class="dr-checkbox dr-field-wide">
            <input type="checkbox" data-zone="${zone.id}" data-control="injectAttr" ${meta.injectOknAttribution ? 'checked' : ''} />
            <span class="dr-checkbox-label">
              ${esc(t('zone.metadata-studio.inject'))}
              <span class="dr-hint">${esc(t('zone.metadata-studio.inject.hint'))}</span>
            </span>
          </label>

          <label class="dr-checkbox dr-field-wide">
            <input type="checkbox" data-zone="${zone.id}" data-control="blankOnly" ${meta.forceOverwriteBlankOnly ? 'checked' : ''} />
            <span class="dr-checkbox-label">
              ${esc(t('zone.metadata-studio.blankOnly'))}
            </span>
          </label>

          <label class="dr-checkbox dr-field-wide">
            <input type="checkbox" data-zone="${zone.id}" data-control="normaliseOrientation" ${ex.normaliseOrientation ? 'checked' : ''} />
            <span class="dr-checkbox-label">
              ${esc(t('zone.metadata-studio.normaliseOrientation'))}
              <span class="dr-hint">${esc(t('zone.metadata-studio.normaliseOrientation.hint'))}</span>
            </span>
          </label>

          <p class="dr-hint dr-field-wide" style="margin-top:4px">
            ${esc(t('zone.metadata-studio.unsupported'))}
          </p>
        </div>

        <details class="dr-advanced">
          <summary class="dr-advanced-summary">Rename & advanced</summary>
          <div class="dr-zone-controls" style="padding-top:14px">
            ${buildRenameSelect(zone, rename)}
            ${showEvent  ? buildEventField(zone, settings) : ''}
            ${showCustom ? buildCustomTemplateField(zone, rename) : ''}
          </div>
          <div class="dr-advanced-body" style="padding-top:14px">
            ${buildRenameAdvanced(zone, rename)}
          </div>
        </details>
      </article>
    `;
  },

  'social': (zone, title, desc) => {
    const settings = state.zoneSettings[zone.id];
    const rename = settings.rename;
    const ex = settings.extra;
    const meta = settings.metadata;
    const showCustom = rename.preset === 'custom';
    const showEvent  = needsEventToken(rename);
    const qPct = Math.round((ex.quality ?? 0.85) * 100);
    const isCustom = ex.platform === 'custom';
    const isContain = ex.fit === 'contain';
    const transparentDisabled = ex.format === 'image/jpeg';

    return `
      <article class="dr-zone" data-zone="${zone.id}">
        ${zoneHead(zone, title, desc)}
        ${buildDropzone(zone)}

        <div class="dr-zone-controls">
          <label class="dr-field dr-field-wide">
            <span class="dr-field-label">${esc(t('zone.social.platform'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="platform">
              <option value="instagram-square"   ${ex.platform === 'instagram-square'   ? 'selected' : ''}>${esc(t('zone.social.platform.instagram-square'))}</option>
              <option value="instagram-portrait" ${ex.platform === 'instagram-portrait' ? 'selected' : ''}>${esc(t('zone.social.platform.instagram-portrait'))}</option>
              <option value="instagram-story"    ${ex.platform === 'instagram-story'    ? 'selected' : ''}>${esc(t('zone.social.platform.instagram-story'))}</option>
              <option value="facebook-post"      ${ex.platform === 'facebook-post'      ? 'selected' : ''}>${esc(t('zone.social.platform.facebook-post'))}</option>
              <option value="facebook-cover"     ${ex.platform === 'facebook-cover'     ? 'selected' : ''}>${esc(t('zone.social.platform.facebook-cover'))}</option>
              <option value="custom"             ${isCustom ? 'selected' : ''}>${esc(t('zone.social.platform.custom'))}</option>
            </select>
          </label>

          ${isCustom ? `
            <label class="dr-field">
              <span class="dr-field-label">${esc(t('zone.social.customSize'))}</span>
              <span style="display:flex;gap:8px;align-items:center">
                <input type="number" min="16" max="8192" step="1" class="dr-input dr-input-small"
                  data-zone="${zone.id}" data-control="customW" value="${ex.customW ?? 1080}" />
                <span class="dr-muted">×</span>
                <input type="number" min="16" max="8192" step="1" class="dr-input dr-input-small"
                  data-zone="${zone.id}" data-control="customH" value="${ex.customH ?? 1080}" />
              </span>
            </label>
          ` : ''}

          <label class="dr-field">
            <span class="dr-field-label">${esc(t('zone.social.fit'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="socialFit">
              <option value="cover"   ${ex.fit === 'cover'   ? 'selected' : ''}>${esc(t('zone.social.fit.cover'))}</option>
              <option value="contain" ${ex.fit === 'contain' ? 'selected' : ''}>${esc(t('zone.social.fit.contain'))}</option>
            </select>
          </label>

          ${isContain ? `
            <label class="dr-field">
              <span class="dr-field-label">${esc(t('zone.social.background'))}</span>
              <select class="dr-select" data-zone="${zone.id}" data-control="socialBackground">
                <option value="blur"        ${ex.background === 'blur'        ? 'selected' : ''}>${esc(t('zone.social.background.blur'))}</option>
                <option value="white"       ${ex.background === 'white'       ? 'selected' : ''}>${esc(t('zone.social.background.white'))}</option>
                <option value="black"       ${ex.background === 'black'       ? 'selected' : ''}>${esc(t('zone.social.background.black'))}</option>
                <option value="transparent" ${ex.background === 'transparent' ? 'selected' : ''} ${transparentDisabled ? 'disabled' : ''}>${esc(t('zone.social.background.transparent'))}</option>
              </select>
            </label>
          ` : ''}

          <label class="dr-field">
            <span class="dr-field-label">${esc(t('zone.social.format'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="format">
              <option value="image/jpeg" ${ex.format === 'image/jpeg' ? 'selected' : ''}>JPEG</option>
              <option value="image/webp" ${ex.format === 'image/webp' ? 'selected' : ''}>WebP</option>
              <option value="image/png"  ${ex.format === 'image/png'  ? 'selected' : ''}>PNG (lossless)</option>
            </select>
          </label>

          <label class="dr-field dr-field-wide">
            <span class="dr-field-label">
              ${esc(t('zone.social.quality'))}
              <span class="dr-field-value" data-zone="${zone.id}" data-qv>${qPct}%</span>
            </span>
            <input type="range" min="60" max="95" step="1" class="dr-range"
              data-zone="${zone.id}" data-control="quality"
              value="${qPct}"
              ${ex.format === 'image/png' ? 'disabled' : ''} />
          </label>
        </div>

        <details class="dr-advanced">
          <summary class="dr-advanced-summary">Rename & advanced</summary>
          <div class="dr-zone-controls" style="padding-top:14px">
            ${buildRenameSelect(zone, rename)}
            ${showEvent  ? buildEventField(zone, settings) : ''}
            ${showCustom ? buildCustomTemplateField(zone, rename) : ''}
            <label class="dr-field dr-field-wide">
              <span class="dr-field-label">${esc(t('zone.metadata-studio.policy'))}</span>
              <select class="dr-select" data-zone="${zone.id}" data-control="metadataMode">
                <option value="keep-all"      ${meta.mode === 'keep-all'      ? 'selected' : ''}>${esc(t('zone.metadata-studio.policy.keep-all'))}</option>
                <option value="strip-private" ${meta.mode === 'strip-private' ? 'selected' : ''}>${esc(t('zone.metadata-studio.policy.strip-private'))}</option>
                <option value="strip-all"     ${meta.mode === 'strip-all'     ? 'selected' : ''}>${esc(t('zone.metadata-studio.policy.strip-all'))}</option>
              </select>
            </label>
          </div>
          <div class="dr-advanced-body" style="padding-top:14px">
            ${buildRenameAdvanced(zone, rename)}
          </div>
        </details>
      </article>
    `;
  },

  'heic-to-jpeg': (zone, title, desc) => {
    const settings = state.zoneSettings[zone.id];
    const rename = settings.rename;
    const ex = settings.extra;
    const meta = settings.metadata;
    const showCustom = rename.preset === 'custom';
    const showEvent  = needsEventToken(rename);
    const qPct = Math.round((ex.quality ?? 0.90) * 100);

    return `
      <article class="dr-zone" data-zone="${zone.id}">
        ${zoneHead(zone, title, desc)}
        ${buildDropzone(zone)}

        <div class="dr-zone-controls">
          <label class="dr-field">
            <span class="dr-field-label">${esc(t('zone.heic-to-jpeg.format'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="format">
              <option value="image/jpeg" ${ex.format === 'image/jpeg' ? 'selected' : ''}>JPEG</option>
              <option value="image/webp" ${ex.format === 'image/webp' ? 'selected' : ''}>WebP</option>
            </select>
          </label>

          <label class="dr-field">
            <span class="dr-field-label">${esc(t('zone.heic-to-jpeg.maxEdge'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="maxEdge">
              <option value="0"    ${ex.maxEdge === 0    ? 'selected' : ''}>${esc(t('zone.heic-to-jpeg.maxEdge.off'))}</option>
              <option value="1600" ${ex.maxEdge === 1600 ? 'selected' : ''}>1600 px</option>
              <option value="2048" ${ex.maxEdge === 2048 ? 'selected' : ''}>2048 px</option>
              <option value="2560" ${ex.maxEdge === 2560 ? 'selected' : ''}>2560 px</option>
              <option value="3840" ${ex.maxEdge === 3840 ? 'selected' : ''}>3840 px</option>
            </select>
          </label>

          <label class="dr-field dr-field-wide">
            <span class="dr-field-label">
              ${esc(t('zone.heic-to-jpeg.quality'))}
              <span class="dr-field-value" data-zone="${zone.id}" data-qv>${qPct}%</span>
            </span>
            <input type="range" min="60" max="98" step="1" class="dr-range"
              data-zone="${zone.id}" data-control="quality" value="${qPct}" />
          </label>

          <label class="dr-checkbox dr-field-wide">
            <input type="checkbox" data-zone="${zone.id}" data-control="srgbConvert" ${ex.srgbConvert ? 'checked' : ''} />
            <span class="dr-checkbox-label">
              ${esc(t('zone.heic-to-jpeg.srgbConvert'))}
              <span class="dr-hint">${esc(t('zone.heic-to-jpeg.srgbConvert.hint'))}</span>
            </span>
          </label>

          <label class="dr-field dr-field-wide">
            <span class="dr-field-label">${esc(t('zone.web-ready.metadata'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="metadataMode">
              <option value="keep-all"      ${meta.mode === 'keep-all'      ? 'selected' : ''}>${esc(t('zone.web-ready.metadata.keep-all'))}</option>
              <option value="strip-private" ${meta.mode === 'strip-private' ? 'selected' : ''}>${esc(t('zone.web-ready.metadata.strip-private'))}</option>
              <option value="strip-all"     ${meta.mode === 'strip-all'     ? 'selected' : ''}>${esc(t('zone.web-ready.metadata.strip-all'))}</option>
            </select>
          </label>

          <label class="dr-checkbox dr-field-wide">
            <input type="checkbox" data-zone="${zone.id}" data-control="injectAttr" ${meta.injectOknAttribution ? 'checked' : ''} />
            <span class="dr-checkbox-label">${esc(t('zone.web-ready.inject'))}</span>
          </label>
        </div>

        <details class="dr-advanced">
          <summary class="dr-advanced-summary">Rename & advanced</summary>
          <div class="dr-zone-controls" style="padding-top:14px">
            ${buildRenameSelect(zone, rename)}
            ${showEvent  ? buildEventField(zone, settings) : ''}
            ${showCustom ? buildCustomTemplateField(zone, rename) : ''}
          </div>
          <div class="dr-advanced-body" style="padding-top:14px">
            ${buildRenameAdvanced(zone, rename)}
          </div>
        </details>
      </article>
    `;
  },

  'colour-space': (zone, title, desc) => {
    const settings = state.zoneSettings[zone.id];
    const rename = settings.rename;
    const ex = settings.extra;
    const targetProfile = isServerOnlyColourTarget(ex.targetProfile) ? 'srgb' : ex.targetProfile;
    ex.targetProfile = targetProfile;
    const meta = settings.metadata;
    const showCustom = rename.preset === 'custom';
    const showEvent  = needsEventToken(rename);
    const qPct = Math.round((ex.quality ?? 0.92) * 100);

    return `
      <article class="dr-zone" data-zone="${zone.id}">
        ${zoneHead(zone, title, desc)}
        ${buildDropzone(zone)}

        <div class="dr-zone-controls">
          <label class="dr-field dr-field-wide">
            <span class="dr-field-label">${esc(t('zone.colour-space.target'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="targetProfile">
              <option value="srgb"       ${targetProfile === 'srgb'       ? 'selected' : ''}>${esc(t('zone.colour-space.target.srgb'))}</option>
              <option value="display-p3" ${targetProfile === 'display-p3' ? 'selected' : ''}>${esc(t('zone.colour-space.target.display-p3'))}</option>
              <option value="adobe-rgb"  disabled>${esc(t('zone.colour-space.target.adobe-rgb'))}</option>
              <option value="prophoto"   disabled>${esc(t('zone.colour-space.target.prophoto'))}</option>
            </select>
            <span class="dr-hint">${esc(t('zone.colour-space.serverOptionsLocked'))}</span>
          </label>

          <label class="dr-field">
            <span class="dr-field-label">${esc(t('zone.colour-space.format'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="format">
              <option value="image/jpeg" ${ex.format === 'image/jpeg' ? 'selected' : ''}>JPEG</option>
              <option value="image/webp" ${ex.format === 'image/webp' ? 'selected' : ''}>WebP</option>
              <option value="image/png"  ${ex.format === 'image/png'  ? 'selected' : ''}>PNG (lossless)</option>
            </select>
          </label>

          <label class="dr-field dr-field-wide">
            <span class="dr-field-label">
              ${esc(t('zone.colour-space.quality'))}
              <span class="dr-field-value" data-zone="${zone.id}" data-qv>${qPct}%</span>
            </span>
            <input type="range" min="60" max="98" step="1" class="dr-range"
              data-zone="${zone.id}" data-control="quality" value="${qPct}"
              ${ex.format === 'image/png' ? 'disabled' : ''} />
          </label>

          <label class="dr-checkbox dr-field-wide">
            <input type="checkbox" data-zone="${zone.id}" data-control="tagOutputSlug" ${ex.tagOutputWithProfileSlug ? 'checked' : ''} />
            <span class="dr-checkbox-label">${esc(t('zone.colour-space.tagSlug'))}</span>
          </label>

          <label class="dr-field dr-field-wide">
            <span class="dr-field-label">${esc(t('zone.web-ready.metadata'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="metadataMode">
              <option value="keep-all"      ${meta.mode === 'keep-all'      ? 'selected' : ''}>${esc(t('zone.web-ready.metadata.keep-all'))}</option>
              <option value="strip-private" ${meta.mode === 'strip-private' ? 'selected' : ''}>${esc(t('zone.web-ready.metadata.strip-private'))}</option>
              <option value="strip-all"     ${meta.mode === 'strip-all'     ? 'selected' : ''}>${esc(t('zone.web-ready.metadata.strip-all'))}</option>
            </select>
          </label>
        </div>

        <details class="dr-advanced">
          <summary class="dr-advanced-summary">Rename & advanced</summary>
          <div class="dr-zone-controls" style="padding-top:14px">
            ${buildRenameSelect(zone, rename)}
            ${showEvent  ? buildEventField(zone, settings) : ''}
            ${showCustom ? buildCustomTemplateField(zone, rename) : ''}
          </div>
          <div class="dr-advanced-body" style="padding-top:14px">
            ${buildRenameAdvanced(zone, rename)}
          </div>
        </details>
      </article>
    `;
  },

  'archive': (zone, title, desc) => {
    const settings = state.zoneSettings[zone.id];
    const ex = settings.extra;

    return `
      <article class="dr-zone" data-zone="${zone.id}">
        ${zoneHead(zone, title, desc)}
        ${buildDropzone(zone)}

        <div class="dr-zone-controls">
          <label class="dr-field dr-field-wide">
            <span class="dr-field-label">${esc(t('zone.archive.event'))}</span>
            <input type="text" class="dr-input"
              data-zone="${zone.id}" data-control="event"
              value="${esc(ex.event ?? '')}"
              placeholder="${esc(t('zone.archive.event.placeholder'))}" />
          </label>

          <label class="dr-field dr-field-wide">
            <span class="dr-field-label">${esc(t('zone.archive.location'))}</span>
            <input type="text" class="dr-input"
              data-zone="${zone.id}" data-control="archiveLocation"
              value="${esc(ex.location ?? '')}"
              placeholder="${esc(t('zone.archive.location.placeholder'))}" />
          </label>

          <label class="dr-checkbox dr-field-wide">
            <input type="checkbox" data-zone="${zone.id}" data-control="includeSidecars" ${ex.includeSidecars ? 'checked' : ''} />
            <span class="dr-checkbox-label">${esc(t('zone.archive.includeSidecars'))}</span>
          </label>

          <label class="dr-checkbox dr-field-wide">
            <input type="checkbox" data-zone="${zone.id}" data-control="includeManifest" ${ex.includeManifest ? 'checked' : ''} />
            <span class="dr-checkbox-label">${esc(t('zone.archive.includeManifest'))}</span>
          </label>

          <label class="dr-checkbox dr-field-wide">
            <input type="checkbox" data-zone="${zone.id}" data-control="includeReadme" ${ex.includeReadme ? 'checked' : ''} />
            <span class="dr-checkbox-label">${esc(t('zone.archive.includeReadme'))}</span>
          </label>

          <p class="dr-hint dr-field-wide">${esc(t('zone.archive.hint'))}</p>
        </div>
      </article>
    `;
  },

  'raw-develop': (zone, title, desc) => {
    const settings = state.zoneSettings[zone.id];
    const rename = settings.rename;
    const ex = settings.extra;
    const showCustom = rename.preset === 'custom';
    const showEvent  = needsEventToken(rename);
    const qPct = Math.round((ex.quality ?? 0.92) * 100);
    const processingDisabled = true;

    return `
      <article class="dr-zone dr-zone-off" data-zone="${zone.id}" aria-disabled="true">
        ${zoneHead(zone, title, desc)}

        <div class="dr-server-notice" role="note">
          <span class="dr-server-notice-icon" aria-hidden="true">◎</span>
          <div class="dr-server-notice-body">
            <strong class="dr-server-notice-title">${esc(t('zone.serverOnly.heading'))}</strong>
            <span class="dr-server-notice-text">${esc(t('zone.serverOnly.body'))}</span>
            <span class="dr-server-notice-meta">${esc(t('zone.serverOnly.meta'))}</span>
          </div>
        </div>

        ${buildDropzone(zone, { disabled: processingDisabled, disabledTitle: t('zone.raw-develop.unavailable') })}

        <div class="dr-zone-controls">
          <label class="dr-field">
            <span class="dr-field-label">${esc(t('zone.raw-develop.outputFormat'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="rawOutputFormat" disabled aria-disabled="true">
              <option value="image/jpeg" ${ex.outputFormat === 'image/jpeg' ? 'selected' : ''}>JPEG</option>
              <option value="image/tiff" ${ex.outputFormat === 'image/tiff' ? 'selected' : ''}>TIFF (16-bit)</option>
            </select>
          </label>

          <label class="dr-field">
            <span class="dr-field-label">${esc(t('zone.raw-develop.whiteBalance'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="whiteBalance" disabled aria-disabled="true">
              <option value="as-shot"  ${ex.whiteBalance === 'as-shot'  ? 'selected' : ''}>${esc(t('zone.raw-develop.whiteBalance.as-shot'))}</option>
              <option value="auto"     ${ex.whiteBalance === 'auto'     ? 'selected' : ''}>${esc(t('zone.raw-develop.whiteBalance.auto'))}</option>
              <option value="daylight" ${ex.whiteBalance === 'daylight' ? 'selected' : ''}>${esc(t('zone.raw-develop.whiteBalance.daylight'))}</option>
              <option value="tungsten" ${ex.whiteBalance === 'tungsten' ? 'selected' : ''}>${esc(t('zone.raw-develop.whiteBalance.tungsten'))}</option>
            </select>
          </label>

          <label class="dr-field dr-field-wide">
            <span class="dr-field-label">
              ${esc(t('zone.raw-develop.exposure'))}
              <span class="dr-field-value" data-zone="${zone.id}" data-ev>${(ex.exposure ?? 0).toFixed(1)}</span>
            </span>
            <input type="range" min="-3" max="3" step="0.1" class="dr-range"
              data-zone="${zone.id}" data-control="exposure" value="${ex.exposure ?? 0}" disabled aria-disabled="true" />
          </label>

          <label class="dr-field dr-field-wide">
            <span class="dr-field-label">
              ${esc(t('zone.raw-develop.quality'))}
              <span class="dr-field-value" data-zone="${zone.id}" data-qv>${qPct}%</span>
            </span>
            <input type="range" min="60" max="98" step="1" class="dr-range"
              data-zone="${zone.id}" data-control="quality" value="${qPct}"
              disabled aria-disabled="true" />
          </label>
        </div>

        <details class="dr-advanced">
          <summary class="dr-advanced-summary">Rename & advanced</summary>
          <div class="dr-zone-controls" style="padding-top:14px">
            ${buildRenameSelect(zone, rename)}
            ${showEvent  ? buildEventField(zone, settings) : ''}
            ${showCustom ? buildCustomTemplateField(zone, rename) : ''}
          </div>
          <div class="dr-advanced-body" style="padding-top:14px">
            ${buildRenameAdvanced(zone, rename)}
          </div>
        </details>
      </article>
    `;
  }
};

function needsEventToken(rename) {
  if (rename.preset === 'okn-event') return true;
  if (rename.preset === 'custom' && (rename.template ?? '').includes('{event}')) return true;
  return false;
}

// ─── Render: job history strip ──────────────────────────────────────────

function renderHistory() {
  const root = $('#dr-history');
  if (!root) return;

  if (state.history.length === 0) {
    root.innerHTML = `
      <div class="dr-history-head">
        <h2 class="dr-history-title">${esc(t('history.title'))}</h2>
      </div>
      <p class="dr-history-empty">${esc(t('history.empty'))}</p>
    `;
    return;
  }

  root.innerHTML = `
    <div class="dr-history-head">
      <h2 class="dr-history-title">${esc(t('history.title'))}</h2>
      <span class="dr-history-count">${state.history.length}</span>
    </div>
    <div class="dr-history-list">
      ${state.history.map(renderHistoryEntry).join('')}
    </div>
  `;
}

function renderHistoryEntry(entry) {
  const zone = ZONES.find((z) => z.id === entry.zone);
  const zoneTitle = zone ? t(zone.title) : entry.zone;
  return `
    <div class="dr-history-entry">
      <div class="dr-history-entry-main">
        <span class="dr-history-entry-zone">${esc(zoneTitle)}</span>
        <span class="dr-history-entry-summary">${esc(t('history.summary', {
          zone: '',
          count: entry.fileCount,
          duration: formatDuration(entry.durationMs)
        })).replace(/^\s*·\s*/, '')}</span>
      </div>
      <div class="dr-history-entry-actions">
        ${entry.successCount > 0 ? `<span class="dr-pill dr-pill-ok">${entry.successCount} ok</span>` : ''}
        ${entry.failureCount > 0 ? `<span class="dr-pill dr-pill-warn">${entry.failureCount} fail</span>` : ''}
        <button type="button" class="dr-btn dr-btn-ghost dr-btn-xs"
          data-history-replay="${esc(entry.id)}"
          data-history-started="${entry.startedAt}">${esc(t('history.replay'))}</button>
        <button type="button" class="dr-btn dr-btn-subtle dr-btn-xs"
          data-history-remove="${esc(entry.id)}"
          data-history-started="${entry.startedAt}"
          aria-label="${esc(t('history.remove'))}">×</button>
      </div>
    </div>
  `;
}

// ─── Event binding (delegated from document root) ───────────────────────
//
// All handlers use the asEl() helper to narrow e.target (which is typed
// as EventTarget, not Element) before calling closest()/matches(). The
// helper returns null for non-Element targets (window, document itself,
// text nodes) — the existing null-guards below just become optional-
// chain-short-circuits in that case.

function bindGlobalEvents() {
  const root = document;

  // Tab switching
  root.addEventListener('click', (e) => {
    const tab = asEl(e.target)?.closest('[data-tab]');
    if (tab) {
      state.activeTab = /** @type {HTMLElement} */ (tab).dataset.tab;
      renderTabs();
      renderZones();
    }
  });

  // Drop-zone: click to open file picker
  root.addEventListener('click', (e) => {
    const el = asEl(e.target);
    const dz = el?.closest('[data-dropzone]');
    if (!dz) return;
    if (el?.closest('.dr-zone-controls')) return;
    const zoneId = /** @type {HTMLElement} */ (dz).dataset.zone;
    const input = $(`.dr-file-input[data-zone="${zoneId}"]`);
    input?.click();
  });

  // Drop-zone: keyboard (Enter/Space)
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const dz = asEl(e.target)?.closest('[data-dropzone]');
    if (!dz) return;
    e.preventDefault();
    const zoneId = /** @type {HTMLElement} */ (dz).dataset.zone;
    const input = $(`.dr-file-input[data-zone="${zoneId}"]`);
    input?.click();
  });

  // Drag-and-drop
  root.addEventListener('dragover', (e) => {
    const dz = asEl(e.target)?.closest('[data-dropzone]');
    if (!dz) return;
    e.preventDefault();
    dz.classList.add('is-hover');
  });
  root.addEventListener('dragleave', (e) => {
    const dz = asEl(e.target)?.closest('[data-dropzone]');
    if (dz) dz.classList.remove('is-hover');
  });
  root.addEventListener('drop', async (e) => {
    const dz = asEl(e.target)?.closest('[data-dropzone]');
    if (!dz) return;
    e.preventDefault();
    dz.classList.remove('is-hover');
    const zoneId = /** @type {HTMLElement} */ (dz).dataset.zone;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) await handleFilesDropped(zoneId, files);
  });

  // File picker change
  root.addEventListener('change', async (e) => {
    const input = /** @type {HTMLInputElement | null} */ (asEl(e.target)?.closest('.dr-file-input'));
    if (!input) return;
    const zoneId = input.dataset.zone;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length > 0) await handleFilesDropped(zoneId, files);
  });

  // Zone controls (delegated input/change)
  root.addEventListener('input',  (e) => handleZoneControl(e));
  root.addEventListener('change', (e) => handleZoneControl(e));

  // Settings drawer
  $('#dr-open-settings')?.addEventListener('click', openSettings);
  $('#dr-close-settings')?.addEventListener('click', closeSettings);
  $('#dr-close-settings-foot')?.addEventListener('click', closeSettings);
  $('#dr-save-settings-foot')?.addEventListener('click', onSettingsSave);
  $('#dr-settings-backdrop')?.addEventListener('click', closeSettings);

  // Language switcher (inside settings drawer)
  $('#set-language')?.addEventListener('change', (e) => {
    const el = /** @type {HTMLSelectElement | null} */ (asEl(e.target));
    const value = el?.value;
    if (value === 'en' || value === 'ko') setLocale(value);
  });

  // Dry-run / processing / result actions
  root.addEventListener('click', (e) => {
    const el = asEl(e.target);
    if (!el) return;
    if (el.closest('[data-action="dryrun-process"]')) startProcessing();
    if (el.closest('[data-action="dryrun-back"]'))    closeDryRunAndReset();
    if (el.closest('[data-action="process-cancel"]')) cancelProcessing();
    if (el.closest('[data-action="result-close"]'))   closeResult();
    if (el.closest('[data-action="result-retry"]'))   retryFailedJob();
    if (el.closest('[data-action="result-copy-diag"]')) copyDiagnostics();

    // Per-zone queue actions (Process / Clear / Remove row).
    const processBtn = /** @type {HTMLElement | null} */ (el.closest('[data-action="zone-process"]'));
    if (processBtn && !processBtn.hasAttribute('disabled')) {
      const zid = processBtn.dataset.zone;
      if (zid) startZoneJob(zid);
    }
    const clearBtn = /** @type {HTMLElement | null} */ (el.closest('[data-action="zone-clear"]'));
    if (clearBtn) {
      const zid = clearBtn.dataset.zone;
      if (zid) clearZoneQueue(zid);
    }
    const removeBtn = /** @type {HTMLElement | null} */ (el.closest('[data-action="zone-remove"]'));
    if (removeBtn) {
      const zid = removeBtn.dataset.zone;
      const rid = removeBtn.dataset.row;
      if (zid && rid) removeQueuedFile(zid, rid);
    }

    const replay = /** @type {HTMLElement | null} */ (el.closest('[data-history-replay]'));
    if (replay) replayHistoryEntry(replay.dataset.historyReplay, Number(replay.dataset.historyStarted));
    const remove = /** @type {HTMLElement | null} */ (el.closest('[data-history-remove]'));
    if (remove) removeHistoryEntryAndReload(remove.dataset.historyRemove, Number(remove.dataset.historyStarted));
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // ⌘/Ctrl + Enter — "Process" when the dry-run panel is open.
    // This works even with focus inside an input, because power users
    // often tweak a setting and immediately want to kick off the job.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key === 'Return')) {
      if ($('#dr-dryrun')?.classList.contains('is-open')) {
        e.preventDefault();
        startProcessing();
        return;
      }
    }

    if (asEl(e.target)?.matches('input, textarea, select')) return;
    if (e.key === '?') { e.preventDefault(); toggleShortcuts(); }
    if (e.key === 'Escape') {
      if ($('#dr-settings')?.classList.contains('is-open')) closeSettings();
      else if ($('#dr-dryrun')?.classList.contains('is-open')) closeDryRun();
      else if ($('#dr-shortcuts')?.classList.contains('is-open')) toggleShortcuts();
    }
    if (e.key === ',') { e.preventDefault(); openSettings(); }

    // 1–9 — jump to the nth WIRED zone in the active tab. Scrolls it
    // into view and focuses its dropzone so Enter/Space opens the picker.
    // Non-wired (“Coming soon”) zones are skipped so focus never lands on
    // a dropzone that rejects everything.
    if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const zones = (ZONES_BY_TAB[state.activeTab] ?? []).filter((z) => WIRED_ZONES.has(z.id));
      const idx = Number(e.key) - 1;
      const zone = zones[idx];
      if (zone) {
        e.preventDefault();
        const card = document.querySelector(`.dr-zone[data-zone="${zone.id}"]`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const dz = /** @type {HTMLElement | null} */ (card.querySelector('[data-dropzone]'));
          dz?.focus();
        }
      }
    }
  });
}

function handleZoneControl(e) {
  const el = /** @type {HTMLInputElement | HTMLSelectElement | null} */ (asEl(e.target));
  if (!el) return;
  const zoneId = el.dataset?.zone;
  const control = el.dataset?.control;
  if (!zoneId || !control || !state.zoneSettings[zoneId]) return;

  const settings = state.zoneSettings[zoneId];
  let needsRerender = false;

  switch (control) {
    // ─── Rename controls (shared) ─────────────────────────────────────
    case 'preset': {
      const prev = settings.rename.preset;
      settings.rename.preset = el.value;
      if (prev !== el.value) needsRerender = true;
      break;
    }
    case 'template':
      settings.rename.template = el.value;
      updateCustomPreview(zoneId);
      return;
    case 'event':
      settings.extra.event = el.value;
      return;
    case 'seqStart':
      settings.rename.seqStart = Math.max(0, parseInt(el.value, 10) || 0);
      break;
    case 'collision':
      settings.rename.collision = el.value;
      break;
    case 'case':
      settings.rename.case = el.value;
      break;

    // ─── Web-ready controls ──────────────────────────────────────────
    case 'maxEdge': {
      if (el.value === 'custom') {
        // Web-ready: show the custom numeric input on next render.
        needsRerender = true;
        settings.extra.maxEdge = settings.extra.maxEdge || 2048;
      } else {
        const n = parseInt(el.value, 10);
        // Bulk Compress allows 0 ("keep original"); Web-ready's options
        // are always >= 1600. Accept any finite non-negative integer.
        if (Number.isFinite(n) && n >= 0) {
          settings.extra.maxEdge = n;
          needsRerender = true;
        }
      }
      break;
    }
    case 'maxEdgeCustom': {
      const n = parseInt(el.value, 10);
      if (Number.isFinite(n) && n >= 100 && n <= 10000) {
        settings.extra.maxEdge = n;
      }
      break;
    }
    case 'format':
      settings.extra.format = el.value;
      needsRerender = true;      // PNG disables the quality slider
      break;
    case 'quality': {
      const pct = Math.max(60, Math.min(95, parseInt(el.value, 10) || 82));
      settings.extra.quality = pct / 100;
      // Live-update the visible % without a full re-render.
      const qv = $(`[data-qv][data-zone="${zoneId}"]`);
      if (qv) qv.textContent = pct + '%';
      break;
    }
    case 'metadataMode':
      settings.metadata.mode = el.value;
      break;
    case 'injectAttr':
      settings.metadata.injectOknAttribution = !!(/** @type {HTMLInputElement} */ (el).checked);
      break;
    case 'srgbConvert':
      settings.extra.srgbConvert = !!(/** @type {HTMLInputElement} */ (el).checked);
      break;

    // ─── Bulk Compress unique controls ─────────────────────────
    case 'targetSize': {
      const mb = Math.max(5, Math.min(2000, parseInt(el.value, 10) || 50));
      settings.extra.targetSizeMB = mb;
      const tv = $(`[data-tv][data-zone="${zoneId}"]`);
      if (tv) tv.textContent = mb + ' MB';
      break;
    }
    case 'minQuality': {
      const pct = Math.max(30, Math.min(90, parseInt(el.value, 10) || 60));
      settings.extra.minQuality = pct / 100;
      const mqv = $(`[data-mqv][data-zone="${zoneId}"]`);
      if (mqv) mqv.textContent = pct + '%';
      break;
    }

    // Metadata Studio unique controls
    case 'blankOnly':
      settings.metadata.forceOverwriteBlankOnly = !!(/** @type {HTMLInputElement} */ (el).checked);
      break;
    case 'normaliseOrientation':
      settings.extra.normaliseOrientation = !!(/** @type {HTMLInputElement} */ (el).checked);
      break;

    // ─── Social unique controls ──────────────────────────────────
    case 'platform':
      settings.extra.platform = el.value;
      needsRerender = true;   // toggle custom size / background visibility
      break;
    case 'customW': {
      const n = parseInt(el.value, 10);
      if (Number.isFinite(n) && n >= 16 && n <= 8192) settings.extra.customW = n;
      break;
    }
    case 'customH': {
      const n = parseInt(el.value, 10);
      if (Number.isFinite(n) && n >= 16 && n <= 8192) settings.extra.customH = n;
      break;
    }
    case 'socialFit':
      settings.extra.fit = el.value;
      needsRerender = true;   // toggle background picker
      break;
    case 'socialBackground':
      settings.extra.background = el.value;
      break;

    // ─── Colour-space unique controls ────────────────────────────
    case 'targetProfile':
      if (isServerOnlyColourTarget(el.value)) {
        openToast(t('zone.colour-space.serverOptionsLocked'));
        renderZones();
        return;
      }
      settings.extra.targetProfile = el.value;
      break;
    case 'tagOutputSlug':
      settings.extra.tagOutputWithProfileSlug = !!(/** @type {HTMLInputElement} */ (el).checked);
      break;

    // ─── Archive unique controls ─────────────────────────────────
    case 'archiveLocation':
      settings.extra.location = el.value;
      return;   // no re-render; freeform text input
    case 'includeSidecars':
      settings.extra.includeSidecars = !!(/** @type {HTMLInputElement} */ (el).checked);
      break;
    case 'includeManifest':
      settings.extra.includeManifest = !!(/** @type {HTMLInputElement} */ (el).checked);
      break;
    case 'includeReadme':
      settings.extra.includeReadme = !!(/** @type {HTMLInputElement} */ (el).checked);
      break;

    // ─── RAW develop unique controls ─────────────────────────────
    case 'rawOutputFormat':
      settings.extra.outputFormat = el.value;
      needsRerender = true;   // TIFF disables quality slider
      break;
    case 'whiteBalance':
      settings.extra.whiteBalance = el.value;
      break;
    case 'exposure': {
      const n = parseFloat(el.value);
      if (Number.isFinite(n)) {
        settings.extra.exposure = Math.max(-3, Math.min(3, n));
        const ev = $(`[data-ev][data-zone="${zoneId}"]`);
        if (ev) ev.textContent = settings.extra.exposure.toFixed(1);
      }
      break;
    }

    default:
      return;  // unknown control; nothing to do
  }

  rememberZoneDefaults(zoneId).catch(() => undefined);
  if (needsRerender) renderZones();
}

async function rememberZoneDefaults(zoneId) {
  state.user = {
    ...state.user,
    zoneDefaults: { ...state.user.zoneDefaults, [zoneId]: state.zoneSettings[zoneId] }
  };
  await saveSettings(state.user);
}

function updateCustomPreview(zoneId) {
  const preview = $(`[data-preview][data-zone="${zoneId}"]`);
  if (!preview) return;
  const settings = state.zoneSettings[zoneId];
  const sample = state.activeJob?.rows?.slice(0, 3).map((r) => ({
    originalName: r.name,
    exif: r.inputExif,
    fileMtime: r.file?.lastModified
  })) ?? [{ originalName: 'IMG_0001.jpg' }, { originalName: 'IMG_0002.jpg' }, { originalName: 'IMG_0003.jpg' }];

  const names = previewFirst(
    sample,
    settings.rename,
    settings.extra?.event,
    state.user?.creator?.slug || state.user?.creator?.name
  );
  preview.innerHTML = `<span class="dr-field-preview-label">${esc(t('rename.custom.preview'))}</span> ${names.map((n) => `<code>${esc(n)}</code>`).join(' · ')}`;
}

// ─── Intake → dry-run → processing flow ─────────────────────────────────

async function handleFilesDropped(zoneId, files, options = {}) {
  const zone = ZONES.find((z) => z.id === zoneId);
  if (!zone || !WIRED_ZONES.has(zoneId)) return;

  const { accepted, rejected } = await intake(files, zone);

  if (rejected.length > 0) {
    openToast(t('dropzone.rejected', { count: rejected.length }));
  }

  // Retry path: bypass the per-zone queue and go straight back into
  // the dry-run with this exact set of files. Retries have already
  // been queued + processed once; a second queue step is friction.
  if (options.forceDryRun) {
    if (accepted.length === 0) return;
    const settings = state.zoneSettings[zoneId];
    state.activeJob = { zoneId, rows: accepted, rejected, settings, dispatcher: null };
    openDryRun();
    return;
  }

  if (accepted.length === 0) return;

  // Default path: enqueue into the zone's pending list. The user
  // clicks the zone's Process button to launch the dry-run; drops
  // alone never open a modal.
  enqueueZoneFiles(zoneId, accepted, rejected);
}

/**
 * Launch the dry-run (or skip straight to processing if the user
 * opted out of dry-runs for this zone) using whatever files are
 * currently queued for the given zone.
 */
async function startZoneJob(zoneId) {
  const zone = ZONES.find((z) => z.id === zoneId);
  if (!zone || !WIRED_ZONES.has(zoneId)) return;

  const q = state.zoneQueues[zoneId];
  if (!q || q.rows.length === 0) return;

  const settings = state.zoneSettings[zoneId];
  state.activeJob = {
    zoneId,
    rows: q.rows.slice(),
    rejected: q.rejected.slice(),
    settings,
    dispatcher: null
  };

  // Shared prep: predict output names + compute server routing so both
  // paths (dry-run AND skip-dry-run) hand the dispatcher a fully-
  // populated activeJob. Previously only openDryRun ran these steps,
  // which meant skip-dry-run landed in startProcessing with no
  // outputName on any row → the row.filter(r => !!r.outputName) step
  // dropped every file and the user got an empty ZIP.
  prepareJob(zoneId);

  const skipDryRun = !!state.user?.dryRunSkip?.[zoneId];
  if (skipDryRun) {
    await startProcessing();
  } else {
    openDryRun();
  }
}

/**
 * Predict output names and compute server routing for the current
 * activeJob. Safe to call from either startZoneJob (skip-dry-run) or
 * openDryRun — idempotent if called twice on the same rows.
 */
function prepareJob(zoneId) {
  if (!state.activeJob) return;
  const { rows, settings } = state.activeJob;
  // Reset per-row dry-run state. Without this, a Back → re-open cycle
  // keeps stale warnings (e.g. 'name-collision (skip)') around, and a
  // previously-unset outputName can stay undefined even if the new
  // settings would have resolved it.
  for (const row of rows) {
    row.warnings = [];
    row.outputName = undefined;
  }

  const predicted = computeBatch({
    items: rows.map((r) => ({
      originalName: r.name,
      exif: r.inputExif,
      fileMtime: r.file?.lastModified
    })),
    settings: settings.rename,
    event: settings.extra?.event,
    photographer: state.user?.creator?.slug || state.user?.creator?.name
  });

  rows.forEach((row, i) => {
    const r = predicted[i];
    if (r.status === 'ok') {
      const ext = r.outputName.includes('.') ? '.' + r.outputName.split('.').pop() : '';
      const stem = ext ? r.outputName.slice(0, -ext.length) : r.outputName;
      row.outputName = postProcessName(zoneId, stem, ext, settings);
    } else if (r.status === 'skipped') {
      row.warnings.push('name-collision (skip)');
      row.outputName = undefined;
    } else {
      row.warnings.push(r.message);
      row.outputName = undefined;
    }
  });

  const routing = routeJob(
    rows.map((r) => ({ id: r.id, size: r.size })),
    zoneId,
    state.user?.thresholdOverrides
  );
  state.activeJob.routing = routing;
}

/**
 * Zone-specific name post-processing. The generic rename engine doesn't
 * know about social platform slugs or colour-space profile tags, so the
 * dry-run preview has to mirror whatever the zone's processor appends
 * — otherwise the user sees one name in the table and a different one
 * in the ZIP.
 */
function postProcessName(zoneId, stem, ext, settings) {
  if (zoneId === 'social') {
    const platform = String(settings.extra?.platform ?? '').trim();
    if (platform) {
      const slug = platform.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (slug) return `${stem}_${slug}${ext}`;
    }
  }
  if (zoneId === 'colour-space' && settings.extra?.tagInName) {
    const profile = String(settings.extra?.targetProfile ?? '').trim();
    if (profile) {
      const slug = profile.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (slug) return `${stem}_${slug}${ext}`;
    }
  }
  return `${stem}${ext}`;
}

function openDryRun() {
  const panel = $('#dr-dryrun');
  if (!panel || !state.activeJob) return;

  const { rows, rejected, zoneId, settings } = state.activeJob;
  const zone = ZONES.find((z) => z.id === zoneId);
  const totalBytes = rows.reduce((a, r) => a + r.size, 0);

  // Populate predicted output names + routing. prepareJob resets per-
  // row dry-run state (warnings, outputName) before running so repeat
  // openDryRun calls don't accumulate stale warnings.
  prepareJob(zoneId);

  $('#dr-dryrun-title').textContent = t('dryrun.title');
  $('#dr-dryrun-zone').textContent  = zone ? t(zone.title) : zoneId;
  $('#dr-dryrun-summary').textContent = t('dryrun.summary', {
    count: rows.length,
    size: formatBytes(totalBytes)
  });

  // Estimated output size — crude per-zone heuristic. We don't claim
  // accuracy; it's directional so the user can sanity-check before hitting
  // Process. Zones that passthrough bytes (e.g. Archive, Batch-rename) are
  // reported as roughly the input total.
  const estBytes = estimateOutputBytes(zoneId, settings, rows);
  if (estBytes != null) {
    const prev = $('#dr-dryrun-summary');
    if (prev) {
      // Attach on a trailing sibling span so the main summary stays tidy.
      prev.textContent = t('dryrun.summary', {
        count: rows.length,
        size: formatBytes(totalBytes)
      }) + ' · ' + t('dryrun.estimate', { size: formatBytes(estBytes) });
    }
  }

  const warnings = [];
  if (rejected.length > 0) warnings.push(t('dryrun.warnings.unsupported', { n: rejected.length }));

  // Routing already computed by prepareJob(); re-read it here.
  const routing = state.activeJob.routing;
  const summary = summariseRouting(routing);

  // Any server-routed file blocks the batch while the processing server
  // is offline. Mixed browser/server batches are no longer allowed to run
  // partially; the user asked to block all server-side processing and show
  // a clear message instead.
  const blockedByServerRouting = summary.server > 0;

  if (summary.server > 0) {
    const ex = routing.explain;
    const reasonKey = ex.reason ? `routing.explain.${ex.reason}` : '';
    const n =
      ex.reason === 'per-file-oversize'    ? ex.fileSizeMB :
      ex.reason === 'batch-size'           ? ex.batchSizeMB :
      ex.reason === 'batch-count'          ? ex.batchCount :
      ex.reason === 'batch-size-and-count' ? ex.batchSizeMB : 0;
    warnings.push(t('routing.server', { n: summary.server }));
    if (reasonKey) warnings.push(t(reasonKey, { n }));
    warnings.push(t('routing.serverNotLive'));
  }

  const blockTip = blockedByServerRouting ? t('routing.blockedAnyServer') : '';

  $('#dr-dryrun-warnings').innerHTML = [
    ...(blockTip ? [`<div class="dr-warning dr-warning-block" role="alert">${esc(blockTip)}</div>`] : []),
    ...warnings.map((w) => `<div class="dr-warning">${esc(w)}</div>`)
  ].join('');

  const processBtn = /** @type {HTMLButtonElement | null} */ ($('#dr-dryrun-process'));
  if (processBtn) {
    processBtn.disabled = blockedByServerRouting;
    processBtn.setAttribute('aria-disabled', blockedByServerRouting ? 'true' : 'false');
    if (blockedByServerRouting) processBtn.title = t('routing.blockedAnyServer');
    else processBtn.removeAttribute('title');
  }

  const tbody = $('#dr-dryrun-tbody');
  const impl = ZONE_IMPL[zoneId];
  const wantsInspector = !!impl?.dryRunInspector;

  tbody.innerHTML = rows.map((r, idx) => {
    const routedToServer = routing.perFile.get(r.id) === 'server-large-batch-soon';
    const outputCell = routedToServer
      ? '<span class="dr-muted">(server, coming soon)</span>'
      : (r.outputName ? `<code>${esc(r.outputName)}</code>` : '<span class="dr-muted">—</span>');
    const statusPill = routedToServer
      ? `<span class="dr-pill dr-pill-sm dr-pill-warn">Coming soon</span>`
      : `<span class="dr-pill dr-pill-sm">${r.outputName ? esc(t('status.pending')) : esc(t('status.warning'))}</span>`;

    const mainRow = `
    <tr${routedToServer ? ' class="dr-row-server"' : ''}${wantsInspector ? ` data-inspect-row="${idx}"` : ''}>
      <td class="dr-col-original"><code>${esc(r.name)}</code></td>
      <td class="dr-col-arrow">→</td>
      <td class="dr-col-output">${outputCell}</td>
      <td class="dr-col-size">${esc(formatBytes(r.size))}</td>
      <td class="dr-col-status">${statusPill}</td>
    </tr>`;

    // Per-zone inspector row — Metadata Studio opts in via dryRunInspector.
    if (!wantsInspector || routedToServer) return mainRow;

    const summary = summariseExif(r.inputExif);
    if (!summary || summary.length === 0) {
      return mainRow + `
    <tr class="dr-inspect-row" data-for="${idx}">
      <td colspan="5" class="dr-inspect-body">
        <span class="dr-muted">${esc(t('zone.metadata-studio.inspector.none'))}</span>
      </td>
    </tr>`;
    }

    const cells = summary.map((s) => `
      <span class="dr-inspect-cell${s.sensitive ? ' is-sensitive' : ''}">
        <span class="dr-inspect-key">${esc(s.label)}</span>
        <span class="dr-inspect-val">${esc(s.value)}</span>
      </span>
    `).join('');
    return mainRow + `
    <tr class="dr-inspect-row" data-for="${idx}">
      <td colspan="5" class="dr-inspect-body">${cells}</td>
    </tr>`;
  }).join('');

  const skip = $('#dr-dryrun-skipfuture');
  if (skip) /** @type {HTMLInputElement} */ (skip).checked = !!state.user.dryRunSkip?.[zoneId];

  openModal('dr-dryrun', /** @type {HTMLElement | null} */ ($('#dr-dryrun-process')) || undefined);
}

/**
 * Close the dry-run panel's DOM without tearing down activeJob.
 * Processing / result panels need activeJob to stay alive after the
 * dry-run dismounts; closeResult() is the sole owner of the teardown.
 */
function closeDryRun() {
  closeModal('dr-dryrun');
}

/**
 * Back button on the dry-run — the user is abandoning the job, so we
 * drop activeJob too. Queued rows stay in state.zoneQueues so the user
 * can re-trigger Process without re-dropping.
 */
function closeDryRunAndReset() {
  closeModal('dr-dryrun');
  state.activeJob = null;
}

async function startProcessing() {
  if (!state.activeJob) return;

  // Hard-guard: if any row is server-routed (and the server isn't live),
  // Process is not acceptable. The dry-run already disables the button and
  // shows a tip; this catches keyboard / programmatic triggers too.
  const routingSummary = state.activeJob.routing
    ? summariseRouting(state.activeJob.routing)
    : null;
  if (routingSummary && routingSummary.server > 0) {
    openToast(t('routing.blockedAnyServer'));
    return;
  }

  const skip = /** @type {HTMLInputElement | null} */ ($('#dr-dryrun-skipfuture'));
  if (skip) {
    state.user = await setDryRunSkip(state.activeJob.zoneId, skip.checked);
  }

  const { zoneId, rows, settings } = state.activeJob;
  const impl = ZONE_IMPL[zoneId];
  if (!impl) { closeDryRun(); return; }

  // Committing to processing — clear the pending-files list so a fresh
  // drop after this point starts a new batch rather than piling onto
  // the one that's already running.
  clearZoneQueue(zoneId);

  const processor = await impl.makeProcessor(settings);
  const processedRows = rows.filter((r) => !!r.outputName);

  // Stamp the job's total file count onto every row so zones with
  // batch-aware heuristics (e.g. bulk-compress Solve) can scale their
  // sampling without needing the dispatcher to grow a jobBlueprint API.
  for (const r of processedRows) {
    /** @type {any} */ (r).__jobFileCount = processedRows.length;
  }

  // Archive (and future zones with batch-level outputs) return
  // { process, finalize } instead of a bare ProcessFn. Detect the shape
  // and route the finalize hook through the dispatcher.
  const isBundle = processor && typeof processor === 'object'
    && typeof processor.process === 'function';
  const processFile = isBundle ? processor.process : processor;
  const onFinalize = isBundle && typeof processor.finalize === 'function'
    ? async (zipper, _job) => { await processor.finalize(zipper); }
    : undefined;

  const dispatcher = createDispatcher({
    zoneId,
    settings,
    rows: processedRows,
    processFile,
    onFinalize,
    onUpdate: onJobUpdate,
    // Persistence hook: dispatcher is tool-agnostic now, so we inject
    // history writes here. Errors are swallowed by the dispatcher.
    onFinish: async (finishedJob) => { await recordJob(finishedJob); },
    routing: state.activeJob.routing
  });

  state.activeJob.dispatcher = dispatcher;

  closeDryRun();
  openProcessing(dispatcher.job);

  await dispatcher.start();

  openResult(dispatcher.job);
  state.history = await listHistory();
  renderHistory();
}

function cancelProcessing() {
  state.activeJob?.dispatcher?.cancel();
}

/** @type {number} */
let lastJobUpdateRender = 0;
/** @type {number | null} */
let pendingJobUpdate = null;

function onJobUpdate(job) {
  const panel = $('#dr-processing');
  if (!panel || !panel.classList.contains('is-open')) return;

  // Throttle renders to ~16fps during bursty progress events. Always
  // render the final state (when every file is terminal) immediately.
  const allTerminal = job.files.every((f) =>
    f.status === 'done' || f.status === 'error' || f.status === 'filtered' || f.status === 'cancelled'
  );
  const now = Date.now();
  if (!allTerminal && now - lastJobUpdateRender < 60) {
    if (pendingJobUpdate != null) cancelAnimationFrame(pendingJobUpdate);
    pendingJobUpdate = requestAnimationFrame(() => {
      pendingJobUpdate = null;
      lastJobUpdateRender = Date.now();
      renderJobUpdate(job);
    });
    return;
  }
  // Final / allTerminal render: cancel any RAF scheduled during the
  // throttle window so it can't fire after us and paint stale progress.
  if (pendingJobUpdate != null) {
    cancelAnimationFrame(pendingJobUpdate);
    pendingJobUpdate = null;
  }
  lastJobUpdateRender = now;
  renderJobUpdate(job);
}

function renderJobUpdate(job) {
  const panel = $('#dr-processing');
  if (!panel || !panel.classList.contains('is-open')) return;

  const done = job.files.filter((f) => f.status === 'done').length;
  const failed = job.files.filter(
    (f) => f.status === 'error' || f.status === 'filtered' || f.status === 'cancelled'
  ).length;
  const total = job.files.length;

  $('#dr-processing-banner').textContent = t('processing.banner', { done, total });
  const bar = /** @type {HTMLElement | null} */ ($('#dr-processing-bar-fill'));
  if (bar) bar.style.width = `${Math.round(((done + failed) / total) * 100)}%`;

  const list = $('#dr-processing-list');
  if (list) {
    list.innerHTML = job.files.map((f) => `
      <div class="dr-processing-row dr-status-${f.status}">
        <span class="dr-processing-name"><code>${esc(f.name)}</code></span>
        <span class="dr-processing-arrow">→</span>
        <span class="dr-processing-output">${f.outputName ? `<code>${esc(f.outputName)}</code>` : '<span class="dr-muted">…</span>'}</span>
        <span class="dr-pill dr-pill-sm dr-pill-${statusTone(f.status)}">${esc(t('status.' + f.status))}</span>
      </div>
    `).join('');
  }
}

function statusTone(status) {
  if (status === 'done') return 'ok';
  if (status === 'error' || status === 'cancelled') return 'err';
  if (status === 'filtered' || status === 'warning') return 'warn';
  return 'info';
}

function openProcessing(job) {
  openModal('dr-processing');
  onJobUpdate(job);
}

function closeProcessing() {
  closeModal('dr-processing');
}

// ─── Result panel ───────────────────────────────────────────────────────

function openResult(job) {
  closeProcessing();
  const panel = $('#dr-result');
  if (!panel) return;

  // Remember the last finished job so "Retry failed" / "Copy diagnostics"
  // can reach into it from the result panel's button handlers.
  state.lastFinishedJob = job;

  const okRows   = job.files.filter((f) => f.status === 'done');
  const failed   = job.files.filter((f) => f.status !== 'done');
  const totalOut = okRows.reduce((a, r) => a + (r.outputSize ?? 0), 0);

  $('#dr-result-banner').textContent = t('result.banner', {
    count: okRows.length,
    size: formatBytes(totalOut),
    duration: formatDuration(job.durationMs ?? 0)
  });

  // Show the Retry button only when at least one non-server failure has
  // its original File still attached (dispatcher clears `.file` on done
  // but not on error, and server-routed rows were never processed).
  const retryBtn = /** @type {HTMLButtonElement | null} */ ($('#dr-result-retry'));
  if (retryBtn) {
    const retryable = findRetryableRows(job);
    retryBtn.hidden = retryable.length === 0;
    retryBtn.textContent = t('result.retryFailed');
  }

  const needs = $('#dr-needs-attention');
  // "With warnings" — rows that finished (status === 'done') but carry
  // at least one non-fatal warning (metadata write failed, solver extrapolated,
  // attribution couldn't be injected, etc.). These are easy to miss otherwise
  // because they count as successes in the banner.
  const warned = okRows.filter((r) => Array.isArray(r.warnings) && r.warnings.length > 0);
  const withWarningsHtml = warned.length === 0 ? '' : `
      <h3 class="dr-needs-title">${esc(t('withWarnings.title'))}</h3>
      <ul class="dr-needs-list">
        ${warned.map((f) => {
          const items = (f.warnings ?? []).map((w) => {
            const key = 'withWarnings.' + w;
            return hasMessage(key) ? t(key) : w;
          });
          return `
            <li class="dr-needs-item">
              <code>${esc(f.name)}</code>
              <span class="dr-needs-detail">${esc(items.join(' · '))}</span>
            </li>
          `;
        }).join('')}
      </ul>
    `;
  if (failed.length === 0) {
    needs.innerHTML = (warned.length === 0)
      ? `<p class="dr-muted">${esc(t('needsAttention.empty'))}</p>`
      : withWarningsHtml;
  } else {
    needs.innerHTML = `
      <h3 class="dr-needs-title">${esc(t('needsAttention.title'))}</h3>
      <ul class="dr-needs-list">
        ${failed.map((f) => {
          const cls = f.error?.class ?? 'unknown';
          const classKey = 'needsAttention.classes.' + cls;
          const label = hasMessage(classKey)
            ? t(classKey)
            : t('needsAttention.classes.unknown');
          return `
            <li class="dr-needs-item">
              <code>${esc(f.name)}</code>
              <span class="dr-muted">${esc(label)}</span>
              ${f.error?.message ? `<span class="dr-needs-detail">${esc(f.error.message)}</span>` : ''}
            </li>
          `;
        }).join('')}
      </ul>
      ${withWarningsHtml}
    `;
  }

  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
  panel.setAttribute('aria-modal', 'true');
  if (!panel.hasAttribute('role')) panel.setAttribute('role', 'dialog');
  const handler = trapTabWithin(panel);
  modalState.set('dr-result', { prev: /** @type {HTMLElement | null} */ (document.activeElement), handler });

  // Move focus inside the dialog — prefer the primary Close button so
  // keyboard users can dismiss immediately. Fall back to Retry if Close
  // is missing (shouldn't happen) or the panel itself.
  const focusTarget = /** @type {HTMLElement | null} */ (
    $('#dr-result-close')
    ?? (retryBtn && !retryBtn.hidden ? retryBtn : null)
    ?? panel
  );
  focusTarget?.focus?.();
}

function closeResult() {
  closeModal('dr-result');
  state.activeJob = null;
}

// ─── Retry failed + diagnostics ─────────────────────────────────────────

/**
 * Return the File objects for rows that failed in the given job and
 * still have their original bytes attached in `state.activeJob.rows`.
 * Skips server-routed "coming soon" rows — those never reached the
 * worker, so "retry" on them would just re-surface the same routing.
 * @param {import('@okn/job/dispatcher.js').Job} job
 * @returns {Array<{ id: string, file: File, name: string }>}
 */
function findRetryableRows(job) {
  const failedIds = new Set(
    job.files
      .filter((f) =>
        f.status !== 'done' &&
        f.error?.class !== 'server-large-batch-soon' &&
        f.error?.class !== 'server-required'
      )
      .map((f) => f.id)
  );
  const out = [];
  const rows = state.activeJob?.rows ?? [];
  for (const r of rows) {
    if (!failedIds.has(r.id)) continue;
    if (!r.file) continue;
    out.push({ id: r.id, file: r.file, name: r.name });
  }
  return out;
}

async function retryFailedJob() {
  const job = state.lastFinishedJob;
  if (!job) return;
  const retryable = findRetryableRows(job);
  if (retryable.length === 0) {
    openToast(t('result.retryNone'));
    return;
  }
  const zoneId = job.zone;
  const files = retryable.map((r) => r.file);
  closeResult();
  // Force dry-run on retry so the user can re-review config before reprocessing.
  await handleFilesDropped(zoneId, files, { forceDryRun: true });
}

/**
 * Build a sanitised diagnostics bundle and copy it to the clipboard.
 * Excludes user identity and anything from attribution so users can
 * paste it into bug reports without leaking secrets.
 */
async function copyDiagnostics() {
  const job = state.lastFinishedJob;
  const activeSettings = job ? sanitiseSettingsForDiag(job.settings) : null;
  const routing = state.activeJob?.routing
    ? {
        perFile: Array.from(state.activeJob.routing.perFile.entries()),
        explain: state.activeJob.routing.explain
      }
    : null;

  const diag = {
    tool: 'okn-darkroom',
    generatedAt: new Date().toISOString(),
    locale: (typeof getLocale === 'function') ? getLocale() : undefined,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    job: job ? {
      id: job.id,
      zone: job.zone,
      state: job.state,
      durationMs: job.durationMs,
      routing: job.routing,
      settings: activeSettings,
      files: job.files.map((f) => ({
        id: f.id,
        // Hash filenames — filenames can contain PII ("IMG_alice-venue.heic").
        // Keep extension for debugging (format-specific bugs) + size + status.
        nameHash: hashShort(f.name),
        ext: extOf(f.name),
        size: f.size,
        status: f.status,
        outputExt: f.outputName ? extOf(f.outputName) : undefined,
        outputSize: f.outputSize,
        error: f.error ? {
          class: f.error.class,
          // Strip absolute paths from messages (browser decode errors can
          // include blob: URLs; native File API won't surface fs paths, but
          // zone processors might).
          message: redactErrorMessage(f.error.message),
          retryable: f.error.retryable
        } : undefined
      }))
    } : null,
    routingSnapshot: routing
  };

  const text = JSON.stringify(diag, null, 2);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      openToast(t('result.copied'));
    } else {
      throw new Error('no clipboard API');
    }
  } catch (err) {
    // Fallback: dump to console. Most bug reports happen in dev-tools open.
    console.log('[darkroom diagnostics]\n' + text);
    openToast(t('result.copyFailed'));
  }
}

/**
 * Short non-cryptographic hash for filenames in diagnostics. Just enough
 * bits to correlate rows in a single report without reversing to the
 * original name.
 * @param {string} s
 */
function hashShort(s) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 'f_' + h.toString(16).padStart(8, '0');
}

/** @param {string} name */
function extOf(name) {
  const m = /\.[a-z0-9]{1,8}$/i.exec(name);
  return m ? m[0].toLowerCase() : '';
}

/**
 * Strip absolute paths, blob:/file: URLs, and long home-directory tails
 * from error messages so diagnostics don\u2019t leak filesystem context.
 * @param {string | undefined} msg
 */
function redactErrorMessage(msg) {
  if (!msg) return msg;
  return String(msg)
    .replace(/blob:[^\s)"']+/gi, 'blob:[redacted]')
    .replace(/file:\/\/[^\s)"']+/gi, 'file://[redacted]')
    .replace(/\/Users\/[^\s/)"']+(?:\/[^\s)"']+)*/g, '/Users/[redacted]')
    .replace(/\/home\/[^\s/)"']+(?:\/[^\s)"']+)*/g, '/home/[redacted]')
    .replace(/[A-Z]:\\\\[^\s)"']+/g, '[redacted-path]');
}

/**
 * Drop potentially-identifying bits from a settings bundle before
 * sharing diagnostics. We keep shape + zone-relevant knobs but scrub
 * freeform fields that could carry personal context.
 */
function sanitiseSettingsForDiag(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  /** @type {any} */
  const clone = JSON.parse(JSON.stringify(settings));
  if (clone.extra) {
    if (typeof clone.extra.event === 'string')    clone.extra.event = '<redacted>';
    if (typeof clone.extra.location === 'string') clone.extra.location = '<redacted>';
  }
  if (clone.metadata) {
    // Keep policy/mode flags; drop template strings that mention the user.
    delete clone.metadata.attribution;
  }
  return clone;
}

// ─── History replay & remove ────────────────────────────────────────────

function replayHistoryEntry(id, startedAt) {
  const entry = state.history.find((e) => e.id === id && e.startedAt === startedAt);
  if (!entry) return;
  state.zoneSettings[entry.zone] = normaliseZoneSettingsForClient(
    entry.zone,
    mergeSettings(
      ZONE_IMPL[entry.zone]?.defaults ? ZONE_IMPL[entry.zone].defaults() : {},
      entry.settings
    )
  );
  const zone = ZONES.find((z) => z.id === entry.zone);
  if (zone) {
    state.activeTab = zone.tab;
    renderTabs();
    renderZones();
    openToast(t('history.replay.loaded', { zone: t(zone.title) }));
  }
}

async function removeHistoryEntryAndReload(id, startedAt) {
  await removeHistoryEntry(id, startedAt);
  state.history = await listHistory();
  renderHistory();
}

// ─── Settings drawer ────────────────────────────────────────────────────

/** Generic modal focus-state: each open modal stores the previously
 *  focused element and its Tab-trap handler so closeModal() can restore
 *  focus + remove the listener. */
/** @type {Map<string, { prev: HTMLElement | null, handler: ((e: KeyboardEvent) => void) | null }>} */
const modalState = new Map();

function getFocusableIn(root) {
  if (!root) return [];
  const sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll(sel))
    .filter((el) => !el.hasAttribute('aria-hidden') && el.offsetParent !== null);
}

function trapTabWithin(root) {
  /** @param {KeyboardEvent} e */
  const handler = (e) => {
    if (e.key !== 'Tab') return;
    const focusable = getFocusableIn(root);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      /** @type {HTMLElement} */ (last).focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      /** @type {HTMLElement} */ (first).focus();
    }
  };
  document.addEventListener('keydown', handler);
  return handler;
}

/**
 * Open a generic modal: saves previous focus, installs Tab trap, sets
 * ARIA state. Pair with `closeModal(id)`.
 * @param {string} id                element id (without the `#`)
 * @param {HTMLElement=} focusTarget element to focus after opening
 */
function openModal(id, focusTarget) {
  const panel = document.getElementById(id);
  if (!panel) return;
  const prev = /** @type {HTMLElement | null} */ (document.activeElement);
  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
  if (!panel.hasAttribute('role')) panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  const handler = trapTabWithin(panel);
  modalState.set(id, { prev, handler });
  focusTarget?.focus?.();
}

/** @param {string} id */
function closeModal(id) {
  const panel = document.getElementById(id);
  if (!panel) return;
  panel.classList.remove('is-open');
  panel.setAttribute('aria-hidden', 'true');
  const st = modalState.get(id);
  if (st?.handler) document.removeEventListener('keydown', st.handler);
  st?.prev?.focus?.();
  modalState.delete(id);
}

function openSettings() {
  const panel = $('#dr-settings');
  if (!panel) return;

  /** @type {HTMLInputElement} */ ($('#set-creator-name')).value  = state.user.creator.name;
  /** @type {HTMLInputElement} */ ($('#set-creator-email')).value = state.user.creator.email;
  /** @type {HTMLInputElement} */ ($('#set-creator-slug')).value  = state.user.creator.slug;
  /** @type {HTMLInputElement} */ ($('#set-attr-copy')).value     = state.user.attribution.copyrightTemplate;
  /** @type {HTMLInputElement} */ ($('#set-attr-rights')).value   = state.user.attribution.rights;
  /** @type {HTMLInputElement} */ ($('#set-attr-credit')).value   = state.user.attribution.credit;
  /** @type {HTMLInputElement} */ ($('#set-attr-source')).value   = state.user.attribution.source ?? '';

  const langSel = /** @type {HTMLSelectElement | null} */ ($('#set-language'));
  if (langSel) langSel.value = getLocale();

  // Route through the shared modalState registry so focus restoration
  // and Tab-trap teardown use the same code path as every other panel.
  openModal('dr-settings', /** @type {HTMLElement | null} */ ($('#set-creator-name')) || undefined);
}

function closeSettings() {
  closeModal('dr-settings');
}

async function onSettingsSave() {
  state.user = await updateCreator({
    name:  /** @type {HTMLInputElement} */ ($('#set-creator-name')).value.trim(),
    email: /** @type {HTMLInputElement} */ ($('#set-creator-email')).value.trim(),
    slug:  /** @type {HTMLInputElement} */ ($('#set-creator-slug')).value.trim()
  });
  state.user = await updateAttribution({
    copyrightTemplate: /** @type {HTMLInputElement} */ ($('#set-attr-copy')).value,
    rights:            /** @type {HTMLInputElement} */ ($('#set-attr-rights')).value,
    credit:            /** @type {HTMLInputElement} */ ($('#set-attr-credit')).value,
    source:            /** @type {HTMLInputElement} */ ($('#set-attr-source')).value.trim() || undefined
  });
  openToast(t('settings.saved'));
  closeSettings();
}

async function onSettingsExport() {
  const blob = exportSettings(state.user);
  const url = URL.createObjectURL(blob);
  /** @type {HTMLAnchorElement | null} */
  let a = null;
  try {
    a = document.createElement('a');
    a.href = url;
    a.download = `darkroom-settings-${Date.now()}.json`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    await new Promise((res) => setTimeout(res, 0));
  } finally {
    if (a) a.remove();
    URL.revokeObjectURL(url);
  }
}

async function onSettingsImport(e) {
  const target = /** @type {HTMLInputElement | null} */ (asEl(e.target));
  const file = target?.files?.[0];
  if (!file) return;
  try {
    state.user = await importSettings(file);
    openToast(t('settings.imported'));
    closeSettings();
  } catch (err) {
    openToast(t('settings.import.failed', { reason: (/** @type {Error} */ (err)?.message ?? 'invalid file') }));
  } finally {
    if (target) target.value = '';
  }
}

async function onPanicReset() {
  const input = /** @type {HTMLInputElement | null} */ ($('#set-panic-input'));
  const msg = $('#set-panic-msg');
  if (!input || input.value !== 'RESET') {
    if (msg) msg.textContent = t('settings.panic.typeToConfirm') + '.';
    return;
  }
  await db.panic();
  state.user = await loadSettings();
  state.history = await listHistory();
  state.zoneSettings = {};
  for (const zone of ZONES) {
    if (!ZONE_IMPL[zone.id]) continue;
    state.zoneSettings[zone.id] = ZONE_IMPL[zone.id].defaults();
  }
  renderAll();
  if (msg) msg.textContent = t('settings.panic.done');
  input.value = '';
}

// ─── Shortcuts overlay ──────────────────────────────────────────────────

function toggleShortcuts() {
  const panel = $('#dr-shortcuts');
  if (!panel) return;
  const open = panel.classList.toggle('is-open');
  panel.setAttribute('aria-hidden', open ? 'false' : 'true');
}

// ─── Toast ──────────────────────────────────────────────────────────────

let toastTimer = null;
function openToast(message) {
  const el = $('#dr-toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('is-open');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-open'), 3200);
}

// ─── Expose settings actions for inline button bindings ─────────────────

window.__DARKROOM__ = {
  onSettingsSave,
  onSettingsExport,
  onSettingsImport,
  onPanicReset,
  closeResult
};

// ─── Go ─────────────────────────────────────────────────────────────────

boot().catch((err) => {
  console.error('Darkroom boot failed:', err);
  openToast('Darkroom failed to start — check console.');
});
