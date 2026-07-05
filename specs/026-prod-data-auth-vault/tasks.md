---
description: "Task list for feature 026 — Production Data-Tier Authentication & Secrets-Management Standard"
---

# Tasks: Production Data-Tier Authentication & Secrets-Management Standard

**Input**: Design documents from `specs/026-prod-data-auth-vault/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: No automated app-test tasks — this feature makes **zero application code changes** (both services already parse credentials from their env-supplied Mongo URL). Acceptance is **operational**: the quickstart.md oracles (B1–B7) plus the web E2E regression. "No runtime patches" applies — a broken cutover fails the anonymous-rejected / count / E2E checks.

**Organization**: Tasks grouped by user story. Sequencing follows the spec gate — **US2 (secrets decision ADR) settles the credential-storage direction before US1 (Mongo auth) is finalized** (FR-011); US1 is the concrete MVP security win; US3 is conditional.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 = Mongo auth, US2 = secrets decision, US3 = migration plan (conditional)
- `[operational]` = a host/Komodo/deploy action, not a repo edit

## Path Conventions

Infrastructure-as-code feature. Edits live in `infrastructure-as-code/` (compose + Komodo + env templates), `scripts/` (secret generation), and `docs/` (runbook + ADR). Application source (`backend/mc-service/src`, `frontend/mcm-app/src`) is deliberately **not** modified.

---

## Phase 1: Setup & Ground Truth

**Purpose**: Confirm the residual unknowns from research.md before any change.

- [ ] T001 [P] Confirm the mongod runtime uid/gid in image `mongodb/mongodb-community-server:8.0.8-ubi9` (`docker run --rm --entrypoint id mongodb/mongodb-community-server:8.0.8-ubi9`); record it in `docs/runbooks/prod-data-tier-auth.md` (created in T018) for the keyfile `chown`.
- [ ] T002 [P] Audit connect-log hygiene: verify `backend/mc-service/src/adapters/mongodb/client.rs` and `frontend/mcm-app/src/bff-server/mongo-client.ts` do NOT log the credentialed connection URL; note (do not yet apply) any redaction needed. No behavior change expected.
- [ ] T003 [P] Confirm `.gitignore` covers the generated auth `.env` files used by the scratch/rehearsal env (the keyfile is carried in the `MONGO_MC_KEYFILE` env value, NOT a committed/host file — no separate keyfile ignore needed). Add an ignore entry only if a new `.env` path is introduced.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish a known-green baseline and confirm the no-code-change premise before edits.

**⚠️ CRITICAL**: Complete before US1/US2 work so regressions are attributable.

- [ ] T004 Establish a green gate baseline: run `node scripts/secret-scan.mjs --selftest && node scripts/secret-scan.mjs`, `node scripts/check-no-inline-secrets.mjs --selftest && node scripts/check-no-inline-secrets.mjs`, and `node scripts/check-resource-naming.mjs --section=all`; confirm all exit 0 before changes. **Also verify (L3)** the `check-no-inline-secrets` URL-password rule accepts a `${VAR}` sentinel in the password position (`mongodb://user:${VAR}@host`) — inspect the regex or dry-run a sample — before relying on the URL-embedded-password form in T013/T016.
- [ ] T005 Re-confirm the zero-app-code-change premise: re-read `backend/mc-service/src/config.rs` (`MC_DB_URL`) + `adapters/mongodb/client.rs` (`Client::with_uri_str`) and `frontend/mcm-app/src/config/env.ts` (`MONGO_URL`) + `bff-server/mongo-client.ts` (`new MongoClient`); confirm each consumes credentials verbatim from the URL. Record confirmation in plan.md residual-risks if anything diverges.

**Checkpoint**: Baseline green; premise confirmed — story work can begin.

---

## Phase 3: User Story 2 — Ratify a single production secrets-management standard (Priority: P1) 🚪 Decision Gate

**Goal**: One documented, sanctioned prod-secrets mechanism (the ADR) — gates US1's credential-storage design (FR-011).

**Independent Test**: The committed ADR names exactly one mechanism, maps 100% of secret categories to it, reconciles the agent-layer Vault path, and is constitution-cited (quickstart Scenario 9 / SC-006).

- [ ] T006 [US2] Create the decision record from `specs/026-prod-data-auth-vault/contracts/secrets-decision-record-template.md` at `docs/decisions/ADR-0001-prod-secrets-management.md`; select ONE mechanism (recommended default per research.md Decision 7: **B-opt-1 — ratify Komodo Variables** for the core stacks, Vault stays agent-layer-scoped).
- [ ] T007 [US2] Fill the secret-category coverage map (100%): identity-provider DB/bootstrap, BFF client/cookie/subject-token, agent gateway/agent-DB, control-tower (025), and **Workstream A's new Mongo secrets** → the chosen mechanism.
- [ ] T008 [US2] Document the agent-layer Vault reconciliation (keep `agents/movie-assistant/src/secrets.py` as a scoped, fail-open optional reader — NOT a competing backbone, no dual mechanism — FR-013) and the constitution note (which principle leg; ratification vs enhancement — FR-015) and per-user BYO preservation (FR-014).
- [ ] T009 [US2] Record the branch condition: if **B-opt-1**, write the "revisit Vault" trigger and mark US3 not-applicable in the ADR; if **B-opt-2**, note that 026 delivers the US3 migration plan only and the rollout is deferred to a follow-up feature.

**Checkpoint**: ADR complete → US1's credential direction is locked (static SCRAM + the sanctioned mechanism).

---

## Phase 4: User Story 1 — Enforce authentication on production data stores (Priority: P1) 🎯 MVP

**Goal**: Both prod MongoDBs require a credential; least-privilege app users; no data loss.

**Independent Test**: Anonymous connection to either store is rejected; each service works via its least-privilege app user; record/collection counts match before/after (quickstart Scenarios 2–4 / SC-001..003).

### Secret scaffolding

- [ ] T010 [US1] Add Mongo secret placeholders to `infrastructure-as-code/docker/stacks/mcm.env.example`: `MONGO_MC_APP_PASSWORD`, `MONGO_MC_ROOT_PASSWORD`, `MONGO_BFF_APP_PASSWORD`, `MONGO_BFF_ROOT_PASSWORD` as `<generate:complex-16>` (scratch/rehearsal + prod-shape only; dev local stays unauthenticated).
- [ ] T011 [US1] Extend `scripts/gen-dev-secrets.mjs` to mint the four Mongo passwords and generate the replica-set keyfile **as a single-line env value** (`openssl rand -base64 756`, newlines stripped) assigned to `MONGO_MC_KEYFILE` in the scratch/rehearsal `.env`; idempotent by default, `--force` rotates. Do NOT write a standalone keyfile file — it is materialized in-container by the entrypoint (T013a).
- [ ] T012 [US1] [operational] Seed the masked Komodo Variables `MONGO_MC_APP_PASSWORD`, `MONGO_MC_ROOT_PASSWORD`, `MONGO_BFF_APP_PASSWORD`, `MONGO_BFF_ROOT_PASSWORD`, `MONGO_MC_KEYFILE` in the Komodo store.

### Movie store (replica set + keyfile) — entrypoint + `compose.prod.yaml` + Komodo

- [ ] T013a [US1] Create `infrastructure-as-code/docker/mc-service/mongo-entrypoint.sh` (H1): write `$MONGO_MC_KEYFILE` to an in-container file (e.g. `/etc/mongo/keyfile`), `chmod 0400`, `chown` to the mongod uid (T001), fail fast if `MONGO_MC_KEYFILE` is empty, then `exec mongod "$@"`. This keeps the keyfile **env-only** (no host file-secret, feature-022-compliant).
- [ ] T013 [US1] Edit `infrastructure-as-code/docker/mc-service/compose.prod.yaml`: mount `mongo-entrypoint.sh` `:ro` and set it as the container `entrypoint`; add `--keyFile /etc/mongo/keyfile` to the mongod args (materialized by T013a); keep `--replSet rs0`; set `MC_DB_URL` to `mongodb://mc_service_app:${MONGO_MC_APP_PASSWORD}@mc-service-store-mongo:27017/mc_db?replicaSet=rs0&authSource=admin&directConnection=true`.
- [ ] T014 [US1] In the same file, replace the self-initializing `rs.status()`/`rs.initiate()` healthcheck with credential-less `mongosh --quiet --eval "db.adminCommand('ping').ok"`.
- [ ] T015 [US1] Extend the `prod-mc-service` env block in `infrastructure-as-code/komodo/stacks.toml` with `MONGO_MC_APP_PASSWORD=[[MONGO_MC_APP_PASSWORD]]` and `MONGO_MC_KEYFILE=[[MONGO_MC_KEYFILE]]` (delivered as env; materialized in-container by the entrypoint, T013a).

### BFF store (standalone + auth) — `compose.prod.yaml` + Komodo

- [ ] T016 [US1] [P] Edit `infrastructure-as-code/docker/bff/compose.prod.yaml`: add `--auth` to the mongod command (NO keyfile — standalone); set `MONGO_URL` to `mongodb://bff_app:${MONGO_BFF_APP_PASSWORD}@mcm-bff-store-mongo:27017/?authSource=admin` (keep `MONGO_DB_NAME=bff_db`).
- [ ] T017 [US1] [P] Extend the `prod-mcm-bff` env block in `infrastructure-as-code/komodo/stacks.toml` with `MONGO_BFF_APP_PASSWORD=[[MONGO_BFF_APP_PASSWORD]]`.

### Cutover runbook + rehearsal + execution

- [ ] T018 [US1] Author `docs/runbooks/prod-data-tier-auth.md`: the `--transitionToAuth` two-phase cutover per store (Phase 1 transition + create root/app users; switch consumer URL; Phase 2 enforce), the localhost-exception fallback, count-verification, rollback path, the ≤60-min window, the mongod uid from T001, and a fresh-volume bootstrap appendix. **The appendix MUST make FR-008 explicit**: the one-time `rs.initiate()`/reconfig on a fresh authenticated volume runs as an **authenticated** `mongosh` call using the admin credential (the populated-volume cutover does NOT re-initiate — the set is already initialized).
- [ ] T019 [US1] [operational] Provision the scratch rehearsal environment and restore a snapshot of each prod Mongo volume into same-named scratch volumes (quickstart Scenario 0).
- [ ] T020 [US1] [operational] Rehearse the full cutover on the restored snapshots; verify anonymous-rejected (B1), least-privilege app user (B2/Scenario 3), counts preserved (B3), and the keyfile negative test (B5/Scenario 5); iterate the scripts until green. **Gate before prod.**
- [ ] T021 [US1] [operational] Execute the production cutover for `mc-service-store-mongo` within the scheduled window; capture baseline + post counts; confirm anonymous-rejected.
- [ ] T022 [US1] [operational] Execute the production cutover for `mcm-bff-store-mongo` within the scheduled window; capture baseline + post counts; confirm anonymous-rejected.
- [ ] T023 [US1] [operational] Recreate the `mc-service` and BFF containers against the authenticated stores (image unchanged — no rebuild; new env only) and confirm both are healthy and serving.

**Checkpoint**: Both stores reject anonymous access; app works via least-privilege users; data preserved.

---

## Phase 5: User Story 3 — Secrets-backbone migration plan (Priority: P3, conditional)

**Goal**: If (and only if) the ADR (T006) selected the adopt-a-manager direction (B-opt-2), deliver the migration plan; the full rollout is deferred to a follow-up feature.

**Independent Test**: If applicable, a committed migration plan enumerates 100% of secret categories, sequence, rotation, manager-unavailable behavior, and injector secret-zero bootstrap (SC-008). If B-opt-1 was chosen, US3 is explicitly marked not-applicable (no artifact).

- [ ] T024 [US3] IF T006 selected **B-opt-2**: author `docs/proposals/prod-hardening/vault-migration-plan.md` per FR-016 (secret categories, migration sequence, rotation procedure, manager-unavailable behavior, secret-zero bootstrap, agent-layer unification), marking the rollout deferred. IF **B-opt-1**: confirm the ADR marks US3 not-applicable and skip (no artifact) — record the skip rationale in tasks completion.

---

## Phase 6: Polish & Cross-Cutting Verification

**Purpose**: Prove no regression and close the SCs.

- [ ] T025 [P] Re-run the guardrails gates post-change: `secret-scan.mjs`, `check-no-inline-secrets.mjs`, `check-resource-naming.mjs` — confirm all green (SC-005 / quickstart Scenario 7); confirm `git status` shows the keyfile + generated `.env` ignored.
- [ ] T026 Run the web E2E regression against the containerized dev BFF (`E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app`) proving unchanged end-user behavior (SC-004 / Scenario 6); rebuild/recreate changed containers first (stale image = meaningless run).
- [ ] T027 [P] Confirm dev stays unauthenticated (quickstart Scenario 8 / FR-009): bring up the plain dev stack and verify local Mongo still accepts an unauthenticated connection; update `CLAUDE.md` "Local Dev Infrastructure" gotchas + `docs/runbooks/local-dev.md` to note prod-only auth and that integration tests use the unauthenticated dev Mongo.
- [ ] T028 [P] Cross-link docs: reference `docs/runbooks/prod-data-tier-auth.md` from `docs/runbooks/prod-control-tower.md`; ensure the ADR is linked from the feature spec.
- [ ] T029 Run the quickstart Definition-of-Done checklist; confirm SC-001..SC-008 verified and SC-007 window/rehearsal evidence (≤60 min per store, rehearsed on snapshot) is captured.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately.
- **Foundational (Phase 2)**: after Setup — establishes baseline; blocks story work.
- **US2 (Phase 3)**: after Foundational — the decision gate; **must complete before US1's compose/secret finalization** (FR-011). US2 itself depends on nothing but the template + research.md.
- **US1 (Phase 4)**: after US2 — the MVP build. Internal order: secret scaffolding (T010–T012) → keyfile entrypoint (T013a, prereq of T013) → compose edits (T013–T017) → runbook + rehearsal (T018–T020, gate) → prod cutover (T021–T023).
- **US3 (Phase 5)**: after US2 — conditional on the ADR outcome; independent of US1.
- **Polish (Phase 6)**: after US1 (and US3 if applicable).

### Critical rule

- **T020 (rehearsal green) is a hard gate before T021/T022 (prod cutover).** Never run the production cutover before a green rehearsal on the restored snapshot.

### Parallel Opportunities

- Setup: T001, T002, T003 all [P].
- US1 movie-store vs bff-store edits: T016/T017 [P] can proceed alongside T013–T015 (different files).
- Polish: T025, T027, T028 [P].

---

## Parallel Example: US1 compose edits

```bash
# Movie store and BFF store touch different files — parallelizable:
Task: "Edit infrastructure-as-code/docker/mc-service/compose.prod.yaml (T013)"
Task: "Edit infrastructure-as-code/docker/bff/compose.prod.yaml (T016)"
Task: "Extend prod-mcm-bff env block in stacks.toml (T017)"
```

---

## Implementation Strategy

### MVP scope

- **US2 (decision gate, ~4 small tasks) + US1 (Mongo auth)** together are the MVP: the security win plus the governance decision that shapes it. US2 is cheap (a document); do it first, then build US1.
- **STOP and VALIDATE** after Phase 4: both stores reject anonymous access, app works, counts preserved, web E2E green.

### Incremental delivery

1. Setup + Foundational → baseline green, premise confirmed.
2. US2 → ADR committed (mechanism decided).
3. US1 → rehearse on snapshot → prod cutover → validate (MVP security win).
4. US3 → only if the ADR chose Vault (else marked N/A).
5. Polish → gates + E2E + docs + SC sign-off.

---

## Notes

- `[operational]` tasks touch the prod host / Komodo store / running containers — not the repo; capture evidence (counts, gate output, screenshots) for the SC sign-off.
- The two Mongos are **not symmetric**: movie = replica set (keyfile), bff = standalone (no keyfile) — do not add a keyfile to the BFF store.
- **Keyfile is env-only** (`MONGO_MC_KEYFILE` → entrypoint materializes it in-container at `0400`): never a host bind-mount, never a committed file, never a data volume (feature 022 removed host file-secrets). See T013a.
- No application code is modified; if a task tempts you to edit `config.rs`/`client.rs`/`env.ts`/`mongo-client.ts`, stop — the URL already carries the credential.
- Commit after each repo-editing task or logical group; `[operational]` steps are recorded in the runbook, not committed as code.
