/**
 * OKN Studio · Darkroom — Batch Rename zone processor
 * ===================================================
 * Pixel-less. Takes the original bytes and writes them to the ZIP under a
 * new name computed by the rename engine. Proves the full pipeline
 * end-to-end without any WASM dependencies.
 */

import { computeName }    from '@okn/engines/rename.js';
import { DispatchError }  from '@okn/job/dispatcher.js';
import { loadSettings }   from '../storage/settings.js';

/** @returns {object} */
export function defaultSettings() {
  return {
    zoneId: 'batch-rename',
    preset: 'date-seq',
    rename: {
      preset: 'date-seq',
      seqStart: 1,
      collision: 'suffix',
      case: 'keep'
    },
    metadata: {
      mode: 'keep-all',
      injectOknAttribution: false,
      forceOverwriteBlankOnly: true
    },
    extra: { event: '' }
  };
}

/**
 * Build a process function bound to shared job state (sequence counter and
 * collision-seen map). Dispatcher calls this once per file in parallel, so
 * we carry the shared counter as a closure rather than on settings.
 *
 * @param {object} settings
 * @returns {Promise<import('@okn/job/dispatcher.js').ProcessFn>}
 */
export async function createBatchRenameProcessor(settings) {
  const userSettings = await loadSettings();
  const photographer = userSettings.creator.slug || userSettings.creator.name || undefined;

  let seq = settings.rename.seqStart;
  /** @type {Map<string, number>} */
  const seen = new Map();

  return async function process(row /*, _settings, _signal */) {
    if (!row.file) throw new DispatchError('corrupt', 'File bytes unavailable');

    const mySeq = seq++;
    const { outputName: computed, stem } = computeName(
      {
        originalName: row.name,
        exif: row.inputExif,
        fileMtime: row.file.lastModified
      },
      settings.rename,
      mySeq,
      settings.extra?.event,
      photographer
    );

    const ext = extOf(computed);
    const finalName = resolveCollision(computed, stem, ext, seen, settings.rename.collision);

    if (finalName === null) {
      throw new DispatchError('collision-skip', 'Skipped duplicate', false, true);
    }

    // Original bytes, new name. Blob.slice() is zero-copy on modern engines.
    return { blob: row.file.slice(), outputName: finalName, outputSize: row.size };
  };
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i);
}

function resolveCollision(outputName, stem, ext, seen, strategy) {
  const key = outputName.toLowerCase();
  const prior = seen.get(key);
  if (prior === undefined) { seen.set(key, 1); return outputName; }
  if (strategy === 'skip')  return null;
  if (strategy === 'error') throw new DispatchError('unknown', `name collision: ${outputName}`);

  let n = prior;
  let candidate = '';
  let candidateKey = '';
  do {
    candidate = `${stem}_${n}${ext}`;
    candidateKey = candidate.toLowerCase();
    n += 1;
  } while (seen.has(candidateKey));
  seen.set(key, n);
  seen.set(candidateKey, 1);
  return candidate;
}
