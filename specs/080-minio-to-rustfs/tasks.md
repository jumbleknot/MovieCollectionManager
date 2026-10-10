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

- [ ] T001 Rebase the branch on `main` **after item #642 (Langfuse 4.56.0) has merged**; resolve the
  Langfuse image lines in `infrastructure-as-code/docker/observability/compose.yaml` and
  `compose.prod.yaml` in #642's favour.

  **Done when**: `git log origin/main` contains #642's merge and the branch rebases cleanly onto it.

- [ ] T002 Check item #552's precondition: `infrastructure-as-code/docker/stacks/mcm.env` holds
  `BACKUP_TEST_S3_ACCESS_KEY`, `BACKUP_TEST_S3_SECRET_KEY`, `BACKUP_TEST_WEBDAV_USER`,
  `BACKUP_TEST_WEBDAV_PASSWORD` (names only — never print values). If any is missing, **stop** and
  point at #552; do not hand-patch around it (research R17). CI is unaffected (mints its own).

  **Done when**: the four keys are present, or #552 is resolved first.

- [ ] T003 **[OPERATOR]** Early go/no-go on the production host, read-only, before any tool exists
  (research R6, R14). The agent prepares; the operator runs and pastes:

  ```sh
  docker volume ls | grep -i minio        # expect observability-langfuse-minio-data (+ the Nx-cache volume)
  docker run --rm -v observability-langfuse-minio-data:/data:ro alpine:3.24 sh -c '
    cat /data/.minio.sys/format.json; echo;
    grep -rlis "X-Minio-Internal-Server-Side-Encryption" --include=xl.meta /data | wc -l;
    grep -rlis "transition-status" --include=xl.meta /data | wc -l;
    ls /data; du -sh /data; find /data ! -user 1000 | wc -l'
  ```

  Repeat for the Nx-cache volume. Also confirm **where the tool will run**: either `node` on the prod
  host, or the dev container with `DOCKER_HOST=ssh://prod@<host>` (the tool drives Docker only through
  the CLI and runs every S3 call inside a throwaway container on the target network, so either works).

  **Done when**: both drives report `"format":"xl-single"` with one set of one drive, 0 SSE, 0 tiered,
  and the tool's execution location is recorded in research.md. **Any other result stops the feature
  for an operator decision** (spec Edge Cases) — do not proceed to Phase 2.

- [ ] T004 Resolve the `rustfs/rustfs` pin: the newest 1.x past Renovate's 3-day cooldown (1.0.1 unless
  a later one qualifies), **index** digest via `docker buildx imagetools inspect`; re-scan it under the
  gate criterion (`aquasec/trivy:0.74.0 image --severity CRITICAL --ignore-unfixed`, ghcr DB mirrors);
  confirm `id -u` = 10001 and `curl` present. Record in research.md R4.

  **Done when**: one digest is chosen, 0 fixable Critical is observed (not inferred), and R4 is updated.

- [ ] T005 Save the baseline touchpoint list
  (`git grep -il minio -- . ':!openwiki' ':!specs' ':!pnpm-lock.yaml'`) to the PR description and map
  every file to a task below or to a G2 exemption in `contracts/no-minio-guard.md`.

  **Done when**: every one of the files is mapped; an unmapped file becomes a task here before Phase 3.

---

## Phase 2: Foundational — the migration tool and the service contract guard

**⚠️ No story work starts until this phase is complete.**

- [ ] T006 [P] Write `scripts/__tests__/object-store-migration.test.mjs` — pure logic of
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

- [ ] T007 Implement the pure logic in `scripts/object-store-migration.mjs` (exports + parser + `main`
  guarded so importing has no side effects).

  **Verify GREEN**: same command → all pass, 0 skipped. Regression:
  `node --test scripts/__tests__/*.test.mjs` → no new failures.

- [ ] T008 Write `scripts/__tests__/object-store-migration.rehearsal.mjs` (deliberately **not**
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

- [ ] T009 Implement the Docker-driving subcommands `inventory`, `manifest`, `copy`, `verify`,
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

- [ ] T010 [P] Write `scripts/__tests__/object-store-service.guard.test.mjs` asserting, for every
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

- [ ] T011 Measure the three open items in the contract on the pinned image (research R7, R8, R10):
  (a) does `/health/ready` return non-200 while the drive initialises (start on a large copied drive
  and poll from t=0)? (b) the console-disable variable for this version and that `:9001` is then
  closed; (c) `sleep` present for `exec sleep infinity`. Amend `contracts/object-store-service.md` S4/S7
  and research.md if any answer differs.

  **Done when**: three measured answers are recorded, and the contract matches them.

**Checkpoint**: tool rehearsed end to end; contract guard RED and waiting for compose.

---

## Phase 3: User Story 2 — Backups proven against a real RustFS (Priority: P1) 🎯

**Goal**: the backup S3 test destination is RustFS; every S3-using integration suite passes with 0
skips; driver logic unchanged.

**Independent Test**: fresh `backups` stack → `test:integration` with skipping forbidden → skip count 0.

- [ ] T012 [US2] `infrastructure-as-code/docker/backups/compose.yaml`: `mcm-bff-backup-minio{,-init}`
  → `mcm-bff-backup-rustfs{,-init}` per contract S1–S8 (no `user:`, `RUSTFS_*` creds from
  `BACKUP_TEST_S3_*`, S4 health, S5 one-shot init exiting 0, S6 logs, drop `127.0.0.1:9101`, keep
  `127.0.0.1:9100:9000`); volume `mcm-bff-backup-rustfs-data`; drop `REGISTRY_HOST` and the header
  comments that justify it; rewrite the "reuses the from-source MinIO image" comment.

  **Verify GREEN** (T010, backups half): `node --test --test-name-pattern "backups" scripts/__tests__/object-store-service.guard.test.mjs` → pass.

- [ ] T013 [P] [US2] `scripts/gen-dev-env.mjs` (lines ~173, ~501) and `scripts/gen-ci-env.mjs` (~68):
  `mcm-bff-backup-minio` → `mcm-bff-backup-rustfs` in `BACKUP_ALLOWED_DESTINATION_HOSTS` and
  `BACKUP_TEST_S3_INTERNAL_ENDPOINT`. Regenerate local env with the documented generator.

  **Done when**: `node scripts/gen-dev-env.mjs` output and `frontend/mcm-app/.env.local` carry the new
  host; `frontend/mcm-app/src/bff-server/unit-tests/backup-destination-url-guard.test.ts` still passes
  (`pnpm nx test mcm-app -- --testPathPattern='backup-destination-url-guard'`).

- [ ] T014 [P] [US2] Integration tier and comments:
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

- [ ] T015 [US2] `.forgejo/workflows/app-ci.yml`, step "Bring up the backup destinations" (~683–780):
  container names in both wait loops, `BACKUP_TEST_S3_INTERNAL_ENDPOINT` (~967, ~1041), the failure
  log-dump list (~1328); remove `REGISTRY_HOST: ${{ vars.REGISTRY }}`, its "unset" check and the
  comments about anonymously pulling `jumbleknot/minio`; rewrite the step-split comment.
  `scripts/ci-step-ceilings.tsv` (~48): comment; leave the ceiling unless a measured run exceeds it.

  **Done when**: no MinIO or `REGISTRY_HOST` reference remains in that step, and
  `node --test scripts/__tests__/*.test.mjs` (which includes the step-ceiling guards) passes.

- [ ] T016 [US2] Local proof, fresh volumes: `docker compose -p mcm --env-file
  infrastructure-as-code/docker/stacks/mcm.env -f infrastructure-as-code/docker/backups/compose.yaml
  up -d` after removing any old `mcm-bff-backup-minio*` containers and volume; wait for
  `mcm-bff-backup-rustfs` healthy and the init exit 0; then

  ```bash
  MCM_REQUIRE_LIVE_STACK=1 MCM_REQUIRE_BACKUP_TARGETS=1 pnpm nx test:integration mcm-app
  ```

  then `tests/e2e/web/backups.spec.ts` via the Playwright image recipe (docs/runbooks/e2e-testing.md).

  **Done when**: integration reports 0 failed and **0 skipped** — and the 14 S3-using suites
  (research R16) are each in the passed list — and the backups E2E passes. Paste counts into the PR.

**Checkpoint**: US2 provable on its own; CI's `app-e2e` proves it again (T035).

---

## Phase 4: User Story 1 — Production Langfuse on RustFS, data preserved (Priority: P1)

**Goal**: Langfuse dev and prod use RustFS; dev's real data migrated by the tool; prod ready to cut over.

**Independent Test**: dev migration with parity pass and both trace kinds loading.

- [ ] T017 [US1] `infrastructure-as-code/docker/observability/compose.yaml`: `langfuse-minio{,-init}` →
  `langfuse-rustfs{,-init}` (contract S1–S8, dev one-shot init); `LANGFUSE_S3_{EVENT,MEDIA}_UPLOAD_*`
  endpoint `http://langfuse-rustfs:9000`, access key `langfuse`, secret
  `${LANGFUSE_RUSTFS_SECRET_KEY:?…}`, path-style and bucket unchanged; both `depends_on` blocks;
  volume `langfuse-rustfs-data`; drop `REGISTRY_HOST`.

  **Verify GREEN** (T010, dev half): `node --test --test-name-pattern "observability/compose.yaml" scripts/__tests__/object-store-service.guard.test.mjs`.

- [ ] T018 [US1] `infrastructure-as-code/docker/observability/compose.prod.yaml`: same, prod shape —
  `restart: always`; init keeps "touch `/tmp/ready`, `exec sleep infinity`" + marker healthcheck,
  dependants on `service_healthy`; volume `langfuse-rustfs-data` → `external: true`, name
  `observability-langfuse-rustfs-data` (contract S9 — **never** created by compose); drop
  `REGISTRY_HOST`; header comment's "minio/mc" vendor-tool note.

  **Verify GREEN** (T010 fully): `node --test scripts/__tests__/object-store-service.guard.test.mjs` → all pass.

- [ ] T019 [US1] **Verify RED first, with the existing guard**: after T018, run

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

- [ ] T020 [P] [US1] Gates: `scripts/check-resource-naming.mjs` (~36) — `langfuse-rustfs{,-init}` into
  `NAME_ALLOWLIST` (Rule 3 vendor bundle; `mcm-bff-backup-rustfs*` already match `IDENTIFIER_RE`), and
  the four retired MinIO keys into `RETIRED_KEYS` (Rule 4: a missed reference resurrected as a network
  alias must fail loudly — this is the one live-code place MinIO names stay, exempted by line in G2);
  `scripts/check-prod-restart-policy.mjs` self-test fixtures (~100, ~108); `scripts/check-no-inline-secrets.mjs`
  comment (~32) and fixture value (~195).

  **Verify RED**: before editing, `node scripts/check-resource-naming.mjs` → **Expected RED**: fails
  naming `langfuse-rustfs` / `langfuse-rustfs-init` as not matching the identifier format (they are
  not yet in `NAME_ALLOWLIST`).
  **Verify GREEN**: the three checks and `node --test scripts/__tests__/*.test.mjs` pass.

- [ ] T021 [US1] **Dev migration on real data** (the second rehearsal, contracts/migration-procedure.md
  M1–M5 against dev): identify the dev volume by ownership **and** contents (feature 070 trap 1);
  stop `langfuse-web`/`langfuse-worker`; `manifest`; stop MinIO; `inventory`; `copy --apply` into the
  compose-prefixed `langfuse-rustfs-data`; bring the stack up on the new compose; `verify`.

  **Done when**: `parity.json` verdict `pass`; a pre-existing trace **with media** and a new
  assistant trace both load in Langfuse at `localhost:3030`; all four JSON records attached to the PR.

- [ ] T022 [P] [US1] Monitoring unchanged (dev): Grafana (`otel-lgtm`) loads, and Tempo/Prometheus/Loki
  show telemetry newer than the stack restart (research R15).

  **Done when**: observed and noted on the PR.

**Checkpoint**: everything in-repo for US1 is done; production waits for Phase 8.

---

## Phase 5: User Story 3 — RustFS on the ordinary supply chain (Priority: P2)

**Goal**: Renovate extracts and proposes RustFS; the sweep scans it; the MinIO build machinery and its
allowlist entries are gone.

- [ ] T023 [P] [US3] `scripts/__tests__/renovate-workflow.guard.test.mjs`: **add** (a) a packageRule
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

- [ ] T024 [US3] `renovate.json`: delete the `["minio/minio", "minio/mc"]` packageRule and its prose
  (~1044–1100) including the false "by the customManager below"; fix MinIO mentions in other rule
  descriptions (~224, ~772, ~1024); add a `rustfs/rustfs` docker rule (description says why: pulled
  upstream since feature 080; Alpine tag line; standard cooldown), placed with the other server-image
  rules.

  **Verify GREEN**: T023's command → all pass. Also `npx --yes renovate-config-validator` via the
  repository's existing validator step, if one exists in `guardrails`.

- [ ] T025 [P] [US3] `scripts/__tests__/infra-image-scan.test.mjs`: assert `BUILT_IMAGE_NAMES` does not
  contain `minio` and that `enumerateImages` over the repository's compose files includes
  `rustfs/rustfs`; replace `minio/*` fixture strings (~263–311, ~412, ~441, ~590) with neutral
  hypothetical images (the file's own convention, ~76).

  **Verify RED**: `node --test scripts/__tests__/infra-image-scan.test.mjs` → **Expected RED**: the
  `BUILT_IMAGE_NAMES` assertion fails (`minio` still present).

- [ ] T026 [US3] `scripts/infra-image-scan.mjs`: remove `minio` from `BUILT_IMAGE_NAMES` and the
  comments at ~37–47, ~141–148; `.forgejo/workflows/infra-image-scan.yml`: header image list (~3), cron
  ordering note (~49–56 — no 05:00 `minio-image` any more), the `REGISTRY_HOST` comment (~156) and its
  env if it exists only for MinIO.

  **Verify GREEN**: T025's command → pass; `node --test scripts/__tests__/*.test.mjs` → pass.

- [ ] T027 [US3] `security/infra-images/allowlist.yaml`: delete the four `jumbleknot/minio` entries
  (~281–300) and the MinIO comment blocks (~114–115, ~174–260).

  **Verify RED** (before deleting, after T012/T017/T018): `node scripts/check-infra-image-findings.mjs
  --check-expiring` — the call site in `.forgejo/workflows/infra-image-scan.yml` (~338); reproduce its
  inputs from that step and the script's `--help` → **Expected RED**: the four entries reported as
  UNMATCHED (no compose references the image any more). If it cannot be reproduced locally, the PR's
  `infra-image-scan` run is the RED/GREEN instrument — record which.
  **Verify GREEN**: same → exit 0, no unmatched entries. Update `scripts/allowlist-expiry.mjs`,
  `scripts/check-infra-image-findings.mjs` comments ("two jobs consult this allowlist" → one) and
  `scripts/__tests__/allowlist-expiry.test.mjs`'s `minio` fixture key (~153–170).

- [ ] T028 [US3] Retire the build machinery: delete `.forgejo/workflows/minio-image.yml`,
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

- [ ] T029 [P] [US3] `.devcontainer/egress-allowlist.json`: confirm nothing else fetches Go modules
  (`git grep -n -i 'golang\|GOPROXY\|go mod\|go build'` outside specs/docs — `backend/mc-service/Dockerfile`
  matched the broad search; read it), then delete `proxy.golang.org` and `sum.golang.org` if both were
  added only for feature 069 (read each `reason`). Run any guard covering the allowlist and the sandbox
  host-policy sync described in `docs/runbooks/devcontainer-sandbox.md`.

  **Done when**: the entries are removed (or kept with a corrected reason naming their real consumer)
  and the allowlist guards pass.

**Checkpoint**: no workflow, schedule or allowlist entry for MinIO remains (SC-011).

---

## Phase 6: User Story 4 — Nothing still says MinIO, except history (Priority: P2)

- [ ] T030 [US4] Write `scripts/__tests__/no-minio-references.guard.test.mjs` per
  `contracts/no-minio-guard.md` (G1 scan of `git ls-files`, G2 closed exemption list with reasons, G3
  instrument checks incl. "every exemption matches something").

  **Verify RED**:
  ```bash
  node --test scripts/__tests__/no-minio-references.guard.test.mjs
  ```
  **Expected RED**: fails listing every live file still naming MinIO (at this point: runbooks, README,
  remaining comments) as `path:line`.

- [ ] T031 [US4] Runbooks: `docs/runbooks/prod-control-tower.md` (replace the feature-070 "migrate the
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

- [ ] T032 [P] [US4] `README.md` (~50) stack table; `infrastructure-as-code/docker/stacks/mcm.compose.yaml`
  (~19) comment; any remaining comment the T030 guard names.

  **Done when**: the guard names nothing outside G2.

- [ ] T033 [US4] **Verify GREEN** + mutation: `node --test scripts/__tests__/no-minio-references.guard.test.mjs`
  → pass. Mutations (each RED, then revert): plant `minio` in `README.md`; plant it in a runbook
  outside a history block (inside one → stays GREEN); add an exemption path that matches no file.

- [ ] T034 [US4] OpenWiki: `pnpm nx wiki-plan infrastructure-as-code` (offline, free) to list the
  concept pages whose sources changed; do **not** hand-edit pages that carry a `resource`. Regeneration
  happens through the merge-triggered `wiki-maintain` workflow (one always-current PR, never
  auto-merged) — or, if the operator wants it in this PR, `pnpm nx wiki-update infrastructure-as-code`
  (never the bare CLI). `pnpm nx okf-lint infrastructure-as-code` and
  `pnpm nx okf-governance infrastructure-as-code` pass.

  **Done when**: the wiki-maintain PR after merge describes RustFS as current for Langfuse storage and
  the backup destination (US4-AC3); the gates are green.

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

- [ ] T043 [US3] After the next **scheduled** Friday `infra-image-scan` run (not a dispatch): its
  digest shows `rustfs/rustfs` scanned and `expiry_step=success` (SC-005).

---

## Phase 10: User Story 5 — the Nx remote cache (Priority: P3) **[OPERATOR]**

- [ ] T044 [US5] **[OPERATOR]** contracts/migration-procedure.md M8 on the prod host using the
  Phase 8 runbook text shipped in T031: stop `nx-cache`, `manifest`, stop MinIO, `inventory`, `copy
  --apply`, start RustFS from `/home/prod/rustfs/compose.yaml`, update `nx-cache.env` credential
  lines, start `nx-cache`, `verify`. (Or, per Open Question 1, recreate empty.)

- [ ] T045 [US5] Two CI runs of the same cacheable target: the second reports a remote-cache hit
  (`Nx read the output from the remote cache`) (SC-010).

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
