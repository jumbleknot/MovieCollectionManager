# Quickstart: validating the repo-scoped evidence package

## Prerequisites

- A checkout with `node_modules` installed (the retention script imports `yaml`).
- For the live checks only: `MCM_FORGE_URL` and a read token (`MCM_FORGE_TOKEN`), as in
  [docs/runbooks/ci-diagnostics.md](../../docs/runbooks/ci-diagnostics.md).

## 1. Offline: the unit tiers (before the PR)

```bash
node --test scripts/__tests__/ci-failure-digest.test.mjs scripts/__tests__/ci-status.test.mjs scripts/__tests__/registry-retention.test.mjs
node scripts/ci-failure-digest.mjs --selftest
node --test scripts/__tests__/*.test.mjs        # full suite: no failure that main does not also have
```

Expected: the three files pass. The new cases cover naming, the exact-name filter against a
`belay-ci-failures` decoy, fallback fetch, per-package durations URLs, both-name prune, and the guard
on both names.

## 2. Config: the retention report (before the PR)

```bash
node scripts/registry-retention.mjs --package mcm-ci-failures
node scripts/registry-retention.mjs --package ci-failures
```

Expected: both load without a `ConfigError`. Before cutover the first reports no versions and the
second reports today's set, all `keep:*`.

## 3. Live: after merge (the cutover)

1. The first failing job on `main` (or a dispatched run of a job that fails) posts a digest whose
   reference reads `mcm-ci-failures:<runId>--<job>`.
2. `node scripts/ci-status.mjs failure --run <that run> --job <job> --full` retrieves it.
3. `node scripts/ci-status.mjs failure --run <a pre-cutover run> --job <job> --full` still retrieves
   that run from the legacy package.
4. `node scripts/ci-status.mjs durations --job app-e2e` reports the same sample size as before cutover.
5. List the owner's generic packages and confirm that no new `ci-failures` version is dated after the
   cutover.

## 4. Transition end (cutover + 30 days)

List `ci-failures`. When it returns 0 versions, the backlog item filed at close-out removes the legacy
name (see the [contract](contracts/evidence-package.md), "Transition end").
