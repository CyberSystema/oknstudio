/**
 * OKN Studio · Shared — Web Worker pool
 * =====================================
 * Every heavy op (resize, HEIC decode, ICC convert, EXIF strip, pHash, face
 * detect, RAW develop, etc.) runs off the main thread so the UI stays live
 * on 500-photo batches.
 *
 * Design
 * ------
 * - One pool, many task kinds. Workers are "generic runners" that import
 *   task handlers dynamically from ./workers/*.js on first use and cache them.
 *   That way the pool doesn't need to know about every task type up front.
 * - Pool size = navigator.hardwareConcurrency - 1, clamped [2, 8]. We leave
 *   one core for the main thread + UI.
 * - Tasks transfer ArrayBuffers zero-copy via postMessage's transfer list.
 *   The caller hands over ownership; results come back with new buffers.
 * - Abort flows end-to-end: the AbortSignal triggers a pool.cancel(taskId)
 *   message to whichever worker is running it.
 *
 * Task shape (task dispatched from main thread)
 * ---------------------------------------------
 *   {
 *     id:        string,            // unique per task
 *     kind:      string,            // maps to ./workers/<kind>.js
 *     payload:   unknown,           // structured-cloneable
 *     transfer?: Transferable[]     // zero-copy list (ArrayBuffers, etc.)
 *   }
 *
 * Worker protocol (what every worker script must do)
 * --------------------------------------------------
 *   self.onmessage = async ({ data }) => {
 *     const { id, kind, payload } = data;
 *     try {
 *       const result = await handle(kind, payload);
 *       self.postMessage({ id, ok: true, result }, transferList(result));
 *     } catch (err) {
 *       self.postMessage({ id, ok: false, error: { message: err.message, class: err.klass ?? 'unknown' } });
 *     }
 *   };
 *
 * Public API
 * ----------
 *   const pool = getPool();
 *   const result = await pool.run({ kind, payload, transfer, signal });
 *   pool.stats()                          // { size, busy, queued }
 *   pool.destroy()                        // terminates all workers (rarely needed)
 *
 * The pool is a lazy singleton. First call to getPool() spawns the workers.
 */

// ─── Config ─────────────────────────────────────────────────────────────

/** Path (relative to this module's URL) where task-handler workers live. */
const WORKER_URL = new URL('./workers/runner.js', import.meta.url);

function computePoolSize() {
  if (typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number') {
    return Math.min(8, Math.max(2, navigator.hardwareConcurrency - 1));
  }
  return 4;
}

// ─── Internal singleton ─────────────────────────────────────────────────

/** @type {Pool | null} */
let singleton = null;

/**
 * Get (or lazily create) the shared pool.
 * @returns {Pool}
 */
export function getPool() {
  if (!singleton) singleton = createPool(computePoolSize());
  return singleton;
}

/** Destroy + release the singleton. Tests/Panic-reset may call this. */
export function destroyPool() {
  singleton?.destroy();
  singleton = null;
}

// ─── Pool implementation ────────────────────────────────────────────────

/**
 * @typedef {Object} RunOptions
 * @property {string} kind                        which worker handler to dispatch
 * @property {unknown} payload                    structured-cloneable payload
 * @property {Transferable[]=} transfer           zero-copy list
 * @property {AbortSignal=} signal                cancels this task
 * @property {(progress:number)=>void=} onProgress 0..1, optional — workers can postMessage({id, progress})
 *
 * @typedef {Object} Pool
 * @property {(opts: RunOptions) => Promise<unknown>} run
 * @property {() => { size:number, busy:number, queued:number }} stats
 * @property {() => void} destroy
 */

/**
 * @param {number} size
 * @returns {Pool}
 */
function createPool(size) {
  /** @type {WorkerSlot[]} */
  const slots = Array.from({ length: size }, () => createSlot());

  /** @type {Array<PendingTask>} */
  const queue = [];

  /** @type {Map<string, PendingTask>} */
  const inFlight = new Map();

  // ─── Task lifecycle ─────────────────────────────────────────────────

  function dispatch() {
    if (queue.length === 0) return;
    const free = slots.find((s) => !s.task);
    if (!free) return;

    const task = queue.shift();
    free.task = task;
    inFlight.set(task.id, task);

    task.slot = free;

    try {
      free.worker.postMessage(
        { id: task.id, kind: task.kind, payload: task.payload },
        task.transfer ?? []
      );
    } catch (err) {
      // postMessage can throw on structured-clone failures. Resolve the task
      // with an error so callers see it cleanly.
      finish(task, { ok: false, error: { class: 'unknown', message: String(err) } });
    }
  }

  /**
   * Resolve/reject a task and free it from the in-flight map. Separated
   * from slot bookkeeping so cancellation can settle the caller's
   * promise immediately without re-dispatching into a slot whose worker
   * may still be mid-task (and whose late response would otherwise land
   * on the next, unrelated task).
   *
   * @param {PendingTask} task
   * @param {{ok:boolean,result?:unknown,error?:{class:string,message:string}}} msg
   */
  function settle(task, msg) {
    if (!inFlight.has(task.id)) return;
    inFlight.delete(task.id);

    if (task.signal && task.onAbort) {
      task.signal.removeEventListener('abort', task.onAbort);
    }

    if (msg.ok) {
      task.resolve(msg.result);
    } else {
      const err = new Error(msg.error?.message ?? 'Worker failed');
      err.klass = msg.error?.class ?? 'unknown';
      task.reject(err);
    }
  }

  /**
   * Called when a worker itself reports a terminal message for the task
   * that currently owns its slot. Settles the caller (if still pending)
   * and frees the slot for the next dispatch.
   *
   * @param {PendingTask} task
   * @param {{ok:boolean,result?:unknown,error?:{class:string,message:string}}} msg
   */
  function finish(task, msg) {
    settle(task, msg);
    if (task.slot && task.slot.task === task) task.slot.task = null;
    dispatch();
  }

  // ─── Slot wiring ────────────────────────────────────────────────────

  for (const slot of slots) {
    slot.worker.addEventListener('message', (e) => {
      const msg = e.data;
      if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') return;

      // Progress update: forward to caller, don't finish the task.
      if ('progress' in msg) {
        const task = inFlight.get(msg.id);
        if (task && task.onProgress) {
          try { task.onProgress(Math.max(0, Math.min(1, Number(msg.progress)))); } catch { /* ignore */ }
        }
        return;
      }

      const task = inFlight.get(msg.id);
      if (task) { finish(task, msg); return; }

      // No in-flight task with this id — usually means the caller aborted
      // and we already settled their promise. The worker still finished
      // the task (or acknowledged the abort), so the slot that was holding
      // it must be freed before we dispatch the next task.
      const slot = slots.find((s) => s.task && s.task.id === msg.id);
      if (slot) {
        slot.task = null;
        dispatch();
      }
    });

    slot.worker.addEventListener('error', (e) => {
      const task = slot.task;
      if (!task) return;
      finish(task, {
        ok: false,
        error: { class: 'unknown', message: e.message || 'worker error' }
      });
      // The worker is still usable for subsequent tasks (errors bubble from
      // user code, not the runner itself), so we leave it alive.
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * @param {RunOptions} opts
   * @returns {Promise<unknown>}
   */
  function run(opts) {
    if (opts.signal?.aborted) {
      return Promise.reject(abortError());
    }

    return new Promise((resolve, reject) => {
      const task = {
        id: ridTask(),
        kind: opts.kind,
        payload: opts.payload,
        transfer: opts.transfer,
        signal: opts.signal,
        onProgress: opts.onProgress,
        onAbort: null,
        slot: null,
        resolve,
        reject
      };

      // Abort wiring: if cancelled while queued, drop from queue; if
      // in-flight, tell the worker to stop (graceful — worker may ignore).
      // We settle the caller's promise immediately, but leave slot.task
      // intact so the worker's eventual terminal response can still land
      // on this task id (finish() no-ops because inFlight no longer has
      // it) without re-dispatching a sibling onto a still-busy worker.
      if (opts.signal) {
        task.onAbort = () => {
          const qIx = queue.indexOf(task);
          if (qIx !== -1) {
            queue.splice(qIx, 1);
            settle(task, { ok: false, error: { class: 'cancelled', message: 'Cancelled' } });
            return;
          }
          if (inFlight.has(task.id)) {
            if (task.slot) {
              try { task.slot.worker.postMessage({ __abort: task.id }); } catch { /* ignore */ }
            }
            settle(task, { ok: false, error: { class: 'cancelled', message: 'Cancelled' } });
          }
        };
        opts.signal.addEventListener('abort', task.onAbort, { once: true });
      }

      queue.push(task);
      dispatch();
    });
  }

  function stats() {
    return {
      size: slots.length,
      busy: slots.filter((s) => !!s.task).length,
      queued: queue.length
    };
  }

  function destroy() {
    for (const slot of slots) {
      try { slot.worker.terminate(); } catch { /* ignore */ }
    }
    slots.length = 0;
    for (const task of queue) {
      task.reject(new Error('Pool destroyed'));
    }
    queue.length = 0;
    for (const task of inFlight.values()) {
      task.reject(new Error('Pool destroyed'));
    }
    inFlight.clear();
  }

  return { run, stats, destroy };
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** @returns {WorkerSlot} */
function createSlot() {
  const worker = new Worker(WORKER_URL, { type: 'module' });
  return { worker, task: null };
}

function ridTask() {
  return `t_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function abortError() {
  const e = new Error('Cancelled');
  e.klass = 'cancelled';
  return e;
}

// ─── Type notes (JSDoc) ─────────────────────────────────────────────────

/**
 * @typedef {Object} WorkerSlot
 * @property {Worker} worker
 * @property {PendingTask | null} task
 *
 * @typedef {Object} PendingTask
 * @property {string} id
 * @property {string} kind
 * @property {unknown} payload
 * @property {Transferable[] | undefined} transfer
 * @property {AbortSignal | undefined} signal
 * @property {((n:number)=>void) | undefined} onProgress
 * @property {(() => void) | null} onAbort
 * @property {WorkerSlot | null} slot
 * @property {(v:unknown)=>void} resolve
 * @property {(e:unknown)=>void} reject
 */
