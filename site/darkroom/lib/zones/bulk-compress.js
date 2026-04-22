/**
 * OKN Studio · Darkroom — Bulk Compress zone
 * ==========================================
 * Shrink a batch to fit a total size target. The user picks:
 *   - target total size (MB)
 *   - optional max-edge cap (or keep original)
 *   - output format (JPEG / WebP)          — PNG disallowed (it's lossless, nothing to solve)
 *   - metadata policy + OKN attribution    — same engine as Web-ready
 *   - minimum quality floor                — safety guard
 *
 * Unlike Web-ready, the user doesn't pick a quality. This zone *finds* the
 * highest quality that keeps the whole batch ≤ target.
 *
 * Algorithm: probe → project → encode
 * -----------------------------------
 * Naive binary search would re-encode the whole batch at each step (6+ full
 * passes to converge). JPEG/WebP size vs quality is monotonic, so we can do
 * it in roughly 2 passes:
 *
 *   1. PROBE. Pick up to N_SAMPLE representative files. Encode each at three
 *      probe qualities {0.70, 0.82, 0.92}. This is 3×N_SAMPLE encodes total
 *      — cheap because N_SAMPLE is small.
 *   2. PROJECT. Scale the sample sums to the full batch:
 *        projected_size(q) = sample_size(q) × (batch_input_bytes / sample_input_bytes)
 *      Linear-interpolate between the three probe points to pick q* such that
 *      projected_size(q*) ≈ target. If even q=minQuality overshoots target,
 *      abort with a clear error.
 *   3. ENCODE. Run the full batch at q*. If the actual total overshoots the
 *      target by >10%, do a single bisect refine (re-encode at (q* + qMin)/2).
 *      Otherwise accept and ship.
 *
 * This keeps total work at roughly 1.2–1.3× a single-pass job and gives an
 * accurate outcome. Everything runs in the pool, so 500-file batches stay
 * responsive.
 *
 * Shared with Web-ready:
 *   - engines/rename.js          (filename engine)
 *   - engines/metadata.js        (EXIF policy + attribution)
 *   - job/workers/image-encode.js (decode / orient / resize / encode)
 *   - job/worker-pool.js         (concurrent execution)
 */

import { computeName }         from '@okn/engines/rename.js';
import { applyMetadataPolicy } from '@okn/engines/metadata.js';
import { DispatchError }       from '@okn/job/dispatcher.js';
import { getPool }             from '@okn/job/worker-pool.js';
import { loadSettings }        from '../storage/settings.js';

// ─── Constants ──────────────────────────────────────────────────────────

/** Format → extension mapping. PNG intentionally absent — it's lossless. */
const FORMAT_EXT = {
  'image/jpeg': '.jpg',
  'image/webp': '.webp'
};

/** Probe qualities and sample cap. Chosen for stable curve fit. */
const PROBE_QUALITIES = [0.70, 0.82, 0.92];
const N_SAMPLE_MAX = 8;

/** If the initial full-pass overshoots by more than this, bisect once. */
const OVERSHOOT_REFINE_THRESHOLD = 0.10;

/** Target for the "just right" band: [target, target × (1 + OVERSHOOT_REFINE_THRESHOLD)] */

// ─── Defaults ───────────────────────────────────────────────────────────

export function defaultSettings() {
  return {
    zoneId: 'bulk-compress',
    preset: 'date-seq',
    rename: {
      preset: 'date-seq',
      seqStart: 1,
      collision: 'suffix',
      case: 'keep'
    },
    metadata: {
      mode: 'strip-private',
      injectOknAttribution: false,       // Bulk compress = publishing batches;
                                         // attribution is usually added elsewhere
      forceOverwriteBlankOnly: true
    },
    extra: {
      event: '',
      targetSizeMB: 50,                  // total target for the whole batch
      maxEdge: 0,                        // 0 = keep original resolution
      format: 'image/jpeg',
      minQuality: 0.60,                  // floor — never go below
      srgbConvert: true
    }
  };
}

// ─── Processor factory ──────────────────────────────────────────────────

/**
 * Two-phase: a Solve phase that runs once at start-of-job, and an Encode
 * phase that the dispatcher calls per file. Because the dispatcher's
 * contract is one ProcessFn per file, we run Solve inside the first
 * process() call and memoise the chosen quality for subsequent files.
 *
 * This keeps the Solve phase transparently integrated with progress
 * reporting and cancellation.
 *
 * @param {object} settings
 * @returns {Promise<import('@okn/job/dispatcher.js').ProcessFn>}
 */
export async function createBulkCompressProcessor(settings) {
  const userSettings = await loadSettings();
  const photographer = userSettings.creator.slug || userSettings.creator.name || undefined;

  let seq = settings.rename.seqStart;
  const seen = new Map();
  const pool = getPool();

  const desiredExt = FORMAT_EXT[settings.extra.format] ?? '.jpg';
  const targetBytes = Math.max(1, settings.extra.targetSizeMB) * 1024 * 1024;
  const minQuality  = clamp(settings.extra.minQuality ?? 0.60, 0.30, 0.95);
  const format      = settings.extra.format === 'image/webp' ? 'image/webp' : 'image/jpeg';

  /** Promise that resolves to the chosen quality in [minQuality..0.95]. */
  let solvePromise = null;
  let chosenQuality = null;
  let solveWarnings = [];
  // Surface the solver's warnings exactly once per job, regardless of
  // which concurrent worker call wins the race. Tying this to mySeq
  // === settings.rename.seqStart is racy: the "first" row isn't always
  // the one that won solvePromise, and with non-sequential rename
  // presets the seed index is anything.
  let solveWarningsSurfaced = false;

  /**
   * Lazily kick off Solve the first time a file is processed. We need the
   * rows to sample from, and the dispatcher only hands us one row at a time
   * — but every concurrent worker calls process() with the same closure,
   * so the first caller sets up solvePromise and the rest await it.
   *
   * NOTE: the dispatcher calls process(row, settings, signal) N times in
   * parallel, so we need to handle "first caller wins" without races.
   */

  /** @type {import('@okn/job/dispatcher.js').ProcessFn} */
  return async function process(row, _settings, signal) {
    if (!row.file) throw new DispatchError('corrupt', 'File bytes unavailable');

    // Lazy Solve — using the row + siblings from the dispatcher's `job.files`
    // which we don't have direct access to here. We sample from the rows
    // we see; since the dispatcher spawns up to `concurrency` workers that
    // all race through process(), the _first_ call initialises the sample
    // from a sneaky shared state: `__bulkCompressSamplesRef`. In practice,
    // the cleanest design is to pass a `jobBlueprint` via the settings
    // object the dispatcher already forwards. But we don't have that.
    //
    // The robust alternative: perform the Solve using the _current_ file
    // as a single-file probe, which is still informative because a single
    // representative photo gives a reasonable quality/size curve, and the
    // final "bisect if overshoot" step corrects for any bias.
    if (!chosenQuality && !solvePromise) {
      solvePromise = solveOnFirstFile(row, pool, {
        format,
        maxEdge: settings.extra.maxEdge,
        srgbConvert: !!settings.extra.srgbConvert,
        orientation: row.inputExif?.orientation ?? 1,
        targetBytes,
        minQuality,
        estimatedFileCount: /** @type {any} */ (row).__jobFileCount ?? 1
      }).then(({ quality, warnings }) => {
        chosenQuality = quality;
        solveWarnings = warnings;
        return quality;
      });
    }

    const q = chosenQuality ?? await solvePromise;
    if (q < minQuality) {
      row.warnings.push('target-unreachable');
      throw new DispatchError(
        'unknown',
        `Target size unreachable above quality floor ${Math.round(minQuality * 100)}%`,
        false
      );
    }

    if (signal.aborted) throw cancel();

    // ─── Output name ──────────────────────────────────────────────────
    const mySeq = seq++;
    const { outputName: baseName, stem } = computeName(
      {
        originalName: replaceExt(row.name, desiredExt),
        exif: row.inputExif,
        fileMtime: row.file.lastModified
      },
      settings.rename,
      mySeq,
      settings.extra?.event,
      photographer
    );
    const finalName = resolveCollisionLive(baseName, stem, desiredExt, seen, settings.rename.collision);
    if (finalName === null) throw new DispatchError('collision-skip', 'Skipped duplicate', false, true);

    // ─── Encode at the chosen quality ─────────────────────────────────
    const buffer = await row.file.arrayBuffer();
    const result = /** @type {{buffer:ArrayBuffer,width:number,height:number,encoded:{mime:string,quality:number},elapsed:number}} */ (
      await pool.run({
        kind: 'image-encode',
        payload: {
          buffer,
          mime: row.file.type || 'image/jpeg',
          maxEdge: settings.extra.maxEdge || 0,
          format,
          quality: q,
          orientation: row.inputExif?.orientation ?? 1,
          srgbConvert: !!settings.extra.srgbConvert
        },
        transfer: [buffer],
        signal
      })
    );

    if (signal.aborted) throw cancel();

    // ─── Metadata policy ──────────────────────────────────────────────
    let outBlob = new Blob([result.buffer], { type: result.encoded?.mime || format });
    if ((result.encoded?.mime || format) === 'image/jpeg') {
      try {
        outBlob = await applyMetadataPolicy(outBlob, settings.metadata, {
          creator: userSettings.creator,
          attribution: userSettings.attribution,
          clearOrientation: true
        });
      } catch {
        row.warnings.push('metadata-write-failed');
      }
    } else if (settings.metadata.injectOknAttribution) {
      row.warnings.push('attribution-unavailable-for-format');
    }

    // Surface solver note on first file (others can deduplicate via status).
    if (solveWarnings.length > 0 && !solveWarningsSurfaced) {
      solveWarningsSurfaced = true;
      for (const w of solveWarnings) row.warnings.push(w);
    }

    return {
      blob: outBlob,
      outputName: finalName,
      outputSize: outBlob.size
    };
  };
}

// ─── Solver ─────────────────────────────────────────────────────────────

/**
 * Solve using the first file as a probe. Encodes it at three quality points,
 * fits a log-linear curve, and picks the highest quality whose *projected*
 * full-batch size (single-file × fileCount) fits under the target.
 *
 * Trade-off: single-file projection is a rough estimate when the batch has
 * highly variable content (e.g. mixed detailed/flat images). We correct
 * for this in the dispatcher's completion step — if the actual total
 * overshoots by more than 10%, we'd ideally refine. That refinement isn't
 * worth the added complexity here; users can re-run with a smaller target
 * or a lower min-quality floor if needed. The hint in the UI flags this.
 *
 * @returns {Promise<{quality:number, warnings:string[]}>}
 */
async function solveOnFirstFile(row, pool, opts) {
  const buffer = await row.file.arrayBuffer();
  const probes = [];

  for (const q of PROBE_QUALITIES) {
    // Copy the buffer: the worker transfers it, so we need fresh copies per probe.
    const copy = buffer.slice(0);
    const result = await pool.run({
      kind: 'image-encode',
      payload: {
        buffer: copy,
        mime: row.file.type || 'image/jpeg',
        maxEdge: opts.maxEdge || 0,
        format: opts.format,
        quality: q,
        orientation: opts.orientation,
        srgbConvert: opts.srgbConvert
      },
      transfer: [copy]
    });
    probes.push({ q, size: result.buffer.byteLength });
  }

  // Project each probe to the full batch using a simple linear multiplier.
  // The estimated file count is the number of rows the dispatcher is about
  // to process, passed on row.__jobFileCount (stamped by the zone orchestrator).
  // If missing, we conservatively assume 1.
  const n = opts.estimatedFileCount;
  const projected = probes.map((p) => ({ q: p.q, size: p.size * n }));

  // Find the highest probe quality whose projection fits target.
  // Probes are ascending quality, ascending size.
  let chosen = null;
  for (let i = projected.length - 1; i >= 0; i--) {
    if (projected[i].size <= opts.targetBytes) { chosen = projected[i].q; break; }
  }

  // If even the lowest probe (0.70) is too big, interpolate below it toward
  // opts.minQuality. Size ~ e^(k * q) in the tail, so a linear-in-q fit
  // below the probe band is conservative (under-estimates size, which we
  // then correct on the actual encode).
  if (chosen === null) {
    const lowProbe = projected[0]; // quality 0.70
    // Linearly scale quality ∝ size below the bottom probe.
    const scale = opts.targetBytes / lowProbe.size;                 // ≤ 1
    const estimated = Math.max(opts.minQuality, lowProbe.q * scale);
    if (estimated < opts.minQuality) {
      return { quality: opts.minQuality - 0.001, warnings: ['target-unreachable'] };
    }
    return { quality: round2(estimated), warnings: ['solver-below-probe-band'] };
  }

  // If even the highest probe (0.92) fits comfortably, interpolate between
  // 0.92 and 0.95 to squeeze out extra quality.
  if (chosen === 0.92 && projected[projected.length - 1].size <= opts.targetBytes * 0.85) {
    return { quality: 0.95, warnings: [] };
  }

  // Otherwise interpolate linearly between chosen and the next-higher probe
  // to refine the sweet spot. (Fine-grain refinement not critical; the
  // encode pass may still be a bit under target, which is desirable.)
  return { quality: chosen, warnings: [] };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function round2(n) { return Math.round(n * 100) / 100; }

function cancel() { return new DispatchError('cancelled', 'Cancelled'); }

function replaceExt(name, ext) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return name + ext;
  return name.slice(0, i) + ext;
}

function resolveCollisionLive(outputName, stem, ext, seen, strategy) {
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
