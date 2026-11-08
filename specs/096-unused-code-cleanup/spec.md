# Spec 096: Unused code removed, and four backup suites fail by name

**Status**: Complete | **Date**: 2026-11-08 | **Input**: implementation review, 2026-11-08 (unused-files step)

## Problem

The review looked for unused files and code across the repository. Every file under `scripts/` and `tools/`
is referenced, `verify/` and the spec `HANDOFF*.md` notes are cited by runbooks and the wiki, and
`assets/android-adaptive-icon/` is the icon's documented source bundle. Rust dead code fails clippy
`-D warnings`, and Python unused imports fail ruff `F401`.

TypeScript is the gap: `@typescript-eslint/no-unused-vars` only warns, and the `mcm-app` lint target covers
`src/` only. 15 unused symbols had built up. Four of them were not cosmetic. `backup-destination-probe`,
`backup-destinations-authz`, `backup-jobs-authz` and `backup-restore-routes` import
`assertBackupTargetsPresent` but never call it. The helper's contract is "put it at the top of every suite
that needs the targets". Without it, a run with `MCM_REQUIRE_BACKUP_TARGETS=1` and the targets down fails
as dozens of connection errors instead of one assertion naming the missing input.

## Requirements

- **FR-001**: The 15 unused symbols reported by `eslint .` in mcm-app MUST be removed.
- **FR-002**: The four backup suites MUST call `assertBackupTargetsPresent()` in a top-level `beforeAll`,
  as the other ten suites do.
- **FR-003**: No behaviour change. The one production edit (`assistant-panel.tsx`) removes two unused imports.

## Success criteria

- **SC-001**: `eslint .` in mcm-app reports 0 `no-unused-vars`.
- **SC-002**: mcm-app lint and typecheck pass, as do the touched unit suites.

## Out of scope

- Linting `tests/` in CI. `eslint .` reports 18 errors there, mostly `expo/no-dynamic-env-var`, an app-code
  rule that does not fit test configuration. That is its own decision: item #962.
