# Tools

Standalone utilities that support the site but don't ship as part of the
runtime. Keep these framework-free and committed-dependency-free where
possible.

## `bucket-map.py`

One-off helper that inspects the Backblaze B2 bucket and emits a JSON map
consumed by the media gallery. Run manually when adding new top-level
folders:

```bash
source .venv/bin/activate
python tools/bucket-map.py > site/media/bucket-map.json
```

Requires the same `B2_*` credentials documented in
[`functions/README.md`](../functions/README.md), exported in the shell env.
