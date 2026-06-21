---
description: "Task list for externalizing Docker Compose credentials"
---

# Tasks: Externalize Docker Compose Credentials

**Input**: Design documents from `specs/021-externalize-compose-secrets/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: TDD is mandatory (constitution). The gate is authored first and Verified RED on the current tree, GREEN after the compose edits. Each test/validation task carries a Verify RED and/or Verify GREEN command per `docs/templates/feature-test-tasks-template.md`.

**Organization**: Grouped by the three user stories from spec.md (P1 no-plaintext / P2 one-command setup / P3 history scrub).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US2 / US3 (Setup, Foundational, Polish carry no story label)
- All paths are repo-relative from the root.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the tooling prerequisites the gate + generator rely on.

- [ ] T001 Confirm `yaml` is a **root** dependency in `package.json` (feature 019 lesson — CI frozen-install needs it at root for `check-resource-naming.mjs`; the new gate reuses it). If absent, add it.
- [ ] T002 [P] Confirm `git-filter-repo` availability is documented for the Phase D scrub (dev-machine tool only; note install in [docs/runbooks/local-dev.md](../../docs/runbooks/local-dev.md) — not a repo dependency).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the canonical variable names + the gitignore boundary that BOTH US1 (compose edits reference the vars) and US2 (generator reads the templates) depend on.

**⚠️ CRITICAL**: No user-story work can begin until this phase is complete.

- [ ] T003 Add the `.gitignore` carve-out: insert `!*.env.example` immediately after the `*.env` / `*.env.*` lines (`.gitignore:12-13`) so placeholder templates are trackable while generated `*.env` stay ignored.
  - Verify: `git check-ignore infrastructure-as-code/docker/stacks/auth.env` matches; `git check-ignore infrastructure-as-code/docker/stacks/auth.env.example` does **not** match (after the file exists).
- [ ] T004 [P] Create `infrastructure-as-code/docker/stacks/auth.env.example` — keys `KC_BOOTSTRAP_ADMIN_PASSWORD=<generate:complex-16>`, `VAULT_DEV_ROOT_TOKEN_ID=<generate:b62-48>`, with a header comment (real values generated, never committed). Per [contracts/env-var-manifest.md](./contracts/env-var-manifest.md) + [data-model.md](./data-model.md).
- [ ] T005 [P] Create `infrastructure-as-code/docker/stacks/mcm.env.example` — key `AGENT_DB_PASSWORD=<generate:b62-32>`.
- [ ] T006 [P] Create `infrastructure-as-code/docker/stacks/audit.env.example` — key `OPENSEARCH_INITIAL_ADMIN_PASSWORD=<generate:complex-16>`.
- [ ] T007 [P] Create `infrastructure-as-code/docker/stacks/observability.env.example` — the 13 observability keys (LANGFUSE_PG/CLICKHOUSE/REDIS_PASSWORD, LANGFUSE_MINIO_ROOT_PASSWORD, LANGFUSE_SALT, LANGFUSE_ENCRYPTION_KEY=`<generate:hex-64>`, LANGFUSE_NEXTAUTH_SECRET, LANGFUSE_INIT_USER_PASSWORD, UNLEASH_PG_PASSWORD, UNLEASH_ADMIN_TOKEN=`<generate:unleash-admin>`, UNLEASH_CLIENT_TOKEN=`<generate:unleash-client>`) **plus the 2 fixed fixtures** `LANGFUSE_INIT_PROJECT_PUBLIC_KEY=pk-lf-mcm-dev-0000000000000000` and `LANGFUSE_INIT_PROJECT_SECRET_KEY=sk-lf-mcm-dev-0000000000000000` (verbatim).
  - **Verify (X1 — fixture byte-identity)**: the two fixture values in the template are **byte-identical** to the current inline values in `observability/compose.yaml` (lines 72–73) so the agent-gateway + feature-012 SC-008 verify-test contract holds unchanged.

**Checkpoint**: Canonical var names fixed; templates tracked; gitignore boundary correct.

---

## Phase 3: User Story 1 — No plaintext credentials in tracked compose files (Priority: P1) 🎯 MVP

**Goal**: Zero clear-text credentials remain in any tracked compose file; a CI gate enforces it.

**Independent Test**: `node scripts/check-no-inline-secrets.mjs` exits 0 (was 1); the gate fails any re-inlined literal in CI.

### Test for User Story 1 (gate-first — write FIRST, verify RED) ⚠️

- [ ] T008 [US1] Author the gate `scripts/check-no-inline-secrets.mjs` per [contracts/inline-secret-gate.md](./contracts/inline-secret-gate.md): parse tracked `infrastructure-as-code/docker/**/compose*.yaml` + `stacks/*.compose.yaml` + root `compose.yaml` with `yaml`; flag secret-shaped keys / password-bearing URLs / `command`·`healthcheck`·`entrypoint` literals that are not pure `${VAR}`/`${VAR:?}`; honor the allowlist; add `--selftest`; exit 0/1/2.
  - **Scenarios covered**: SC-001, SC-005, spec AC1/AC2.
  - **Verify RED**: `node scripts/check-no-inline-secrets.mjs` → **exit 1**, lists the ~25 current literals across the 6 component files (e.g. `agent-db/compose.yaml: POSTGRES_PASSWORD`, `opensearch/compose.yaml: OPENSEARCH_INITIAL_ADMIN_PASSWORD`, `observability/compose.yaml: CLICKHOUSE_PASSWORD` …).
  - **Verify (selftest)**: `node scripts/check-no-inline-secrets.mjs --selftest` → **exit 0** (planted `POSTGRES_PASSWORD: hunter2` detected; `${VAR}` sample passes).

### Implementation for User Story 1

- [ ] T009 [P] [US1] `infrastructure-as-code/docker/keycloak/compose.yaml` — replace `KC_BOOTSTRAP_ADMIN_PASSWORD: ***REMOVED***` with `${KC_BOOTSTRAP_ADMIN_PASSWORD:?set in stacks/auth.env}`. (Leave `KC_DB_PASSWORD`/`.env.local` + the `POSTGRES_PASSWORD_FILE` secret untouched — out of scope.)
- [ ] T010 [P] [US1] `infrastructure-as-code/docker/vault/compose.yaml` — `VAULT_DEV_ROOT_TOKEN_ID` → `${VAULT_DEV_ROOT_TOKEN_ID:?set in stacks/auth.env}`.
- [ ] T011 [P] [US1] `infrastructure-as-code/docker/agent-db/compose.yaml` — `POSTGRES_PASSWORD=***REMOVED***` → `${AGENT_DB_PASSWORD:?set in stacks/mcm.env}`.
- [ ] T012 [P] [US1] `infrastructure-as-code/docker/agent-gateway/compose.yaml` — `AGENT_DB_URL` password → `postgresql://agent:${AGENT_DB_PASSWORD:?set in stacks/mcm.env}@movie-assistant-store-postgres:5432/agent_db` (same var as T011).
- [ ] T013 [P] [US1] `infrastructure-as-code/docker/opensearch/compose.yaml` — `OPENSEARCH_INITIAL_ADMIN_PASSWORD` (env) **and** the healthcheck `curl -sk -u admin:<literal>` → `${OPENSEARCH_INITIAL_ADMIN_PASSWORD:?set in stacks/audit.env}`; **sanitize the header-comment credential lines** (R6: `admin: ***REMOVED***`, `agent-audit: ***REMOVED***`) to refer to the env var instead of literals.
- [ ] T014 [US1] `infrastructure-as-code/docker/observability/compose.yaml` — externalize every literal to its canonical `${VAR:?set in stacks/observability.env}` at **all** occurrences (per [data-model.md](./data-model.md) registry): langfuse `DATABASE_URL` pw + `SALT` + `ENCRYPTION_KEY` + `NEXTAUTH_SECRET` + `CLICKHOUSE_PASSWORD` + `REDIS_AUTH` + both S3 `SECRET_ACCESS_KEY` + `LANGFUSE_INIT_USER_PASSWORD` + the 2 fixture keys; langfuse-postgres `POSTGRES_PASSWORD`; clickhouse `CLICKHOUSE_PASSWORD`; redis `command --requirepass` + healthcheck `-a`; minio `MINIO_ROOT_PASSWORD` + minio-init `entrypoint`; unleash `DATABASE_URL` pw + `INIT_ADMIN_API_TOKENS` + `INIT_CLIENT_API_TOKENS`; unleash-seed `entrypoint` Authorization; unleash-postgres `POSTGRES_PASSWORD`. (Single file → not [P].)
  - **Verify GREEN** (after T009–T014): `node scripts/check-no-inline-secrets.mjs` → **exit 0**.
- [ ] T015 [US1] Wire the gate into CI: add a step + Nx target. Add `check-no-inline-secrets` to `infrastructure-as-code/project.json` (mirrors `check-naming`); add a step to `.github/workflows/naming-gate.yml` (`node scripts/check-no-inline-secrets.mjs --selftest` then `... `) and broaden its `paths:` filter to include `infrastructure-as-code/docker/stacks/*.compose.yaml`, `scripts/check-no-inline-secrets.mjs`, and `infrastructure-as-code/docker/stacks/*.env.example`.
  - **Verify GREEN**: `node scripts/check-no-inline-secrets.mjs --selftest && node scripts/check-no-inline-secrets.mjs` → exit 0; a scratch re-inline of one literal turns it RED (revert after).

**Checkpoint**: Tracked compose tree is scanner-clean and CI-enforced. (Stacks are not yet startable without `.env` — that is US2.)

---

## Phase 4: User Story 2 — One-command local setup preserves the dev workflow (Priority: P2)

**Goal**: A single command mints local values; every stack `config`-resolves and comes up healthy on them.

**Independent Test**: On a clean checkout, `node scripts/gen-dev-secrets.mjs` then `pnpm nx up-*` → all stacks healthy; re-run preserves values.

- [ ] T016 [US2] Write `scripts/gen-dev-secrets.mjs` per [contracts/env-var-manifest.md](./contracts/env-var-manifest.md): read each `stacks/<stack>.env.example`; replace `<generate:KIND>` with a minted value honoring the KIND invariants (b62 URL-safe, hex-64, complex-16, unleash-admin/-client); copy fixtures verbatim; idempotent (skip existing unless `--force`); `--stack=` filter; write `# GENERATED … DO NOT COMMIT` header.
  - **Verify**: clean run creates `stacks/{auth,mcm,audit,observability}.env` with every key filled ([quickstart.md](./quickstart.md) Scenario 2).
- [ ] T017 [US2] Wire interpolation source (research R1): convert each `stacks/*.compose.yaml` `include:` entry to long syntax with `env_file: ./<stack>.env`; add `--env-file infrastructure-as-code/docker/stacks/<stack>.env` to `up-auth`/`up-mcm`/`up-audit`/`up-observability`/`up-all` (and matching `down-*` if needed) in `infrastructure-as-code/project.json`.
  - **Verify GREEN** (Scenario 3): `docker compose -p <stack> -f stacks/<stack>.compose.yaml --env-file stacks/<stack>.env [--profile …] config` renders with **no** `variable is not set` warnings, for all four stacks.
  - **Verify (fail-fast, AC4)**: running `config` **without** `--env-file` aborts with the `:?` message naming the missing var.
- [ ] T018 [US2] Validate idempotency + gitignore boundary + rotation ([quickstart.md](./quickstart.md) Scenario 2):
  - **Verify**: 2nd `gen-dev-secrets.mjs` run leaves each `.env` byte-identical (hash match); `git check-ignore stacks/auth.env` matches; `git ls-files stacks/auth.env.example` lists it; `--force --stack=observability` changes randomized lines but keeps **both** fixtures (`LANGFUSE_INIT_PROJECT_PUBLIC_KEY` **and** `LANGFUSE_INIT_PROJECT_SECRET_KEY`) byte-identical to the template (X1 — the deterministic cross-consumer contract survives rotation).
- [ ] T019 [US2] Bring up all four stacks on generated values and confirm health + cross-service auth ([quickstart.md](./quickstart.md) Scenario 4): `pnpm nx up-auth` → `up-mcm` → `up-audit` → `up-observability`; `pnpm nx ps`.
  - **Verify GREEN**: all expected containers healthy; LangFuse web reaches pg/clickhouse/redis/minio (no auth errors in logs); OpenSearch healthcheck passes; agent-gateway connects to `movie-assistant-store-postgres` via `AGENT_DB_PASSWORD`.
- [ ] T020 [P] [US2] Update [docs/runbooks/local-dev.md](../../docs/runbooks/local-dev.md): first-time setup runs `node scripts/gen-dev-secrets.mjs` before any `up-*`; document the per-stack `.env`/`.env.example` model and the fail-fast behavior. Add an optional `infrastructure-as-code/docker/stacks/README.md`.

**Checkpoint**: Clean clone → one command → working stacks. US1 + US2 together leave a fully functional, scanner-clean tree (ship together — see Dependencies).

---

## Phase 5: User Story 3 — Historical credentials purged from git history (Priority: P3)

**Goal**: Past commits no longer expose the credentials.

**Independent Test**: After the scrub, `git log -p -S '<literal>'` returns nothing for each scrubbed string; the tree still builds.

> **Sequenced AFTER US1+US2 are merged** (spec FR-010). Coordinated, history-rewriting — do not run on the feature branch.

- [ ] T021 [US3] Build `replacements.txt` (research R7): map each historical literal → `***REMOVED***`, scoping generic words (`agent`, `redis`, `langfuse`, `clickhouse`) to their `KEY=value`/URL context to avoid corrupting unrelated history; include `***REMOVED***`, `***REMOVED***`, `***REMOVED***`, `***REMOVED***`, `***REMOVED***`, the 64-hex encryption key, `***REMOVED***`, `***REMOVED***`, `***REMOVED***`, `change_me`, `***REMOVED***`; **exclude** the `pk-lf-…`/`sk-lf-…0000…` fixtures.
- [ ] T022 [US3] On a fresh mirror clone, run `git filter-repo --replace-text replacements.txt`, then `git push --force --mirror`; notify collaborators that existing clones / open PRs must re-clone or rebase.
  - **Verify (SC-006)**: `git log -p -S '<literal>'` returns 0 matches for each scrubbed string; a fresh clone builds and `pnpm nx up-*` still works (Scenario 6).

**Checkpoint**: History clean; remediation complete.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T023 Run the web-E2E regression to prove no behavior change (SC-007, constitution "E2E when done"): `pnpm nx docker-build mcm-app`; bring up the mcm `bff-nonsecure` profile on generated values; `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` → matches the known-green baseline. ([quickstart.md](./quickstart.md) Scenario 5.)
- [ ] T024 [P] Full quickstart validation pass (Scenarios 1–4) as the final pre-merge check; confirm gate GREEN + selftest + all four stacks healthy.
  - **Verify (C1 — cross-gate)**: the existing feature-018 committed-tree gate stays green with the new templates — `node scripts/secret-scan.mjs --selftest && node scripts/secret-scan.mjs` → exit 0 (the `*.env.example` fixtures/placeholders must not trip its Anthropic/TMDB rules; generated `*.env` are gitignored so unseen).
- [ ] T025 [P] Update the auto-memory index entry for feature 021 and add a short session-handoff note in the spec folder capturing the R1 `include`/`env_file` outcome actually used and any residual caveats.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)** → no deps.
- **Foundational (P2)** → after Setup; **blocks US1 and US2** (defines the var names + gitignore boundary).
- **US1 (P3)** → after Foundational. Independently testable via the gate (RED→GREEN).
- **US2 (P4)** → after Foundational. Independently testable via setup+health.
- **US3 (P5)** → after US1+US2 **merged** (post-merge, coordinated).
- **Polish (P6)** → after US1+US2.

### Critical cross-story note

US1's compose edits use fail-fast `${VAR:?}`, so after US1 alone the stacks cannot start until US2's generator + env wiring exist. Each story is independently *testable*, but **US1 + US2 MUST ship in the same merge** to avoid leaving a tree where local bring-up is broken. Recommended build order for a single merge: Setup → Foundational → US1 → US2 → Polish; US3 follows as a separate coordinated step.

### Within each story

- US1: gate authored + Verified RED (T008) **before** any compose edit (T009–T014); gate Verified GREEN after.
- US2: generator (T016) + wiring (T017) before health validation (T019).

### Parallel opportunities

- T004–T007 (the four `*.env.example`) are [P] (different files).
- T009–T013 (keycloak / vault / agent-db / agent-gateway / opensearch edits) are [P] (different files); T014 (observability) is solo (single large file); all must precede the GREEN check.
- T020, T024, T025 are [P].

---

## Implementation Strategy

### MVP (security objective)

Setup → Foundational → **US1** delivers the spec's primary outcome (scanner-clean, CI-enforced). But per the cross-story note, pair it with **US2** in the same merge so the dev workflow keeps working. Validate with the gate (T008/T014/T015) + Scenario 4 health + T023 E2E, then merge. Run **US3** as the coordinated post-merge history scrub.

### Verify-RED-first reminder

T008 is the TDD anchor: the gate MUST exit 1 on today's tree before any compose edit. A gate that is already GREEN (or that can't be shown RED) is invalid and must be corrected before T009 begins.
