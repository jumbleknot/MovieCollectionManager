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
