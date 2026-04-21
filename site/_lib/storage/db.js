/**
 * OKN Studio · Shared — IndexedDB wrapper
 * =======================================
 * Namespaced stores. Falls back to in-memory map if IDB is blocked
 * (private-browsing mode, certain iOS configurations), so callers don't
 * have to branch.
 *
 * Note on scope: the store names below (`settings`, `history`,
 * `zone-defaults`) and the DB name (`okn-darkroom`) are currently tuned
 * for Darkroom. When a second tool adopts this module, the plan is to
 * add a small `openNamespace(dbName, storeName)` helper so each tool gets
 * its own IndexedDB database. Deferred until there's an actual second
 * caller — YAGNI until then.
 *
 * We import idb-keyval from the esm.sh CDN so there's no npm step — this
 * project has no bundler. Version is pinned for reproducibility.
 */

import {
  createStore,
  get,
  set,
  del,
  keys,
  clear
} from 'https://esm.sh/idb-keyval@6.2.1?bundle';

const DB_NAME = 'okn-darkroom';

// Detect IDB availability once. Private-browsing Safari exposes the API but
// throws on open; a cheap probe at module load is safer than per-op try/catch.
let idbReady = false;
try {
  // eslint-disable-next-line no-undef
  if (typeof indexedDB !== 'undefined') {
    // createStore doesn't open until used; just make sure indexedDB is callable.
    const probe = indexedDB.open(DB_NAME + ':probe', 1);
    probe.onsuccess = () => { probe.result.close(); idbReady = true; };
    probe.onerror   = () => { idbReady = false; };
    // Mark ready optimistically; ops still try/catch
    idbReady = true;
  }
} catch { idbReady = false; }

// ─── Fallback in-memory store ───────────────────────────────────────────

/** @type {Map<string, Map<string, unknown>>} */
const memory = new Map();
const memStore = (name) => {
  if (!memory.has(name)) memory.set(name, new Map());
  return memory.get(name);
};

// ─── Store factories ────────────────────────────────────────────────────

const settingsStore     = idbReady ? createStore(DB_NAME, 'settings')      : null;
const historyStore      = idbReady ? createStore(DB_NAME, 'history')       : null;
const zoneDefaultsStore = idbReady ? createStore(DB_NAME, 'zone-defaults') : null;

/** @param {ReturnType<typeof createStore>|null} store @param {string} name */
function makeNamespace(store, name) {
  return {
    async get(key) {
      if (!store) return memStore(name).get(key);
      try { return await get(key, store); }
      catch { return memStore(name).get(key); }
    },
    async set(key, value) {
      memStore(name).set(key, value);
      if (!store) return;
      try { await set(key, value, store); } catch { /* keep memory copy */ }
    },
    async del(key) {
      memStore(name).delete(key);
      if (!store) return;
      try { await del(key, store); } catch { /* ignore */ }
    },
    async keys() {
      if (!store) return Array.from(memStore(name).keys());
      try { return await keys(store); }
      catch { return Array.from(memStore(name).keys()); }
    },
    async clear() {
      memStore(name).clear();
      if (!store) return;
      try { await clear(store); } catch { /* ignore */ }
    }
  };
}

export const db = {
  settings:     makeNamespace(settingsStore,     'settings'),
  history:      makeNamespace(historyStore,      'history'),
  zoneDefaults: makeNamespace(zoneDefaultsStore, 'zone-defaults'),

  /** Wipe every darkroom store. Used by Panic reset. */
  async panic() {
    await Promise.all([
      this.settings.clear(),
      this.history.clear(),
      this.zoneDefaults.clear()
    ]);
  },

  get idbAvailable() { return idbReady; }
};
