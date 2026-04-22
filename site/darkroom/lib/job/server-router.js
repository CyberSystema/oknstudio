/**
 * OKN Studio · Darkroom — Server router (decides per-file, per-job)
 * =================================================================
 * Smart-routing contract (per spec): every zone ships browser-capable, but
 * when batch size / file size crosses a per-zone threshold, routing returns
 * 'server-large-batch-soon'. The processing server isn't live yet, so that
 * decision currently surfaces as "Coming soon" in the dry-run and lands the
 * file in Needs attention at process time — never silently dropped.
 *
 * Three places each rule can be set (later overrides earlier):
 *   1. Zone manifest defaults: zones/registry.js → zone.thresholds
 *   2. User overrides:          UserSettings.thresholdOverrides[zoneId]
 *   3. (Future) Admin remote:   not yet implemented
 *
 * @typedef {Object} Thresholds
 * @property {number=} fileSizeMB     single-file size above which the file itself routes to server
 * @property {number=} batchCount     batch-count at which WHOLE JOB routes to server
 * @property {number=} batchSizeMB    batch total size at which WHOLE JOB routes to server
 *
 * @typedef {'browser' | 'server-large-batch-soon'} Target
 *
 * @typedef {Object} RoutingExplain
 * @property {string | null} reason   human-readable why, null if all-browser
 * @property {number=} fileSizeMB
 * @property {number=} batchCount
 * @property {number=} batchSizeMB
 *
 * @typedef {Object} RoutingDecision
 * @property {Target} job                       job-level decision
 * @property {Map<string, Target>} perFile      file.id -> target
 * @property {RoutingExplain} explain           why the routing decision went this way
 */

const MB = 1024 * 1024;

/**
 * Sentinel: no threshold. Used when a zone has no per-file threshold
 * (batch-rename is pixel-less; file size never matters).
 */
export const NO_THRESHOLD = Infinity;

/**
 * Default thresholds per zone. Declared here so thresholds live in one
 * grep-able place; the registry imports from this module.
 *
 * Numbers picked conservatively on the principle "most user batches go
 * browser-side fine; only genuinely bulk work routes to server".
 *
 * @type {Record<string, Thresholds>}
 */
export const ZONE_THRESHOLDS = {
  'web-ready':        { fileSizeMB: 80,  batchCount: 250,   batchSizeMB: 1500 },
  'social':           { fileSizeMB: 60,  batchCount: 150,   batchSizeMB: 800  },
  'bulk-compress':    { fileSizeMB: 100, batchCount: 300,   batchSizeMB: 2000 },

  'heic-to-jpeg':     { fileSizeMB: 80,  batchCount: 120,   batchSizeMB: 1200 },
  'raw-develop':      { fileSizeMB: 80,  batchCount: 10,    batchSizeMB: 400  }, // RAW is heavy even in-browser
  'colour-space':     { fileSizeMB: 100, batchCount: 300,   batchSizeMB: 2000 },

  'archive':          { fileSizeMB: 200, batchCount: 500,   batchSizeMB: 5000 },

  // metadata-studio: JPEG EXIF is rewritten via piexifjs (loads the full
  // file into memory). Per-file cap guards against single-file RAM blowups
  // on multi-GB TIFF/PNG inputs. Batch-rename stays truly pixel-less.
  'metadata-studio':  { fileSizeMB: 200, batchCount: 2000, batchSizeMB: 5000 },
  'batch-rename':     { fileSizeMB: NO_THRESHOLD, batchCount: 10000, batchSizeMB: NO_THRESHOLD }
};

/**
 * Merge per-user overrides on top of zone defaults. Missing keys inherit.
 * @param {string} zoneId
 * @param {Record<string, Partial<Thresholds>>=} overrides
 * @returns {Thresholds}
 */
export function effectiveThresholds(zoneId, overrides) {
  const base = ZONE_THRESHOLDS[zoneId] ?? {};
  const o = overrides?.[zoneId] ?? {};
  return {
    fileSizeMB:  num(o.fileSizeMB,  base.fileSizeMB ?? NO_THRESHOLD),
    batchCount:  num(o.batchCount,  base.batchCount ?? NO_THRESHOLD),
    batchSizeMB: num(o.batchSizeMB, base.batchSizeMB ?? NO_THRESHOLD)
  };
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @param {{id:string, size:number}[]} files
 * @param {string} zoneId
 * @param {Record<string, Partial<Thresholds>>=} overrides
 * @returns {RoutingDecision}
 */
export function routeJob(files, zoneId, overrides) {
  const th = effectiveThresholds(zoneId, overrides);
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  const totalMB = totalBytes / MB;

  /** @type {Map<string, Target>} */
  const perFile = new Map();

  // Job-level short-circuits first — batch count / batch size cross the line.
  const jobByCount  = files.length > th.batchCount;
  const jobBySize   = totalMB      > th.batchSizeMB;

  if (jobByCount || jobBySize) {
    for (const f of files) perFile.set(f.id, 'server-large-batch-soon');
    return {
      job: 'server-large-batch-soon',
      perFile,
      explain: {
        reason: jobBySize && jobByCount ? 'batch-size-and-count'
              : jobBySize               ? 'batch-size'
              :                           'batch-count',
        fileSizeMB: th.fileSizeMB,
        batchCount: th.batchCount,
        batchSizeMB: th.batchSizeMB
      }
    };
  }

  // Per-file: any oversized file routes individually.
  let anyOversized = false;
  for (const f of files) {
    const fileMB = f.size / MB;
    if (fileMB > th.fileSizeMB) {
      perFile.set(f.id, 'server-large-batch-soon');
      anyOversized = true;
    } else {
      perFile.set(f.id, 'browser');
    }
  }

  return {
    job: 'browser', // whole job stays browser; per-file map may differ
    perFile,
    explain: {
      reason: anyOversized ? 'per-file-oversize' : null,
      fileSizeMB: th.fileSizeMB,
      batchCount: th.batchCount,
      batchSizeMB: th.batchSizeMB
    }
  };
}

/**
 * For UI display: counts of server-routed vs browser-routed.
 * @param {RoutingDecision} decision
 */
export function summariseRouting(decision) {
  let browser = 0, server = 0;
  for (const t of decision.perFile.values()) {
    if (t === 'browser') browser++;
    else server++;
  }
  return { browser, server, job: decision.job, explain: decision.explain };
}
