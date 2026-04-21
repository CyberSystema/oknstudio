/**
 * OKN Studio · Shared — Echo worker handler (diagnostic)
 * ======================================================
 * Useful for:
 *   - confirming the pool boots at all
 *   - smoke-testing the abort protocol
 *   - measuring round-trip latency in the console
 *
 * Usage (from main thread):
 *   const pool = getPool();
 *   const result = await pool.run({ kind: 'echo', payload: { ping: 'hi', sleepMs: 50 } });
 *
 * This handler is intentionally not referenced from any zone; it exists so
 * the app boot can do a one-time health check at startup.
 */

export default {
  /**
   * @param {{ ping?: string, sleepMs?: number, failWith?: string }} payload
   * @param {import('./runner.js').HandlerCtx} ctx
   */
  async handle(payload, ctx) {
    if (payload?.failWith) {
      throw Object.assign(new Error(payload.failWith), { klass: 'unknown' });
    }

    const sleep = Number(payload?.sleepMs ?? 0);
    if (sleep > 0) {
      await new Promise((resolve, reject) => {
        if (ctx.signal.aborted) {
          reject(Object.assign(new Error('cancelled'), { klass: 'cancelled' }));
          return;
        }
        const timer = setTimeout(() => resolve(undefined), sleep);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('cancelled'), { klass: 'cancelled' }));
        }, { once: true });
      });
    }

    return { pong: payload?.ping ?? 'ok', at: Date.now() };
  }
};
