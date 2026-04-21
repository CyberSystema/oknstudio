/**
 * OKN Studio · Darkroom — User settings
 * =====================================
 * Creator identity, attribution template, zone defaults, dry-run skip prefs.
 * Stored under the single key "user" in the settings namespace.
 *
 * No schema library (keeping deps minimal); we validate shape defensively
 * on load and fill gaps from DEFAULT_SETTINGS so corrupt state can't brick
 * the UI.
 *
 * @typedef {Object} CreatorIdentity
 * @property {string} name
 * @property {string} email
 * @property {string} slug
 *
 * @typedef {Object} AttributionTemplate
 * @property {string} copyrightTemplate
 * @property {string} rights
 * @property {string} credit
 * @property {string=} source
 *
 * @typedef {Object} UserSettings
 * @property {CreatorIdentity} creator
 * @property {AttributionTemplate} attribution
 * @property {Record<string, any>} zoneDefaults
 * @property {Record<string, boolean>} dryRunSkip
 */

import { db } from '@okn/storage/db.js';

const KEY = 'user';

/** @type {UserSettings} */
export const DEFAULT_SETTINGS = Object.freeze({
  creator: { name: '', email: '', slug: '' },
  attribution: {
    copyrightTemplate: '© {year} Orthodox Metropolis of Korea',
    rights: 'All rights reserved',
    credit: 'Orthodox Korea Network'
  },
  zoneDefaults: {},
  dryRunSkip: {}
});

/** Defensive merge: always returns a fully-shaped UserSettings object. */
function coerce(raw) {
  const d = DEFAULT_SETTINGS;
  if (!raw || typeof raw !== 'object') return { ...d, creator: { ...d.creator }, attribution: { ...d.attribution }, zoneDefaults: {}, dryRunSkip: {} };
  return {
    creator: {
      name:  typeof raw?.creator?.name  === 'string' ? raw.creator.name  : d.creator.name,
      email: typeof raw?.creator?.email === 'string' ? raw.creator.email : d.creator.email,
      slug:  typeof raw?.creator?.slug  === 'string' ? raw.creator.slug  : d.creator.slug
    },
    attribution: {
      copyrightTemplate: typeof raw?.attribution?.copyrightTemplate === 'string' ? raw.attribution.copyrightTemplate : d.attribution.copyrightTemplate,
      rights:            typeof raw?.attribution?.rights            === 'string' ? raw.attribution.rights            : d.attribution.rights,
      credit:            typeof raw?.attribution?.credit            === 'string' ? raw.attribution.credit            : d.attribution.credit,
      source:            typeof raw?.attribution?.source            === 'string' ? raw.attribution.source            : undefined
    },
    zoneDefaults: raw?.zoneDefaults && typeof raw.zoneDefaults === 'object' ? raw.zoneDefaults : {},
    dryRunSkip:   raw?.dryRunSkip   && typeof raw.dryRunSkip   === 'object' ? raw.dryRunSkip   : {}
  };
}

/** @returns {Promise<UserSettings>} */
export async function loadSettings() {
  const raw = await db.settings.get(KEY);
  return coerce(raw);
}

/** @param {UserSettings} settings */
export async function saveSettings(settings) {
  await db.settings.set(KEY, coerce(settings));
}

/** @param {Partial<CreatorIdentity>} update */
export async function updateCreator(update) {
  const current = await loadSettings();
  const next = { ...current, creator: { ...current.creator, ...update } };
  await saveSettings(next);
  return next;
}

/** @param {Partial<AttributionTemplate>} update */
export async function updateAttribution(update) {
  const current = await loadSettings();
  const next = { ...current, attribution: { ...current.attribution, ...update } };
  await saveSettings(next);
  return next;
}

/** @param {string} zoneId @param {boolean} skip */
export async function setDryRunSkip(zoneId, skip) {
  const current = await loadSettings();
  const next = { ...current, dryRunSkip: { ...current.dryRunSkip, [zoneId]: skip } };
  await saveSettings(next);
  return next;
}

/** @param {UserSettings} settings @param {{ includePII?: boolean }=} opts @returns {Blob} */
export function exportSettings(settings, opts) {
  const coerced = coerce(settings);
  // Exported settings are often shared between team members or saved to
  // disk. Strip PII by default — users can opt back in with { includePII }.
  const includePII = !!opts?.includePII;
  const safe = includePII ? coerced : {
    ...coerced,
    creator: {
      ...coerced.creator,
      email: '',
    },
  };
  const payload = {
    kind: 'darkroom-settings',
    version: 1,
    exportedAt: new Date().toISOString(),
    piiIncluded: includePII,
    settings: safe,
  };
  return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
}

/** @param {File} file @returns {Promise<UserSettings>} */
export async function importSettings(file) {
  const text = await file.text();
  const json = JSON.parse(text);
  if (json?.kind !== 'darkroom-settings' || json?.version !== 1) {
    throw new Error('Not a darkroom settings file (v1).');
  }
  const settings = coerce(json.settings);
  await saveSettings(settings);
  return settings;
}
