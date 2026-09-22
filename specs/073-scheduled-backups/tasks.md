# Tasks: Per-user scheduled collection backups

**Feature**: `specs/073-scheduled-backups` | **Branch**: `073-scheduled-backups`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Research**: [research.md](./research.md) · **Data model**: [data-model.md](./data-model.md) · **Quickstart**: [quickstart.md](./quickstart.md)

Task detail blocks follow `docs/templates/feature-test-tasks-template.md`, mandatory per the
constitution's TDD Checkpoint Format. Tasks without a unit under test (config, compose, docs) carry a
**Done when** instead of a RED/GREEN pair, and say so rather than pretending to be RED.

## Before the first task — environment facts that cost time if learned late

- **`pnpm nx` does not work in a fresh worktree.** The `node_modules` symlink covers the gate
  scripts, but any nx target dies in pnpm's deps check with `ERR_PNPM_UNSAFE_MODULES_DIR` naming
  the main checkout — a path error that is really a foreign-tree error. **Remove the symlink
  first**, then run `CI=true pnpm install --frozen-lockfile` inside this worktree (~4 min)
  **before T001**. Leaving the symlink in place makes the install print that same
  `ERR_PNPM_UNSAFE_MODULES_DIR` and **exit 0** — it looks like it worked and nothing was
  installed.
- **A fresh worktree has no gitignored artefacts, and several gates READ rather than generate
  them.** Copy `.env.local`, `.env.docker`, `.env.e2e.local`, `stacks/*.env` and
  `backend/mc-service/.env.local` in from the main checkout before running any tier.
- **These suites are jest, NOT `node --test`.** They use `describe`/`it`/`expect`, `jest.mock`
  and the `@/` path alias, none of which node's test runner resolves — it errors rather than
  producing a meaningful RED. Every command below was corrected to
  `pnpm nx test mcm-app --testPathPattern='<stem>'` after being run.
  (The original warning here — that `node --test <file> --test-name-pattern "x"` silently runs
  everything because anything after the script path becomes the script's own argv — is true and
  worth keeping in mind generally, but it does not apply to this repository's suites.)
- **There is no `mcm-app-e2e` nx project and no `e2e` target.** The web suite runs through
  Playwright directly from `frontend/mcm-app`. Do **not** use `--grep-invert` to select a tier:
  Playwright 1.60+ accepts it here and silently does nothing — `E2E_TIER` in
  `playwright.config.ts` is the mechanism.
- **Running the web E2E from a worktree needs a different recipe than the runbook gives.** The
  documented `docker run -v "$PWD"` cannot work: the dev container's Docker is a Sandbox microVM
  sharing only `/workspaces`, so a worktree path mounts as an EMPTY DIRECTORY. Copy the source in
  instead (`tar --exclude=node_modules | docker cp -`) and let the container run its own
  `pnpm install` — and pass **both** `.env.e2e.local` and `.env.local`, or the credential-gated
  specs all skip and the run exits 0 having asserted nothing. Tracked as item #524.

## Three suites are INTEGRATION, not unit — and why

T010 (the Redis lock), T018 (the destination store) and T036 (the job store) were specified here
as unit suites and were written as integration ones. Every property each of them asserts is a
behaviour of the DEPENDENCY, not of code in this repository: `SET NX EX` having exactly one
winner and expiring on its own, an atomic compare-and-delete, a Mongo read projection excluding a
field, a filter scoping by `userId`, a partial `$set` leaving an omitted field intact. Asserted
against a mock, each of those tests only proves that the author's model of Redis or Mongo agrees
with itself.

The repository already draws this line in the same place: `unit-tests/rate-limiter.test.ts` mocks
the cache service and tests the DECISION logic, while `rate-limiter.integration.test.ts` exercises
the Redis behaviour against a real instance.

## Ordering principle

Where a task asserts behaviour that does not exist yet, it is a genuine RED. Where a task asserts
behaviour that is **already correct** — the control cases — the block says so explicitly and the
expected RED count excludes it. A checkpoint reporting 0 failures means the premise is wrong: stop
and find out why before implementing.

---

## Phase 1: Setup

- [X] T001 Add `luxon` and `fast-xml-parser` to `frontend/mcm-app/package.json`
- [X] T002 [P] Add the six new environment variables to `frontend/mcm-app/src/config/env.ts` and `scripts/gen-dev-env.mjs`
- [X] T003 [P] Define shared backup types in `frontend/mcm-app/src/types/backups.ts`
- [X] T004 [P] Add MinIO and WebDAV test services to `infrastructure-as-code/docker/stacks/` under a `backups` profile
- [X] T005 Add the three collection accessors and their indexes to `frontend/mcm-app/src/bff-server/mongo-client.ts`

### T001 — Add the two new dependencies

**Type**: Config change | **Time**: 10m | **Risk**: Low
**Spec reference**: [research.md](./research.md) §R5, §R6

`luxon` for timezone/DST arithmetic (§R6 — SC-006 demands provable correctness across DST
transitions; this is not arithmetic to hand-roll). `fast-xml-parser` for WebDAV PROPFIND responses
only (§R5 — Node has no XML parser and a regex over XML is the wrong answer).

**Deliberately NOT added**: `@aws-sdk/client-s3`. See [plan.md](./plan.md) Complexity Tracking — the
SigV4 signer in T012/T013 replaces it, and that decision is contained behind the driver interface.

**Done when**: both appear in `package.json` with pinned ranges, `pnpm install` succeeds, and
`pnpm nx build mcm-app` still passes. Renovate picks both up with no further configuration.

### T002 — New environment variables

**Type**: Config change | **Time**: 30m | **Risk**: Medium
**Spec reference**: FR-002, FR-005, FR-015, R1

| Variable | Purpose |
|---|---|
| `BACKUP_CREDENTIAL_ENC_KEY` | 32 bytes base64. **A distinct key from `AGENT_CONFIG_ENC_KEY`** — reusing that one widens its blast radius for no gain |
| `BACKUP_TICK_SECRET` | Guards the internal tick route |
| `BACKUP_ALLOWED_DESTINATION_HOSTS` | Comma-separated allowlist. The guard denies private ranges **by default**, so a homelab NAS must be listed |
| `BACKUP_MAX_MOVIES` | Default `25000` |
| `BACKUP_MAX_UNCOMPRESSED_BYTES` | Default `67108864` (64 MiB) |
| `BACKUP_TICK_INTERVAL_MS` | Default `60000` |

Follow the existing `env.ts` shape. **No inline comments on value lines** in any `.env` file —
dotenv treats everything after `=` as the literal value, so a trailing comment becomes part of the
secret (`openwiki/gotchas/env-file-inline-comments.md`).

**Done when**: `node scripts/gen-dev-env.mjs` produces a `.env.local` containing all six, and the
BFF refuses to start with a clear message when `BACKUP_CREDENTIAL_ENC_KEY` is absent but a
destination exists — absent-and-unused must stay startable so the feature is genuinely optional.

### T004 — Real S3 and WebDAV targets for the integration tier

**Type**: Config change | **Time**: 45m | **Risk**: Low
**Spec reference**: [research.md](./research.md) §R11 · constitution §Test Type Integrity

Add two services in their own compose file so they are opt-in:

- **MinIO** — reuse `infrastructure-as-code/docker/minio/Dockerfile`, the from-source non-root image
  from features 069/070. Do not add a third-party pull for something already built here.
- **WebDAV** — a small server container, digest-pinned like every other infra image
  (`openwiki/runbooks/infra-image-scanning.md` — a new pulled image enters the CVE sweep).

Both bind to `127.0.0.1` only, and both hosts go in `BACKUP_ALLOWED_DESTINATION_HOSTS` for dev.

**Done when**: `docker compose -p mcm --env-file infrastructure-as-code/docker/stacks/mcm.env -f infrastructure-as-code/docker/backups/compose.yaml up -d` yields two healthy containers, and
`mc alias set` against the MinIO one succeeds. **These must be real** — an integration test that
passes with these containers down is not an integration test and its result is worthless.

### T005 — Collections and indexes

**Type**: Implementation | **Time**: 30m | **Risk**: Low
**Spec reference**: [data-model.md](./data-model.md)

Add `getBackupDestinationsCollection`, `getBackupJobsCollection`, `getBackupRunsCollection`
alongside the existing accessors, plus index creation: `{userId:1}` on all three,
`{userId:1,label:1}` unique on destinations, `{nextRunAt:1,enabled:1}` on jobs,
`{userId:1,jobId:1,startedAt:-1}` plus a 180-day TTL on runs.

**Remember the standing constraint**: this store is a **standalone Mongo, not a replica set** — no
multi-document transactions. Nothing in this feature may span two documents atomically.

**Done when**: indexes are present in `db.backup_jobs.getIndexes()` after first use.

---

## Phase 2: Foundational

**Blocking.** Nothing in any user story may land before this phase. It contains the security control
the whole feature's safety rests on, and the two drivers everything else writes through.

- [X] T006 Write the resolving URL guard unit suite in `frontend/mcm-app/src/bff-server/unit-tests/backup-destination-url-guard.test.ts`
- [X] T007 Implement the DNS-resolving, connection-pinning guard in `frontend/mcm-app/src/bff-server/backup-destination-url-guard.ts`
- [X] T008 [P] Write the AAD-binding unit suite in `frontend/mcm-app/src/bff-server/unit-tests/backup-credential-crypto.test.ts`
- [X] T009 [P] Add backup AAD helpers to `frontend/mcm-app/src/bff-server/agent-config-crypto.ts`
- [X] T010 [P] Write the lock suite (`frontend/mcm-app/tests/integration/redis-lock.integration.test.ts` — INTEGRATION, see the block) and implement `frontend/mcm-app/src/bff-server/redis-lock.ts`
- [X] T011 Define the driver interface in `frontend/mcm-app/src/bff-server/backup-destination-driver.ts`
- [X] T012 Write the SigV4 signer suite against published AWS test vectors in `frontend/mcm-app/src/bff-server/unit-tests/backup-request-signer.test.ts`
- [X] T013 Implement the SigV4 signer in `frontend/mcm-app/src/bff-server/backup-request-signer.ts`
- [X] T014 Write the S3 driver integration suite in `frontend/mcm-app/tests/integration/backup-driver-s3.test.ts`
- [X] T015 Implement the S3 driver in `frontend/mcm-app/src/bff-server/backup-driver-s3.ts`
- [X] T016 [P] Write the WebDAV driver integration suite in `frontend/mcm-app/tests/integration/backup-driver-webdav.test.ts`
- [X] T017 [P] Implement the WebDAV driver in `frontend/mcm-app/src/bff-server/backup-driver-webdav.ts`

### T003 — Shared types

**Type**: New file | **Time**: 30m | **Risk**: None
**Spec reference**: [data-model.md](./data-model.md)

`BackupDestination`, `BackupJob`, `Schedule`, `RunSummary`, `BackupRun`, `BackupVersion`, and the
`BackupDestinationDriver` result types. Discriminated on `type` so an `s3` value cannot carry a
`username`. **No `FR-###` in any identifier** — requirement ids belong in a provenance comment, per
the constitution's Behavior-Descriptive Identifiers rule.

**Done when**: `pnpm nx lint mcm-app` and `tsc --noEmit` both pass with the types imported nowhere yet.

---

### T006 — The guard suite, including the case the existing guard cannot catch

**Type**: Test | **Time**: 1h30m | **Risk**: High
**Spec reference**: FR-005 · SC-011 · US1-AC4 · [research.md](./research.md) §R4

**Scenarios covered**: US1-AC4 — a destination address resolving to a loopback, link-local, private
or cloud-metadata address is rejected, including via DNS-rebinding-shaped hostnames.

**File(s)**: `frontend/mcm-app/src/bff-server/unit-tests/backup-destination-url-guard.test.ts`

**Read `research.md` §R4 before writing this.** The backlog item says to reuse
`validateOllamaUrl`. It cannot be reused: `agent-config-ssrf.ts` is **DNS-blind by documented
design** (`openwiki/gotchas/agent-config-ssrf-guard.md` states it as a residual risk in those words).
This suite must fail against that guard, and it is the reason a new one exists.

Four groups, each independently asserted:

1. **Literal blocked addresses** — `169.254.169.254`, `fe80::1`, `fd00:ec2::254`, `127.0.0.1`,
   `10.0.0.5`, `192.168.1.10`. All rejected. Private ranges **are** rejected here, unlike the Ollama
   guard — `mc-service` and `keycloak-service` live in private space too (§R4).
2. **The canonicalization case** — `http://[::ffff:169.254.169.254]/`. WHATWG `new URL()` rewrites
   this to the hex form `::ffff:a9fe:a9fe`, so a dotted-decimal regex never fires. Rejected.
3. **The resolving case — this is the new capability.** A test hostname resolving to a blocked
   address, with the resolver injected as a seam. Rejected. *If this passes against an
   implementation that never calls a resolver, the test is wrong, not the guard.*
4. **The allowlist case** — a private address **in** `BACKUP_ALLOWED_DESTINATION_HOSTS` is accepted,
   because a homelab NAS is the primary legitimate destination.

Plus: **multi-address rejection** — a hostname resolving to one safe and one blocked address is
rejected. Checking only the first answer is the subtle version of this bug.

**Verify RED**:
```bash
pnpm nx test mcm-app --testPathPattern='backup-destination-url-guard'
```
**Expected RED**: the whole suite fails to resolve the module — `backup-destination-url-guard.ts`
does not exist yet. After T007 stubs the export, expect **every** assertion in groups 1–4 failing.

> A checkpoint here showing 0 failures means the suite is not exercising the new module. Do not
> proceed on it.

### T007 — The guard

**Type**: Implementation | **Time**: 2h | **Risk**: High
**Spec reference**: FR-005 · **Prerequisite**: T006 complete and verified RED.

Implement `assertDestinationUrlAllowed(url)`:

1. Parse; require `http:`/`https:`.
2. Resolve the hostname to **all** A and AAAA addresses (`dns.promises.lookup` with `all: true`).
3. Reject if **any** resolved address is loopback, link-local, private, unique-local,
   cloud-metadata, or unspecified. Reuse `mappedIpv4()`'s de-mapping logic from
   `agent-config-ssrf.ts` — that part is correct and load-bearing.
4. Consult `BACKUP_ALLOWED_DESTINATION_HOSTS` to admit an otherwise-blocked host.
5. Return the **vetted address** so the caller can pin to it.

Export `createPinnedFetch(vettedAddress)` which supplies a custom `lookup` to the connection agent so
the address checked is the address connected to. **Keep `redirect: 'manual'`** — proven in
`agent-config-probes.ts`; a vetted URL must not 30x-bounce to a blocked target.

> **The pinning is the part most likely to be got subtly wrong.** Resolve-then-connect without
> pinning leaves a TOCTOU window, and a guard with that window is theatre. T014 asserts the address
> actually connected to, not merely that the guard returned one.

**Verify GREEN**:
```bash
pnpm nx test mcm-app --testPathPattern='backup-destination-url-guard'
```
**Expected GREEN**: 0 failures.

**Also run** (the existing guard must be untouched — this feature adds a guard, it does not modify
the Ollama one):
```bash
pnpm nx test mcm-app --testPathPattern='agent-config-ssrf'
```
**Expected**: previously passing tests still pass.

### T008 / T009 — Credential encryption bound to owner *and* destination

**Type**: Test + Implementation | **Time**: 45m | **Risk**: Medium
**Spec reference**: FR-002 · [research.md](./research.md) §R10

**Scenarios covered**: US1-AC3 — a stored secret is never displayed or returned.

Add `backupSecretAad(userId, destinationId)` → `${userId}:backupDestinationSecret:${destinationId}`
and `offlineTokenAad(userId)` → `${userId}:offlineRefresh`, alongside the existing `secretAad`.

**Including the destination id matters**: without it, two of one user's *own* destination secrets are
interchangeable, and a store-layer mixup decrypts silently instead of failing authentication.

Assert: a blob sealed for destination A fails to decrypt under destination B's AAD; a blob sealed for
user A fails under user B's; the correct AAD round-trips.

**Verify RED**:
```bash
pnpm nx test mcm-app --testPathPattern='backup-credential-crypto'
```
**Expected RED**: 3 failures — the helpers are not exported yet.

**Verify GREEN**: same command, 0 failures. Also re-run `agent-config-crypto.test.ts` unchanged.

### T010 — The Redis leader lock

**Type**: Test + Implementation | **Time**: 1h | **Risk**: Low
**Spec reference**: FR-018 · [research.md](./research.md) §R2

`cache-service.ts`'s private `RedisLike` already declares `set(key, value, 'EX', n, 'NX')` — export a
narrow `acquireLock` / `releaseLock` pair rather than the raw client.

Assert: two concurrent acquires → one wins; the lock expires after its TTL; releasing a lock held by
a **different** instance id is a no-op (or a stale holder steals another's lock).

This is an **optimisation, not the correctness guarantee** — that is the atomic claim in T050/T051.
Do not let a passing lock test stand in for it.

**Verify RED**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='redis-lock'
```
**Expected RED**: 3 failing cases.

**Verify GREEN**: same command, 0 failures.

---

### T011 — The driver interface

**Type**: New file | **Time**: 30m | **Risk**: Low
**Spec reference**: FR-001 · [research.md](./research.md) §R5

`put` / `get` / `list` / `delete` / `testConnection`, plus a factory selecting on
`destination.type`. Every method takes an already-vetted, pinned connection from T007 — the guard
must not be something a driver can forget to call.

**This interface is what contains the SigV4 decision.** If the operator later prefers
`@aws-sdk/client-s3`, only T013 and T015 change. Keep it free of S3-shaped assumptions: no
`bucket` in the signatures, no ETag semantics, no multipart.

**Done when**: both drivers in T015 and T017 satisfy it with no `type`-specific branching outside the
factory.

---

### T012 / T013 — SigV4

**Type**: Test + Implementation | **Time**: 3h | **Risk**: High
**Spec reference**: [research.md](./research.md) §R5 · [plan.md](./plan.md) Complexity Tracking

Test **against AWS's published SigV4 test-suite vectors** — canonical request, string-to-sign, and
final signature are all specified with known-good expected values, so this is verified against an
external oracle rather than against itself. Cover PUT with a payload hash, GET, LIST (query string
signing, which is where the canonical-query ordering rule bites), and DELETE.

**Ratified 2026-09-20 — do not substitute the AWS SDK.** This was the plan's one open decision and
the operator settled it in favour of the signer. Verification is against AWS's published vectors (an
external oracle) plus a real MinIO in T014, so "it works" never rests on the implementation agreeing
with itself.

**Verify RED**:
```bash
pnpm nx test mcm-app --testPathPattern='backup-request-signer'
```
**Expected RED**: every vector failing — the module does not exist.

**Verify GREEN**: same command, 0 failures, every published vector matching exactly.

### T014 / T015 — S3 driver against a real MinIO

**Type**: Test + Implementation | **Time**: 3h | **Risk**: Medium
**Spec reference**: FR-001, FR-004, FR-011 · **Prerequisite**: T004, T013.

**File(s)**: `frontend/mcm-app/tests/integration/backup-driver-s3.test.ts`

**No mocking of any kind** — constitution §Test Type Integrity. The golden-tier cassette exception is
LLM-only and does not apply. If this suite passes with MinIO down, it is misclassified.

Assert: `put` then `get` round-trips bytes exactly; `list` returns keys in lexicographic order under
a prefix; `delete` removes one object and leaves its neighbours; `testConnection` distinguishes
**unreachable** from **credentials rejected** from **no write permission** (FR-004 requires reporting
which); and the connection was made to the **pinned address** from T007.

**Verify RED**:
```bash
docker compose -f infrastructure-as-code/docker/backups/compose.yaml up -d
pnpm nx test:integration mcm-app --testPathPattern='backup-driver-s3'
```
**Expected RED**: all cases failing — no driver module.

**Verify GREEN**: same command, 0 failures. Set `MCM_REQUIRE_LIVE_STACK=1` so a credential-driven
skip becomes a failure — **watch the skip count**, because a skipped test reads as a pass.

### T016 / T017 — WebDAV driver

Same shape as T014/T015 against the WebDAV container. `PROPFIND` returns XML parsed by
`fast-xml-parser`; assert against a real server response, not a hand-written fixture — the point of
this tier is that the real server's dialect is what gets exercised.

---

## Phase 3: User Story 1 — Add and verify a destination I own (P1)

**Goal**: A user can add, test, edit and delete S3 and WebDAV destinations; credentials never come back.

**Independent test**: Add both kinds, test both, edit one, delete the other — with no job, no backup
and no scheduler in existence.

- [X] T018 [P] [US1] Write the destination store suite in `frontend/mcm-app/tests/integration/backup-destination-store.integration.test.ts` (INTEGRATION, not unit — see the block)
- [X] T019 [US1] Implement `frontend/mcm-app/src/bff-server/backup-destination-store.ts`
- [X] T020 [P] [US1] Write the destination route authz suite in `frontend/mcm-app/tests/integration/backup-destinations-authz.test.ts`
- [X] T021 [US1] Implement the destination routes under `frontend/mcm-app/src/app/bff-api/backups/destinations/`
- [X] T022 [P] [US1] Write the probe suite in `frontend/mcm-app/tests/integration/backup-destination-probe.test.ts`
- [X] T023 [US1] Implement `POST /bff-api/backups/destinations/test`
- [X] T024 [US1] Build the destination UI in `frontend/mcm-app/src/components/backups/destination-form.tsx` and `destination-list.tsx`
- [X] T025 [US1] Write the destination E2E in `frontend/mcm-app/e2e/web/backups.spec.ts`, tagged `@gate`

### T018 — The store must make leaking a secret impossible, not merely unlikely

**Type**: Test | **Time**: 1h | **Risk**: Medium
**Spec reference**: FR-002, FR-003, FR-006, FR-034 · **Scenarios covered**: US1-AC3, US1-AC5

Assert:

1. `secretEnc` is **excluded by the store's read projection**, not stripped per route. A route that
   forgets to strip cannot then leak it — that is the difference between a control and a convention.
2. An update **omitting** `secret` preserves the stored one (FR-003); an update sending `""` is
   **rejected**, not treated as a clear — silently blanking a credential is indistinguishable from a
   UI bug.
3. Every read is filtered by `userId` taken from the caller, and a read with a foreign `userId`
   returns `null` (FR-034).
4. Delete wipes `secretEnc` and disables referencing jobs (FR-006).

**Verify RED**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-destination-store'
```
**Expected RED**: 4 failing cases — module absent.

**Verify GREEN**: same command, 0 failures.

### T019 — The destination store

**Type**: Implementation | **Time**: 1h30m | **Risk**: Medium
**Spec reference**: FR-002, FR-003, FR-006, FR-034 · **Prerequisite**: T018 complete and verified RED.

Implement `backup-destination-store.ts` following `agent-config-store.ts`: partial upsert so an
omitted field is left intact, `userId` always a caller argument, and a read projection that
**excludes `secretEnc` at the store layer**. A route that forgets to strip it must be unable to leak
it — that is the difference between a control and a convention.

Secrets are sealed by the caller using `backupSecretAad(userId, destinationId)` from T009; this layer
never sees plaintext.

**Verify GREEN**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-destination-store'
```
**Expected GREEN**: 0 failures — `4 passed`.

---

### T020 — 404, never 403

**Type**: Test | **Time**: 1h | **Risk**: Medium
**Spec reference**: FR-034 · SC-010 · **Scenarios covered**: US1-AC5

Two real users against the real stack. User B requests every one of user A's destination routes —
GET, PATCH, DELETE — and receives **404, not 403**. A 403 confirms the resource exists, which is
itself the leak.

Also assert no route accepts a `userId` from path, query or body: the OpenAPI contract deliberately
contains no such parameter anywhere ([contracts/bff-backups-api.yaml](./contracts/bff-backups-api.yaml)).

**Verify RED**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-destinations-authz'
```
**Expected RED**: all cases failing — routes return 404 because they do not exist, which is
**indistinguishable from passing**. Therefore this suite must **first** assert user A's own happy
path returns 200; that assertion is the one that makes the 404 cases meaningful. Expect the happy
path failing at RED.

> This is the trap in authz testing: "not found" is both the failure mode and the expected result.
> Without a positive control the suite passes against a feature that was never built.

### T021 — The destination routes

**Type**: Implementation | **Time**: 2h | **Risk**: Medium
**Spec reference**: FR-001..FR-006, FR-034 · **Prerequisite**: T020 complete and verified RED.

Implement the routes under `src/app/bff-api/backups/destinations/` per
[contracts/bff-backups-api.yaml](./contracts/bff-backups-api.yaml). Every handler goes through the
shared `requireAuth` → `requireMcUser` layer — **no per-handler auth checks**, which the constitution
prohibits: a handler added without the opt-in would be silently unprotected.

Bodies are `zod`-parsed as a discriminated union on `type`, so an `s3` document can never carry a
`username`. A foreign or unknown id returns **404, never 403**.

**Verify GREEN**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-destinations-authz'
```
**Expected GREEN**: 0 failures. The positive control (user A's own 200) passing is what makes the
404 cases meaningful — check it is in the passing set, not skipped.

---

### T022 / T023 — The probe reports *which* thing failed

**Type**: Test + Implementation | **Time**: 1h30m | **Risk**: Medium
**Spec reference**: FR-004 · **Scenarios covered**: US1-AC1, US1-AC2, US1-AC4

Follow `agent-config-probes.ts`: bounded by `AbortController`, `redirect: 'manual'`, outcomes
normalised to `'ok'` or `{ reason }`, **never** the upstream body — it may carry a credential.

Assert all four outcomes separately: reachable+authorised, reachable+credentials rejected,
unreachable, and reachable+authorised-but-no-write-permission. Plus: the probe **re-runs the guard**
(T007), so it can never be used as a way around the save-time check.

Accepts an unsaved draft as well as a saved id, so a user verifies before committing a credential.

**Verify RED**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-destination-probe'
```
**Expected RED**: 5 failing cases.

**Verify GREEN**: same command, 0 failures.

### T024 — Destination UI

**Type**: Implementation | **Time**: 3h | **Risk**: Low
**Spec reference**: FR-001..FR-006

Replace the body of `screens/settings/backups-settings-screen.tsx`. **The route, its registry row,
its label and its reported `current_screen` (`settings-backups`) all stay exactly as they are** —
feature 062 shipped them and the gateway's `current_screen` vocabulary is a contract tested by
`test_current_screen_contract.py`. Changing it here breaks the agent's context resolution.

Use `@mcm/design-system` tokens, not raw values. Secret fields render empty on edit with placeholder
text saying the stored secret is retained — never a masked stand-in, which implies a value was
fetched.

**Done when**: both destination kinds can be added, tested, edited and deleted through the UI, and
the network tab shows no secret in any response body.

### T025 — Destination E2E

**Type**: Test | **Time**: 1h30m | **Risk**: Low
**Spec reference**: SC-001 · **Scenarios covered**: US1-AC1, US1-AC2, US1-AC3, US1-AC5

**Must carry a tier tag.** An unclassified E2E test **fails** rather than defaulting into the gate
(`openwiki/invariants/testing-tiers.md`). These are deterministic and non-model, so `@gate`.

Locators use `data-testid` — React Native Web renders `testID` as `data-testid` and
`playwright.config.ts` sets `testIdAttribute` accordingly.

**Verify RED**:
```bash
E2E_BFF_TARGET=dev-container E2E_TIER=gate npx playwright test backups
```
**Expected RED**: the spec fails at the first locator — the Backups screen still shows the 062
placeholder.

> This task carries a Verify RED but no Verify GREEN, and that is deliberate: its paired
> implementation is T024, which is a UI task verified by a **Done when** condition. The GREEN
> for this spec arrives with T024's completion — run the command again then.

> Do **not** use `--grep-invert` to split tiers. Playwright 1.60 accepts it here and **silently does
> nothing**; `E2E_TIER` in `playwright.config.ts` is the mechanism.

---

## Phase 4: User Story 2 — Take a backup right now (P1)

**Goal**: One artifact per run, verifiably faithful to the live data.

**Independent test**: Press "Back up now", inspect the destination, confirm one artifact whose
recorded contents match live data — with no scheduler and no restore path built.

- [X] T026 [P] [US2] Write the snapshot reader suite in `frontend/mcm-app/tests/integration/backup-snapshot-reader.test.ts`
- [X] T027 [US2] Implement `frontend/mcm-app/src/bff-server/backup-snapshot-reader.ts`
- [X] T028 [P] [US2] Write the artifact suite in `frontend/mcm-app/src/bff-server/unit-tests/backup-artifact.test.ts`
- [X] T029 [US2] Implement `frontend/mcm-app/src/bff-server/backup-artifact.ts`
- [X] T030 [P] [US2] Write the size-ceiling suite in `frontend/mcm-app/tests/integration/backup-ceiling.test.ts`
- [X] T031 [US2] Enforce the ceiling in `frontend/mcm-app/src/bff-server/backup-runner.ts`
- [X] T032 [US2] Write the runner suite in `frontend/mcm-app/tests/integration/backup-runner.test.ts`
- [X] T033 [US2] Implement `frontend/mcm-app/src/bff-server/backup-runner.ts`
- [X] T034 [P] [US2] Write the concurrency and rate-limit suite in `frontend/mcm-app/tests/integration/backup-run-gate.test.ts`
- [X] T035 [US2] Implement the per-user run gate and rate limit in `frontend/mcm-app/src/bff-server/backup-runner.ts`
- [X] T036 [P] [US2] Write the job and run store suite in `frontend/mcm-app/tests/integration/backup-job-store.integration.test.ts` (INTEGRATION, not unit — see the block)
- [X] T037 [US2] Implement `backup-job-store.ts`, `backup-run-store.ts` and the job, run and runs routes under `frontend/mcm-app/src/app/bff-api/backups/jobs/`
- [X] T038 [US2] Build the job form, "Back up now" and run history UI in `frontend/mcm-app/src/components/backups/`
- [X] T039 [US2] Extend the `@gate` E2E with the back-up-now flow in `frontend/mcm-app/e2e/web/backups.spec.ts`

### T026 / T027 — Paging is where a silent truncation would come from

**Type**: Test + Implementation | **Time**: 2h | **Risk**: Medium
**Spec reference**: FR-009 · **Scenarios covered**: US2-AC1, US2-AC2

`listMovies` uses **opaque compound keyset cursors**, not offsets
(`openwiki/gotchas/keyset-pagination.md`). Assert that a collection with more movies than one page
is read **completely** — seed past the page size deliberately, then compare the count to
`movies/count`. A reader that silently stops at page one produces an artifact that looks valid and
has lost data, which is the worst failure this feature can have.

Also assert: a collection deleted mid-read is recorded as absent rather than failing the whole run,
and the manifest then agrees with the body (spec Edge Cases).

Reads go through `createMcServiceClient(jwt)` — the unchanged seam.

**Verify RED**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-snapshot-reader'
```
**Expected RED**: 3 failing cases.

**Verify GREEN**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-snapshot-reader'
```
**Expected GREEN**: 0 failures — `3 passed`. Set `MCM_REQUIRE_LIVE_STACK=1` so a credential-driven
skip becomes a failure, and **watch the skip count**: a skipped test reads as a pass.

### T028 / T029 — Manifest and integrity

**Type**: Test + Implementation | **Time**: 2h | **Risk**: Medium
**Spec reference**: FR-008, FR-010, FR-014 · [contracts/backup-artifact-v1.schema.json](./contracts/backup-artifact-v1.schema.json)

`sha256` is computed over the **canonically serialised, uncompressed** `collections` array — not the
compressed bytes — so the check survives a compression-setting change and still catches a bad
decompression.

Assert: build → gzip → gunzip → parse round-trips exactly; the digest recomputes; per-collection
counts in the manifest equal the body's actual lengths; a one-byte mutation anywhere in the body
makes verification fail; and the output validates against the JSON Schema contract.

**Canonical serialisation must be pinned** — key order must be deterministic, or the digest is
unstable across Node versions and every restore fails months later for no visible reason.

**Verify RED**:
```bash
pnpm nx test mcm-app --testPathPattern='backup-artifact'
```
**Expected RED**: 5 failing cases.

**Verify GREEN**:
```bash
pnpm nx test mcm-app --testPathPattern='backup-artifact'
```
**Expected GREEN**: 0 failures — `5 passed`.

**Also run** (the artifact contract must still validate):
```bash
pnpm nx test mcm-app --testPathPattern='backup-credential-crypto'
```
**Expected**: previously passing tests still pass.

### T030 / T031 — The ceiling fails loudly and writes nothing

**Type**: Test + Implementation | **Time**: 1h30m | **Risk**: High
**Spec reference**: FR-015 · **Scenarios covered**: US2-AC6

Run with `BACKUP_MAX_MOVIES=5` against a collection of 20.

**Assert the object count at the destination is zero** — not merely that the call threw. A truncated
artifact that looks complete is precisely the failure this exists to prevent, and "it threw" does not
prove nothing was written.

The failure reason must name **both the ceiling and the measured value**, so the error tells the
operator what to raise. Check both units independently: many small movies (count-bound) and few large
ones (bytes-bound).

**Verify RED**:
```bash
BACKUP_MAX_MOVIES=5 pnpm nx test:integration mcm-app --testPathPattern='backup-ceiling'
```
**Expected RED**: 3 failing cases — no ceiling is enforced, so the run succeeds and writes an object.

**Verify GREEN**:
```bash
BACKUP_MAX_MOVIES=5 pnpm nx test:integration mcm-app --testPathPattern='backup-ceiling'
```
**Expected GREEN**: 0 failures — `3 passed`, and the destination object count asserted at **zero**
in each case.

**Also run** (the ceiling must not break an ordinary run):
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-runner'
```
**Expected**: previously passing tests still pass.

### T032 / T033 — The runner, end to end, against MinIO

**Type**: Test + Implementation | **Time**: 4h | **Risk**: High
**Spec reference**: FR-008, FR-012, FR-014 · **Scenarios covered**: US2-AC1, US2-AC2, US2-AC5

**Compare against live data read back from mc-service**, never against the in-memory structure used
to build the artifact — comparing a thing to itself proves nothing and will pass over a broken
reader.

Assert: exactly one object appears; its digest recomputes; its counts equal live counts; and for a
destination that fails **mid-run**, the run is recorded `failed` and **no object exists** (FR-014) —
so a partial can never later be listed as a version.

**Verify RED**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-runner'
```
**Expected RED**: 4 failing cases.

**Verify GREEN**: same command, 0 failures, `MCM_REQUIRE_LIVE_STACK=1` set. **Watch the skip count.**

### T034 / T035 — One run per user, and a rate limit

**Type**: Test + Implementation | **Time**: 1h | **Risk**: Low
**Spec reference**: FR-012, FR-013 · **Scenarios covered**: US2-AC3, US2-AC4

`backup:running:<userId>` in Redis with a TTL matched to the run-timeout ceiling, so a crashed run
cannot lock the user out permanently. Reuse the `rate-limiter.ts` pattern for "Back up now".

Assert a genuinely **concurrent** second request gets 409 (not a sequential one, which proves
nothing about the race), and that the key expires.

---

### T038 / T039 — Job UI and the back-up-now E2E

**Type**: Implementation + Test | **Time**: 3h30m | **Risk**: Low
**Spec reference**: FR-007, FR-012, FR-036 · **Scenarios covered**: US2-AC3, US2-AC4 · Tag: `@gate`

Job form (destination, collections, retention), a "Back up now" button, and run history. Design-system
tokens only, no raw values.

The button must be **disabled while a run is in flight** and show why — the 409 from T035 is the
server-side guarantee, but a user who can click twice and receive an error has been told the feature
is broken when it is working correctly.

**Verify RED**:
```bash
E2E_BFF_TARGET=dev-container E2E_TIER=gate npx playwright test backups
```
**Expected RED**: the back-up-now case fails at the job-form locator; the T025 destination cases
still pass.

**Verify GREEN**: same command, 0 failures.

---

### T036 / T037 — Job and run persistence, and the routes over them

**Type**: Test + Implementation | **Time**: 3h | **Risk**: Medium
**Spec reference**: FR-007, FR-034 · **Scenarios covered**: US2-AC1, US6-AC1

Job definition is the feature's central entity and had no test of its own until this task existed.

Assert on the store: a job round-trips `collectionIds`, `keepLast` and `enabled`; an **empty**
`collectionIds` means *every collection the user owns at run time*, resolved at run time and not at
save time (a collection created after the job must be included); `keepLast` outside 1–365 is
rejected; `destinationId` must reference a destination **the same user owns**, checked against the
caller's id rather than trusted from the body (FR-034); and `lastRun` is a denormalised copy so the
list view is one query.

Implement all three route groups from the contract, including **`GET /jobs/{jobId}/runs`**
(`listBackupRuns`) — it is defined in
[contracts/bff-backups-api.yaml](./contracts/bff-backups-api.yaml) and was missing from the plan's
file tree, so it is easy to skip.

Run records are written as **independent documents**: the BFF Mongo is standalone, so nothing can tie
a run record to its job atomically ([data-model.md](./data-model.md)).

**Verify RED**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-job-store'
```
**Expected RED**: 5 failing cases — module absent.

**Verify GREEN**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-job-store'
pnpm nx test:integration mcm-app --testPathPattern='backup-run-gate'
```
**Expected GREEN**: 0 failures in both.

---

## Phase 5: User Story 3 — Recover without risking what I have now (P1)

**Goal**: Restore a version into new collections, having proven the artifact first.

**Independent test**: Back up, change live data, restore, confirm the restored copy is faithful and
the live data is untouched.

- [X] T040 [P] [US3] Write the verify-before-write suite in `frontend/mcm-app/tests/integration/backup-restore-verify.test.ts`
- [X] T041 [US3] Implement artifact verification in `frontend/mcm-app/src/bff-server/backup-artifact.ts`
- [X] T042 [US3] Write the restore fidelity and non-destructiveness suite in `frontend/mcm-app/tests/integration/backup-restore.test.ts`
- [X] T043 [US3] Implement `frontend/mcm-app/src/bff-server/backup-restore-writer.ts`
- [X] T044 [P] [US3] Implement version listing and `usable` detection in `frontend/mcm-app/src/app/bff-api/backups/jobs/[jobId]/versions+api.ts`
- [X] T045 [US3] Implement the restore and download routes under `frontend/mcm-app/src/app/bff-api/backups/jobs/[jobId]/`
- [X] T046 [US3] Build the version list, Restore and Download UI in `frontend/mcm-app/src/components/backups/version-list.tsx`
- [X] T047 [US3] Extend the `@gate` E2E with backup → mutate → restore → verify in `frontend/mcm-app/e2e/web/backups.spec.ts`

### T040 / T041 — Nothing is written until the artifact proves itself

**Type**: Test + Implementation | **Time**: 2h | **Risk**: High
**Spec reference**: FR-031, FR-032 · SC-004 · **Scenarios covered**: US3-AC3, US3-AC4

Order is load-bearing: download → decompress → parse → check `formatVersion` → recompute `sha256` →
**only then** create anything.

Four cases, each asserting **zero collections created** afterwards — assert the count, not just that
an error was thrown:

1. A flipped byte inside the gzip.
2. A truncated object.
3. `formatVersion: 99` — refused, not best-effort parsed (FR-032).
4. A manifest whose counts disagree with its body.

**Verify RED**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-restore-verify'
```
**Expected RED**: 4 failing cases.

**Verify GREEN**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-restore-verify'
```
**Expected GREEN**: 0 failures — `4 passed`, each having asserted **zero collections created**.

### T042 / T043 — Fidelity, and the guarantee the feature rests on

**Type**: Test + Implementation | **Time**: 4h | **Risk**: High
**Spec reference**: FR-029, FR-030, FR-033 · SC-002, SC-003 · **Scenarios covered**: US3-AC1, US3-AC2, US3-AC6

Sequence, in this order:

1. Snapshot the **full live state** before restoring.
2. Restore; new collections appear as `<name> (backup <timestamp>)`.
3. Re-read live state and diff against step 1 — **zero differences** in pre-existing collections.
   **This is SC-003 and it is the whole safety argument.**
4. The restored copy matches movie count, every metadata field, and every external identifier
   (SC-002).
5. Restore the **same version twice** — both succeed, because collection-name uniqueness is
   case-insensitive at the index level (`openwiki/gotchas/mongodb-indexes-and-uniqueness.md`) and the
   timestamp suffix keeps the second name legal.

Writes go through `createMcServiceClient(jwt)` as the user, so domain validation, DAC and audit all
apply unchanged (FR-033). Bounded concurrency, with per-movie failures recorded rather than aborting.

**Verify RED**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-restore'
```
**Expected RED**: 5 failing cases.

**Verify GREEN**: same command, 0 failures.

---

### T044 — Version listing, and the artifact that is present but unusable

**Type**: Test + Implementation | **Time**: 2h | **Risk**: Medium
**Spec reference**: FR-028 · spec.md Edge Cases · **Scenarios covered**: US3-AC5

Lists the job's prefix at the destination directly, so it reflects **what is actually there** —
including objects this system did not write and versions since removed elsewhere.

The case that is easy to miss, and is in the spec's Edge Cases and the contract's `usable` field:
**an object that is present but zero-length or unreadable must be listed as unusable, not offered for
restore.** A version list that offers a corrupt object as restorable sends the user to a failure at
the worst possible moment.

Assert: a zero-length object → `usable: false`; an object that is not valid gzip → `usable: false`;
a healthy object → `usable: true`; objects outside this job's prefix are not listed; ordering is
newest-first.

**Verify RED**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-versions'
```
**Expected RED**: 5 failing cases — route absent.

**Verify GREEN**: same command, 0 failures — `5 passed`.

---

### T045 / T046 — Restore and download, route and UI

**Type**: Implementation | **Time**: 3h | **Risk**: Medium
**Spec reference**: FR-028, FR-029, FR-031 · **Prerequisite**: T040–T043 complete and verified.

The restore route is a thin caller of T041's verification and T043's writer — **no validation logic
lives in the handler**, so the verify-before-write ordering cannot be bypassed by a second entry
point later.

Download follows `agent/export-download+api.ts`: stream the bytes with a `Content-Disposition`
attachment, audit by key and size only. Unlike that route the handle is **not** a capability — the
key is guessable, so ownership is checked from the session on every request.

The UI offers Restore and Download per version, with `usable: false` versions visibly non-restorable.

**Verify GREEN**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-restore'
```
**Expected GREEN**: 0 failures, and a manual download whose bytes gunzip and validate against
[contracts/backup-artifact-v1.schema.json](./contracts/backup-artifact-v1.schema.json).

---

## Phase 6: User Story 4 — Backups happen without me (P2)

**Goal**: A job fires at its configured local time with no session present, exactly once.

**Independent test**: Configure a daily schedule, log out entirely, confirm the run fires and
produces a valid artifact.

- [x] T048 [P] [US4] Write the schedule arithmetic suite in `frontend/mcm-app/src/bff-server/unit-tests/backup-schedule.test.ts`
- [x] T049 [US4] Implement `frontend/mcm-app/src/bff-server/backup-schedule.ts`
- [x] T050 [P] [US4] Write the atomic-claim suite in `frontend/mcm-app/tests/integration/backup-job-claim.test.ts`
- [x] T051 [US4] Implement the atomic claim in `frontend/mcm-app/src/bff-server/backup-job-store.ts`
- [x] T052 [US4] Write the consent and revocation suite in `frontend/mcm-app/tests/integration/backup-offline-token.test.ts`
- [x] T053 [US4] Implement `frontend/mcm-app/src/bff-server/backup-offline-token.ts` and the consent routes
- [x] T054 [P] [US4] Write the account-deletion teardown suite in `frontend/mcm-app/tests/integration/backup-account-deletion.test.ts`
- [x] T055 [US4] Implement backup teardown on account deletion in `frontend/mcm-app/src/bff-server/backup-offline-token.ts` and the account-deletion path
- [x] T056 [US4] Register the consent redirect URI in `frontend/mcm-app/src/app/bff-api/auth/init+api.ts`
- [x] T057 [P] [US4] Write the tick route suite in `frontend/mcm-app/tests/integration/backup-tick.test.ts`
- [x] T058 [US4] Implement `frontend/mcm-app/src/app/bff-api/backups/tick+api.ts`
- [x] T059 [US4] Add the tick clock to `frontend/mcm-app/server.js`
- [x] T060 [US4] Build the schedule editor and consent prompt UI in `frontend/mcm-app/src/components/backups/schedule-editor.tsx`
- [x] T061 [US4] Extend the `@gate` E2E with an unattended, exactly-once scheduled run in `frontend/mcm-app/e2e/web/backups.spec.ts`

### T048 / T049 — DST, both directions, and the month that has no 31st

**Type**: Test + Implementation | **Time**: 3h | **Risk**: High
**Spec reference**: FR-019 · SC-006 · **Scenarios covered**: US4-AC5

Pure unit tests. **No clock, no network, no database** — `now` is an argument.

| Case | Zone | Rule |
|---|---|---|
| Spring forward | `Europe/London`, daily 02:30, on the day 02:30 does not exist | Next valid instant after the gap |
| Fall back | `Europe/London`, daily 01:30, on the day 01:30 occurs twice | The **first** occurrence; `nextRunAt` advances **past the second** so one occurrence yields one run |
| Southern DST | `Australia/Sydney` | Both directions again — the northern-hemisphere cases alone hide sign errors |
| Monthly 31st | 30-day month | **Clamp to the last day. Never skip a month** — a skipped month is a silent backup gap |
| Monthly 29th | Non-leap February | Clamp to the 28th |
| Weekly | Across a DST boundary | Still the same local time |
| Invalid zone | `Not/AZone` | Rejected at save time |
| **Raw cron string** (M1) | `frequency: '0 3 * * *'` | **Rejected** at save time (FR-016). A malformed expression silently means "never", the worst failure a backup can have |
| **User changes timezone** (M2) | job stored as `Europe/London`, request arrives from `America/New_York` | Next run is computed from the **job's** stored zone. The requesting device's zone must not influence it |

**Verify RED**:
```bash
pnpm nx test mcm-app --testPathPattern='backup-schedule'
```
**Expected RED**: all 9 groups failing — module absent.

**Verify GREEN**: same command, 0 failures. SC-006 says 100%; there is no partial credit here.

### T050 / T051 — Exactly once, without transactions

**Type**: Test + Implementation | **Time**: 2h | **Risk**: High
**Spec reference**: FR-018 · SC-005 · **Scenarios covered**: US4-AC4

**The BFF Mongo is standalone — no multi-document transactions** (`mongo-client.ts`). The single
atomic `findOneAndUpdate` in [data-model.md](./data-model.md) is the entire correctness mechanism;
the Redis lock is only an optimisation with a TTL guess in it.

Assert with **genuinely concurrent** callers — `Promise.all` over N claim attempts, not a sequential
loop, which proves nothing about the race:

1. N concurrent claims on one due job → exactly **one** returns the document, N−1 return `null`.
2. A job whose `claimedAt` is older than the reclaim ceiling **is** reclaimable — otherwise an
   instance killed mid-run wedges that job permanently.
3. A job whose `claimedAt` is recent is **not** reclaimable.
4. A disabled job is never claimed.

**Verify RED**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-job-claim'
```
**Expected RED**: 4 failing cases.

**Verify GREEN**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-job-claim'
```
**Expected GREEN**: 0 failures — `4 passed`. Run it at least 5 times: a race that passes once has
not been shown to be safe.

```bash
for i in $(seq 5); do pnpm nx test:integration mcm-app --testPathPattern='backup-job-claim' --skip-nx-cache || break; done
```

### T052 / T053 — Revocation must be asserted at Keycloak, not locally

**Type**: Test + Implementation | **Time**: 3h | **Risk**: High
**Spec reference**: FR-021..FR-024 · SC-012 · **Scenarios covered**: US4-AC2, US4-AC3, US4-AC7

Enabling a schedule is a **separate OIDC round trip** carrying `scope=openid offline_access`, whose
result is *stored*, never turned into a session. The BFF holds no refresh token to promote — the
session record is tokenless by constitution v2.0.0 — so there is nothing to shortcut.

**The assertion that matters (SC-012)**: after disabling the last schedule, **use the previously
stored refresh token against Keycloak and confirm it is rejected**. Observing a local `$unset` is
*not* evidence that anything was revoked, and a silently retained offline token is the failure mode
the spec singles out by name.

Order is load-bearing: `revokeToken(..., 'refresh_token')` **then** `$unset`. Reversed, a failed
revocation orphans a live token with no local record that it exists.

Also assert (US4-AC7): with the token revoked, a run **fails with an actionable reason** and does
**not** fall back to any other path to read the data (FR-024). Assert no mc-service call was made
with any other identity.

**Verify RED**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-offline-token'
```
**Expected RED**: 4 failing cases.

**Verify GREEN**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-offline-token'
```
**Expected GREEN**: 0 failures — `4 passed`. The SC-012 case must pass by **Keycloak rejecting the
stored token when used**, not by observing a local delete.

### T054 / T055 — Account deletion must take the standing permission with it

**Type**: Test + Implementation | **Time**: 2h | **Risk**: High
**Spec reference**: FR-023 · spec.md Edge Cases · **Scenarios covered**: US4-AC3

The spec says a deleted account leaves nothing behind: destinations, credentials, jobs, run history
and the standing permission are all erased. **Nothing covered this until now** — a deleted account
could leave a live offline token at Keycloak with no local record that it exists, which is the same
failure SC-012 exists to prevent, arriving by a different door.

Assert, for a user who is deleted:

1. The stored refresh token is **rejected by Keycloak when used** afterwards — the same standard as
   SC-012. A local `$unset` is not evidence that anything was revoked.
2. Every `backup_destinations`, `backup_jobs` and `backup_runs` document for that user is gone, and
   no `secretEnc` survives anywhere.
3. **Artifacts at the user's own destination are untouched.** They are the user's property at storage
   the user owns and pays for — this system deleting them would be destroying data it was trusted to
   copy, not cleaning up after itself.
4. Revocation is attempted **before** local deletion, and a revocation failure is surfaced rather
   than swallowed — reversed, a failed revocation orphans a live token with nothing left pointing
   at it.
5. Deleting a user with no backup configuration at all succeeds and is a no-op.

**Verify RED**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-account-deletion'
```
**Expected RED**: 5 failing cases — no teardown path exists.

**Verify GREEN**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-account-deletion'
```
**Expected GREEN**: 0 failures — `5 passed`.

**Also run** (the existing account-deletion path must be unbroken):
```bash
pnpm nx test:integration mcm-app --testPathPattern='auth'
```
**Expected**: previously passing tests still pass.

---

### T057 / T058 — The tick route

**Type**: Test + Implementation | **Time**: 2h | **Risk**: Medium
**Spec reference**: FR-017, FR-018, FR-020 · **Scenarios covered**: US4-AC1, US4-AC4, US4-AC6

Assert:

1. **No secret → 404, not 401.** The route must not advertise its own existence. Constant-time
   comparison.
2. A due job runs; a not-yet-due job does not.
3. Two concurrent ticks → `claimed` sums to 1. One reports `leader: false`, which is a **normal
   outcome, not an error**.
4. **With every cookie cleared** — the run must succeed on the stored standing permission alone, or
   it proves nothing about unattended operation.
5. A job whose time passed while the system was down runs **once** on recovery, not once per missed
   occurrence (FR-020).
6. The `?now=` override is **rejected** when the deployment is not explicitly non-production.

Time is **driven, not awaited**: a scheduling test that sleeps is a flaky test, and this repository
has paid for flaky E2E more than once.

**Verify RED**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-tick'
```
**Expected RED**: 6 failing cases — the route returns 404 for **every** request because it does not
exist, which **coincides with case 1's expected result**. Case 1 is therefore **not** meaningful at
RED; it becomes meaningful only once cases 2–6 pass. Note this in the checkpoint rather than
counting case 1 as a genuine RED.

**Verify GREEN**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-tick'
```
**Expected GREEN**: 0 failures — `6 passed`. Case 1 only becomes meaningful here, once cases 2–6
pass and a 404 can no longer be explained by the route being absent.

### T059 — The clock

**Type**: Implementation | **Time**: 1h | **Risk**: Medium
**Spec reference**: [research.md](./research.md) §R1

`setInterval` in `server.js` calling `POST http://127.0.0.1:${PORT}/bff-api/backups/tick` with the
secret, every `BACKUP_TICK_INTERVAL_MS`. Errors are logged and swallowed — a failing tick must never
take the HTTP server down.

Why a loopback call rather than a direct function call: `server.js` is **CommonJS outside the Metro
bundle**. It `require`s `@expo/server/adapter/express` and hands `dist/server` to
`createRequestHandler`; it cannot import `src/bff-server/*`, because those modules exist only inside
the bundle. The loopback call is the seam between the clock and the work.

**Do not touch the `__ExpoImportMetaRegistry` seeding** at the top of the file — it looks like dead
defensive code and removing it reintroduces a silent production-only hang
(`openwiki/gotchas/expo-router-and-transport-traps.md`).

**Done when**: a container run shows tick log lines at the configured interval, and
`docker compose logs bff-service` shows no unhandled rejection. **Document the dev/prod asymmetry**:
`server.js` does not run under Metro, so **no tick fires in dev** — that is expected, and the tick
route is called directly instead.

### T061 — Unattended E2E

**Type**: Test | **Time**: 2h | **Risk**: Medium
**Spec reference**: SC-005 · **Scenarios covered**: US4-AC1, US4-AC4 · Tag: `@gate`

Consent → schedule → **clear every cookie** → drive two concurrent ticks at the due instant → exactly
one artifact. Deterministic: the instant is supplied, never waited for.

---

## Phase 7: User Stories 5 & 6 — Retention and visibility (P2, P3)

**Goal**: Old versions are pruned on success only; failures are visible.

**Independent test**: keep-last-3, run four times → three remain, oldest gone. Then force a failure →
still three.

- [x] T062 [P] [US5] Write the retention suite in `frontend/mcm-app/tests/integration/backup-retention.test.ts`
- [x] T063 [US5] Implement `frontend/mcm-app/src/bff-server/backup-retention.ts`
- [x] T064 [US5] Wire pruning into `frontend/mcm-app/src/bff-server/backup-runner.ts`, after the artifact is confirmed written
- [x] T065 [P] [US6] Write the run-history and next-run surfacing suite in `frontend/mcm-app/src/bff-server/unit-tests/backup-run-summary.test.ts`
- [x] T066 [US6] Build the run history, failure banner and next-run UI in `frontend/mcm-app/src/components/backups/run-history.tsx`
- [x] T067 [US6] Extend the `@gate` E2E with retention and the failure banner in `frontend/mcm-app/e2e/web/backups.spec.ts`

### T062 / T063 / T064 — A failed run must never cost a good version

**Type**: Test + Implementation | **Time**: 2h30m | **Risk**: High
**Spec reference**: FR-025, FR-026, FR-027 · SC-007, SC-008 · **Scenarios covered**: US5-AC1..AC5

Assert:

1. `keepLast=3`, four **successful** runs → exactly 3 objects, and the removed one is the **oldest**.
2. A **failed** run prunes **nothing** — still 3 objects. **This is SC-008 and it is the one that
   matters**: a failed run must never be the reason a good version disappears.
3. Pruning runs **after** the new artifact is confirmed written, never before.
4. A delete failure at the destination leaves the run **successful**, records
   `pruneFailureReason` separately (FR-027), and the next successful run retries — which falls out of
   listing-and-sorting, needing no retry state.
5. Objects **not** belonging to this job are never considered, including another job's artifacts
   under the same destination and unrelated files the user put there (US5-AC5).
6. Lowering `keepLast` on an existing job applies on the next successful run.

Retention is "sort the keys, delete the tail" — ISO-8601 sorts lexicographically, which is why
[data-model.md](./data-model.md) chose that key layout.

**Verify RED**:
```bash
pnpm nx test:integration mcm-app --testPathPattern='backup-retention'
```
**Expected RED**: 6 failing cases.

**Verify GREEN**: same command, 0 failures.

### T066 — Visibility

**Type**: Implementation | **Time**: 2h | **Risk**: Low
**Spec reference**: FR-036, FR-037 · **Scenarios covered**: US6-AC1..AC4

Last run outcome, time, duration, artifact size, per-collection counts; next run rendered in the
**job's** timezone, not the device's; a failure banner that **persists until a later run succeeds**
(FR-037). No credential and no collection content anywhere in the rendered output (US6-AC4).

---

## Phase 8: Polish & cross-cutting

- [x] T068 [P] Write the audit-event coverage suite in `frontend/mcm-app/tests/integration/backup-audit.test.ts`
- [x] T069 [P] Run the credential and content leak scan per `specs/073-scheduled-backups/quickstart.md` Scenario 10
- [x] T070 [P] Write the operator runbook at `docs/runbooks/backups.md`
- [x] T071 [P] Record the durable learnings in `openwiki/gotchas/agent-config-ssrf-guard.md` and `openwiki/projects/bff.md`
- [x] T072 File the follow-up backlog items via `scripts/backlog.mjs` (streaming, email, Ollama guard, SFTP driver)
- [x] T073 Full gate sweep per `specs/073-scheduled-backups/quickstart.md` before opening the PR

### T068 — All eleven audit events, and nothing sensitive in them

**Type**: Test | **Time**: 1h30m | **Risk**: Medium
**Spec reference**: FR-035 · SC-009

Assert each of the eleven enumerated events fires: destination saved / tested / deleted, schedule
enabled / disabled, run started / succeeded / failed, restore started / completed / refused.

The `audit()` sink already strips every key containing `token` plus an explicit redact list — **assert
it for the new events rather than assuming inheritance**. A field named `destinationSecret` is not
caught by the `token` rule.

### T069 — The leak scan

**Type**: Test | **Time**: 1h | **Risk**: Medium
**Spec reference**: SC-009

Drive the full flow, capture all BFF output, and grep for the known test secrets, the WebDAV app
password, and `refresh_token`. Expect **0**.

Note `awk 'length>100'` counts **bytes**, so any byte-length check over text containing em-dashes
over-reports. Use character length if a length assertion is involved.

### T071 — Where the learnings go

**Type**: Documentation | **Time**: 1h | **Risk**: None

A concept citing a `resource` is a **derived summary** — write into the **cited source**, not the
concept. Candidates from this feature:

- **The Ollama SSRF guard is DNS-blind and this feature did not fix it.** The gotcha page already
  says so; add that a second, resolving guard now exists for backups with a *different* policy
  (private denied by default), so a future reader does not assume one guard covers both.
- **The BFF's first background-work mechanism**, and the `server.js`-is-outside-the-bundle constraint
  that forced the loopback seam.
- **The BFF Mongo is standalone**, so no multi-document transactions — this shaped the claim design
  and will shape the next feature that needs atomicity here.

Never into the root `CLAUDE.md`: it is an index, and `check-openwiki-governance.mjs` fails on prose
beyond it.

### T072 — Follow-ups this feature deliberately did not do

**Type**: Documentation | **Time**: 30m | **Risk**: None

File as backlog items, with acceptance criteria — a vague idea cannot ever be closed honestly:

1. **Streaming snapshots**, replacing the T031 ceiling. The ceiling exists so this arrives as a clear
   error rather than resource exhaustion.
2. **Failure notification by email.** Out of scope by operator decision; `email-service.ts` only
   triggers Keycloak account flows, so this means building a real outbound channel.
3. **The Ollama guard's DNS-blindness**, and the agent gateway's entirely unguarded Python
   `ChatOllama` fetch. This feature must not be read as having closed either.
4. **A third destination kind** (SFTP), which should be a third file against the T011 interface — if
   it is not, the interface failed and that is worth knowing.

### T073 — The gate

```bash
pnpm nx affected -t lint test build --skip-nx-cache
pnpm nx test:integration mcm-app
E2E_BFF_TARGET=dev-container E2E_TIER=gate npx playwright test
```

Run the tiers **your diff touches**, derived from what changed — not the ones you remember. This
feature touches TypeScript, compose and docs; `nx affected` will find the first, and the E2E tier
must be run explicitly.

A stale nx cache answers with a failure from a path that no longer exists — re-run with
`--skip-nx-cache` before diagnosing anything.

---

### T047 — Restore E2E

**Type**: Test | **Time**: 1h30m | **Risk**: Low
**Spec reference**: SC-002, SC-003 · **Scenarios covered**: US3-AC1, US3-AC2 · Tag: `@gate`

Back up → change live data → restore → assert the restored collection appears **and** the mutated
live collection still holds the mutation. The second half is the point: it is SC-003 through the real
UI, and without it the test proves only that restore creates something.

**Verify RED**: `E2E_BFF_TARGET=dev-container E2E_TIER=gate npx playwright test backups` — the restore
case fails at the version-list locator.
**Verify GREEN**: same command, 0 failures.

---

### T056 — Register the consent redirect URI

**Type**: Config change | **Time**: 30m | **Risk**: Medium
**Spec reference**: FR-022

`ensureClientRedirectUris()` in `auth/init+api.ts` already takes a list and registers three URIs;
this adds a fourth for the consent callback. Non-destructive and idempotent, as that route already is.

**Done when**: the Keycloak client shows the new URI after one `/bff-api/auth/init` call, and the
existing three are **still present** — this function replaces a list, so dropping one of them is the
way this task goes wrong.

---

### T060 — Schedule editor and consent prompt

**Type**: Implementation | **Time**: 3h | **Risk**: Medium
**Spec reference**: FR-016, FR-022 · **Scenarios covered**: US4-AC2, US4-AC5

Frequency, time, weekday/day-of-month, timezone (defaulted from the device but **stored on the job**),
retention count. No free-text recurrence field anywhere in the UI — FR-016 is a UI constraint as much
as a validation rule.

The consent step must state plainly what is being granted: that the system will read the user's
collections while they are away, and that disabling the schedule revokes it. An OAuth consent screen
the user cannot connect to a cause they recognise is consent in name only.

**Done when**: enabling a schedule without consent is impossible through the UI, and the next run
time is shown in the job's timezone immediately after saving.

---

### T065 — Run summary surfacing

**Type**: Test | **Time**: 45m | **Risk**: Low
**Spec reference**: FR-036, FR-037 · **Scenarios covered**: US6-AC1..AC4

Pure unit tests over the summary shape: duration derives from start and finish; a failure reason is
present when and only when status is `failed` or `partial`; next-run renders in the **job's** zone;
and no field carries a credential or collection content (US6-AC4).

**Verify RED**: `pnpm nx test mcm-app --testPathPattern='backup-run-summary'`
— 4 failing cases.
**Verify GREEN**: same command, 0 failures.

---

### T067 — Retention and failure-banner E2E

**Type**: Test | **Time**: 1h | **Risk**: Low
**Spec reference**: SC-007 · **Scenarios covered**: US5-AC1, US6-AC2 · Tag: `@gate`

Run to exceed the retention count, assert the version list settles at N. Then force a failure and
assert the banner appears **and persists across a reload** — a banner held only in component state
disappears on refresh, which is exactly when a user would look for it.

**Verify RED**: `E2E_BFF_TARGET=dev-container E2E_TIER=gate npx playwright test backups` — both cases
fail.
**Verify GREEN**: same command, 0 failures.

---

### T070 — Operator runbook

**Type**: Documentation | **Time**: 1h30m | **Risk**: None
**Spec reference**: FR-015, R1

`docs/runbooks/backups.md`. Must cover, because each is a support question waiting to happen:

- The six environment variables, and that `BACKUP_CREDENTIAL_ENC_KEY` is **not** the agent-config key.
- **`server.js` does not run under Metro, so no scheduled backup fires in dev.** Expected, not broken.
- Raising the size ceiling, and reading the error that names it.
- Why a private-range destination is refused by default and how `BACKUP_ALLOWED_DESTINATION_HOSTS`
  admits a NAS.
- How to confirm a standing permission was really revoked — by using the token, not by reading a
  database.

**Done when**: the runbook is linked from `openwiki/quickstart.md` and the docs gate passes.

---

## Dependencies

```text
Phase 1 (Setup)  ──►  Phase 2 (Foundational)  ──►  ┌─ Phase 3 (US1) ─► Phase 4 (US2) ─► Phase 5 (US3)
                                                    │                        │
                                                    └────────────────────────┴─► Phase 6 (US4) ─► Phase 7 (US5/US6)
                                                                                         │
                                                                                         ▼
                                                                                   Phase 8 (Polish)
```

- **Phase 2 blocks everything.** It holds the security control the feature's safety rests on.
- **US2 depends on US1** — a backup needs a destination.
- **US3 depends on US2** — a restore needs an artifact.
- **US4 depends on US2** — the scheduler runs the same runner.
- **US5 depends on US4** in practice (retention is interesting once runs accumulate) though it only
  strictly needs US2.

## Parallel opportunities

- **Phase 1**: T002, T003, T004 are independent files.
- **Phase 2**: the crypto pair (T008/T009) and the lock (T010) are independent of the guard
  (T006/T007). The two drivers (T014–T017) are independent of each other once T011 and T013 land.
- **Phase 3**: T018, T020, T022 are three independent suites.
- **Phase 8**: T068–T072 are fully parallel.

Every `[P]` task touches a file no other concurrent task touches.

## MVP scope

**Phases 1–5** — Setup, Foundational, US1, US2, US3.

A user who stops there can configure storage they own, take real backups, and restore from them.
That is the feature's whole promise; scheduling and retention are convenience on top. Shipping
Phases 1–5 and pausing is a legitimate outcome, and the phases are ordered so it is a clean stopping
point rather than a half-built one.
