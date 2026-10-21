# Tasks: Replace MinIO with RustFS

**Input**: Design documents from `/specs/080-minio-to-rustfs/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: REQUIRED. The constitution makes TDD non-negotiable and mandates the Verify RED / Verify
GREEN checkpoint format from `docs/templates/feature-test-tasks-template.md`. Every test task carries
a Verify RED; every paired implementation task carries a Verify GREEN. Compose, config, deletion and
documentation tasks use the template's **Done when** format.

**Total**: 48 tasks (T001–T048). **[OPERATOR]** marks a step only the operator can run (production
host, Komodo, the Dependency Dashboard). An agent never runs an [OPERATOR] step; it prepares the
command and reads back the evidence the operator pastes.

## Rules that apply to every task

- **`node --test` flags go BEFORE the path.** `node --test <file> --test-name-pattern x` silently runs
  everything (CLAUDE.md). Use `node --test --test-name-pattern "x" <file>`.
- **Read the test and skip counts.** A Verify RED with 0 failures is trivially passing and must be
  fixed first; a GREEN with skips proved nothing. Integration runs set `MCM_REQUIRE_LIVE_STACK=1`.
- **Work in a worktree** (`/home/coder/worktrees/080-rustfs`), never `/workspaces/mcm`. Any `pnpm nx`
  target needs a real `CI=true pnpm install --frozen-lockfile` in the worktree first.
- **The touchpoint list is measured, not remembered**: `git grep -il minio -- . ':!openwiki' ':!specs'
  ':!pnpm-lock.yaml'` — 72 files on `60d03774` (research R18). T030's guard is the final arbiter.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US5; setup, foundational and polish tasks carry none

---

## Phase 1: Setup and preconditions

- [x] T001 Rebase the branch on `main` **after item #642 (Langfuse 4.56.0) has merged**; resolve the
  Langfuse image lines in `infrastructure-as-code/docker/observability/compose.yaml` and
  `compose.prod.yaml` in #642's favour.

  **Done when**: `git log origin/main` contains #642's merge and the branch rebases cleanly onto it.

- [x] T002 Check item #552's precondition: `infrastructure-as-code/docker/stacks/mcm.env` holds
  `BACKUP_TEST_S3_ACCESS_KEY`, `BACKUP_TEST_S3_SECRET_KEY`, `BACKUP_TEST_WEBDAV_USER`,
  `BACKUP_TEST_WEBDAV_PASSWORD` (names only — never print values). If any is missing, **stop** and
  point at #552; do not hand-patch around it (research R17). CI is unaffected (mints its own).

  **Done when**: the four keys are present, or #552 is resolved first. **Done 2026-10-11**: all four
  keys are present in this dev container's `mcm.env`, and PR #724 (item #552) merged the generator fix.

- [x] T003 **[OPERATOR]** Early go/no-go on the production host, read-only, before any tool exists
  (research R6, R14). The agent prepares; the operator runs and pastes. The command must run under
  Alpine's BusyBox, which has **no `grep --include`**. The first attempt on 2026-10-10 used it: both
  grep calls failed, and the `0`s it printed were `wc -l` of empty output, not measurements. Hence
  the `find … -exec grep` form, and a **control count**: every `xl.meta` begins with the `XL2 `
  header, so `control` must equal `xl.meta files`, or the zeros below it mean nothing. Validated on a
  local MinIO drive: 36 / 36. Run it once per volume (`observability-langfuse-minio-data`, then the
  Nx cache `minio_minio-data`):

  ```sh
  docker run --rm -i -v <VOLUME>:/data:ro alpine:3.24 sh <<'EOS'
  cat /data/.minio.sys/format.json; echo
  echo "xl.meta files:         $(find /data -name xl.meta -type f | wc -l)"
  echo "control (XL2 header):  $(find /data -name xl.meta -type f -exec grep -l 'XL2 ' {} + | wc -l)"
  echo "SSE-marked xl.meta:    $(find /data -name xl.meta -type f -exec grep -lis 'X-Minio-Internal-Server-Side-Encryption' {} + | wc -l)"
  echo "tiered xl.meta:        $(find /data -name xl.meta -type f -exec grep -lis 'transition-status' {} + | wc -l)"
  echo "top level:             $(ls /data | tr '\n' ' ')"
  echo "size:                  $(du -sh /data | cut -f1)"
  echo "not owned by uid 1000: $(find /data ! -user 1000 | wc -l)"
  EOS
  ```

  **Result, 2026-10-11: GO.** Both drives pass. The operator ran the command on the prod host:

  | | `observability-langfuse-minio-data` | `minio_minio-data` (Nx cache) |
  |---|---|---|
  | format | `xl-single`, 1 set × 1 drive | `xl-single`, 1 set × 1 drive |
  | `xl.meta` files / control | 1076 / 1076 | 1113 / 1113 |
  | SSE / tiered | 0 / 0 | 0 / 0 |
  | top level | `langfuse` | `nx-cache` |
  | size | 558.3M | 399.2M |
  | not owned by uid 1000 | 0 | 2314 |

  The Nx-cache drive's ownership is expected, because the upstream `quay.io/minio/minio` image
  created it. The migration chowns the **copy** to the RustFS image's uid, never the original
  (research R5), so neither drive needs a pre-step.

  **Tool execution location — decided 2026-10-11:**
  - The tool runs **on the production host**, inside a pinned container image that carries `node` and
    the Docker CLI, with the host's rootless socket (`$XDG_RUNTIME_DIR/docker.sock`) mounted.
  - The operator invokes it through a wrapper script that T009 adds next to the tool.
  - It does **not** run from the dev container over `DOCKER_HOST=ssh://`. That would put standing
    control of the prod daemon (root-equivalent) into the assistant's sandbox, which this repository
    keeps free of prod credentials.
  - Nothing is installed on the host: the setup runbook provisions no `node` there.

  **Done when**:
  - Both volumes report `xl-single` with one set of one drive.
  - `control` equals `xl.meta files`.
  - 0 SSE and 0 tiered.

  **Any other result stops the feature for an operator decision** (spec Edge Cases). Do not proceed
  to Phase 2.

  **Amended 2026-10-11 (T009, research R19): the SSE and tiered zeros above are NOT evidence.**
  BusyBox `grep` in its default locale misses a marker that follows non-UTF-8 bytes, and every marker
  inside an `xl.meta` does. Measured on the deployed MinIO with one real SSE-S3 object: this exact
  command printed **0**, `LC_ALL=C` printed **1**, and the `XL2 ` control read 6 of 6 either way.
  - The format, set shape, size and ownership rows stand, because they do not use grep.
  - The GO is therefore **provisional**. The operator's advance tool `inventory` (T037, M0.4) is the
    first valid SSE and tiered measurement. It sets `LC_ALL=C` and self-tests the search, and it must
    report `migratable` before the window.

- [x] T004 Resolve the `rustfs/rustfs` pin: the newest 1.x past Renovate's 3-day cooldown (1.0.1 unless
  a later one qualifies), **index** digest via `docker buildx imagetools inspect`; re-scan it under the
  gate criterion (`aquasec/trivy:0.74.0 image --severity CRITICAL --ignore-unfixed`, ghcr DB mirrors);
  confirm `id -u` = 10001 and `curl` present. Record in research.md R4.

  **Done when**: one digest is chosen, 0 fixable Critical is observed (not inferred), and R4 is updated.

- [x] T005 Save the baseline touchpoint list
  (`git grep -il minio -- . ':!openwiki' ':!specs' ':!pnpm-lock.yaml'`) to the PR description and map
  every file to a task below or to a G2 exemption in `contracts/no-minio-guard.md`.

  **Done when**: every one of the files is mapped; an unmapped file becomes a task here before Phase 3.

---

## Phase 2: Foundational — the migration tool and the service contract guard

**⚠️ No story work starts until this phase is complete.**

- [x] T006 [P] Write `scripts/__tests__/object-store-migration.test.mjs` — pure logic of
  `scripts/object-store-migration.mjs` (data-model.md): `classifyDrive(formatJson, counts)` refuses
  `fs`, multi-set, multi-drive, SSE > 0, tiered > 0, notification config; accepts `xl-single`;
  `diffManifests(old, new)` names missing / unexpected / size / ETag mismatches; `checksumSample()` is
  deterministic and includes every multipart ETag (`-`); the argument parser **rejects** an unknown
  flag and refuses `copy` without `--apply` (CLAUDE.md: an unrecognised `--dry-run` once meant
  "delete for real" — use the repository's shared rejecting parser, `scripts/lib/argv-contract.mjs`).

  **Verify RED**:
  ```bash
  node --test scripts/__tests__/object-store-migration.test.mjs
  ```
  **Expected RED**: fails — `Cannot find module '../object-store-migration.mjs'`, then (with an empty
  stub exporting nothing) every case failing `is not a function`. Read the count: one file.

  **Done 2026-10-11.** RED, read:
  - With no module: `ERR_MODULE_NOT_FOUND: Cannot find module '…/scripts/object-store-migration.mjs'`
    (1 file failed).
  - With an empty stub: `SyntaxError: The requested module '../object-store-migration.mjs' does not
    provide an export named 'ACCEPTED_FLAGS'`. ESM named imports fail at link time, so this is not
    the `is not a function` the task predicted.

  One case was added after T009 found the grep defect (research R19): `classifyDrive` refuses on a
  failed or missing instrument self-test. Its RED: 2 of 41 failing. The real-compose case of
  `pinnedRustfsRef` lives in T010's guard instead, so this file stays independent of compose.

- [x] T007 Implement the pure logic in `scripts/object-store-migration.mjs` (exports + parser + `main`
  guarded so importing has no side effects).

  **Verify GREEN**: same command → all pass, 0 skipped. Regression:
  `node --test scripts/__tests__/*.test.mjs` → no new failures.

  **Done 2026-10-11.** GREEN: 41 tests, 41 pass, 0 fail, **0 skipped**. Regression
  `node --test scripts/__tests__/*.test.mjs`: see T028 for the final count.

- [x] T008 Write `scripts/__tests__/object-store-migration.rehearsal.mjs` (deliberately **not**
  `*.test.mjs`, so `guardrails`' glob — which has no Docker — does not run it; research R13). Skips
  without a Docker daemon **unless** `MCM_REQUIRE_LIVE_STACK=1`, which turns the skip into a failure.
  Scenario: seed a scratch volume with the **currently deployed** MinIO
  (`${REGISTRY_HOST}/jumbleknot/minio@sha256:8054a7ce…`) — bucket `langfuse` with an inline object, a
  2 MB object, a ≥ 70 MB multipart object, 50 small JSON objects under deep prefixes; a second bucket
  with versioning on, two versions and a delete marker → `manifest` → stop → `inventory` (migratable)
  → `copy --apply` → start RustFS (pinned, no `user:`) → `verify` (pass) → source `treeDigest`
  unchanged → stop RustFS, **start MinIO on the original** and re-read every object (rollback). Plus:
  RustFS on a **fresh** volume becomes healthy; negative fixtures — a drive whose `format.json` says
  `"fs"`, and one `xl.meta` carrying `X-Minio-Internal-Server-Side-Encryption` — make `inventory`
  refuse. Every scratch volume/network is prefixed and removed in a `finally`.

  **Verify RED**:
  ```bash
  MCM_REQUIRE_LIVE_STACK=1 node --test scripts/__tests__/object-store-migration.rehearsal.mjs
  ```
  **Expected RED**: fails at the first Docker-driving subcommand (`inventory`/`manifest`/`copy`/
  `verify` not implemented). 0 skipped.

  **Done 2026-10-11.** **Deviation**: the Docker subcommands were written in the same sitting as
  T007, so the first RED is not "subcommand not implemented". The real first RED was 16 of 16
  failing, **0 skipped**, on
  `AssertionError: compose.prod.yaml carries no digest-pinned rustfs/rustfs image`. The rehearsal and
  the wrapper read the pin from `compose.prod.yaml`, and T018 had not run yet.

  T009's four mutations stand in as the evidence that this file detects real defects.

  Additions beyond the task:
  - Wrapper coverage: `object-store-migration.sh` runs `inventory` to the same digest and refuses
    `copy` without `--apply`.
  - "copy refused while the source is still mounted".
  - The old credential pair is rejected by RustFS.
  - A lifecycle negative control: a lifecycle rule must not read as versioning.
  - A notification-target refusal.
  - A **real** SSE-S3 fixture, written by the deployed MinIO with a static KMS key.

- [x] T009 Implement the Docker-driving subcommands `inventory`, `manifest`, `copy`, `verify`,
  `rehearse` (research R12): Docker via the CLI only (`DOCKER_HOST` honoured); S3 calls inside
  `docker run --rm --network <net> <pinned rustfs> curl --aws-sigv4 …` with credentials passed by
  **name** (`-e S3_SECRET_KEY`) from the caller's environment, never as a value in argv; `copy` refuses
  an existing target, mounts the source `:ro`, reads the runtime uid from the image, chowns, counts
  non-owned entries, re-digests the source.

  **Verify GREEN**: T008's command → all pass, **0 skipped**; attach the output to the PR.
  **Mutation checks** (each must turn the rehearsal RED, then revert): (a) drop the chown → owner
  count / RustFS start fails; (b) mount the source read-write and touch a file → source digest
  assertion fails; (c) make `verify` ignore ETags → a planted ETag mismatch passes unnoticed → the
  rehearsal's planted-mismatch case fails. Regression: `node --test scripts/__tests__/*.test.mjs`.

  **Done 2026-10-11.** `MCM_REQUIRE_LIVE_STACK=1 node --test scripts/__tests__/object-store-migration.rehearsal.mjs`
  → **17 tests, 17 pass, 0 fail, 0 skipped**, in about 36 s. All scratch containers and volumes were
  removed afterwards.

  Mutations: each one turned the rehearsal RED, then was reverted.

  | Mutation | Result |
  |---|---|
  | (a) drop the chown | 4 fail: the copy reports non-owned entries; RustFS never becomes ready on the copy |
  | (b) mount the source rw and touch a file | 2 fail: `sourceDigestBefore != sourceDigestAfter`, and "the source drive is byte-identical" |
  | (c) `verify` ignores ETags | 1 fail: the planted-mismatch case |
  | (d) **added**: drop `LC_ALL=C` | 4 fail, including the real-SSE fixture |

  **Finding (research R19)**: BusyBox `grep` in its default locale misses markers inside binary
  `xl.meta`. On one real SSE-S3 object it counted **0** in the default locale and **1** with
  `LC_ALL=C`; the `XL2 ` control read 6 of 6 either way.
  - T003's SSE and tiered zeros are therefore **not evidence**, and T003's GO is provisional until the
    operator's tool `inventory` (T037) passes.
  - `inventory` now sets `LC_ALL=C` and runs a self-test on a planted marker that follows high bytes.

  The prod wrapper `scripts/object-store-migration.sh` copies the CLI out of
  `docker:29.8.2-cli@sha256:35cfcf89…`, runs the tool in
  `node:24.21.0-alpine3.23@sha256:9ec4a2e2…`, and moves files with `docker cp`, not bind mounts.
  `--network` was added to `manifest`/`verify`; it is required, never inferred.

- [x] T010 [P] Write `scripts/__tests__/object-store-service.guard.test.mjs` asserting, for every
  compose service whose image is `rustfs/rustfs` (contracts/object-store-service.md S1–S8): digest
  pinned to the index digest, identical across files; **no `user:` key**; `RUSTFS_ACCESS_KEY` /
  `RUSTFS_SECRET_KEY` set (no `MINIO_*` alias, secret is `${…:?…}`); healthcheck is the S4 form;
  `RUSTFS_OBS_LOG_DIRECTORY: ""`; no container port 9001 published; prod services `restart: always`;
  init services reference credentials only as `$$VAR` (no `${…}` interpolated into `entrypoint` /
  `command`). Instrument check: asserts it found ≥ 1 RustFS service in each of the three compose files.

  **Verify RED**:
  ```bash
  node --test scripts/__tests__/object-store-service.guard.test.mjs
  ```
  **Expected RED**: fails on the instrument check — 0 RustFS services in `observability/compose.yaml`,
  `observability/compose.prod.yaml`, `backups/compose.yaml`.

  **Done 2026-10-11.** RED: 34 tests, **24 fail**, 10 pass. The 10 passed vacuously: their loops
  matched zero RustFS services, and the instrument check is the case that failed for that reason.
  GREEN after T012/T017/T018: 34 pass, 0 fail, 0 skipped. Two clauses were added beyond the task:
  `RUSTFS_CONSOLE_ENABLE: "false"` (T011b), and the S9 external-volume shape.

- [x] T011 Measure the three open items in the contract on the pinned image (research R7, R8, R10):
  (a) does `/health/ready` return non-200 while the drive initialises (start on a large copied drive
  and poll from t=0)? (b) the console-disable variable for this version and that `:9001` is then
  closed; (c) `sleep` present for `exec sleep infinity`. Amend `contracts/object-store-service.md` S4/S7
  and research.md if any answer differs.

  **Done when**: three measured answers are recorded, and the contract matches them.

  **Done 2026-10-11.** Measured on the pinned image:
  - (a) Readiness, on a migrated drive of 5,001 objects / 300 MB, polled every 50 ms from before the
    container existed: `/health/ready` answered `503` while the server initialised. It turned `200` in
    the same poll as an authenticated `HEAD /langfuse` and a listing, never before them. S4 stands.
  - (b) `RUSTFS_CONSOLE_ENABLE=false`. With it unset, the console is ON and `:9001` listens; with
    `false`, `:9001` is closed (curl exit 7).
  - (c) `/bin/sleep` (coreutils) is present, and `sleep infinity` runs.

  The contract S4/S7 and research R7/R8/R10 now record these answers.

**Checkpoint**: tool rehearsed end to end; contract guard RED and waiting for compose.

---

## Phase 3: User Story 2 — Backups proven against a real RustFS (Priority: P1) 🎯

**Goal**: the backup S3 test destination is RustFS; every S3-using integration suite passes with 0
skips; driver logic unchanged.

**Independent Test**: fresh `backups` stack → `test:integration` with skipping forbidden → skip count 0.

- [x] T012 [US2] `infrastructure-as-code/docker/backups/compose.yaml`: `mcm-bff-backup-minio{,-init}`
  → `mcm-bff-backup-rustfs{,-init}` per contract S1–S8 (no `user:`, `RUSTFS_*` creds from
  `BACKUP_TEST_S3_*`, S4 health, S5 one-shot init exiting 0, S6 logs, drop `127.0.0.1:9101`, keep
  `127.0.0.1:9100:9000`); volume `mcm-bff-backup-rustfs-data`; drop `REGISTRY_HOST` and the header
  comments that justify it; rewrite the "reuses the from-source MinIO image" comment.

  **Verify GREEN** (T010, backups half): `node --test --test-name-pattern "backups" scripts/__tests__/object-store-service.guard.test.mjs` → pass.

  **Done 2026-10-11.** GREEN on the backups half: 10/10. Fresh volume measured: `mcm-bff-backup-rustfs`
  is healthy as uid 10001, the init exits 0 (`mcm-backups-test bucket ready`), the only port is
  `127.0.0.1:9100`, and neither container's argv holds the secret (checked against the value
  without printing it).

- [x] T013 [P] [US2] `scripts/gen-dev-env.mjs` (lines ~173, ~501) and `scripts/gen-ci-env.mjs` (~68):
  `mcm-bff-backup-minio` → `mcm-bff-backup-rustfs` in `BACKUP_ALLOWED_DESTINATION_HOSTS` and
  `BACKUP_TEST_S3_INTERNAL_ENDPOINT`. Regenerate local env with the documented generator.

  **Done when**: `node scripts/gen-dev-env.mjs` output and `frontend/mcm-app/.env.local` carry the new
  host; `frontend/mcm-app/src/bff-server/unit-tests/backup-destination-url-guard.test.ts` still passes
  (`pnpm nx test mcm-app -- --testPathPattern='backup-destination-url-guard'`).

  **Done 2026-10-11, with an added fix.** The generator change alone did NOT update an existing
  `.env.local`: `BACKUP_TEST_S3_INTERNAL_ENDPOINT` and `BACKUP_ALLOWED_DESTINATION_HOSTS` are
  seeded-once defaults there, so every existing dev box kept the old host. Measured: after
  `node scripts/gen-dev-env.mjs`, `.env.docker` carried `mcm-bff-backup-rustfs` but `.env.local`
  still carried the old name.
  - Fix: `syncEnvFile` now upgrades a seeded value only when it is byte-equal to the PRE-080
    default; a customised value is untouched.
  - Two tests in `gen-dev-env.guard.test.mjs`: RED 1/2, then GREEN 19/19.
  - After a re-run, both files carry the RustFS host.
  - `backup-destination-url-guard` unit test: see T035's mcm-app run.

- [x] T014 [P] [US2] Integration tier and comments:
  `frontend/mcm-app/tests/integration/setup/preflight.global.js` probes `/health/ready` labelled
  `Backup S3 (RustFS)`; `backup-destination-probe.integration.test.ts` default endpoint and its
  unreachable-port case use `mcm-bff-backup-rustfs`; comments naming MinIO as the oracle in
  `backup-driver-s3.integration.test.ts`, `backup-account-deletion`, `backup-destinations-authz`,
  `backup-jobs-authz`, `backup-restore-routes`, `backup-retention`, `backup-runner`,
  `account-deletion` suites, `tests/e2e/web/backups.spec.ts`,
  `src/bff-server/backup-driver-s3.ts`, `backup-request-signer.ts`,
  `unit-tests/backup-request-signer.test.ts`, `src/types/backups.ts`. **No logic change** in the
  driver or signer (FR-018) — `git diff` of those two files shows comment lines only.

  **Done when**: the listed files contain no MinIO reference and the driver/signer diff is comments only.

  **Done 2026-10-11.** No MinIO reference is left in the listed files. In the driver and signer the
  `git diff` changes comment lines only (checked: no non-comment `+`/`-` lines).

- [x] T015 [US2] `.forgejo/workflows/app-ci.yml`, step "Bring up the backup destinations" (~683–780):
  container names in both wait loops, `BACKUP_TEST_S3_INTERNAL_ENDPOINT` (~967, ~1041), the failure
  log-dump list (~1328); remove `REGISTRY_HOST: ${{ vars.REGISTRY }}`, its "unset" check and the
  comments about anonymously pulling `jumbleknot/minio`; rewrite the step-split comment.
  `scripts/ci-step-ceilings.tsv` (~48): comment; leave the ceiling unless a measured run exceeds it.

  **Done when**: no MinIO or `REGISTRY_HOST` reference remains in that step, and
  `node --test scripts/__tests__/*.test.mjs` (which includes the step-ceiling guards) passes.

  **Done 2026-10-11.** The step has no MinIO or `REGISTRY_HOST` reference left, and the YAML
  parses. `node --test scripts/__tests__/*.test.mjs` passes, including the step-ceiling guards.
  The ceiling is unchanged, because there is no measured run yet; see T035.

- [x] T016 [US2] Local proof, fresh volumes: `docker compose -p mcm --env-file
  infrastructure-as-code/docker/stacks/mcm.env -f infrastructure-as-code/docker/backups/compose.yaml
  up -d` after removing any old `mcm-bff-backup-minio*` containers and volume; wait for
  `mcm-bff-backup-rustfs` healthy and the init exit 0; then

  ```bash
  MCM_REQUIRE_LIVE_STACK=1 MCM_REQUIRE_BACKUP_TARGETS=1 pnpm nx test:integration mcm-app
  ```

  then `tests/e2e/web/backups.spec.ts` via the Playwright image recipe (docs/runbooks/e2e-testing.md).

  **Done when**: integration reports 0 failed and **0 skipped** — and the 14 S3-using suites
  (research R16) are each in the passed list — and the backups E2E passes. Paste counts into the PR.

  **Done 2026-10-11, all REAL, nothing skipped.**
  - Stacks: auth was brought up with the documented `up-auth` command. mcm (`app` + `bff-nonsecure`)
    was built from this worktree (`nx build mc-service`, `nx docker-build mcm-app`). The backups stack
    runs on a fresh RustFS volume.
  - The old backup-destination containers were removed. Their volume `mcm_mcm-bff-backup-minio-data`
    was **kept**, because this session did not create it.
  - `MCM_REQUIRE_LIVE_STACK=1 MCM_REQUIRE_BACKUP_TARGETS=1 pnpm nx run mcm-app:test:integration`:
    **58 suites passed of 58; 401 tests passed of 401; 0 failed, 0 skipped.**
  - Every suite that imports the backup-targets gate is in the passed list. That is **15** suites:
    the 14 S3 suites of research R16, plus `backup-driver-webdav`.
  - `backups.spec.ts`, run in `mcr.microsoft.com/playwright:v1.63.0-noble` from a staged named volume
    with both env files and `E2E_REQUIRE_BACKUP_TARGETS=1`: **9 passed, 0 skipped**.

**Checkpoint**: US2 provable on its own; CI's `app-e2e` proves it again (T035).

---

## Phase 4: User Story 1 — Production Langfuse on RustFS, data preserved (Priority: P1)

**Goal**: Langfuse dev and prod use RustFS; dev's real data migrated by the tool; prod ready to cut over.

**Independent Test**: dev migration with parity pass and both trace kinds loading.

- [x] T017 [US1] `infrastructure-as-code/docker/observability/compose.yaml`: `langfuse-minio{,-init}` →
  `langfuse-rustfs{,-init}` (contract S1–S8, dev one-shot init); `LANGFUSE_S3_{EVENT,MEDIA}_UPLOAD_*`
  endpoint `http://langfuse-rustfs:9000`, access key `langfuse`, secret
  `${LANGFUSE_RUSTFS_SECRET_KEY:?…}`, path-style and bucket unchanged; both `depends_on` blocks;
  volume `langfuse-rustfs-data`; drop `REGISTRY_HOST`.

  **Verify GREEN** (T010, dev half): `node --test --test-name-pattern "observability/compose.yaml" scripts/__tests__/object-store-service.guard.test.mjs`.

  **Done 2026-10-11.** GREEN on the dev half.

- [x] T018 [US1] `infrastructure-as-code/docker/observability/compose.prod.yaml`: same, prod shape —
  `restart: always`; init keeps "touch `/tmp/ready`, `exec sleep infinity`" + marker healthcheck,
  dependants on `service_healthy`; volume `langfuse-rustfs-data` → `external: true`, name
  `observability-langfuse-rustfs-data` (contract S9 — **never** created by compose); drop
  `REGISTRY_HOST`; header comment's "minio/mc" vendor-tool note.

  **Verify GREEN** (T010 fully): `node --test scripts/__tests__/object-store-service.guard.test.mjs` → all pass.

  **Done 2026-10-11.** GREEN on the full guard: 34/34.

- [x] T019 [US1] **Verify RED first, with the existing guard**: after T018, run

  ```bash
  node --test scripts/__tests__/komodo-stack-env.guard.test.mjs
  ```
  **Expected RED**: `prod-observability` requires `LANGFUSE_RUSTFS_SECRET_KEY`, not supplied by its
  `environment` block (feature 069 R9's guard doing its job).

  Then `infrastructure-as-code/komodo/stacks.toml` `prod-observability`: add
  `LANGFUSE_RUSTFS_SECRET_KEY=[[LANGFUSE_RUSTFS_SECRET_KEY]]`; remove `LANGFUSE_MINIO_ROOT_PASSWORD`
  and `REGISTRY_HOST` lines (the revert restores them for rollback — research R11); update the
  "13 LangFuse/Unleash Variables" comment. `stacks/observability.env.example`: rename the variable
  (`<generate:b62-32>`), delete the `REGISTRY_HOST` block; `stacks/mcm.env.example`: delete the
  `REGISTRY_HOST` MinIO paragraph (keep the key only if another `mcm` service needs it — check);
  update `komodo-stack-env.guard.test.mjs`'s header comment.

  **Verify GREEN**: same command → pass. Then `node scripts/gen-dev-secrets.mjs` on a scratch copy
  produces the new key.

  **Done 2026-10-11.** RED as predicted:
  `prod-observability: … requires ${LANGFUSE_RUSTFS_SECRET_KEY:?…} but neither its environment block
  nor its additional_env_files supply it`.
  - It also failed `the guard detects a removed variable`, whose mutation subject was the
    `REGISTRY_HOST` line that this change removes. That test was updated at the cause, to use the new
    variable as its subject.
  - GREEN: 3/3.
  - `gen-dev-secrets.mjs --stack=observability`, run on a scratch copy, seeded
    `LANGFUSE_RUSTFS_SECRET_KEY` with a value of 20 characters or more.
  - `mcm.env.example`: the `REGISTRY_HOST` key was removed, because no mcm-stack dev service
    interpolates it. The prod composes get it from Komodo.

- [x] T020 [P] [US1] Gates: `scripts/check-resource-naming.mjs` (~36) — `langfuse-rustfs{,-init}` into
  `NAME_ALLOWLIST` (Rule 3 vendor bundle; `mcm-bff-backup-rustfs*` already match `IDENTIFIER_RE`), and
  the four retired MinIO keys into `RETIRED_KEYS` (Rule 4: a missed reference resurrected as a network
  alias must fail loudly — this is the one live-code place MinIO names stay, exempted by line in G2);
  `scripts/check-prod-restart-policy.mjs` self-test fixtures (~100, ~108); `scripts/check-no-inline-secrets.mjs`
  comment (~32) and fixture value (~195).

  **Verify RED**: before editing, `node scripts/check-resource-naming.mjs` → **Expected RED**: fails
  naming `langfuse-rustfs` / `langfuse-rustfs-init` as not matching the identifier format (they are
  not yet in `NAME_ALLOWLIST`).
  **Verify GREEN**: the three checks and `node --test scripts/__tests__/*.test.mjs` pass.

  **Done 2026-10-11.** RED: `check-resource-naming.mjs` exited 1 with 4 violations
  (`langfuse-rustfs`/`-init` in both observability files). GREEN: all three gates and their
  `--selftest`s exit 0.

- [x] T021 [US1] **Dev migration on real data** (the second rehearsal, contracts/migration-procedure.md
  M1–M5 against dev): identify the dev volume by ownership **and** contents (feature 070 trap 1);
  stop `langfuse-web`/`langfuse-worker`; `manifest`; stop MinIO; `inventory`; `copy --apply` into the
  compose-prefixed `langfuse-rustfs-data`; bring the stack up on the new compose; `verify`.

  **Done when**: `parity.json` verdict `pass`; a pre-existing trace **with media** and a new
  assistant trace both load in Langfuse at `localhost:3030`; all four JSON records attached to the PR.

  **Done 2026-10-11, with one deviation.**
  - There was no pre-existing dev Langfuse data in this container. The pre-080 observability compose
    (`origin/main`) was brought up first, and real data was written through Langfuse's own paths:
    - 40 traces, through the OTel endpoint the gateway's SDK uses;
    - 2 media objects, through `/api/public/media` and its presigned PUT.
    - On MinIO, 20/20 + 20/20 traces loaded, and the media bytes matched (SHA-256).
  - The dev volume was identified by its compose labels (project `observability`, volume
    `langfuse-minio-data`) and by its contents (inventory: owner 1000, bucket `langfuse`).
  - M0.4–M5 were run **through the production wrapper** (`scripts/object-store-migration.sh`):
    - the advance inventory said `migratable`;
    - the manifest held 8 objects / 488,541 bytes, all 8 checksummed;
    - the inventory of the stopped drive said `migratable`;
    - copy: `pass` — uid 10001, 0 entries not owned, source digest unchanged.
  - The worktree compose was brought up; `langfuse-rustfs-init` exited 0.
  - verify: **`pass`** — 8 → 8 objects, 0 missing, unexpected, size, ETag or checksum mismatches,
    8 checksummed.
  - Both pre-migration media traces load, and their media now downloads from `langfuse-rustfs:9000`
    with matching bytes.
  - A post-migration trace with media loads, and the bucket grew to 11 objects.
  - **Deviation:** the "new assistant trace" was produced through Langfuse's OTel ingestion endpoint,
    not through a live assistant turn, because the agent stack and model were not brought up. This is
    the same write path. The four JSON records are in the PR description.

- [x] T022 [P] [US1] Monitoring unchanged (dev): Grafana (`otel-lgtm`) loads, and Tempo/Prometheus/Loki
  show telemetry newer than the stack restart (research R15).

  **Done when**: observed and noted on the PR.

  **Done 2026-10-11.** Grafana 13.2.2 `/api/health` is ok. After the cutover, one OTLP span, one metric
  and one log were sent to `:4318`. Through Grafana's datasource proxy:
  - Tempo returned the trace by id;
  - Prometheus returned the metric's value;
  - Loki returned the log line.
  `count(up)` = 1.

**Checkpoint**: everything in-repo for US1 is done; production waits for Phase 8.

---

## Phase 5: User Story 3 — RustFS on the ordinary supply chain (Priority: P2)

**Goal**: Renovate extracts and proposes RustFS; the sweep scans it; the MinIO build machinery and its
allowlist entries are gone.

- [x] T023 [P] [US3] `scripts/__tests__/renovate-workflow.guard.test.mjs`: **add** (a) a packageRule
  matching `rustfs/rustfs` resolves for a docker dep with `minimumReleaseAge` ≥ the 3-day global; (b)
  **visibility** — modelled on `infra-image-scan.test.mjs`'s "(412) every compose file carrying an
  image ref is VISIBLE to Renovate": every tracked file containing `rustfs/rustfs` matches a
  docker-compose `managerFilePatterns` entry and is not under `ignorePaths`, with an instrument check
  that ≥ 3 such files were found. **Delete** the minio date-tag tests (~1736–1760), and `minio/*` from
  the lists at ~1888–1950 and the comment at ~1096 — they guard a rule this feature deletes (deleted at
  the cause, not for convenience).

  **Verify RED**:
  ```bash
  node --test scripts/__tests__/renovate-workflow.guard.test.mjs
  ```
  **Expected RED**: (a) fails — no rule names `rustfs/rustfs`. (b) passes already (the default
  docker-compose pattern matches) — so **mutation-RED** it: temporarily set
  `docker-compose.managerFilePatterns` to a pattern excluding `observability/` → (b) fails naming both
  observability files; revert.

  **Done 2026-10-11.**
  - RED: 125 of 126 pass. The failure was `(080a) a packageRule names rustfs/rustfs …`.
  - (b) passed at once, so it was mutation-RED'd: `managerFilePatterns` was narrowed to exclude
    `observability/`. That failed (b), naming both observability files. Then it was reverted.
  - Also deleted, because they guarded deleted machinery:
    - the date-tag test;
    - the `(069) our own MinIO image is referenced identically` test;
    - the `minio/*` names in the lists.

- [x] T024 [US3] `renovate.json`: delete the `["minio/minio", "minio/mc"]` packageRule and its prose
  (~1044–1100) including the false "by the customManager below"; fix MinIO mentions in other rule
  descriptions (~224, ~772, ~1024); add a `rustfs/rustfs` docker rule (description says why: pulled
  upstream since feature 080; Alpine tag line; standard cooldown), placed with the other server-image
  rules.

  **Verify GREEN**: T023's command → all pass. Also `npx --yes renovate-config-validator` via the
  repository's existing validator step, if one exists in `guardrails`.

  **Done 2026-10-11.** GREEN: 126/126. `renovate-config-validator --strict --no-global
  renovate.json` (renovate@44) → `Config validated successfully`.

- [x] T025 [P] [US3] `scripts/__tests__/infra-image-scan.test.mjs`: assert `BUILT_IMAGE_NAMES` does not
  contain `minio` and that `enumerateImages` over the repository's compose files includes
  `rustfs/rustfs`; replace `minio/*` fixture strings (~263–311, ~412, ~441, ~590) with neutral
  hypothetical images (the file's own convention, ~76).

  **Verify RED**: `node --test scripts/__tests__/infra-image-scan.test.mjs` → **Expected RED**: the
  `BUILT_IMAGE_NAMES` assertion fails (`minio` still present).

  **Done 2026-10-11.** RED: 1 of 27 failing, `BUILT_IMAGE_NAMES is exactly the six images cd-deploy
  builds` (the old name was still in the list). `BUILT_IMAGE_NAMES` is now exported, with no
  behaviour change.

- [x] T026 [US3] `scripts/infra-image-scan.mjs`: remove `minio` from `BUILT_IMAGE_NAMES` and the
  comments at ~37–47, ~141–148; `.forgejo/workflows/infra-image-scan.yml`: header image list (~3), cron
  ordering note (~49–56 — no 05:00 `minio-image` any more), the `REGISTRY_HOST` comment (~156) and its
  env if it exists only for MinIO.

  **Verify GREEN**: T025's command → pass; `node --test scripts/__tests__/*.test.mjs` → pass.

  **Done 2026-10-11.**
  - GREEN: 27/27.
  - The workflow's `REGISTRY_HOST` env was removed. Measured: `enumerateImages` over the tree with no
    `REGISTRY_HOST` reports `unresolved: []`, because cd-deploy's refs carry a second `${…}` and are
    excluded either way.
  - A local sweep with Trivy 0.74.0 (ghcr DB mirrors) scanned 21 images, `rustfs/rustfs:1.0.1@…`
    among them. RustFS had 1 finding, Medium, and 0 blocking. The gate exited 0.

- [x] T027 [US3] `security/infra-images/allowlist.yaml`: delete the four `jumbleknot/minio` entries
  (~281–300) and the MinIO comment blocks (~114–115, ~174–260).

  **Verify RED** (before deleting, after T012/T017/T018): `node scripts/check-infra-image-findings.mjs
  --check-expiring` — the call site in `.forgejo/workflows/infra-image-scan.yml` (~338); reproduce its
  inputs from that step and the script's `--help` → **Expected RED**: the four entries reported as
  UNMATCHED (no compose references the image any more). If it cannot be reproduced locally, the PR's
  `infra-image-scan` run is the RED/GREEN instrument — record which.
  **Verify GREEN**: same → exit 0, no unmatched entries. Update `scripts/allowlist-expiry.mjs`,
  `scripts/check-infra-image-findings.mjs` comments ("two jobs consult this allowlist" → one) and
  `scripts/__tests__/allowlist-expiry.test.mjs`'s `minio` fixture key (~153–170).

  **Done 2026-10-11. The predicted RED was NOT reproduced, and the measurement explains why.**
  - Inputs: the real findings of the local sweep above.
  - With the four entries still present, `--check-expiring` exits **0**. Since item #423, an entry
    whose image is not in the run's scanned set is OUT OF SCOPE and silent, so it can never show up as
    UNMATCHED.
  - Evaluated with the clock at 2026-11-20 (the `evaluate()` export, run on the same report and
    allowlist), all four are reported **EXPIRING** (expiry 2026-12-01). That is the only signal they
    would ever have produced, and it would have arrived as a red weekly run two weeks before expiry.
  - After deletion: `--check-expiring` exits 0, and at 2026-11-20 only the two unrelated cohort
    entries (opensearch, unleash) remain.
  - The comments in `allowlist-expiry.mjs` and `check-infra-image-findings.mjs` were fixed. "Two jobs"
    stays true: cd-deploy's `scan-push.sh` is the single-image consumer today.
  - `--selftest` passes, and the expiry tests pass 23/23.

- [x] T028 [US3] Retire the build machinery: delete `.forgejo/workflows/minio-image.yml`,
  `infrastructure-as-code/docker/minio/`, `scripts/promote-minio-digest.mjs`,
  `scripts/__tests__/minio-promote.guard.test.mjs`, `scripts/__tests__/promote-minio-digest.test.mjs`.

  **Verify RED** (immediately after the deletions):
  ```bash
  node --test scripts/__tests__/*.test.mjs
  ```
  **Expected RED**: at least `argv-mutating-default.guard.test.mjs` fails on the vanished
  `promote-minio-digest.mjs` entry (~190); possibly `sast-scan.guard.test.mjs` (~271–300, fixture paths
  to the deleted Dockerfile) and `ci-status.test.mjs` (~172). Read every failure.

  Fix each at the cause: drop the argv entry; re-point SAST fixtures to a live Dockerfile (or a pure
  path string if the test only classifies paths); use a live workflow name in `ci-status.test.mjs`;
  update comments in `cd-scan-push-gate.guard.test.mjs` (~14), `scripts/cd/scan-push.sh` (~35),
  `scripts/sast-scan.mjs` (~46–55), `scripts/check-sast-findings.mjs` (~147, ~503) so none describes a
  mechanism that no longer exists.
  **Verify GREEN**: same command → 0 failures.

  **Done 2026-10-11.**
  - RED: 1,652 of 1,653 pass. Only `(#500) every argv-dispatching script … has a RECORDED verdict`
    failed.
  - The SAST and ci-status fixtures did not fail, because they are pure path strings. They were still
    fixed:
    - SAST now uses `infrastructure-as-code/docker/example/…`;
    - ci-status now uses `devcontainer-image / build-publish`.
  - The argv verdict now records `object-store-migration.mjs: guarded` in place of the deleted
    promoter.
  - GREEN: 0 failures (see T035 for the final count).

- [x] T029 [P] [US3] `.devcontainer/egress-allowlist.json`: confirm nothing else fetches Go modules
  (`git grep -n -i 'golang\|GOPROXY\|go mod\|go build'` outside specs/docs — `backend/mc-service/Dockerfile`
  matched the broad search; read it), then delete `proxy.golang.org` and `sum.golang.org` if both were
  added only for feature 069 (read each `reason`). Run any guard covering the allowlist and the sandbox
  host-policy sync described in `docs/runbooks/devcontainer-sandbox.md`.

  **Done when**: the entries are removed (or kept with a corrected reason naming their real consumer)
  and the allowlist guards pass.

  **Done 2026-10-11.**
  - Nothing else fetches Go modules: `backend/mc-service/Dockerfile` matched only on `cargo build`.
  - **Three** entries were removed, not two. `storage.googleapis.com`'s own reason says feature 069
    added it on 2026-09-12 solely because the Go proxy serves module zips from it, and nothing in the
    tree references it.
  - `gen-egress-policy.mjs --check`: 47 destinations valid.
  - `verify-egress-allowlist-contract.sh`: 8/8.
  - The running sandbox's host-side policy is unchanged until it is recreated (devcontainer-sandbox.md
    §4). Shrinking it is an operator's choice.

**Checkpoint**: no workflow, schedule or allowlist entry for MinIO remains (SC-011).

---

## Phase 6: User Story 4 — Nothing still says MinIO, except history (Priority: P2)

- [x] T030 [US4] Write `scripts/__tests__/no-minio-references.guard.test.mjs` per
  `contracts/no-minio-guard.md` (G1 scan of `git ls-files`, G2 closed exemption list with reasons, G3
  instrument checks incl. "every exemption matches something").

  **Verify RED**:
  ```bash
  node --test scripts/__tests__/no-minio-references.guard.test.mjs
  ```
  **Expected RED**: fails listing every live file still naming MinIO (at this point: runbooks, README,
  remaining comments) as `path:line`.

  **Done 2026-10-11.** RED: G1 listed every live reference by `path:line`. The largest counts were
  in the allowlist, prod-control-tower, infra-image-scanning, Server-Setup and renovate.md.
  - Five exemptions were added beyond the contract, each with a reason; the contract G2 is updated:
    - the wrapper (temporary);
    - the guard's `MINIO_` alias assertion;
    - the retired seeded-default constant (gen-dev-env, T013);
    - citations of the spec directories and of this guard;
    - **temporary tokens** for the real names of the rollback resources that exist until M7.
  - The G3 floor is the number of files actually scanned (1,826 → floor 1,800), not the number of
    tracked files.

- [x] T031 [US4] Runbooks: `docs/runbooks/prod-control-tower.md` (replace the feature-070 "migrate the
  MinIO data volume to uid 1000" section with the 080 cutover procedure — link
  `specs/080-minio-to-rustfs/contracts/migration-procedure.md` — and update volume/variable lists);
  `prod-reboot-resilience.md` (host-managed compose table: `rustfs`); `Server-Setup-Runbook.md` Phase 8
  (RustFS digest-pinned, no console port, `curl --aws-sigv4` bucket init, `nx-cache.env` credential
  lines), its backup note (~1004) and services table (~1138); `renovate.md` (~748, and wrap the §5
  item-#560 case study ~844–860 in `<!-- history:begin/end -->`); `infra-image-scanning.md`;
  `ci-diagnostics.md` (~951 "the cache bucket"); `devcontainer-sandbox-lifecycle.md` (~217 container
  list); `local-dev.md` (~49: RustFS does not bake root credentials into the drive — measured,
  research R6 step 5 — so rotation is an env change).

  **Done when**: none of these files fails the T030 guard outside a history block, and every command
  in them names a binary the RustFS image actually has.

  **Done 2026-10-11.** No runbook fails the guard outside a history block or a rollback-resource
  token. The commands name only binaries the RustFS image has (`curl`, `sh`), plus the wrapper.

- [x] T032 [P] [US4] `README.md` (~50) stack table; `infrastructure-as-code/docker/stacks/mcm.compose.yaml`
  (~19) comment; any remaining comment the T030 guard names.

  **Done when**: the guard names nothing outside G2.

  **Done 2026-10-11.** The guard names nothing outside G2.

- [x] T033 [US4] **Verify GREEN** + mutation: `node --test scripts/__tests__/no-minio-references.guard.test.mjs`
  → pass. Mutations (each RED, then revert): plant `minio` in `README.md`; plant it in a runbook
  outside a history block (inside one → stays GREEN); add an exemption path that matches no file.

  **Done 2026-10-11.** GREEN: 11/11, 0 skipped. Each on-disk mutation was run, then reverted:
  | Mutation | Result |
  |---|---|
  | `minio` planted in README.md | RED, `README.md:244` |
  | runbook, outside a history block | RED, `renovate.md:1189` |
  | runbook, inside a history block | GREEN |
  | stale path exemption | RED, `stale path exemption(s) — delete them: scripts/no-such-file.mjs` |

- [ ] T034 [US4] OpenWiki: `pnpm nx wiki-plan infrastructure-as-code` (offline, free) to list the
  concept pages whose sources changed; do **not** hand-edit pages that carry a `resource`. Regeneration
  happens through the merge-triggered `wiki-maintain` workflow (one always-current PR, never
  auto-merged) — or, if the operator wants it in this PR, `pnpm nx wiki-update infrastructure-as-code`
  (never the bare CLI). `pnpm nx okf-lint infrastructure-as-code` and
  `pnpm nx okf-governance infrastructure-as-code` pass.

  **Done when**: the wiki-maintain PR after merge describes RustFS as current for Langfuse storage and
  the backup destination (US4-AC3); the gates are green.

  **Partly done 2026-10-11 (the in-PR half).**
  - `pnpm nx wiki-plan infrastructure-as-code` (offline) planned 7 pages in 5 slices: the
    prod-control-tower, local-dev and ci-diagnostics runbooks, repository, published-port-reservation,
    infrastructure-stacks and the new devcontainer-sandbox-lifecycle. It deferred 8, including
    infra-image-scanning and server-setup.
  - No page was hand-edited, and no paid generation was run.
  - `okf-lint`: 70 concepts conformant. `okf-governance`: 1,110 paths classified.
  - The "Done when" — the wiki-maintain PR after merge describing RustFS — is **post-merge** and is
    still open.

---

## Phase 7: CI proof on the pull request

- [ ] T035 Push (`git push origin HEAD:080-minio-to-rustfs` — a real branch, never AGit) and confirm
  with `node scripts/ci-status.mjs`: `guardrails` green; `app-ci` green **and** its integration step's
  log shows the mcm-app tier with 0 skipped (read the count, do not trust the tick) and `app-e2e`
  (incl. `backups.spec.ts`) green; `infra-image-scan` PR run green with `rustfs/rustfs` in its scanned
  list. The `minio-image / build-publish` advisory context no longer appears.

  **Done when**: SC-003 and SC-004 are evidenced by links on the PR.

---

## Phase 8: Production cutover — User Story 1 (Priority: P1) **[OPERATOR]**

Follow `contracts/migration-procedure.md` exactly. The agent prepares commands and reads back pasted
evidence; it never runs these.

- [ ] T036 **[OPERATOR]** Create Komodo Variable `LANGFUSE_RUSTFS_SECRET_KEY` (masked; fresh value by
  default — spec Open Question 3). Do **not** delete `LANGFUSE_MINIO_ROOT_PASSWORD` (rollback needs it).

- [ ] T037 **[OPERATOR]** Advance `inventory` against `observability-langfuse-minio-data` with the tool
  (M0.4); verdict `migratable`; note `bytes` to size the window.

- [ ] T038 **[OPERATOR]** M1–M3: stop writers; `manifest`; stop MinIO and its init; `inventory`;
  `copy --apply` into `observability-langfuse-rustfs-data`.

  **Done when**: `copy.json` shows `targetPreexisted: false`, `entriesNotOwnedByRuntimeUid: 0`, and
  equal source digests.

- [ ] T039 **[OPERATOR]** M4: merge the PR; watch `app-ci` on `main` → `trigger-cd` → `cd-deploy`
  `deploy=true` complete.

- [ ] T040 **[OPERATOR]** M5: `verify` → `parity.json` `pass` (SC-001); in Langfuse a pre-migration
  trace with media loads and a new assistant turn's trace loads (SC-002); `docker ps` shows every
  `prod-observability` container healthy, init running+healthy, Komodo stack health green (SC-006 —
  `cd-deploy`'s probe does not cover this stack, research R16); Grafana loads with current telemetry
  (SC-008). Paste the evidence on the PR.

- [ ] T041 **[OPERATOR]** M6 **only if T040 fails**: revert; confirm MinIO serves the original object
  count; record the failure in research.md before any second attempt.

---

## Phase 9: Post-merge proofs — User Story 3

- [ ] T042 [US3] **[OPERATOR]** Read Renovate's Dependency Dashboard (item #29) — **read-only, never
  edit it** — after the next Renovate run: `rustfs/rustfs` is listed under each compose file that pins
  it, and nothing lists `infrastructure-as-code/docker/minio/Dockerfile` (SC-007).

- [x] T043 [US3] After the next **scheduled** Friday `infra-image-scan` run (not a dispatch): its
  digest shows `rustfs/rustfs` scanned and `expiry_step=success` (SC-005).
  *Done 2026-10-20 on the Tuesday sweep (cron `0 4 * * 2`, item #642; the operator accepted it as the next
  scheduled run). Run 5693 (event `schedule`, 04:33 UTC, `cefd7ace`) posted `infra-image-scan/expiry`
  `event_name=schedule gate=success expiry_step=success` and `infra-image-scan/weekly` `scan=success`. The
  sweep's own `enumerateImages()` at `cefd7ace` yields 21 images including
  `rustfs/rustfs:1.0.1@sha256:1803faef…` (observability + backups compose). The job log is not readable
  through the forge API, so the rustfs line is shown by the enumerator, not quoted from the log.*

---

## Phase 10: User Story 5 — the Nx remote cache (Priority: P3) **[OPERATOR]**

- [x] T044 [US5] **[OPERATOR]** contracts/migration-procedure.md M8 on the prod host using the
  Phase 8 runbook text shipped in T031: stop `nx-cache`, `manifest`, stop MinIO, `inventory`, `copy
  --apply`, start RustFS from `/home/prod/rustfs/compose.yaml`, update `nx-cache.env` credential
  lines, start `nx-cache`, `verify`. (Or, per Open Question 1, recreate empty.)
  *Done 2026-10-21 23:04–23:10 UTC (copy, not recreate). Old store: `minio-minio-1` (project `minio`,
  network `minio_default`) on `minio_minio-data`. `manifest`: 1360 objects, 1052205412 bytes, 0
  versioned buckets. `inventory`: `xl-single`, 0 SSE, 0 tiered, `migratable`. `copy`: pass,
  `targetPreexisted: false`, uid 10001, `entriesNotOwnedByRuntimeUid: 0`, source digest unchanged
  (`72179400…`). RustFS healthy, `bucket ready`. Only the two `AWS_*` key lines in `nx-cache.env`
  changed (`S3_ENDPOINT_URL=http://127.0.0.1:9000` and the bucket were already right); `/health` OK.
  `verify`: pass — 1360 → 1360, missing 0, unexpected 0, size 0, etag 0, checksum 0 of 50, written
  after manifest 0. Evidence: `/home/prod/080-nx-cache/{manifest,inventory,copy,parity}.json`. The
  remote cache was down for ~5 minutes. `minio_minio-data` and `/home/prod/minio/` are kept as the
  rollback until T047.*

- [x] T045 [US5] Two CI runs of the same cacheable target: the second reports a remote-cache hit
  (`Nx read the output from the remote cache`) (SC-010).
  *Done 2026-10-21 on PR #824, after T044's cutover to RustFS. Same mc-service inputs across runs 5770
  (`582fb26c`), 5773 (`68a29d1e`) and 5776 (`dd917089`). Run 5776's `app-ci / mc-service-checks` printed
  `🔁 > nx run mc-service:lint  [remote cache]` and `🔁 > nx run mc-service:"test:unit"  [remote cache]`,
  each with `Nx read the output from the cache instead of running the command for 1 out of 1 tasks` and
  `Cache: 1/1 hit (100%)`; run durations were 12 ms and 13 ms, against ~33 s and ~48 s of compile in the
  replayed output. This Nx version marks a remote hit with the `[remote cache]` task tag rather than the
  literal sentence in this task; the meaning (output served by the remote cache, now RustFS) is the same.
  Read by the operator from the Forgejo job log, since the forge API exposes no job logs.*

---

## Phase 11: Polish and deferred cleanup

- [ ] T046 Run the final validation checklist (`openwiki/invariants/feature-validation-checklist.md`),
  including the web E2E regression; run `speckit-analyze` over spec/plan/tasks and resolve findings.

- [ ] T047 **[OPERATOR]** After the rollback window (default 14 days, Open Question 2), M7: delete
  `observability-langfuse-minio-data`, the dev and Nx-cache MinIO volumes, the Komodo Variable
  `LANGFUSE_MINIO_ROOT_PASSWORD`, and the `jumbleknot/minio` registry package; remove
  `/home/prod/minio/`.

- [ ] T048 Cleanup PR: delete `scripts/object-store-migration.mjs`,
  `scripts/__tests__/object-store-migration.test.mjs` and `object-store-migration.rehearsal.mjs`.

  **Verify RED**: `node --test scripts/__tests__/no-minio-references.guard.test.mjs` → **Expected
  RED**: G3 reports the temporary exemption as matching no file.
  Remove the exemption row from the guard (and `contracts/no-minio-guard.md`).
  **Verify GREEN**: same command → pass; `node --test scripts/__tests__/*.test.mjs` → pass. Close
  item #560 only when this PR merges (its acceptance criteria are superseded by this feature — say so
  in the closing comment rather than ticking boxes that were not done as written).

---

## Dependencies & Execution Order

- **Phase 1** → **Phase 2** (T003 is a hard gate: a non-`xl-single` or SSE-bearing drive stops the
  feature).
- **Phase 2** blocks every story. T006→T007, T008→T009, T010 before T012/T017/T018.
- **US2 (Phase 3)** and **US1 in-repo (Phase 4)** can proceed in parallel after Phase 2; T019 after
  T018; T021 after T009 + T017.
- **US3 (Phase 5)**: T027's RED needs T012/T017/T018 done; T028 any time after Phase 2.
- **US4 (Phase 6)** after Phases 3–5 (it measures what is left).
- **Phase 7** after Phases 3–6. **Phase 8** after Phase 7 and T001 (#642 merged).
- **Phase 9** after T039. **Phase 10** after T039 (independent of Phase 9).
- **T047** ≥ rollback window after T040; **T048** after T047.

### Parallel opportunities

T006 ∥ T010; T013 ∥ T014; T020 ∥ T022; T023 ∥ T025 ∥ T029; T032 ∥ T031.

## Implementation Strategy

MVP = Phases 1–4 + 7 on the PR (both P1 stories proven in-repo), then Phase 8 as the single cutover.
US3/US4 ride the same PR because the deleted machinery and the swapped compose must land atomically —
a compose with RustFS and an allowlist still keyed to MinIO fails `--check-expiring`, and a deleted
`minio-image.yml` with compose still on MinIO would leave the image unscanned.
