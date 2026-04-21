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

import { t, getLocale, setLocale, getSupportedLocales, onLocaleChange } from './i18n.js';
import { CURRENT_PHASE, ZONES, ZONES_BY_TAB, WIRED_ZONES, isShipped } from './zones/registry.js';
import { intake } from '@okn/job/intake.js';
import { createDispatcher } from '@okn/job/dispatcher.js';
import { routeJob, summariseRouting } from './job/server-router.js';
import {
  loadSettings, saveSettings, updateCreator, updateAttribution,
  setDryRunSkip, exportSettings, importSettings
} from './storage/settings.js';
import { listHistory, clearHistory, removeHistoryEntry, recordJob } from './storage/history.js';
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

// ─── State ──────────────────────────────────────────────────────────────

const state = {
  activeTab: 'publish',    // Web-ready lives here — open publish tab on load
  activeJob: null,
  zoneSettings: {},
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
    state.zoneSettings[zone.id] = mergeSettings(defaults, remembered);
  }

  renderAll();
  bindGlobalEvents();

  // Terminate web workers when the tab is hidden/closed so they don't
  // linger in memory across navigations. `pagehide` fires in more cases
  // than `beforeunload` (BFCache, iOS Safari).
  window.addEventListener('pagehide', () => {
    try { destroyPool(); } catch { /* ignore */ }
  });

  // Re-render whenever the locale changes (sync <html lang> already done by i18n).
  onLocaleChange(() => {
    try { renderAll(); } catch (e) { console.error('re-render on locale change failed:', e); }
  });
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
      ? 'Coming soon — in Phase 2'
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
  return renderFn(zone, title, desc);
}

// ─── Shared renderer helpers ────────────────────────────────────────────
// Builders used by multiple zones. Each writes consistent
// data-zone / data-control attributes so handleZoneControl can route
// change events back into state.

function buildDropzone(zone) {
  return `
    <div class="dr-dropzone"
      data-zone="${zone.id}" data-dropzone
      tabindex="0" role="button"
      aria-label="${esc(t('dropzone.instructions'))}">
      <div class="dr-dropzone-inner">
        <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" class="dr-dropzone-glyph">
          <path d="M24 32 L24 12"/><path d="M16 20 L24 12 L32 20"/><path d="M12 36 L36 36"/>
        </svg>
        <p class="dr-dropzone-prompt">${esc(t('dropzone.instructions'))}</p>
        <p class="dr-dropzone-accepted">${esc(t('dropzone.accepted', { formats: 'JPEG · PNG · HEIC · TIFF · WebP · RAW' }))}</p>
      </div>
      <input type="file" multiple class="dr-file-input" data-zone="${zone.id}"
        accept="image/*,.cr2,.cr3,.nef,.arw,.dng,.raf,.orf,.rw2,.pef" hidden />
    </div>
  `;
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
  return `
    <div class="dr-zone-head">
      <div class="dr-zone-glyph">${zone.glyph}</div>
      <div class="dr-zone-meta">
        <h3 class="dr-zone-title">${esc(title)}</h3>
        <p class="dr-zone-desc">${esc(desc)}</p>
      </div>
      <div class="dr-zone-status is-live"><span class="dr-dot"></span>Live</div>
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
              <option value="srgb"       ${ex.targetProfile === 'srgb'       ? 'selected' : ''}>${esc(t('zone.colour-space.target.srgb'))}</option>
              <option value="display-p3" ${ex.targetProfile === 'display-p3' ? 'selected' : ''}>${esc(t('zone.colour-space.target.display-p3'))}</option>
              <option value="adobe-rgb"  ${ex.targetProfile === 'adobe-rgb'  ? 'selected' : ''}>${esc(t('zone.colour-space.target.adobe-rgb'))}</option>
              <option value="prophoto"   ${ex.targetProfile === 'prophoto'   ? 'selected' : ''}>${esc(t('zone.colour-space.target.prophoto'))}</option>
            </select>
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

    return `
      <article class="dr-zone" data-zone="${zone.id}">
        ${zoneHead(zone, title, desc)}
        ${buildDropzone(zone)}

        <div class="dr-zone-controls">
          <label class="dr-field">
            <span class="dr-field-label">${esc(t('zone.raw-develop.outputFormat'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="rawOutputFormat">
              <option value="image/jpeg" ${ex.outputFormat === 'image/jpeg' ? 'selected' : ''}>JPEG</option>
              <option value="image/tiff" ${ex.outputFormat === 'image/tiff' ? 'selected' : ''}>TIFF (16-bit)</option>
            </select>
          </label>

          <label class="dr-field">
            <span class="dr-field-label">${esc(t('zone.raw-develop.whiteBalance'))}</span>
            <select class="dr-select" data-zone="${zone.id}" data-control="whiteBalance">
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
              data-zone="${zone.id}" data-control="exposure" value="${ex.exposure ?? 0}" />
          </label>

          <label class="dr-field dr-field-wide">
            <span class="dr-field-label">
              ${esc(t('zone.raw-develop.quality'))}
              <span class="dr-field-value" data-zone="${zone.id}" data-qv>${qPct}%</span>
            </span>
            <input type="range" min="60" max="98" step="1" class="dr-range"
              data-zone="${zone.id}" data-control="quality" value="${qPct}"
              ${ex.outputFormat === 'image/tiff' ? 'disabled' : ''} />
          </label>

          <p class="dr-hint dr-field-wide" style="margin-top:4px">
            ${esc(t('zone.raw-develop.unavailable'))}
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
        })).replace(/^·\s*/, '')}</span>
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
    if (el.closest('[data-action="dryrun-back"]'))    closeDryRun();
    if (el.closest('[data-action="dryrun-cancel"]'))  closeDryRun();
    if (el.closest('[data-action="process-cancel"]')) cancelProcessing();
    if (el.closest('[data-action="result-close"]'))   closeResult();

    const replay = /** @type {HTMLElement | null} */ (el.closest('[data-history-replay]'));
    if (replay) replayHistoryEntry(replay.dataset.historyReplay, Number(replay.dataset.historyStarted));
    const remove = /** @type {HTMLElement | null} */ (el.closest('[data-history-remove]'));
    if (remove) removeHistoryEntryAndReload(remove.dataset.historyRemove, Number(remove.dataset.historyStarted));
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (asEl(e.target)?.matches('input, textarea, select')) return;
    if (e.key === '?') { e.preventDefault(); toggleShortcuts(); }
    if (e.key === 'Escape') {
      if ($('#dr-settings')?.classList.contains('is-open')) closeSettings();
      else if ($('#dr-dryrun')?.classList.contains('is-open')) closeDryRun();
      else if ($('#dr-shortcuts')?.classList.contains('is-open')) toggleShortcuts();
    }
    if (e.key === ',') { e.preventDefault(); openSettings(); }
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

async function handleFilesDropped(zoneId, files) {
  const zone = ZONES.find((z) => z.id === zoneId);
  if (!zone || !WIRED_ZONES.has(zoneId)) return;

  const { accepted, rejected } = await intake(files, zone);

  const settings = state.zoneSettings[zoneId];
  const skipDryRun = !!state.user?.dryRunSkip?.[zoneId];

  state.activeJob = { zoneId, rows: accepted, rejected, settings, dispatcher: null };

  if (accepted.length === 0 && rejected.length > 0) {
    openToast(t('dropzone.rejected', { count: rejected.length }));
    return;
  }

  if (skipDryRun) {
    await startProcessing();
  } else {
    openDryRun();
  }
}

function openDryRun() {
  const panel = $('#dr-dryrun');
  if (!panel || !state.activeJob) return;

  const { rows, rejected, zoneId, settings } = state.activeJob;
  const zone = ZONES.find((z) => z.id === zoneId);
  const totalBytes = rows.reduce((a, r) => a + r.size, 0);

  // Compute predicted output names — used as a preview. The actual zone
  // processor does its own rename + collision resolution at process time.
  // For zones that re-encode (e.g. Web-ready), the preview shows the
  // original extension; the real output name will carry the target format.
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
    if (r.status === 'ok')           { row.outputName = r.outputName; }
    else if (r.status === 'skipped') { row.warnings.push('name-collision (skip)'); row.outputName = undefined; }
    else                             { row.warnings.push(r.message); row.outputName = undefined; }
  });

  $('#dr-dryrun-title').textContent = t('dryrun.title');
  $('#dr-dryrun-zone').textContent  = zone ? t(zone.title) : zoneId;
  $('#dr-dryrun-summary').textContent = t('dryrun.summary', {
    count: rows.length,
    size: formatBytes(totalBytes)
  });

  const warnings = [];
  if (rejected.length > 0) warnings.push(t('dryrun.warnings.unsupported', { n: rejected.length }));

  // Server routing
  const routing = routeJob(
    rows.map((r) => ({ id: r.id, size: r.size })),
    zoneId,
    state.user?.thresholdOverrides
  );
  const summary = summariseRouting(routing);
  state.activeJob.routing = routing;

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

  $('#dr-dryrun-warnings').innerHTML = warnings
    .map((w) => `<div class="dr-warning">${esc(w)}</div>`)
    .join('');

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

function closeDryRun() {
  closeModal('dr-dryrun');
  state.activeJob = null;
}

async function startProcessing() {
  if (!state.activeJob) return;

  const skip = /** @type {HTMLInputElement | null} */ ($('#dr-dryrun-skipfuture'));
  if (skip) {
    state.user = await setDryRunSkip(state.activeJob.zoneId, skip.checked);
  }

  const { zoneId, rows, settings } = state.activeJob;
  const impl = ZONE_IMPL[zoneId];
  if (!impl) { closeDryRun(); return; }

  const processor = await impl.makeProcessor(settings);
  const processedRows = rows.filter((r) => !!r.outputName);

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

  const okRows   = job.files.filter((f) => f.status === 'done');
  const failed   = job.files.filter((f) => f.status !== 'done');
  const totalOut = okRows.reduce((a, r) => a + (r.outputSize ?? 0), 0);

  $('#dr-result-banner').textContent = t('result.banner', {
    count: okRows.length,
    size: formatBytes(totalOut),
    duration: formatDuration(job.durationMs ?? 0)
  });

  const needs = $('#dr-needs-attention');
  if (failed.length === 0) {
    needs.innerHTML = `<p class="dr-muted">${esc(t('needsAttention.empty'))}</p>`;
  } else {
    needs.innerHTML = `
      <h3 class="dr-needs-title">${esc(t('needsAttention.title'))}</h3>
      <ul class="dr-needs-list">
        ${failed.map((f) => {
          const cls = f.error?.class ?? 'unknown';
          const label = t('needsAttention.classes.' + cls) ?? t('needsAttention.classes.unknown');
          return `
            <li class="dr-needs-item">
              <code>${esc(f.name)}</code>
              <span class="dr-muted">${esc(label)}</span>
              ${f.error?.message ? `<span class="dr-needs-detail">${esc(f.error.message)}</span>` : ''}
            </li>
          `;
        }).join('')}
      </ul>
    `;
  }

  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
  panel.setAttribute('aria-modal', 'true');
  if (!panel.hasAttribute('role')) panel.setAttribute('role', 'dialog');
  const handler = trapTabWithin(panel);
  modalState.set('dr-result', { prev: /** @type {HTMLElement | null} */ (document.activeElement), handler });
}

function closeResult() {
  closeModal('dr-result');
  state.activeJob = null;
}

// ─── History replay & remove ────────────────────────────────────────────

function replayHistoryEntry(id, startedAt) {
  const entry = state.history.find((e) => e.id === id && e.startedAt === startedAt);
  if (!entry) return;
  state.zoneSettings[entry.zone] = mergeSettings(
    ZONE_IMPL[entry.zone]?.defaults ? ZONE_IMPL[entry.zone].defaults() : {},
    entry.settings
  );
  const zone = ZONES.find((z) => z.id === entry.zone);
  if (zone) {
    state.activeTab = zone.tab;
    renderTabs();
    renderZones();
    openToast(`Loaded settings from “${t(zone.title)}” job.`);
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

/** @type {HTMLElement | null} */
let settingsPreviousFocus = null;
/** @type {((e: KeyboardEvent) => void) | null} */
let settingsTrapHandler = null;

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

  settingsPreviousFocus = /** @type {HTMLElement | null} */ (document.activeElement);

  /** @type {HTMLInputElement} */ ($('#set-creator-name')).value  = state.user.creator.name;
  /** @type {HTMLInputElement} */ ($('#set-creator-email')).value = state.user.creator.email;
  /** @type {HTMLInputElement} */ ($('#set-creator-slug')).value  = state.user.creator.slug;
  /** @type {HTMLInputElement} */ ($('#set-attr-copy')).value     = state.user.attribution.copyrightTemplate;
  /** @type {HTMLInputElement} */ ($('#set-attr-rights')).value   = state.user.attribution.rights;
  /** @type {HTMLInputElement} */ ($('#set-attr-credit')).value   = state.user.attribution.credit;
  /** @type {HTMLInputElement} */ ($('#set-attr-source')).value   = state.user.attribution.source ?? '';

  const langSel = /** @type {HTMLSelectElement | null} */ ($('#set-language'));
  if (langSel) langSel.value = getLocale();

  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
  settingsTrapHandler = trapTabWithin(panel);
  /** @type {HTMLElement | null} */ ($('#set-creator-name'))?.focus();
}

function closeSettings() {
  const panel = $('#dr-settings');
  panel?.classList.remove('is-open');
  panel?.setAttribute('aria-hidden', 'true');
  if (settingsTrapHandler) {
    document.removeEventListener('keydown', settingsTrapHandler);
    settingsTrapHandler = null;
  }
  settingsPreviousFocus?.focus?.();
  settingsPreviousFocus = null;
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
  openToast(t('settings.imported'));
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
