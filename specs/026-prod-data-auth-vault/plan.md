# Implementation Plan: Production Data-Tier Authentication & Secrets-Management Standard

**Branch**: `026-prod-data-auth-vault` | **Date**: 2026-07-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/026-prod-data-auth-vault/spec.md`

## Summary

Add a second protective layer to the production data tier and settle the production secrets standard. **Workstream A** enables SCRAM authentication on both production MongoDB stores — a **keyfile + SCRAM** for the single-member replica set `mc-service-store-mongo`, and **SCRAM only** for the standalone `mcm-bff-store-mongo` (it has no replica-set members, so no keyfile) — via a rehearsed, reversible `--transitionToAuth` cutover that preserves all existing data. Because both services already read their connection string from env (`MC_DB_URL` / `MONGO_URL`), **no application code changes** are required: the work is prod-compose edits, new `${VAR:?}` secrets (Komodo Variables), a bind-mounted keyfile, a credential-less healthcheck, a rehearsal/cutover runbook, and dev-secret-template additions. **Workstream B** produces a single **decision record (ADR)** selecting one sanctioned prod-secrets mechanism — the **recommended default is to ratify Komodo Variables** for the core stacks (keeping the dormant feature-025 Vault agent-layer-scoped) — and, only if Vault is instead adopted, a **migration plan** (the full rollout is deferred to a follow-up feature per the Bounded scope decision).

## Technical Context

**Language/Version**: N/A for feature logic (infrastructure-as-code). Docker Compose v2 spec YAML; `mongosh` JS for the cutover; Node.js ES modules for the secret generator/gates. The Rust (mc-service) and TypeScript (BFF) consumers are **unchanged** — they already parse credentials from the URL.

**Primary Dependencies**: Existing images only — `mongodb/mongodb-community-server:8.0.8-ubi9` (both stores, unchanged). Orchestration: Komodo ResourceSync (`infrastructure-as-code/komodo/stacks.toml`, stacks `prod-mc-service` + `prod-mcm-bff`). Secret machinery: `scripts/gen-dev-secrets.mjs`, `stacks/*.env.example`, `${VAR:?}` fail-fast interpolation. MongoDB driver auth: URL-embedded SCRAM (Rust `Client::with_uri_str`, Node `MongoClient`) — no code change.

**Storage**: The two existing external volumes `mc-service-store-mongo-data` and `mcm-bff-store-mongo-data` — **preserved, not recreated**. The movie-store replica-set keyfile is **not** a volume or a host file: it is carried in the `MONGO_MC_KEYFILE` env var (Komodo → `.env.prod`, 022-compliant env-only model) and materialized in-container at start-up by an entrypoint wrapper (`0400`, mongod-owned) — no host file-secret.

**Testing**: No new automated app test suites (no app code change). Acceptance oracles are operational per [quickstart.md](./quickstart.md) — anonymous-rejected / least-privilege / count-preservation / keyfile-negative checks, plus the **web E2E regression** (`E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app`) proving unchanged end-user behavior (required for every feature, incl. backend-only). Guardrails gates (`secret-scan`, `check-no-inline-secrets`, `check-resource-naming`) must stay green.

**Target Platform**: Single prod host (Komodo "Local" server), Linux/Docker; internal-only networking, no published ports. Rehearsal happens in a separate scratch environment against a restored volume snapshot.

**Project Type**: Infrastructure / security hardening (data-tier auth + a governance decision). No app source structure change.

**Performance Goals**: N/A. The binding operational constraint is the **cutover window ≤ 60 minutes per store** (clarified), safety-first stop/redeploy with count verification and rollback checkpoints.

**Constraints**:
- Zero committed secrets — every secret is `${VAR:?}` fail-fast; real values are Komodo Variables (`[[NAME]]`) → gitignored `.env.prod`; the keyfile is gitignored + bind-mounted.
- **No data loss** — in-place `--transitionToAuth` cutover; counts verified before/after; rollback = revert command + redeploy (data untouched).
- **Dev/CI stays unauthenticated** (FR-009) — auth flags live only in the prod compose files + the scratch/rehearsal env.
- **No new named volume or network** — avoids `check-resource-naming` changes (keyfile is a bind-mount, not a `-data` volume).
- Workstream B is **decision-first**: the ADR direction is settled before Workstream A's credential-storage tooling is locked; A ships **static SCRAM** regardless (dynamic Vault-issued creds belong to the deferred rollout).

**Scale/Scope**: 2 prod Mongo services hardened; 2 consumer connection strings re-pointed (env only); ~5 new secret variables (+1 keyfile); 2 prod compose files edited; `stacks.toml` env blocks extended for 2 stacks; dev-secret templates + `.gitignore` updated; 1 cutover/rehearsal runbook; 1 ADR. No application code, no CI pipeline changes.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Gate (constitution) | Assessment |
|---|---|
| **Security — Secrets Management (NON-NEGOTIABLE)** | PASS by design. New Mongo passwords are `${VAR:?}` (Komodo Variables); passwords in URLs are `${VAR}` sentinels; keyfile is gitignored + bind-mounted, never committed, never a data volume. Enforced by `secret-scan` + `check-no-inline-secrets`. Workstream B *strengthens* this by documenting one sanctioned mechanism. |
| **Security — Deny By Default / Access Control (NON-NEGOTIABLE)** | PASS/advanced — this feature *adds* the missing data-tier access-control layer: both stores move from network-scope-only to credential-required (deny anonymous by default). Least-privilege app users; no root at runtime. |
| **Security — topology scrub** | PASS. No host/domain/IP literals introduced; internal DNS is container-name only (`mc-service-store-mongo`, `mcm-bff-store-mongo`). Topology/komodo-sync gates scan the edited files. |
| **Encryption at Rest** | Unaffected/PASS. The 018 AES-256-GCM agent-config payload encryption is untouched; this feature adds transport/access auth, not at-rest changes (explicit non-goal). |
| **Spec-Driven Development** | PASS. Plan derives from spec.md + clarifications; artifacts kept in sync; per-store asymmetry (RS vs standalone) reconciled from the codebase and recorded in research.md. |
| **Test-Driven Development (NON-NEGOTIABLE)** | N/A-with-note. No new app code ⇒ nothing to unit-TDD. Acceptance is operational (quickstart oracles) + the existing web E2E regression run against the re-authenticated stores; **no runtime patches** — a broken cutover fails the anonymous-rejected / count / E2E checks. |
| **Resource Naming (019/020)** | PASS with no change. No new volume/network (keyfile is a bind-mount). Existing names unchanged. |
| **Observability (structured logging)** | PASS. mc-service (`tracing`) and BFF (`logger`) already log Mongo connect success/failure; no secret is logged (URLs with credentials must not be logged — verify the existing connect log lines don't echo the URL). |

**Result: PASS.** No constitution deviations to justify; Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/026-prod-data-auth-vault/
├── plan.md              # This file
├── spec.md              # Feature spec (+ Clarifications)
├── research.md          # Phase 0 — per-store auth model, migration mechanism, Workstream B matrix
├── data-model.md        # Phase 1 — config/credential artifacts
├── quickstart.md        # Phase 1 — validation scenarios (B1–B7 oracles)
├── contracts/
│   ├── mongo-auth-contract.md            # command shape, identity matrix, conn-strings, behaviors
│   └── secrets-decision-record-template.md  # the Workstream B ADR skeleton
├── checklists/
│   └── requirements.md  # spec quality checklist (16/16)
└── tasks.md             # Phase 2 — /speckit-tasks (NOT created here)
```

### Source Code (repository root) — files this feature touches

```text
infrastructure-as-code/docker/
├── mc-service/
│   ├── compose.prod.yaml     # + --keyFile, --transitionToAuth(phase1)/enforced(phase2);
│   │                         #   MC_DB_URL → authenticated; healthcheck → credential-less ping;
│   │                         #   entrypoint wrapper materializes keyfile from env
│   └── mongo-entrypoint.sh   # NEW — writes $MONGO_MC_KEYFILE → 0400 mongod-owned file, exec mongod
├── bff/
│   └── compose.prod.yaml     # + --auth; MONGO_URL → authenticated (no keyfile — standalone)
└── stacks/
    ├── mcm.env.example       # + MONGO_MC_* / MONGO_BFF_* placeholders (scratch/dev-auth only)
    └── (dev compose.yaml files UNCHANGED — dev stays unauthenticated, FR-009)

infrastructure-as-code/komodo/
└── stacks.toml               # prod-mc-service + prod-mcm-bff env blocks: + MONGO_* [[Variables]]

scripts/
├── gen-dev-secrets.mjs       # + Mongo password kinds + keyfile generation (scratch/rehearsal)
└── (guardrails gates UNCHANGED — no new patterns/allowlist needed)

docs/
├── runbooks/
│   └── prod-data-tier-auth.md   # NEW — rehearsal + cutover + rollback runbook (Workstream A)
└── decisions/
    └── ADR-0001-prod-secrets-management.md   # NEW — Workstream B decision record (US2)

.gitignore                    # + rendered keyfile path + any generated auth .env

# UNCHANGED (no code): backend/mc-service/src/config.rs, adapters/mongodb/client.rs;
#                      frontend/mcm-app/src/config/env.ts, bff-server/mongo-client.ts
```

**Structure Decision**: Infrastructure-as-code feature. All changes are in `infrastructure-as-code/` (compose + Komodo + env templates), `scripts/` (secret generation), and `docs/` (runbook + ADR). The application source is deliberately untouched — a key finding that keeps the blast radius to configuration.

## Complexity Tracking

> No constitution violations. No entries.

## Phase notes

**Phase 0 (research.md)** — resolved: the two stores are NOT symmetric (RS keyfile vs standalone), zero app-code change, `--transitionToAuth` migration, credential-less healthcheck under auth, keyfile-as-bind-mount, gate compliance, and the Workstream B decision matrix + recommended B-opt-1. No open NEEDS CLARIFICATION remain.

**Phase 1 (this run)** — produced data-model.md (credential/config artifacts + cutover state machine), contracts/ (Mongo auth interface + ADR template), quickstart.md (B1–B7 validation oracles). Agent context (CLAUDE.md SPECKIT marker) updated to point here.

**Phase 2 (next — `/speckit-tasks`)** — will decompose into: (a) Workstream B ADR first (decision gate), (b) prod-compose + Komodo + secret-template + gitignore edits, (c) the rehearsal-on-snapshot task (provision scratch env), (d) the per-store `--transitionToAuth` cutover runbook + execution, (e) verification (quickstart oracles + web E2E), sequenced US2-decision → US1-build per the spec.

## Known residual risks (carried to tasks)

- **Keyfile delivery (analysis remediation, H1)**: kept **env-only** (`MONGO_MC_KEYFILE`) + in-container entrypoint materialization — feature 022 removed host file-secrets, so a bind-mount has no delivery path. The `mongod` uid for `8.0.8-ubi9` must be confirmed so the entrypoint `chown`s correctly (else startup fails) — a task, not an assumption.
- **FR-008 (rs-init authenticates once auth is on)**: the fresh-volume `rs.initiate()`/reconfig one-shot must present the admin credential; documented explicitly in the runbook (fresh-volume appendix) — the populated-volume cutover does not re-initiate.
- **Connect-log hygiene**: verify neither consumer logs the credentialed URL on connect.
- **Fresh-volume bootstrap** (DR / new host) is a documented secondary procedure (keyfile + auth + seed users + authenticated `rs.initiate()`), distinct from the populated-volume cutover.
- Plan-level items deferred to the Workstream B ADR / any follow-up: Vault auto-unseal source and the injector "secret-zero" bootstrap (only relevant if B-opt-2 is selected).
