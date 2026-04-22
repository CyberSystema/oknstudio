/**
 * OKN Studio · Darkroom — i18n helper
 * ===================================
 * Zero runtime deps. Usage:
 *   import { t, setLocale, getLocale } from './i18n.js';
 *   t('dryrun.summary', { count: 42, size: '18 MB' })
 *
 * Supported locales: `en` (default), `ko`.
 * Missing keys in the active locale fall back to `en`; missing in `en` too
 * returns the raw key so devs notice.
 *
 * Locale selection priority:
 *   1. Explicit setLocale() call (persisted in localStorage under `okn.lang`)
 *   2. `<html lang>` attribute
 *   3. navigator.language
 *   4. 'en'
 */

import { en } from './messages.en.js';
import { ko } from './messages.ko.js';

/** @type {Record<string, Record<string, string>>} */
const CATALOGUES = { en, ko };
const SUPPORTED = /** @type {const} */ (['en', 'ko']);
const STORAGE_KEY = 'okn.lang';

const INTERP_RE = /\{(\w+)\}/g;

/** @type {'en'|'ko'} */
let active = detectInitialLocale();
/** @type {Set<(locale: 'en'|'ko') => void>} */
const listeners = new Set();

// Sync <html lang> with the detected locale on module init. Without
// this, a visitor whose preference comes from localStorage or
// navigator.language lands on a page still advertising the authoring
// default in the DOM, confusing screen readers and any CSS that keys
// off :lang().
try {
  if (globalThis.document?.documentElement && globalThis.document.documentElement.lang !== active) {
    globalThis.document.documentElement.lang = active;
  }
} catch { /* ignore */ }

function detectInitialLocale() {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (stored && SUPPORTED.includes(/** @type {any} */ (stored))) return /** @type {'en'|'ko'} */ (stored);
  } catch {
    // localStorage blocked (private mode, sandboxed iframe) \u2014 fall through.
  }
  const htmlLang = globalThis.document?.documentElement?.lang?.slice(0, 2).toLowerCase();
  if (htmlLang && SUPPORTED.includes(/** @type {any} */ (htmlLang))) return /** @type {'en'|'ko'} */ (htmlLang);
  const navLang = globalThis.navigator?.language?.slice(0, 2).toLowerCase();
  if (navLang && SUPPORTED.includes(/** @type {any} */ (navLang))) return /** @type {'en'|'ko'} */ (navLang);
  return 'en';
}

/**
 * @param {string} key
 * @param {Record<string, string|number>=} vars
 * @returns {string}
 */
export function t(key, vars) {
  const template = CATALOGUES[active][key] ?? CATALOGUES.en[key] ?? key;
  if (!vars) return template;
  return template.replace(INTERP_RE, (_, name) => {
    const v = vars[name];
    return v === undefined ? `{${name}}` : String(v);
  });
}

export function hasMessage(key) {
  return key in CATALOGUES[active] || key in CATALOGUES.en;
}

/** @returns {'en'|'ko'} */
export function getLocale() { return active; }

/** @returns {ReadonlyArray<'en'|'ko'>} */
export function getSupportedLocales() { return SUPPORTED; }

/**
 * @param {'en'|'ko'} locale
 */
export function setLocale(locale) {
  if (!SUPPORTED.includes(locale)) return;
  if (locale === active) return;
  active = locale;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, locale); } catch { /* ignore */ }
  try {
    if (globalThis.document?.documentElement) {
      globalThis.document.documentElement.lang = locale;
    }
  } catch { /* ignore */ }
  for (const fn of listeners) {
    try { fn(locale); } catch { /* ignore listener errors */ }
  }
}

/**
 * Subscribe to locale changes. Returns an unsubscribe function.
 * @param {(locale: 'en'|'ko') => void} fn
 */
export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

