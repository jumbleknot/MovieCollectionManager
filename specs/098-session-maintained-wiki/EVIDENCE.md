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
