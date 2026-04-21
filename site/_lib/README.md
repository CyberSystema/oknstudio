# `site/_lib/` — Shared OKN Studio engines

This folder holds logic that's genuinely cross-tool. Each tool at
`site/<tool>/` (Darkroom, Media Pool, OG renderer, …) can import from
here using the `@okn/*` alias prefix so no tool needs to know the
on-disk path to shared code.

## What's here today

```
_lib/
├── engines/
│   ├── rename.js            — filename token grammar, collision resolver
│   ├── rename.test.mjs      — 41 pure-Node tests
│   └── metadata.js          — JPEG EXIF read/strip/inject (piexifjs)
├── job/
│   ├── worker-pool.js       — shared Web Worker pool (lazy singleton)
│   ├── dispatcher.js        — zone-agnostic job state machine
│   ├── intake.js            — File[] → FileRow[] with EXIF read
│   ├── zipper.js            — streaming ZIP writer
│   └── workers/
│       ├── runner.js        — worker shell that dispatches handlers
│       ├── echo.js          — diagnostic handler
│       └── image-encode.js  — decode / orient / resize / re-encode
└── storage/
    └── db.js                — IndexedDB wrapper with in-memory fallback
```

## How tools consume this

Each tool's `index.html` has an importmap declaring the `@okn/*`
aliases:

```html
<script type="importmap">
{
  "imports": {
    "@okn/engines/": "/_lib/engines/",
    "@okn/job/":     "/_lib/job/",
    "@okn/storage/": "/_lib/storage/"
  }
}
</script>
<script type="module" src="./lib/app.js"></script>
```

Note: the importmap must appear **before** the first module script.
Browsers only read one importmap per document, and only before any
module has started loading.

Then tool code imports cleanly:

```js
import { computeName } from '@okn/engines/rename.js';
import { getPool }     from '@okn/job/worker-pool.js';
import { db }          from '@okn/storage/db.js';
```

## Where these aliases are also declared

When adding a new `@okn/<slug>/` alias, update **three** places in
sync:

1. **This folder** — add the subdirectory with code in it.
2. **`tsconfig.json`** at the repo root — add a matching `paths` entry
   so `tsc --checkJs` can resolve the alias during type-checking:
   ```json
   "paths": {
     "@okn/<slug>/*": ["./site/_lib/<slug>/*"]
   }
   ```
3. **Each consuming tool's `index.html` importmap** — add the
   `"@okn/<slug>/": "/_lib/<slug>/"` entry. If you forget this, the
   browser throws `TypeError: Failed to resolve module specifier` at
   load-time.

## Design rules

- **No tool-specific code.** Anything here must be useful (or at least
  useful-in-theory) to more than one tool. If only Darkroom needs it,
  it stays in `site/darkroom/lib/`.
- **No reverse imports.** `_lib/` must not import from any tool's
  folder. The few places where older code reached back (`dispatcher`
  into `storage/history`, `intake` into `zones/registry`) are inverted
  via injection (`onFinish` hook) or inlined typedefs. Keep it that
  way.
- **esm.sh over npm.** The rest of oknstudio runs with zero build
  step. Dependencies are pinned URL imports (`https://esm.sh/foo@1.2.3`);
  TypeScript's `types/esm-sh.d.ts` tells `tsc` to treat them as `any`.
- **Workers use relative URLs only.** Importmaps don't propagate into
  Worker scopes. Every worker-side module import resolves via
  `new URL('./sibling.js', import.meta.url)` — never via `@okn/*`.

## What stays per-tool, not in `_lib/`

Things that look generic but are tied to a tool's domain:

- **`darkroom/lib/job/server-router.js`** — the zone-threshold table is
  Darkroom's own (per-zone `fileSizeMB` / `batchCount` / `batchSizeMB`
  tuned to image work). Another tool would have a completely different
  routing table.
- **`darkroom/lib/zones/*`** — per-zone processors are the Darkroom UX.
- **`darkroom/lib/storage/settings.js`** and **`history.js`** — schema
  is Darkroom-specific (creator identity, attribution template, zone
  defaults). Another tool would have a different settings shape; these
  two files wrap `@okn/storage/db.js` with their own schema.
- **`darkroom/lib/i18n.js`** and **`messages.en.js`** — Darkroom's own
  string catalogue.

When a second tool needs one of these patterns, the right move is to
extract the *abstraction* (e.g. a generic "schema-coerced key/value
settings helper") into `_lib/`, and keep each tool's concrete schema
in the tool folder.

## Testing

Tests live next to their module: `engines/rename.test.mjs` next to
`engines/rename.js`. Run:

```bash
npm test       # node --test
npm run check  # tsc --noEmit (type-check only)
npm run verify # both
```

CI runs both on every push to `main` and every PR.
