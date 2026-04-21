/**
 * OKN Studio · Shared — Streaming ZIP writer
 * ==========================================
 * client-zip streams entries straight to the browser's download — we never
 * hold every output in memory. That's the difference between "works fine"
 * and "tab crashes" for 500-photo batches.
 */

import { downloadZip } from 'https://esm.sh/client-zip@2.4.5?bundle';

/**
 * @typedef {Object} ZipEntry
 * @property {string} name
 * @property {Blob|ArrayBuffer|Uint8Array|string} input
 * @property {number=} lastModified
 *
 * @typedef {Object} Zipper
 * @property {(entry:ZipEntry)=>void} add
 * @property {()=>void} finish
 * @property {()=>Promise<Blob>} toBlob
 * @property {(filename:string)=>Promise<void>} download
 * @property {number} count
 */

/** Safety caps to keep even huge batches from exhausting browser memory. */
const MAX_ENTRIES = 5000;

/** @returns {Zipper} */
export function createZipper() {
  /** @type {ZipEntry[]} */
  const queue = [];
  let finished = false;
  /** @type {null|(()=>void)} */
  let resolveNext = null;
  /** Total entries ever added (queue.length shrinks as source() drains). */
  let totalAdded = 0;

  async function* source() {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift();
        continue;
      }
      if (finished) return;
      await new Promise((res) => {
        resolveNext = () => { resolveNext = null; res(); };
      });
    }
  }

  return {
    get count() { return totalAdded; },

    add(entry) {
      if (finished) throw new Error('Zipper finished; cannot add more entries');
      if (totalAdded >= MAX_ENTRIES) {
        throw new Error(`Zip entry cap reached (${MAX_ENTRIES}); split the batch.`);
      }
      queue.push(entry);
      totalAdded++;
      if (resolveNext) resolveNext();
    },

    finish() {
      finished = true;
      if (resolveNext) resolveNext();
    },

    async toBlob() {
      return downloadZip(source()).blob();
    },

    async download(filename) {
      const blob = await this.toBlob();
      const url = URL.createObjectURL(blob);
      /** @type {HTMLAnchorElement|null} */
      let a = null;
      try {
        a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        // Yield once so the browser has latched the download before we revoke.
        await new Promise((res) => setTimeout(res, 0));
      } finally {
        if (a) a.remove();
        URL.revokeObjectURL(url);
      }
    }
  };
}
