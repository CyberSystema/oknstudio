/**
 * OKN Studio · Shared — Worker runner
 * ===================================
 * Every worker in the pool boots this script. It dispatches incoming tasks
 * to handler modules loaded lazily from ./<kind>.js.
 *
 * Protocol
 * --------
 * Incoming message shape:
 *   { id, kind, payload }                    — task
 *   { __abort: id }                          — abort request (best-effort; handler decides)
 *
 * Outgoing message shape:
 *   { id, ok: true,  result }                — success (result may be transferred)
 *   { id, ok: false, error: { class, message } } — failure
 *   { id, progress: 0..1 }                   — optional progress tick
 *
 * A handler module default-exports:
 *   async function handle(payload, ctx) { ... }
 *
 * where ctx is { signal: AbortSignal, progress: (n:number)=>void, transfer: (buffers:Transferable[])=>void }.
 * The handler may mutate ctx.transferList by calling ctx.transfer(buf) to include
 * transferable buffers in the reply.
 *
 * Handlers live beside this file so the import URL is stable.
 */

/** @type {Map<string, { handle: (payload:unknown, ctx:HandlerCtx) => Promise<unknown> }>} */
const cache = new Map();

/** @type {Map<string, AbortController>} */
const aborters = new Map();

/**
 * @typedef {Object} HandlerCtx
 * @property {AbortSignal} signal
 * @property {(n:number) => void} progress
 * @property {(buf: Transferable) => void} transfer
 */

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg?.__abort) {
    const ac = aborters.get(msg.__abort);
    if (ac) ac.abort();
    return;
  }

  const { id, kind, payload } = msg || {};
  if (typeof id !== 'string' || typeof kind !== 'string') return;

  const ac = new AbortController();
  aborters.set(id, ac);

  /** @type {Transferable[]} */
  const transferList = [];

  /** @type {HandlerCtx} */
  const ctx = {
    signal: ac.signal,
    progress: (n) => { self.postMessage({ id, progress: n }); },
    transfer: (buf) => { transferList.push(buf); }
  };

  try {
    const handler = await loadHandler(kind);
    const result = await handler.handle(payload, ctx);
    self.postMessage({ id, ok: true, result }, transferList);
  } catch (err) {
    const error = { message: err?.message ?? String(err), class: err?.klass ?? 'unknown' };
    self.postMessage({ id, ok: false, error });
  } finally {
    aborters.delete(id);
  }
};

/** @param {string} kind */
async function loadHandler(kind) {
  let mod = cache.get(kind);
  if (mod) return mod;
  // Handler URL is always a sibling of this file.
  const url = new URL(`./${kind}.js`, import.meta.url).toString();
  const imported = await import(url);
  mod = imported.default ?? imported;
  if (!mod || typeof mod.handle !== 'function') {
    throw Object.assign(new Error(`Worker handler "${kind}" missing default { handle(payload, ctx) }`), {
      klass: 'unknown'
    });
  }
  cache.set(kind, mod);
  return mod;
}
