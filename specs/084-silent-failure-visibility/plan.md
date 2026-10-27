# Implementation Plan: Silent-failure visibility — backups, deploys and app-image scans

**Branch**: `084-silent-failure-visibility` | **Date**: 2026-10-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/084-silent-failure-visibility/spec.md`

## Summary

This feature makes three silent failures loud, and removes the two size defects the measurement
found:

- **Backups (US1)**:
  - The host-only backup script and its units move into `infrastructure-as-code/backup/`, starting
    from a byte-for-byte copy.
  - A failed or hung run opens or updates one p1 backlog item, through systemd `OnFailure` and a 2 h
    start timeout.
  - A separate 6-hourly timer reds the same item when the newest snapshot is older than 36 h, or
    when its age cannot be read.
  - Every dump goes through one `run_dump` path, so a failing forge dump can no longer skip the
    others.
  - Each dump is checked in its own format, against a minimum size and against a shrink of more than
    50 % from the previous good run.
- **Backup size (US4)**: two causes, each fixed at its source.
  - **The forge.** Its data is about 21.8 G of CI artifacts, packed into a gzip stream that
    de-duplicates nothing. `forgejo dump` becomes a `pg_dump -Fc` plus an uncompressed tar of
    `/data`, without artifacts, packages, indexers or queues. Upload artifacts get a deliberate
    14-day retention, and PR #864 fixes the Maestro accumulation.
  - **Komodo.** Its 2 GB is `pg_cron` run history (about 89,000 rows a day, mostly two jobs that
    run every 2 seconds): the dump excludes that table's data, and an hourly pg_cron job purges
    history older than 3 days.
- **Deploys (US2)**: `ci-status` resolves the dispatched `cd-deploy` run by `head_sha`, shows it as an
  advisory context, makes `watch` return on its failure, and falls back to its `ci-failures/<run_id>`
  bundle.
- **App-image scan (US3)**: `scan-push.sh`'s per-image block becomes a shared
  `scripts/cd/scan-app-image.sh`. A new required job, `app-image-scan`, runs it on the six images
  `app-e2e` already built, which are handed over through run-scoped tags. A guard fails if the two
  gates diverge.
- **Registry (US5)**: a repository script with a committed YAML config, report-only by default and
  run weekly. It protects every deployed and rollback digest (read from git) and the dev-container
  pin, and keeps the `ci-failures` evidence window.

Design decisions and their rejected alternatives: [research.md](./research.md) R1–R13.

## Technical Context

**Language/Version**:
- Bash, for the host scripts and the CI step scripts.
- Node 24 ESM, for `ci-status.mjs`, `registry-retention.mjs` and the tests, using built-ins plus the
  repository's existing `yaml`.
- systemd user units, on the prod host.
- SQL, for the pg_cron retention.

**Primary Dependencies**: restic with an rclone backend, which is already on the host; Trivy, through
the existing `scripts/infra-image-scan.mjs`; the Forgejo 15 REST API (issues, actions runs,
packages).

**Storage**: the NAS restic repository; the forge's package registry; local state files under
`~/backup/state/`.

**Testing**:
- `node --test scripts/__tests__/*.test.mjs` (guardrails), with behavioural tests that run the bash
  scripts against fake `docker`/`restic`/`curl` shims on `PATH`, the way
  `ci-maestro-debug.test.mjs` does.
- Workflow guards that parse the YAML.
- Recorded API fixtures for `ci-status`.
- `node scripts/preflight.mjs --gates-only`.

**Target Platform**: the prod host (prod user, rootless Docker) for US1/US4; the Forgejo Actions ci
host (`kvm` runner, `ubuntu-latest` containers) for US2/US3/US5.

**Project Type**: operations tooling, meaning scripts, units, workflows and runbook. There is no
service code.

**Performance Goals**:
- The nightly run stays within 2 h; it measures 8–10 min today.
- New data stored per night is under 2 GiB (SC-008).
- `app-image-scan` adds no time to `app-e2e`.

**Constraints**:
- No secret in the repository.
- Every new credential is single-scope:
  - a host issue token (issues);
  - an optional host `read:package` token;
  - `REGISTRY_CLEANUP_TOKEN` (`write:package`).
- Every host step is done by the operator, through paste-safe blocks.
- Destructive tools are report-only by default and reject unknown arguments.

**Scale/Scope**:
- 8 dumps per night.
- 6 app images per PR.
- 9 packages and 3,657 versions at the first retention run.

## Constitution Check

*GATE: passed before Phase 0, and re-checked after Phase 1. No violations.*

| Principle | How this plan complies |
|---|---|
| SDD gate (CLAUDE.md) | This spec → plan → tasks set precedes all code. PR #864 is FR-019b of this spec. |
| AI Assistant Constraints: behavior-descriptive identifiers | `scan-app-image.sh`, `backup-staleness.sh`, `registry-retention.mjs`, `findDispatchedDeploy`. FR/US ids appear only in provenance comments. |
| Technology agnosticism | Tools, flags and paths live here and in research.md; spec.md stays at WHAT/WHY. |
| Security: no clear-text secrets; least privilege | Credentials are read live, or from mode-600 files. Each new token has one scope, and none decrypts backups (R3 rejects putting the restic password in CI). Alert bodies are passed through the repository's secret patterns. |
| TDD (NON-NEGOTIABLE) | Every task pairs a Verify RED with a Verify GREEN and a mutation. The host steps that cannot run in CI (installing, inducing a failure, the restore drill) are operator acceptance steps with expected output (quickstart), not substitutes for the tests. |
| Test Type Integrity | Shim-based bash tests and fixture-based `ci-status` tests are **unit** tests, and are named so. The restore drill and the PR mutation runs are real end-to-end checks against the real host and forge. |
| Logging & Monitoring: actionable ERRORs, no secrets in logs | Each alert is an actionable item, and the journal tail is filtered. Komodo run-history retention is 3 d. That table is bookkeeping a vendored extension writes inside its own database, not a service log stream and not an audit log, so neither the 30-day operational nor the 90-day audit minimum applies. Confirmed by the operator 2026-10-27: internal bookkeeping, 3-day purge. |
| Logging & Monitoring: structured format for production services | The backup, alert and staleness scripts are operator tooling run by systemd, not services. Their plain-text journal output is read by the operator, and their machine-read record is the `dump-manifest.tsv` table. The structured-log rule for production services therefore does not apply. |
| Docker-native operations | Dumps run `docker exec` inside the existing containers. The pg_cron job lives in Komodo's own Postgres. |
| Guard rules (CLAUDE.md) | Changing scan-push gets the drift guard updated at the cause, never removed. New CI steps are calibrated, or listed ON THE BACKSTOP, in `ci-step-ceilings.tsv`. Mobile scripts appear in both path filters. |

## Project Structure

### Documentation (this feature)

```text
specs/084-silent-failure-visibility/
├── plan.md               # this file
├── research.md           # R1–R13 decisions
├── data-model.md         # manifest, alert item, deploy context, retention config
├── quickstart.md         # host facts (step 0) + per-story validation
├── contracts/
│   └── cli-contracts.md  # every new/changed CLI: args, exits, report-only defaults
└── tasks.md              # /speckit-tasks
```

### Source code (repository root)

```text
infrastructure-as-code/backup/            # NEW — US1/US4
├── backup.sh                             # verbatim host copy first (T001), then run_dump/check_dump/manifest
├── backup-alert.sh                       # open-or-comment the single p1 item
├── backup-staleness.sh                   # 36 h check, independent of the run
├── homelab-backup.service / .timer       # + OnFailure, TimeoutStartSec=2h
├── homelab-backup-alert@.service
├── homelab-backup-staleness.service / .timer
├── komodo-cron-retention.sql             # idempotent pg_cron purge job
├── INSTALLED.sha256                      # host ↔ repo comparison (R6)
└── README.md                             # install block → runbook
infrastructure-as-code/forgejo/registry-retention.yaml   # NEW — US5 config

scripts/
├── backup-install-manifest.mjs           # NEW — regenerates INSTALLED.sha256
├── ci-status.mjs                         # US2: findDispatchedDeploy, watch exit, bundle fallback
├── cd/scan-app-image.sh                  # NEW — US3 shared scan step (extracted from scan-push.sh)
├── cd/scan-push.sh                       # calls scan-app-image.sh
├── registry-retention.mjs                # NEW — US5
├── ci-maestro-debug.sh                   # PR #864 (FR-019b)
└── __tests__/
    ├── helpers/host-shims.mjs            # NEW — fake docker/restic/curl/systemctl on PATH (T003)
    ├── host-shims.test.mjs               # NEW — the helper's own tests
    ├── backup-install-manifest.test.mjs  # NEW — INSTALLED.sha256 and secret-pattern copy pinned
    ├── backup-staleness.test.mjs         # NEW
    ├── backup-units.test.mjs             # NEW
    ├── komodo-cron-retention.test.mjs    # NEW
    ├── backup-script.test.mjs            # NEW — guards + shim behaviour (US1/US4)
    ├── backup-alert.test.mjs             # NEW — dedupe, reasons, token-file errors
    ├── ci-status.test.mjs                # + dispatched-deploy fixtures (US2)
    ├── app-image-scan.test.mjs           # NEW — drift guard + job wiring (US3)
    ├── upload-artifact-retention.test.mjs# NEW — every upload has retention-days ≤ 30 (FR-019c)
    ├── registry-retention.test.mjs       # NEW — protection, rules, config validation (US5)
    └── fixtures/ci-status/dispatched-*.json

.forgejo/workflows/
├── app-ci.yml                            # US3 job + run-scoped tags + trigger-cd needs; FR-019c retention-days
├── cd-deploy.yml                         # FR-019c retention-days on its uploads
└── registry-retention.yml                # NEW — weekly + dispatch, report-only

docs/runbooks/Server-Setup-Runbook.md     # Backups section rewrite + case study + restore-drill log (FR-005/006/017)
docs/runbooks/ci-diagnostics.md           # ci-status deploy context + app-image-scan red meanings
```

**Structure decision**: the host artefacts get their own `infrastructure-as-code/backup/` directory,
next to the other operator-installed stacks. The CI-side code follows the existing `scripts/` +
`scripts/__tests__/` convention.

## Delivery: five PRs

The spec says one story per PR. PR #864 is already open as part of US4. Each story's backlog item is
closed only once its criteria are verified (on the host where needed), not when its PR merges.

| PR | Story | Depends on | Closes (after verification) |
|---|---|---|---|
| #864 (open) | US4 · FR-019b Maestro scope | — | — |
| A | US1 backups visible | — | #830 (with B) |
| B | US4 backup size, Komodo retention, artifact retention | A (same script) | #830 |
| C | US2 ci-status deploy visibility | — | #823 |
| D | US3 PR app-image scan | — | #822 |
| E | US5 registry retention, report-only, then a one-line `mode: apply` PR | — | #863 |

PRs A and B touch the same files, so B is opened after A merges. C, D and E are independent and
batch-safe, but each opens on its own (spec delivery). D adds a required context, so the operator's
branch-protection change lands **with** its merge: the fallback globs are updated in the PR, and
branch protection is updated by the operator.

## Risks

| Risk | Mitigation |
|---|---|
| The new forge backup misses something `forgejo dump` included. | The restore drill (FR-006, T039) runs against the **new** format. Until it passes, the old-format snapshots are still within retention (7 daily, 4 weekly, 6 monthly) and are the fallback. R7's table classifies every directory in `/data`. |
| `retention-days` is ignored by Forgejo 15. | The server default carries it (R9). The two are distinguished at quickstart 0e. |
| The retention script deletes a needed image. | Report-only first. The protected-set preflight exits 5 on any unresolved digest. The rollback test runs after the first apply. |
| `app-image-scan` reds on a vulnerability-database change unrelated to the PR. | Same allowlist and expiry flow as the deploy gate. The spec accepts this (US3 edge case), and US2 makes the deploy-side equivalent visible. |
| Host tools are missing. | Verified 2026-10-27: `curl`, `python3` and `restic` 0.18.1 are present, `jq` is not, so nothing depends on `jq`. The scripts still check at their top. |

## Complexity Tracking

No constitution violations to justify.
