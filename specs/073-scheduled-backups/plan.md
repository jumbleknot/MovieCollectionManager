# Implementation Plan: Per-user scheduled collection backups

**Branch**: `073-scheduled-backups` | **Date**: 2026-09-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/073-scheduled-backups/spec.md`

## Summary

Give each user scheduled and on-demand backups of their own movie collections to storage they own
(S3-compatible or WebDAV), with versioning, keep-last-N retention, and a restore that only ever
creates new collections.

The technical shape, in one paragraph: destinations, jobs and run history are per-user documents in
the **BFF's Mongo store**, with credentials sealed by the existing AES-256-GCM helper; two
**destination drivers** sit behind one interface and are reached through a new **DNS-resolving SSRF
guard**; a **tick route** in the BFF does the scheduling work and `server.js` provides the clock,
with exactly-once guaranteed by a Redis leader lock plus a single-document atomic claim; an
unattended run holds a **Keycloak `offline_access` token** so it reads data as the user through the
unchanged `createMcServiceClient(jwt)` seam; and one run writes one **gzipped JSON artifact** with a
manifest and a `sha256`, which restore verifies before it creates anything.

Full reasoning for each choice, including two places where the backlog item's proposal was wrong on
the facts, is in [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 5.x on Node 24.20 (BFF, server-side only); React Native / React 19
via Expo SDK 56 (UI)

**Primary Dependencies**: Existing — `mongodb` 7.x, `ioredis` 5.x, `zod` 4.x, Tamagui +
`@mcm/design-system`, Expo Router. **New — `luxon`** (timezone/DST arithmetic) and
**`fast-xml-parser`** (WebDAV PROPFIND only). Deliberately *not* added: `@aws-sdk/client-s3` (see
Complexity Tracking).

**Storage**: BFF MongoDB (standalone — **no replica set, therefore no multi-document
transactions**); Redis for the leader lock, per-user run gate and rate limits; the user's own S3 or
WebDAV endpoint for artifacts. Domain data is read from and written to mc-service over HTTP — this
feature never touches mc-db directly.

**Testing**: Jest (BFF unit + integration), Playwright (web E2E, `@gate` tier), Maestro (mobile
flows). Integration tests run against a real MinIO and a real WebDAV container — no mocks, per
constitution §Test Type Integrity.

**Target Platform**: Linux container (BFF); web + Android (UI)

**Project Type**: Web application — Expo Router app with an embedded BFF, calling the Rust
mc-service

**Performance Goals**: A tick completes in under 1 s when no job is due. A backup of 1,000 movies
completes in under 60 s. Scheduled runs fire within 5 minutes of their local time (SC-005).

**Constraints**: One run at a time per user. A run is bounded by `BACKUP_MAX_MOVIES` (default
25,000) and `BACKUP_MAX_UNCOMPRESSED_BYTES` (default 64 MiB) and fails loudly past either. The
snapshot is built in the BFF heap, which is the application server — the ceiling is what keeps a
backup from taking the app down.

**Scale/Scope**: Single-digit-to-dozens of users (homelab). 12 new BFF API route files (14 operations, per the contract), ~16 new
server-side modules, 4 new UI screens/sections inside the existing Backups route, 2 new Compose
services for testing.

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1 design. Both passes recorded.*

| Principle | How this design satisfies it | Verdict |
| --- | --- | --- |
| **Technology Agnosticism in Specification** | `spec.md` names no library, datastore or language; every technology choice appears here or in `research.md`. | PASS |
| **Deny By Default / Centralized Access Control** | Every new route goes through the same `requireAuth` → `requireMcUser` layer as existing routes. The owning `userId` is taken from the validated session, never from request input (FR-034). The internal tick route is not user-facing and is secret-guarded. | PASS |
| **Principle of Least Privilege** | An unattended run uses the user's own minted token — no new role, no new audience, no service-account path. mc-service's DAC is untouched. | PASS |
| **No Local Credential Stores** | No user *identity* credential is stored. Destination credentials are third-party service credentials the user supplies, on the same footing as the existing per-user Anthropic/TMDB keys. The offline refresh token is an IdP-issued token, not a credential — held encrypted and revocable. | PASS |
| **Encryption at Rest / KMS separation** | Reuses `agent-config-crypto.ts` (AES-256-GCM, AAD-bound). Key custody is already compliant: Vault in prod, gitignored env in dev — separate from the Mongo store holding the ciphertext. A distinct `BACKUP_CREDENTIAL_ENC_KEY` avoids widening the agent-config key's blast radius. | PASS |
| **Input Validation** | Every route body is `zod`-parsed. Destination URLs additionally pass the new resolving SSRF guard at save **and** at every use. | PASS |
| **Safe Error Responses** | Driver and provider responses are normalised to `'ok'` or `{ reason }` before reaching the client, following `agent-config-probes.ts`. No upstream body, URL or stack is ever forwarded. | PASS |
| **Audit Logging** | Eleven audit events (FR-035) through the existing `audit()` sink, which already strips every key containing `token` plus an explicit redact list. Counts, sizes and ids only. | PASS |
| **Test-Driven Development** | Every task pairs a Verify RED with a Verify GREEN. Note the **mutation-RED** requirement where a test covers already-correct existing behaviour (`openwiki/process/spec-driven-development.md`). | PASS |
| **Test Type Integrity** | Integration tests use a real MinIO and a real WebDAV server. No HTTP mocking, no in-memory substitutes. The golden-tier cassette exception does not apply to this feature. | PASS |
| **Behavior-Descriptive Identifiers** | Module and symbol names describe behaviour; `FR-###`/`SC-###` appear only in provenance comments. | PASS |
| **Nx as universal task runner** | All build/test/lint through `pnpm nx`. | PASS |
| **Testing tiers** | Every new E2E test carries a tier tag; unclassified tests fail rather than defaulting into the gate. These are deterministic, so `@gate`. | PASS |

**Post-Phase-1 re-check**: no new violations. The one entry in Complexity Tracking is a dependency
*reduction* relative to the obvious approach, not an added abstraction.

## Project Structure

### Documentation (this feature)

```text
specs/073-scheduled-backups/
├── spec.md
├── plan.md              # This file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── bff-backups-api.yaml
│   └── backup-artifact-v1.schema.json
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 — /speckit-tasks, NOT created here
```

### Source Code (repository root)

```text
frontend/mcm-app/
├── server.js                                   # MODIFIED: setInterval → loopback tick call
├── src/
│   ├── app/bff-api/backups/
│   │   ├── destinations/index+api.ts           # GET list, POST create
│   │   ├── destinations/[destinationId]+api.ts # GET, PATCH, DELETE
│   │   ├── destinations/test+api.ts            # POST probe
│   │   ├── jobs/index+api.ts                   # GET list, POST create
│   │   ├── jobs/[jobId]+api.ts                 # GET, PATCH, DELETE
│   │   ├── jobs/[jobId]/run+api.ts             # POST "back up now"
│   │   ├── jobs/[jobId]/runs+api.ts            # GET run history
│   │   ├── jobs/[jobId]/versions+api.ts        # GET version list
│   │   ├── jobs/[jobId]/restore+api.ts         # POST restore
│   │   ├── jobs/[jobId]/download+api.ts        # GET artifact bytes
│   │   ├── consent+api.ts                      # GET start / callback for offline_access
│   │   └── tick+api.ts                         # INTERNAL, secret-guarded
│   ├── bff-server/
│   │   ├── backup-destination-store.ts         # Mongo CRUD, encrypted secrets
│   │   ├── backup-job-store.ts                 # Mongo CRUD + atomic claim
│   │   ├── backup-run-store.ts                 # run history
│   │   ├── backup-destination-driver.ts        # the interface + factory
│   │   ├── backup-driver-s3.ts                 # SigV4 over fetch
│   │   ├── backup-driver-webdav.ts             # HTTP verbs + PROPFIND
│   │   ├── backup-request-signer.ts            # AWS SigV4
│   │   ├── backup-destination-url-guard.ts     # DNS-resolving SSRF guard
│   │   ├── backup-artifact.ts                  # build, hash, gzip, parse, verify
│   │   ├── backup-snapshot-reader.ts           # page collections+movies from mc-service
│   │   ├── backup-restore-writer.ts            # create collections+movies as the user
│   │   ├── backup-schedule.ts                  # Luxon next-run arithmetic
│   │   ├── backup-retention.ts                 # prune oldest beyond N
│   │   ├── backup-runner.ts                    # orchestrates one run end to end
│   │   ├── backup-offline-token.ts             # consent, store, mint, revoke
│   │   └── redis-lock.ts                       # acquire/release leader lock
│   ├── screens/settings/backups-settings-screen.tsx   # MODIFIED: real body
│   ├── components/backups/                     # destination form, job form, run history, versions
│   └── types/backups.ts                        # shared types
└── e2e/web/backups.spec.ts                     # @gate

infrastructure-as-code/docker/
├── minio/                                      # EXISTING image, newly referenced for test use
├── webdav/                                     # NEW test container
└── stacks/                                     # MODIFIED: wire both into the dev stack
```

**Structure Decision**: Everything server-side lives in `frontend/mcm-app/src/bff-server/`,
following the existing `agent-config-*` family — that is where per-user encrypted configuration,
probes and stores already live, and this feature is the same shape with more moving parts. Routes
follow the existing `bff-api/` file convention. No new deployable unit is introduced; mc-service and
the agent gateway are untouched.

## Phased delivery

Each phase maps to the spec's user-story priorities and is independently shippable.

Phase numbers match `tasks.md` exactly, so "Phase 5" means the same thing in both documents.

| Phase | Delivers | Spec stories | Tasks |
| --- | --- | --- | --- |
| **1 — Setup** | Dependencies, environment, shared types, Compose test services, collections and indexes | — | T001–T005 |
| **2 — Foundational** | The resolving URL guard, credential encryption, the leader lock, the driver interface, both drivers | — | T006–T017 |
| **3 — Destinations** | Full destination CRUD and "test connection", end to end | US1 | T018–T025 |
| **4 — Backup on demand** | Snapshot reader, artifact builder, runner, job/run persistence, "Back up now" | US2 | T026–T039 |
| **5 — Restore + download** | Verify-before-write restore, version listing, artifact download | US3 | T040–T047 |
| **6 — Scheduling** | Consent, offline token custody, account-deletion teardown, schedule arithmetic, tick route, `server.js` clock | US4 | T048–T061 |
| **7 — Retention + visibility** | Pruning, failure banner, next-run display | US5, US6 | T062–T067 |
| **8 — Polish** | Audit coverage, leak scan, runbook, OpenWiki learnings, follow-up items, gate sweep | — | T068–T073 |

**Phases 1–5 are the MVP**: a user who stops there can configure storage they own, take real backups,
and restore from them. Scheduling and retention are convenience on top.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| Hand-written AWS SigV4 signer instead of `@aws-sdk/client-s3` | Only 4 S3 operations are needed (PUT/GET/LIST/DELETE). The SDK pulls ~50 transitive packages into a repository whose **entire CI board has gone red over one transitive dependency** (CLAUDE.md), and whose Renovate treadmill is already a standing cost. | The SDK is the obvious choice and would be less code to write. It is rejected on supply-chain surface, not on capability. **Ratified by the operator on 2026-09-20** — this is settled, not open. T012 verifies the signer against AWS's published test vectors (an external oracle, not self-consistency) and T014 against a real MinIO. The decision stays contained behind the driver interface, so reversing it later is one file. |
| First background-work mechanism in the BFF | FR-017 requires runs with no user session present. The BFF has no existing scheduler — `grep -rn setInterval src/` returns nothing — so one must be introduced. | A cron sidecar or Komodo-driven schedule was rejected as a second deployment artifact for one timer; the tick route works either way, so that escape hatch stays open. |
| Two independent exactly-once mechanisms | The Redis lock is an optimisation with a TTL guess in it; the single-document atomic claim is the correctness guarantee. The BFF Mongo is standalone, so a transaction spanning job + run history is **not available**. | Relying on the lock alone makes correctness depend on a TTL. Relying on the claim alone works but has every instance scanning every tick. |

## Risks

- **The offline token is long-lived by construction.** Mitigated by AAD-bound encryption, revocation
  on disable/delete/account-deletion, never returning it to a client, and FR-024's ban on any
  fallback path. Residual risk is accepted and documented, not eliminated.
- **`server.js` does not run under Metro**, so no tick fires in dev. Documented as a known
  asymmetry; the tick route is directly callable, which is what makes the E2E deterministic.
- **The SSRF guard is new code on a security path.** It gets its own unit suite including
  rebinding-shaped cases, and connection pinning is the part most likely to be got subtly wrong —
  it must be asserted, not assumed.
- **Restore is N+1 HTTP calls.** Bounded by the size ceiling; per-movie failures are recorded rather
  than aborting.
- **A `nx e2e` run from a worktree needs a real `pnpm install` in that worktree** (CLAUDE.md) —
  budget ~4 minutes before the first E2E task, or the failure reads as a path error.
