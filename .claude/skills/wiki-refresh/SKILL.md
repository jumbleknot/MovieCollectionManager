---
name: wiki-refresh
description: Refresh an openwiki/ summary page in the same PR as the change to its source. Use when you changed a file that is some openwiki page's `resource`, or when the okf check (V17) reports a page stale or without a fingerprint.
compatibility: Offline and free; no credential, no model call
user-invocable: true
---

# Refreshing a derived wiki page

A **derived** page under `openwiki/` summarises exactly one file, named by its `resource:` front
matter, and records that file's fingerprint in `resource-sha256:`. The required `okf` check (rule
**V17**) fails a PR when a recorded fingerprint no longer matches the file. The coding session that
changed the source refreshes the summary **in the same PR**. Canonical pages (no `resource`) are
hand-maintained and are never checked by V17. Background: ADR-0004 and
`docs/runbooks/wiki-maintenance.md`.

## When to use

- You changed a file that some page names as its `resource`.
- `node scripts/check-openwiki-okf.mjs` (the `okf` check) printed a `V17` line.

## Steps

1. **Find what is stale**: `node scripts/wiki-refresh.mjs --stale`.
   Each line is `<page> ← <resource>  (<reason>)`. It exits 1 when anything is listed.
2. **For each page, read the source change**: `node scripts/wiki-refresh.mjs --diff <page>`.
   This prints the diff since the page was last recorded. The `base:` line says which commit it
   diffed from.
3. **Edit only what the diff invalidates**, following `openwiki/INSTRUCTIONS.md`: what a page
   covers, its tone, its redaction rules. Do not rewrite the page or "tidy" unrelated sections.
4. **Record the fingerprint**: `node scripts/wiki-refresh.mjs --record <page>`.
   This writes `resource-sha256` and `timestamp` into the front matter and never touches the body.
5. **Commit the page in the same PR** as the source change. Then re-run `--stale`, which should
   print nothing.

## Things to know

- **A fingerprint-only refresh is correct** when the diff changes nothing the page says, for
  example a reworded comment or a fix in code the page does not describe. Run `--record` with no
  body edit. That is visible in review, and it is the honest result.
- **Several pages can share one source.** `docs/MCM-Architecture.md` feeds three pages
  (`architecture/system-overview.md`, `projects/mc-service.md`, `projects/mcp-servers.md`). `--stale`
  lists every one of them, so refresh each.
- **Never hand-type a hash** or copy one from another page. Only `--record` writes
  `resource-sha256`, and it hashes the file as it is in your working tree (CRLF normalised to LF).
- **`resource missing`** means the source was renamed or deleted. Re-point `resource:` at the file
  that now holds the subject and then `--record`, or retire the page (and its index entry).
- **`forbidden field: sources` / `verified`**: these openwiki Claims fields are retired. `--record`
  strips them.
- **Unknown flags are rejected** (exit 2). `--help` only prints usage.
