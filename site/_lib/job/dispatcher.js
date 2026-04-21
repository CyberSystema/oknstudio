/**
 * OKN Studio · Shared — Job dispatcher
 * ====================================
 * Drives a job through:   dry-run → processing → done | failed | cancelled.
 *
 * Zone-agnostic: callers provide a processFile(row, settings, signal) that
 * turns one FileRow into { blob, outputName, outputSize }. Every zone in
 * later phases plugs in with the same signature.
 *
 * Persistence is inverted: the dispatcher doesn't know about history
 * storage. Callers pass an optional `onFinish(job)` hook (e.g. Darkroom's
 * app.js wires it to `recordJob` from its own storage layer). This keeps
 * `_lib/` free of any tool-specific coupling.
 */

import { createZipper } from './zipper.js';

/**
 * @typedef {Object} Job
 * @property {string} id
 * @property {string} zone
 * @property {object} settings
 * @property {Array<import('./intake.js').FileRow>} files
 * @property {'dry-run'|'processing'|'done'|'cancelled'|'failed'} state
 * @property {{browser:number, server:number}} routing
 * @property {number=} startedAt
 * @property {number=} finishedAt
 * @property {number=} durationMs
 *
 * @typedef {Object} ZipEntryLite
 * @property {string} name
 * @property {Blob|ArrayBuffer|Uint8Array|string} input
 * @property {number=} lastModified
 *
 * @typedef {(
 *   row: import('./intake.js').FileRow,
 *   settings: object,
 *   signal: AbortSignal
 * ) => Promise<{ blob: Blob, outputName: string, outputSize: number, extraEntries?: ZipEntryLite[] }>} ProcessFn
 *
 * @typedef {(
 *   zipper: { add: (e: ZipEntryLite) => void, count: number },
 *   job: Job
 * ) => (void | Promise<void>)} FinalizeFn
 *
 * Kept local to _lib so this module doesn't reach into any tool's
 * server-router. Callers pass any object with a `perFile` Map; the
 * dispatcher only checks for the sentinel 'server-large-batch-soon'
 * and treats every other value as "handle in browser". Tools may pass
 * richer shapes (e.g. with `job` and `explain` fields) — those are
 * ignored here, which is the point of structural typing.
 *
 * @typedef {Object} DispatcherRouting
 * @property {Map<string, string>} perFile
 */

export class DispatchError extends Error {
  /**
   * @param {string} klass
   * @param {string} message
   * @param {boolean=} retryable
   * @param {boolean=} filtered
   */
  constructor(klass, message, retryable = false, filtered = false) {
    super(message);
    this.name = 'DispatchError';
    this.klass = klass;
    this.retryable = retryable;
    this.filtered = filtered;
  }
}

function rid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function navigatorConcurrency() {
  if (typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number') {
    return Math.min(8, Math.max(2, navigator.hardwareConcurrency - 1));
  }
  return 4;
}

function dateStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * @param {{
 *   zoneId: string,
 *   settings: object,
 *   rows: Array<import('./intake.js').FileRow>,
 *   processFile: ProcessFn,
 *   onUpdate?: (job: Job) => void,
 *   onFinish?: (job: Job) => (void | Promise<void>),
 *   onFinalize?: FinalizeFn,
 *   concurrency?: number,
 *   zipFilename?: string,
 *   routing?: DispatcherRouting
 * }} opts
 */
export function createDispatcher(opts) {
  // Pre-tag rows with their routing target so the pool loop can short-circuit
  // server-routed files cleanly without calling processFile.
  /** @type {Map<string,'browser'|'server-large-batch-soon'>} */
  const routingMap = opts.routing?.perFile ?? new Map();

  const browserCount = opts.rows.filter((r) => routingMap.get(r.id) !== 'server-large-batch-soon').length;
  const serverCount  = opts.rows.length - browserCount;

  /** @type {Job} */
  const job = {
    id: rid('job'),
    zone: opts.zoneId,
    settings: opts.settings,
    files: opts.rows.map((r) => ({ ...r })),
    state: 'dry-run',
    routing: { browser: browserCount, server: serverCount }
  };

  /** @type {Set<(j:Job)=>void>} */
  const listeners = new Set();
  const notify = () => {
    opts.onUpdate?.(job);
    listeners.forEach((l) => l(job));
  };

  const abort = new AbortController();
  const CONCURRENCY = Math.max(1, opts.concurrency ?? navigatorConcurrency());

  return {
    get job() { return job; },

    /** @param {(j:Job)=>void} fn */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    async start() {
      if (job.state !== 'dry-run') return;
      job.state = 'processing';
      job.startedAt = Date.now();
      notify();

      const zipper = createZipper();
      const filename = opts.zipFilename ?? `${opts.zoneId}-${dateStamp(Date.now())}.zip`;
      const downloadPromise = zipper.download(filename);

      try {
        // Mark every server-routed file as a clean "coming soon" error up-front
        // so they never enter the worker loop and can't block the job.
        for (const row of job.files) {
          if (routingMap.get(row.id) === 'server-large-batch-soon') {
            row.status = 'error';
            row.error = {
              class: 'server-large-batch-soon',
              message: 'Routed to processing server (coming soon)',
              retryable: false
            };
          }
        }
        notify();

        await runPool(job, opts.processFile, CONCURRENCY, abort.signal, zipper, notify, routingMap);
        // Finalize hook: runs once after all files are processed (or the
        // job was cancelled). Used by zones like Archive to emit manifest
        // CSVs, READMEs, or contact sheets that depend on the full batch.
        if (opts.onFinalize && !abort.signal.aborted) {
          try { await opts.onFinalize(zipper, job); } catch { /* ignore */ }
        }
        job.state = abort.signal.aborted ? 'cancelled' : 'done';
      } catch {
        job.state = 'failed';
      } finally {
        zipper.finish();
        await downloadPromise.catch(() => undefined);
        job.finishedAt = Date.now();
        job.durationMs = job.finishedAt - (job.startedAt ?? job.finishedAt);
        notify();
        // Caller-supplied persistence hook. Swallow errors so a history
        // write failure never bubbles up and tanks the UI state machine.
        if (opts.onFinish) {
          try { await opts.onFinish(job); } catch { /* ignore */ }
        }
      }
    },

    cancel() {
      if (job.state === 'done' || job.state === 'failed') return;
      abort.abort();
      if (job.state === 'dry-run') {
        job.state = 'cancelled';
        job.finishedAt = Date.now();
        notify();
      }
    }
  };
}

async function runPool(job, processFn, concurrency, signal, zipper, notify, routingMap) {
  // Only process files routed to browser. Server-routed rows were already
  // marked with an error and must not be handed to processFile.
  const todo = job.files
    .map((_, i) => i)
    .filter((i) => routingMap.get(job.files[i].id) !== 'server-large-batch-soon');

  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < todo.length) {
      if (signal.aborted) return;
      const ix = todo[cursor++];
      const row = job.files[ix];
      row.status = 'processing';
      notify();
      try {
        const { blob, outputName, outputSize, extraEntries } = await processFn(row, job.settings, signal);
        if (signal.aborted) {
          row.status = 'cancelled';
          row.error = { class: 'cancelled', message: 'Cancelled', retryable: false };
          notify();
          return;
        }
        zipper.add({ name: outputName, input: blob, lastModified: Date.now() });
        if (Array.isArray(extraEntries)) {
          for (const extra of extraEntries) {
            zipper.add({ lastModified: Date.now(), ...extra });
          }
        }
        row.outputName = outputName;
        row.outputSize = outputSize;
        row.status = 'done';
        row.progress = 1;
        row.file = undefined;  // release memory once zipped
        notify();
      } catch (e) {
        if (signal.aborted) {
          row.status = 'cancelled';
          row.error = { class: 'cancelled', message: 'Cancelled', retryable: false };
        } else if (e instanceof DispatchError) {
          row.status = e.filtered ? 'filtered' : 'error';
          row.error = { class: e.klass, message: e.message, retryable: e.retryable };
        } else {
          row.status = 'error';
          row.error = {
            class: 'unknown',
            message: e instanceof Error ? e.message : 'Unknown error',
            retryable: false
          };
        }
        notify();
      }
    }
  });
  await Promise.all(workers);
}
