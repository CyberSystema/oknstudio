/**
 * OKN Studio · Darkroom — Job history
 * ===================================
 * Bounded at MAX_HISTORY most-recent entries. Only filenames (not bytes) are
 * kept. Reverse-sortable keys so lexicographic listing is newest-first.
 *
 * @typedef {Object} JobHistoryEntry
 * @property {string} id
 * @property {string} zone
 * @property {object} settings
 * @property {number} fileCount
 * @property {number} successCount
 * @property {number} failureCount
 * @property {number} durationMs
 * @property {number} startedAt              epoch ms
 * @property {string[]} filenames            capped at 50 for display
 */

import { db } from '@okn/storage/db.js';

export const MAX_HISTORY = 20;

/** Reverse-sortable key: lex-sort ascending = newest first. */
function entryKey(startedAt, id) {
  const padded = (Number.MAX_SAFE_INTEGER - startedAt).toString().padStart(16, '0');
  return `${padded}_${id}`;
}

/**
 * @param {{id:string,zone:string,settings:object,files:Array<{status:string,name:string}>,startedAt?:number,finishedAt?:number,durationMs?:number}} job
 * @returns {Promise<JobHistoryEntry|null>}
 */
export async function recordJob(job) {
  if (!job.startedAt || !job.finishedAt) return null;

  const successCount = job.files.filter((f) => f.status === 'done').length;
  const failureCount = job.files.filter((f) =>
    f.status === 'error' || f.status === 'filtered' || f.status === 'cancelled'
  ).length;

  /** @type {JobHistoryEntry} */
  const entry = {
    id: job.id,
    zone: job.zone,
    settings: job.settings,
    fileCount: job.files.length,
    successCount,
    failureCount,
    durationMs: job.durationMs ?? 0,
    startedAt: job.startedAt,
    filenames: job.files.map((f) => f.name).slice(0, 50)
  };

  const key = entryKey(job.startedAt, job.id);
  await db.history.set(key, entry);

  const allKeys = await db.history.keys();
  if (allKeys.length > MAX_HISTORY) {
    const sorted = [...allKeys].sort();
    const toRemove = sorted.slice(MAX_HISTORY);
    await Promise.all(toRemove.map((k) => db.history.del(k)));
  }

  return entry;
}

/** @returns {Promise<JobHistoryEntry[]>} Newest-first. */
export async function listHistory() {
  const keys = await db.history.keys();
  const sorted = [...keys].sort();
  const entries = await Promise.all(sorted.map((k) => db.history.get(k)));
  return entries.filter(Boolean);
}

export async function clearHistory() {
  await db.history.clear();
}

export async function removeHistoryEntry(id, startedAt) {
  await db.history.del(entryKey(startedAt, id));
}
