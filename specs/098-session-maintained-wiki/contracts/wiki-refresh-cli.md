# Contract: `node scripts/wiki-refresh.mjs`

Offline, model-free, no credential. Unknown arguments are **rejected** (exit 2), using
`scripts/lib/argv-contract.mjs` (`partitionArgs`, `wantsHelp`, `dieOnArgvError`). CLAUDE.md records why: a mis-typed flag must never turn into
an action.

| Invocation | Effect | Exit |
|---|---|---|
| `--stale` | Prints one line per stale or broken derived page: `<page> ← <resource>  (<reason>)`, where reason is one of `source changed`, `no fingerprint`, `resource missing`, `forbidden field: sources`. Writes nothing. | 0 none stale · 1 any stale |
| `--stale --json` | The same, as `{"stale":[{"page","resource","reason"}]}` | as above |
| `--diff <page>` | Prints the unified diff of `resource` from the newest commit whose bytes match the recorded `resource-sha256`, searched back through `git log --follow` on `resource`, to the working tree. **With no recorded fingerprint** (every page at cut-over), the base is the newest commit to `resource` at or before the page's stamp (`conceptStamp`: the newest of `generated.at` and `timestamp`). The header says `base: commit at page stamp <date>`. Only if neither base can be found (a corrupted hash, or a page with no stamp) does it say so and print the whole file. | 0 · 2 not a derived page |
| `--record <page> [<page>…]` | For each page: writes `resource-sha256` (current bytes) and `timestamp` (now, UTC), and removes `sources:` and `verified:`. **Never touches the body.** Prints `recorded <page> <short-hash>`. | 0 · 2 not a derived page / resource missing |
| `--record --all-fresh` | Cut-over only (R8): records every derived page whose stamp is newer than its resource's last commit. It refuses (exit 1) if any page is not, listing those pages. | 0 · 1 |
| `--help` | Usage. **Does nothing else.** | 0 |

**Invariant**: `--stale` and V17 call the same exported function
(`staleDerivedPages({root})`), so they cannot disagree (FR-009).
