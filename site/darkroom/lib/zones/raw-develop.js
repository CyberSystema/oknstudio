/**
 * OKN Studio · Darkroom — RAW develop zone (server-required stub)
 * ===============================================================
 * Full RAW development needs LibRaw + dcraw tone mapping, which isn't
 * realistic in a browser bundle. This stub keeps the UI contract:
 *   - the card renders, accepts drops, remembers settings
 *   - dispatch surfaces every file under Needs Attention with a clear
 *     "server-required" reason rather than silently failing
 *
 * When the processing server lands, swap `createRawDevelopProcessor`
 * for one that uploads each RAW, polls the job endpoint, and streams the
 * returned TIFF/JPEG into the ZIP.
 */

import { DispatchError } from '@okn/job/dispatcher.js';

export function defaultSettings() {
  return {
    zoneId: 'raw-develop',
    preset: 'keep-original',
    rename: {
      preset: 'date-seq',
      seqStart: 1,
      collision: 'suffix',
      case: 'keep'
    },
    metadata: {
      mode: 'keep-all',
      injectOknAttribution: true,
      forceOverwriteBlankOnly: true
    },
    extra: {
      event: '',
      outputFormat: 'image/jpeg',   // 'image/jpeg' | 'image/tiff'
      whiteBalance: 'as-shot',      // 'as-shot' | 'auto' | 'daylight' | 'tungsten'
      exposure: 0,                  // -3 .. +3 EV
      quality: 0.92
    }
  };
}

/**
 * @param {object} _settings
 * @returns {Promise<import('@okn/job/dispatcher.js').ProcessFn>}
 */
export async function createRawDevelopProcessor(_settings) {
  return async function process(_row, _z, _signal) {
    throw new DispatchError(
      'server-required',
      'RAW develop runs on the processing server, which isn\'t live yet',
      false
    );
  };
}
