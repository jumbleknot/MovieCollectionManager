# Quickstart — validating 098

Run everything from a worktree. All checks are offline and free. `node --test` takes node's flags
**before** the path, never after (CLAUDE.md: anything after the path is ignored as argv).

## 1. The check blocks a stale summary (US1)

```bash
echo "<!-- probe -->" >> docs/runbooks/renovate.md
node scripts/check-openwiki-okf.mjs            # exit 1: V17 openwiki/runbooks/renovate.md: stale against docs/runbooks/renovate.md …
node scripts/wiki-refresh.mjs --stale          # exit 1: openwiki/runbooks/renovate.md ← docs/runbooks/renovate.md (source changed)
node scripts/wiki-refresh.mjs --diff openwiki/runbooks/renovate.md   # shows only the probe line
node scripts/wiki-refresh.mjs --record openwiki/runbooks/renovate.md # recorded … (a stamp-only refresh: the probe changes nothing the page says)
node scripts/check-openwiki-okf.mjs            # exit 0
git checkout -- docs/runbooks/renovate.md openwiki/runbooks/renovate.md
```

Expected: the two failures name the same page. After `--record`, `git diff openwiki/` shows only the
`resource-sha256` and `timestamp` lines.

## 2. Line endings do not make pages stale

```bash
unix2dos -n docs/runbooks/renovate.md /tmp/r.md && cp /tmp/r.md docs/runbooks/renovate.md
node scripts/check-openwiki-okf.mjs            # exit 0
git checkout -- docs/runbooks/renovate.md
```

## 3. Governance (US3)

```bash
node scripts/check-openwiki-governance.mjs     # exit 0. A directory or deny-listed resource → G14
git ls-files openwiki/.claims openwiki/.page-manifest.json openwiki/.last-update.json openwiki/.maintenance-state.json   # prints nothing
git check-ignore openwiki/.claims/x.json openwiki/.page-manifest.json   # both ignored
```

## 4. Gates and unit tests

```bash
node scripts/check-openwiki-okf.mjs --selftest
node scripts/check-openwiki-governance.mjs --selftest
node --test 'scripts/__tests__/wiki-*.test.mjs' 'scripts/__tests__/*openwiki*.test.mjs'
```

Watch the **skip count** as well as the failures (CLAUDE.md: a skip reads as a pass).

## 5. Manual rebuild (US4), operator only, paid

Dispatch `wiki-maintain` with `pages: runbooks/backups.md`. Expected:

- one PR that touches only that page and `runbooks/index.md`,
- `resource-sha256` current,
- no `.claims/` or manifest in the diff,
- the run log lists `landed: runbooks/backups.md`.

The workflow file has no `schedule:` or `push:` key (guarded by `wiki-maintain.guard.test.mjs`).

## 6. Cut-over evidence (US5)

On the PR that turns V17 on, `node scripts/wiki-refresh.mjs --stale` prints nothing and exits 0,
and `guardrails / okf` is green.
