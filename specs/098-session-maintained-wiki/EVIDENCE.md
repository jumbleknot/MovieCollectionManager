# Evidence: Session-Maintained Wiki Summaries (098)

Worktree `/home/coder/worktrees/098-wiki`, branch `098-session-maintained-wiki`.

## T001 — Baseline (HEAD fb541a00, untouched tree, 2026-11-10)

| Command | Exit |
|---|---|
| `node scripts/check-openwiki-okf.mjs` | 0 — `✅ 74 concepts conformant across 8 directories.` |
| `node scripts/check-openwiki-okf.mjs --selftest` | 0 — `passed (V1–V16 …)` |
| `node scripts/check-openwiki-governance.mjs` | 0 — `✅ 1190 documentation path(s) classified, 73 concept(s) …` |
| `node scripts/check-openwiki-governance.mjs --selftest` | 0 — `passed (G1–G4 … G13 …)` |

`node --test 'scripts/__tests__/wiki-*.test.mjs' 'scripts/__tests__/*openwiki*.test.mjs'`:
**tests 412 · pass 412 · fail 0 · skipped 0** (31.5 s).

`node --test 'scripts/__tests__/*.test.mjs'` (full scripts suite):
**tests 2035 · pass 2035 · fail 0 · skipped 0** (67.4 s).

V12 drift list — 12 pages, identical to research R8:

```
openwiki/architecture/system-overview.md ← docs/MCM-Architecture.md
openwiki/gotchas/expo-router-and-transport-traps.md ← frontend/mcm-app/server.js
openwiki/gotchas/external-id-url-opening.md ← frontend/mcm-app/src/components/movie-detail.tsx
openwiki/gotchas/keycloak-service-account.md ← frontend/mcm-app/src/bff-server/keycloak.ts
openwiki/gotchas/playwright-testid-mapping.md ← frontend/mcm-app/playwright.config.ts
openwiki/gotchas/session-lifecycle-and-eviction.md ← frontend/mcm-app/src/bff-server/session-manager.ts
openwiki/process/spec-driven-development.md ← specs/
openwiki/projects/mc-service.md ← docs/MCM-Architecture.md
openwiki/projects/mcp-servers.md ← docs/MCM-Architecture.md
openwiki/projects/repository.md ← README.md
openwiki/runbooks/devcontainer.md ← docs/runbooks/devcontainer.md
openwiki/runbooks/wiki-maintenance.md ← docs/runbooks/wiki-maintenance.md
```

## T002 / T003 — `openwiki-fingerprint.mjs`

RED (`node --test scripts/__tests__/openwiki-fingerprint.test.mjs`):

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/scripts/openwiki-fingerprint.mjs' imported from …/openwiki-fingerprint.test.mjs
ℹ tests 1 · pass 0 · fail 1 · skipped 0
```

GREEN (same command): **tests 15 · pass 15 · fail 0 · skipped 0**.

Found on the way: the OKF gate's front-matter reader (now `scripts/openwiki-front-matter.mjs`,
moved — not copied — so there is still one parser) failed to parse a **CRLF** page whose last
front-matter line is a flow collection (`tags: [a]\r` → `Unexpected scalar at node end`), which
would have failed V1 on a Windows checkout. The CRLF `recordSourceFingerprint` case exposed it;
the fix strips the one trailing `\r` the terminator slice leaves. The OKF gate and `--selftest` still
exit 0 after the move.

## T004 / T005 — V17 in the OKF gate

RED (`node scripts/check-openwiki-okf.mjs --selftest`, exit 1), after the fixture source was renamed
`src.txt` so it is not itself read as a concept:

```
✗ openwiki-okf gate --selftest FAILED:
  v17-fresh: expected no findings, got V6
  v17-stale: expected V17, got [V6]
  v17-stale: the finding must name the page and the wiki-refresh --diff hint
  v17-missing: expected V17, got [V6]
  v17-malformed: expected V17, got [V6]
  v17-crlf: expected no findings, got V6
  v17-sources-field: expected V17, got [V6]
  v17-resource-missing: expected V17, got [V6]
  v17-resource-missing: the finding must say to re-point `resource` or retire the page
exit 1
```

GREEN: `✓ openwiki-okf gate --selftest passed (V1–V17: … derived pages fresh against their source fingerprint)`, exit 0.

Guards updated at the cause, not deleted: the pre-existing clean self-test scenarios and the
`check-openwiki-okf.test.mjs` fixtures that cite a real file now carry that file's fingerprint —
computed at run time for README.md, and a new stable `fixtures/openwiki-okf/source.txt` for the
committed fixtures, so a README edit cannot break them.

Real tree (expected until T026): `node scripts/check-openwiki-okf.mjs` exit 1, **52** V17 findings —
50 `no source fingerprint`, plus the two directory resources (`specs/`, `backend/mc-service/src/domain/`)
reported as "not a single file" until T015 makes those pages canonical. No non-V17 finding.

`node --test scripts/__tests__/check-openwiki-okf.test.mjs`: 31 tests, 29 pass, 2 fail — both expected:
`the real bundle has no … body link` (asserts the real tree exits 0; green at T026) and
`V12 a page whose claims were VERIFIED after its source changed is not stale` (asserts `verified.at`
is a stamp, which this feature retires; removed at T013).

## T006 / T007 — `wiki-refresh.mjs`

RED (`node --test scripts/__tests__/wiki-refresh.test.mjs`): **tests 13 · pass 0 · fail 13 · skipped 0**,
each `Error: Cannot find module '…/scripts/wiki-refresh.mjs'`.

GREEN (same command): **tests 13 · pass 13 · fail 0 · skipped 0**. With the fingerprint tests:
28 / 28 / 0 / 0. Hashing is one definition (`fingerprintBytes` in `openwiki-fingerprint.mjs`),
used by both `sourceFingerprint` and `--diff`'s history search.

Real-tree smoke (read-only): `--stale` lists 52 lines; `--diff gotchas/keycloak-service-account.md`
prints `base: commit at page stamp 2026-11-07T19:02:58.048Z (3d657a96b7)` and a diff of only the
newer change; `--recrod x` exits 2 and writes nothing (`git status` clean apart from the new files).

## T008 / T009 / T017 — skill, instruction surfaces, ADR-0004

- `.claude/skills/wiki-refresh/SKILL.md` names `--stale`, `--diff`, `--record`, matching the contract.
- `CLAUDE.md`: one new gate line, and the "derived summary" index line now says to refresh the
  concept in the same PR. `AGENTS.md`: the OKF notes rewritten; the generated `OPENWIKI:START` block
  is untouched, and a new first entry in the corrections list says its no-hand-edit line does not
  apply here (ADR-0004).
- ADR-0004 written (pulled forward from Phase 5 because AGENTS.md links it and G10 failed on the
  dead link until it existed); ADR-0003 status "Superseded in part by ADR-0004".
- `node scripts/check-openwiki-governance.mjs`: exit 0. `node scripts/check-openwiki-okf.mjs`: only V17
  findings (52).

## T010 / T011 — list-valued actor, G14, G13 removed

RED (`node scripts/check-openwiki-governance.mjs --selftest`, exit 1):

```
✗ openwiki-governance gate --selftest FAILED:
  list-actor-accepted: expected a clean pass, got [G2]
  g3-list-actor: expected G3, got [G2]
  g14-directory: expected G14, got [none]
  g14-env-deploy: expected G14, got [none]
  g14-renovate-custom-manager: expected G14, got [none]
exit 1
```

GREEN: `--selftest` exit 0 (`… G14 one human-written file per derived page, list-valued actor …`).
`node --test scripts/__tests__/check-openwiki-governance.test.mjs`: 29 tests, 28 pass, 1 fail — the
real repository failing G14 on the two directory-resource pages, cleared by T015 (below). The
`--selftest` summary assertion now looks for G14 where it looked for G13. A new unit test pins
`mayWrite` membership for a list-valued actor (`agent` and `generator` allowed, `robot` refused).

## T012 / T013 — `verified.at` is no longer a stamp

RED (`node --test scripts/__tests__/openwiki-stamp.test.mjs`): **tests 10 · pass 6 · fail 4 · skipped 0** —
the new "ignores verified.at" case and the three existing `verified` cases reworked to assert it is
ignored.

GREEN: **10 / 10 / 0 / 0**. `node scripts/check-openwiki-okf.mjs --selftest`: exit 0 after the
`v5-verified-at` scenario (whose premise — V5 validates `verified.at` — this feature retires) was
updated at the cause to `v17-verified-field`: a `verified:` field on a derived page is rejected.
The two `check-openwiki-okf.test.mjs` cases that encoded `verified.at` as a stamp now assert the
same V17 rejection.

**Measured consequence for the cut-over (T025).** With `verified.at` dropped from the stamp, the
stamp-vs-last-commit test no longer reproduces research R8's measurement, because R8 was measured
with V12, which counted `verified.at`:

| Page | R8 (verified counted) | verified ignored |
|---|---|---|
| projects/bff.md, projects/sast.md, runbooks/devcontainer-sandbox.md | fresh | stale |
| architecture/agent-layer.md, gotchas/rfc-9457-problem-details.md, process/constitution.md, runbooks/android-emulator.md | fresh | no stamp |
| gotchas/playwright-testid-mapping.md, gotchas/session-lifecycle-and-eviction.md | stale (in the 11) | no stamp |

To keep the settled 11-page cut-over faithful to R8, `--record --all-fresh` (cut-over only, deleted
in T027) judges with R8's own rule — the newest of `generated.at`, `verified.at` and `timestamp` —
rather than the post-098 stamp.

## T014 / T015 — policy.yaml, two pages canonical

- `openwiki/**` → `actor: [agent, generator]` (rationale cites ADR-0004); the `.claims/**` and
  `.page-manifest.json` entries removed; `event-driven` entries added for
  `process/spec-driven-development.md` (`process-changed`) and `architecture/data-model.md`
  (`domain-model-changed`).
- Both pages lost `resource`/`sources`/`verified` and are listed under `authoritative:` in
  `protected.yaml`, each with its `## Gotchas` section fingerprinted (values from the gate's own
  `--fingerprint`). Both marked **[canonical]** in the CLAUDE.md index.
- `node scripts/check-openwiki-governance.mjs`: exit 0. OKF: neither page has a finding.

## T016 — Claims bookkeeping retired

`du -sh openwiki` **before** retirement: **6.9M**.

- `git rm`: `openwiki/.claims/` (45 files), `.page-manifest.json`, `.last-update.json` and
  `.maintenance-state.json` (also tracked, so removed too); all four gitignored —
  `git ls-files` prints nothing for them, `git check-ignore` matches all four.
- V16, its self-test scenarios, its unit test and the `openwiki-claims.mjs` import removed from the
  OKF gate; `openwiki-claims.mjs`, `wiki-claims-audit.mjs` and their tests deleted.
- `.openwikiignore` deleted with `openwiki-ignore-claims.guard.test.mjs`: every entry it held
  (`**/.env.deploy`, `**/pnpm-lock.yaml`, `security/sast/allowlist.yaml`) existed only to keep churn
  out of Claims evidence, by the file's own header and comments. G14 now refuses all three families as
  a `resource`.
- `openwiki/decisions/adr-0003-claims-and-fingerprints.md` refreshed (its source's status changed in
  T017, and it linked the deleted modules — V15): a supersession note, and the two dead links
  unlinked. `--record`ed. **Not one of the 11 cut-over pages** — an ordinary refresh caused by this PR.
- OKF on the real tree: only V17 `no source fingerprint` lines (49).
- The grep part of T016's done-when (`openwiki-claims|wiki-claims-audit` in `scripts`) waits for
  T020: `wiki-maintain.mjs` imports both modules throughout and is rewritten there.

## `--all-fresh` judges by research R8's stamp rule

RED (`node --test --test-name-pattern "R8" scripts/__tests__/wiki-refresh.test.mjs`): 1 test, 0 pass,
1 fail — `[wiki-refresh] refusing --all-fresh: 1 page(s) need a real refresh first` for a page whose
only newer-than-source stamp was `verified.at`.
GREEN: the whole file, **14 / 14 / 0 / 0**. On the real tree `--record --all-fresh` then refused with
exactly R8's 11 pages, which is the measured set.

## T022–T024 — the cut-over refreshes (10 of 11; the 11th is T028)

Each page: `node scripts/wiki-refresh.mjs --diff <page>`, read the diff against the page, edit only
what it invalidates, `--record <page>`.

| Page | Source change (diff) | Result |
|---|---|---|
| architecture/system-overview.md | MCM-Architecture.md: the gateway's token cache is keyed `(user, audience, sha256(subject token))`, never `user` alone (spec 094) | **edited** — the page stated the old `(user, audience)` key |
| projects/mc-service.md | same diff | fingerprint-only — the page does not describe the gateway cache |
| projects/mcp-servers.md | same diff | fingerprint-only — same |
| projects/repository.md | README.md: Metro is "Node file crawler, hot reload", not watchman-backed (spec 097) | **edited** — one phrase |
| runbooks/devcontainer.md | watchman removed from the image; a new paragraph on why | fingerprint-only — the page never mentions watchman and its toolchain list is still right |
| gotchas/expo-router-and-transport-traps.md | server.js: `expo-server`, absolute-URL hook, `trust proxy` comment | fingerprint-only — the page already describes all of it (feature 087 updated the body without moving its stamp) |
| gotchas/external-id-url-opening.md | movie-detail.tsx: Prettier reformat only | fingerprint-only |
| gotchas/keycloak-service-account.md | keycloak.ts: Prettier, plus `assignMcUserRole` checks each step → 502 | fingerprint-only — the page already documents the checked chain (feature 092) |
| gotchas/playwright-testid-mapping.md | `--diff` base: none (the page's only stamp was `verified.at`, which the contract's base excludes) → whole file. The one commit since its `verified.at` (1195ad3c, Prettier) is line-wrapping only (`git diff -w` shows only re-wrapped lines), and the worktree equals 1195ad3c | fingerprint-only |
| gotchas/session-lifecycle-and-eviction.md | same as above | fingerprint-only |

**SC-005 timing**: T022 (three pages, one body edit) took **25 s** wall-clock from the first `--diff`
to the last `--record` (03:12:25 → 03:12:50 UTC).

`--stale` after T024 lists no page from the R8 set except `runbooks/wiki-maintenance.md`, held for
T028 as instructed.

## T028 / T029 — runbook, brief, superseded specs

- `docs/runbooks/wiki-maintenance.md` rewritten (1137 → 748 lines): a lead `## Refresh` section (the
  `#refresh` anchor the CLAUDE.md gate line links), V17/G14, what was retired with a link to ADR-0004,
  the manual `pages` dispatch; the sections on cooldowns, escalation, drift/parking, the quiet-trigger,
  the run record, the 078 US7 schedule, the claims audit and §9 Claims removed (§9 now a short
  "Claims, retired" note). Measured facts that still explain a rule (the deadline table, the hang, the
  per-page landing runs) kept.
- `openwiki/INSTRUCTIONS.md`: "where a new learning goes" now says source **and** refresh the summary
  in the same PR; §5 explains the fingerprint, V17 and G14 and forbids writing
  `resource-sha256`/`sources`/`verified`; the §9 Claims-citation rules removed and the old §10 renumbered
  §9 (its one inbound reference, in the runbook, updated).
- Pages whose resource is `openwiki/INSTRUCTIONS.md`: `openwiki/quickstart.md` — refreshed and recorded.
- `openwiki/decisions/adr-0004-session-maintained-wiki.md` added (AGENTS.md promises every ADR a citing
  concept), indexed in `decisions/index.md` and the CLAUDE.md knowledge index, and recorded.
- T029: one-paragraph supersession notes on specs 078 (US6, US7, FR-024..FR-029), 082 (whole) and 044
  (FR-007, FR-009..FR-012, FR-016b).

## T018–T021 — manual `--pages` rebuild (done by a forked session; re-verified here)

RED, taken with the two deleted Claims modules briefly restored as untracked files so
`wiki-maintain.mjs` could load (they were removed again afterwards):
- T018 `node --test --test-name-pattern "pages" scripts/__tests__/wiki-maintain.test.mjs`: 17 tests,
  4 pass, 13 fail, 0 skip — every new `--pages` case failed with
  `[wiki-maintain] unknown argument: --pages` / `mod.pagesToSlices is not a function`.
- T019 `node --test scripts/__tests__/wiki-maintain.guard.test.mjs`: 32 tests, 26 pass, 6 fail, 0 skip
  (`a \`pages\` input names what to rebuild`, `no step may run the retired quiet check`, …).

GREEN (re-run in this session): `wiki-maintain.test.mjs` **93 / 93 / 0 / 0**,
`wiki-maintain.guard.test.mjs` **32 / 32 / 0 / 0**, `argv-mutating-default.guard.test.mjs` 23 / 23 / 0 / 0
(gained verdicts for `wiki-refresh.mjs` and `wiki-maintain.mjs`); `wiki-maintain.mjs --selftest` exit 0;
`--since x` exits 2 (unrecognised); a canonical page is refused before any spend. The workflow is
`workflow_dispatch` only with a required `pages` input; `grep "wiki-quiet|maintenance-state|max-slices"`
on it finds nothing. Scenarios covered: T018 → US4-AC1/AC2, T019 → US4-AC3.

**`wiki-maintain.mjs`: 3315 → 1768 lines** (`wiki-maintain.test.mjs` 3791 → 2144). Design calls:
only the job-deadline guard is kept (page/time budgets and exit 3 removed; an unattempted page is
`not landed`); a requested page counts as rewritten only if its body differs from HEAD, and a rewritten
derived page is fingerprinted (`recordSourceFingerprint`) before the gates run; after a normal exit,
unrequested pages the policy lets the generator write are put back (forbidden writes are left so
verification fails); the forge is the only proposal state; `project.json` drops `wiki-plan`.

T016's done-when now holds in full: `grep -rn "openwiki-claims\|wiki-claims-audit" scripts .forgejo`
finds only a history comment and an absence assertion in `wiki-maintain.guard.test.mjs`.

## T023 / T025 / T026 / T027 — the cut-over completes

- T023: `runbooks/wiki-maintenance.md` (the 11th R8 page) refreshed once, after its source was rewritten
  (T028), and recorded. `process/wiki-maintenance.md` was also refreshed — **not one of the 11**: its
  `resource` is `infrastructure-as-code/project.json`, which this PR changed (the `wiki-plan` target
  removed, `wiki-maintain` now `--pages`); V17 would otherwise have failed it.
- T025: `node scripts/wiki-refresh.mjs --record --all-fresh` exit 0, recording the remaining derived pages;
  then `--stale` prints nothing (exit 0) and `grep -rlE "^(sources|verified):" openwiki --include=*.md`
  finds nothing.
- T026 (SC-002): `node scripts/check-openwiki-okf.mjs` → `✅ 75 concepts conformant across 8 directories.`,
  **exit 0** (it exited 1 with 52 V17 findings at T005). **SC-006**: `time node scripts/check-openwiki-okf.mjs`
  → real 0.776 s (under 5 s).
- **SC-007**: `du -sh openwiki` **6.9M before** retirement → **2.1M after**.
- T027: V12, its self-test scenarios, the `unstampable` counter and its two unit tests and fixture removed;
  `scripts/openwiki-drift.mjs` and its test deleted; `--all-fresh` removed from `wiki-refresh.mjs`, its
  tests and the contract (now exit 2). `grep -rn "openwiki-drift" scripts .forgejo` finds nothing.
  `--selftest`, the real tree and `wiki-refresh.test.mjs` (11 / 11 / 0 / 0) all pass;
  `check-openwiki-okf.test.mjs` 27 / 27 / 0 / 0 — its real-bundle test, red since T005, is green.

## T030 — the tiers this diff touches

| Check | Result |
|---|---|
| `check-openwiki-okf.mjs` / `--selftest` | 0 / 0 |
| `check-openwiki-governance.mjs` / `--selftest` | 0 / 0 |
| `wiki-maintain.mjs --selftest` | 0 |
| `node --test 'scripts/__tests__/wiki-*.test.mjs' 'scripts/__tests__/*openwiki*.test.mjs'` | **tests 287 · pass 287 · fail 0 · skipped 0** (baseline 412 / 0 skip; the drop is the 9 deleted test files) |
| `node --test 'scripts/__tests__/*.test.mjs'` | **tests 1910 · pass 1910 · fail 0 · skipped 0** (baseline 2035 / 0 skip) |
| `CI=true pnpm install --frozen-lockfile` (worktree) | exit 0, 5 m 59.7 s |
| `pnpm nx affected -t lint test --base=origin/main --skip-nx-cache` | exit 0 — affected set is `["infrastructure-as-code"]`, which defines no `lint`/`test` target: **0 tasks** (an honest no-op, not a pass of anything) |
| `pnpm nx run-many -t okf-lint okf-governance -p infrastructure-as-code --skip-nx-cache` | **2 tasks: 2 succeeded** — the targets that actually gate this diff |

Skip count: 0 everywhere, no higher than the T001 baseline (0).
