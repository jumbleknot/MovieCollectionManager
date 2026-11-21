---

description: "Task list for feature 105 — Claude Code token usage capture and efficiency analysis"
---

# Tasks: Claude Code token usage capture and efficiency analysis

**Input**: Design documents from `specs/105-cc-token-usage-capture/` — [plan.md](plan.md), [spec.md](spec.md),
[research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ — all present

**Tests**: REQUIRED (constitution "Test-Driven Development", NON-NEGOTIABLE). Every test task names the
acceptance scenarios it covers and carries a **Verify RED** command with the expected failure; its
paired implementation task carries **Verify GREEN**. Documentation and config tasks use **Done when**
(`docs/templates/feature-test-tasks-template.md`). For a brand-new module the honest RED is the
test's own assertions failing against a stub export; create the stub (exporting the functions, each
throwing `not implemented`) as the first step of the test task, so RED is never just
`ERR_MODULE_NOT_FOUND`.

**Organization**: by user story (spec.md US1–US4), after a shared Setup and Foundational phase.

**Instrument rules (AGENTS.md)**: node's flags go **before** the file path; `node --test <file>
--test-name-pattern x` runs everything. Watch the **skip count** — any skip in a Verify GREEN is a
failure. The store integration tier runs with `MCM_REQUIRE_LIVE_STACK=1` so a missing Docker fails
instead of skipping.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)

## Path Conventions

Repository-root paths as in [plan.md](plan.md) Project Structure: `scripts/`, `scripts/lib/cc-usage/`,
`scripts/__tests__/`, `.claude/`, `infrastructure-as-code/docker/dev-usage/`, `.devcontainer/`, `docs/`, `openwiki/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: settle the open measurements, fix the doc impact, and create the shared fixtures

- [ ] T001 **Spike — confirm the open trigger and identity questions in the live container** (no repository change except research.md). In a throwaway worktree with a temporary local `.claude/settings.local.json` hook that only appends its stdin JSON to `$CLAUDE_CONFIG_DIR/usage/spike.ndjson`, confirm and record under a new `## Spike results` heading in `specs/105-cc-token-usage-capture/research.md`: (a) the stdin field names for `SessionStart`, `Stop`, `SessionEnd`; (b) the exact `async` / `timeout` key spellings the installed 2.1.327 accepts; (c) `$CLAUDE_PROJECT_DIR` value in a worktree session and in a main-checkout session; (d) whether project hooks run **alongside** the user-level RTK `PreToolUse` hook; (e) `Stop` on an interrupted turn; (f) `SessionEnd` after a VM idle-stop; (g) `${CLAUDE_SESSION_ID}` substitution in a project skill body; (h) whether the sandbox network policy is per host or per host and port; (i) whether statusline stdin carries `rate_limits` on this plan. Delete the temporary hook afterwards.
  - **Type**: Research | **Spec reference**: research R6, R7, R12, R14
  - **Done when**: research.md has one line per item (a)–(i) with the observed value and date, and each "still unverified" note in R6, R7, R12, R14 points at its result. Any result that contradicts contracts/hooks-and-skill.md or contracts/cli.md is fixed in that contract in the same commit.
- [x] T002 **Doc-impact sweep** (constitution "Documentation"). Ran while generating this file, 2026-11-21, from the feature worktree:
  `git grep -n -F "<term>" -- '*.md' ':!specs/' ':!docs/proposals/' ':!docs/decisions/'`
  **Terms** — this feature removes and renames nothing; it changes the meaning of statements that enumerate things it adds to: `three ports`, `only published ports`, `19099` (as a member of the port list), `seven \`compose.prod.yaml\``, `compose.prod.yaml\` files`, `27 services`, `All seven declare`, `prod-vault` (as the end of the stack list), `prod-auth\` → \`prod-mc-service`, `stacks.toml`, `gen-container-secrets-env`, `MCM_FORGE_ISSUE_TOKEN` (as the end of the credential list), `backup.sh`, `[1/8]`, `VOLUME_RE`, `<context>-<role>`, `ensure-rtk-hook`, `.claude/settings.json`. New identifiers (`MCM_USAGE_INGEST_URL`, `MCM_USAGE_INGEST_TOKEN`, `prod-dev-usage`, `19040`, `cc-usage.mjs`, `usage` skill) have no prior mentions to fix.
  **Hits and dispositions**:
  - `openwiki/invariants/published-port-reservation.md:4,20,37,38` — "three … publishes", "the only published ports … seven compose.prod.yaml files" → T062
  - `openwiki/invariants/index.md:9` — "keeps the three production admin/UI publishes" → T062
  - `docs/runbooks/prod-reboot-resilience.md:86` — "The three (and only) … published ports" table; `:138-144` reachability checks 5–7 and "The three ports probed from off-tailnet" → T063
  - `openwiki/runbooks/prod-reboot-resilience.md:141,204,427` — "27 services across the seven compose.prod.yaml files", "those same three ports" → T063 (refresh)
  - `docs/runbooks/Server-Setup-Runbook.md:954` (ResourceSync stack list), `:1128-1150` (Backups dump table), `:1412` (published-port survivability list), `:1431` (stack table) → T064
  - `openwiki/projects/infrastructure-stacks.md:118,128` — stack list and dependency diagram → T065
  - `docs/runbooks/devcontainer.md:141,232-245` — heading and bullets enumerating forwarded host env vars → T066
  - `openwiki/runbooks/devcontainer.md:166,202` → T066 (refresh)
  - `docs/runbooks/devcontainer-sandbox.md:170-172,691,766` — credential lists shown by `docker inspect` and the `~/.mcm-sandbox-env` example → T067
  - `openwiki/runbooks/devcontainer-sandbox.md:234` → T067 (refresh)
  - `openwiki/projects/repository.md:724,732` — `--env-file` credential list → T067 (refresh)
  - `openwiki/decisions/adr-0001-prod-secrets-management.md:44` — "All seven declare `env_file_path`" → no change: summary of a decision record (ADR-0001), which describes the stacks at decision time
  - `docs/runbooks/prod-control-tower.md:4,25,70,76` — the control-tower stacks and the reserved-range rule → no change: `prod-dev-usage` is not part of the control tower; the range rule already covers 19040
  - `docs/runbooks/prod-control-tower.md:761`, `openwiki/runbooks/prod-control-tower.md:64` (`VOLUME_RE`) → no change: records how the `vault` prefix was added (history)
  - `openwiki/projects/infrastructure-stacks.md:479` (`<context>-<role>-<engine>`) → no change: states the grammar, which is unchanged; T065 adds the new context to the stack page
  - `docs/runbooks/Phase-15-Operator-Checklist.md` (`stacks.toml`, `19099`), `openwiki/runbooks/phase-15-operator-checklist.md:65`, `openwiki/decisions/adr-0001…:53` → no change: the Phase 15 bring-up of the app stacks, dated
  - `README.md:145`, `infrastructure-as-code/backup/README.md:12,31,89,97`, `docs/runbooks/Server-Setup-Runbook.md:830,843,1189,1201,1398` → no change: describe the mechanism, not an enumeration this feature extends (the dump table at 1128 is T064)
  - `MCM_FORGE_ISSUE_TOKEN` hits in `.claude/skills/forgejo-issues/SKILL.md`, `docs/runbooks/backlog.md`, `docs/runbooks/renovate.md`, `openwiki/runbooks/{backlog,renovate}.md`, `.specify/templates/overrides/tasks-template.md` → no change: about that token alone
  - `ensure-rtk-hook` hits in `docs/runbooks/devcontainer-sandbox{,-lifecycle}.md` and their wiki pages → no change: about the user-level RTK hook, which this feature leaves untouched (T001(d) confirms project hooks coexist)
  - `.claude/settings.json`, `[1/8]`, `only published ports`, `seven \`compose.prod.yaml\`` (exact) → no hits outside the above
- [ ] T003 [P] Create the synthetic fixture transcripts in `scripts/__tests__/fixtures/cc-usage/` per research R9: `projects/-workspaces-mcm/<uuid-a>.jsonl` (main session: two human turns, streamed duplicate assistant lines with identical usage, a `compact_boundary`, a skill-attributed turn via `attributionSkill`, Bash `pnpm`/`git` calls, an Edit under `docs/`, an unknown line type, one malformed line), `<uuid-a>/subagents/agent-x.jsonl` + `agent-x.meta.json`, and `agent-y.meta.json` with **no** transcript; `projects/-home-coder-worktrees-feat-a/<uuid-b>.jsonl` (worktree session); a main-checkout session `<uuid-c>.jsonl` whose tool calls touch two worktrees `feat-a` and `docs-b` (for attribution); plus `worktrees.json` describing each fake worktree's branch and `.specify/feature.json`. Every content-bearing field holds a sentinel `SENTINEL-<field>-<n>` string. A `README.md` in the folder lists what each file exercises.
  - **Type**: New file (test data) | **Spec reference**: FR-002–FR-005, FR-012, FR-036
  - **Done when**: every line parses as JSON except the one deliberate malformed line; `git grep -n 'accountUuid\|organizationUuid' scripts/__tests__/fixtures/cc-usage/` shows only synthetic zero-UUIDs; no real transcript text is present.
- [ ] T004 [P] Create the dated weight table `scripts/cc-usage-weights.json` (`asOf`, `source`, and ratios for `input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h`, relative to input = 1), in the shape of `scripts/wiki-provider-prices.json`; cite `data-model.md` `token_weights` for the columns.
  - **Type**: Config | **Spec reference**: FR-026
  - **Done when**: the file parses, every ratio is a positive number, and `source` names the public price page and date it was read from.
- [ ] T005 [P] Add the on-demand Nx target `cc-usage-oracle` to `infrastructure-as-code/project.json`: runs ccusage at an exact pinned version with `pnpm dlx` against `CLAUDE_CONFIG_DIR=scripts/__tests__/fixtures/cc-usage` and writes per-session totals to `scripts/__tests__/fixtures/cc-usage/ccusage-oracle.json`; then run it and commit the oracle (research R8).
  - **Type**: Config + generated test data | **Spec reference**: FR-017, SC-002
  - **Done when**: `pnpm nx cc-usage-oracle infrastructure-as-code` exits 0, re-running it leaves `git diff --exit-code scripts/__tests__/fixtures/cc-usage/ccusage-oracle.json` clean, and the target's description says it is not run in CI and why.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the pure parser and the privacy shape every story ships through

**⚠️ CRITICAL**: no user story work begins until this phase is complete

- [ ] T006 [P] Write parser unit tests in `scripts/__tests__/cc-usage-parse.test.mjs` against `scripts/lib/cc-usage/parse-transcript.mjs` (stub first): one model call per `message.id` with duplicates collapsed (research R2); the four token types plus the 5m/1h cache-write split summing to `cache_creation_input_tokens` (`data-model.md` `model_calls.cache_write_5m_tokens`, `model_calls.cache_write_1h_tokens`); turn boundaries on `origin.kind = human` and task-notification wake-ups flagged (`data-model.md` `turns.origin`); compactions counted; `attributionSkill` → skill use; tool use aggregated per turn with `command_family` = first word of a Bash command only (`data-model.md` `tool_use.command_family`); subagent file attributed to the parent turn via `meta.toolUseId`; a meta file without transcript → `partial` with reason `subagent-transcript-missing` and an assistant line without usage → `partial` with `format-drift` (`data-model.md` `sessions.capture_status`, `sessions.partial_reasons`); parsing from a byte offset returns only the new records.
  - **Scenarios covered**: US1-AC1 (session record fields), US1-AC2 (gap reported as partial, never zero); FR-002–FR-005
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-parse.test.mjs` → expected: every test failing — `Error: not implemented`
- [ ] T007 Implement `scripts/lib/cc-usage/parse-transcript.mjs` (pure; input = text and a starting offset, output = records plus the new offset); ignore the line types research R1 lists as ignorable (prerequisite: T006 verified RED).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-parse.test.mjs` → expected: 0 failures, 0 skipped
- [ ] T008 [P] Write the privacy guard in `scripts/__tests__/cc-usage-privacy.guard.test.mjs`: parse every fixture, serialize every record batch the shipper would send, and assert (a) no `SENTINEL-` string appears anywhere, (b) no key named or containing `content`, `text`, `prompt`, `stdout`, `stderr`, `command`, `path`, `filePath`, `description`, `oldString`, `newString`, (c) no string over 200 characters except `findings.suggestion`, (d) no absolute path, no worktree path, no host name (contracts/store-http.md "Record shape constraints"). Mutation RED: make `privacy-shape.mjs` a pass-through.
  - **Scenarios covered**: US1-AC6; FR-012, FR-003 (no file paths), SC-004
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-privacy.guard.test.mjs` → expected: failing — `AssertionError: sentinel SENTINEL-… found in shipped batch`
- [ ] T009 Implement `scripts/lib/cc-usage/privacy-shape.mjs`: an explicit **allowlist** per table of the columns in `data-model.md` (anything else is dropped, not escaped), applied by the shipper to every batch (prerequisite: T008 verified RED).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-privacy.guard.test.mjs scripts/__tests__/cc-usage-parse.test.mjs` → expected: 0 failures, 0 skipped
- [ ] T010 [P] Write the oracle cross-check test in `scripts/__tests__/cc-usage-oracle.test.mjs`: for every session in `ccusage-oracle.json`, the parser's totals for input, output, cache write and cache read equal the oracle's exactly; and a CLI test that `node scripts/cc-usage.mjs oracle-check` exits 0 on the fixtures and 1 when one fixture's usage is altered in a temp copy.
  - **Scenarios covered**: SC-002; FR-017
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-oracle.test.mjs` → expected: the CLI cases failing — `cc-usage.mjs: no such command oracle-check` (or the entry file missing)
- [ ] T011 Create `scripts/cc-usage.mjs` with argument parsing through `scripts/lib/argv-contract.mjs` (unknown flag → exit 2) and the `oracle-check` command (prerequisite: T010 verified RED).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-oracle.test.mjs` → expected: 0 failures, 0 skipped

**Checkpoint**: parsing is exact, matches the reference tool, and cannot leak content.

---

## Phase 3: User Story 1 — Every session is captured and kept, with no manual step (Priority: P1) 🎯 MVP

**Goal**: every dev-container session ships durable per-session, per-turn and per-tool records to the
homelab store, automatically, safely under concurrency and offline.

**Independent Test**: quickstart.md §1, §2, §3 and §4 — unit, oracle, store-contract and live-capture checks.

### Tests for User Story 1 (REQUIRED — TDD checkpoint format) ⚠️

- [ ] T012 [P] [US1] Write `scripts/__tests__/cc-usage-local-state.test.mjs` for `scripts/lib/cc-usage/local-state.mjs` (stub first) using a temp `CLAUDE_CONFIG_DIR`: offsets written via temp-file-and-rename and never moved backwards; the sweep lock is taken once, refused while fresh, and reclaimable after expiry; a spool file is claimed by rename and removed only after a confirmed send; a fresh back-off marker suppresses network use; the log file is size-capped and rotated (data-model.md "Local state").
  - **Scenarios covered**: US1-AC4 (offline queueing), US1-AC5 (overlap safety); FR-009, FR-010
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-local-state.test.mjs` → expected: every test failing — `Error: not implemented`
- [ ] T013 [P] [US1] Write `scripts/__tests__/cc-usage-ship.test.mjs` for `scripts/lib/cc-usage/ship-records.mjs` with an **injected** `fetch` (unit tier): `POST` per table with `Prefer: resolution=merge-duplicates,return=minimal` and the `on_conflict` keys and batch caps of contracts/store-http.md; parents (`sessions`, `features`) before children; `Authorization: Bearer` carries the env token, and the token never appears in the log or in any thrown message; a failure mid-ship spools the whole batch and writes back-off; connect timeout 2 s, total 5 s.
  - **Scenarios covered**: US1-AC4; FR-008, FR-010, FR-015
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-ship.test.mjs` → expected: every test failing — `Error: not implemented`
- [ ] T014 [P] [US1] Write the hook guard `scripts/__tests__/cc-usage-hook.guard.test.mjs`, spawning `node scripts/cc-usage.mjs hook` with event JSON on stdin and a temp `CLAUDE_CONFIG_DIR` pointing at a copy of the fixtures: for each of `SessionStart`, `Stop`, `SessionEnd`, and for malformed stdin, an unreadable transcript, an unset URL and an unreachable URL — exit code 0, **empty stdout**, empty stderr; `Stop` within `CC_USAGE_SHIP_INTERVAL_S` of the last ship performs no parse and no network (asserted by an injected-fetch counter via a test-only env hook) and finishes in < 1 s; `SessionEnd` records `end_reason`.
  - **Scenarios covered**: US1-AC1, US1-AC4; FR-001, FR-007, FR-011, SC-005
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-hook.guard.test.mjs` → expected: failing — `cc-usage.mjs: no such command hook`
- [ ] T015 [P] [US1] Write `scripts/__tests__/cc-usage-sweep.test.mjs`: a `SessionStart` sweep visits **every** `projects/*/` directory (research R4) and ships each transcript's unshipped bytes once; a transcript whose last line is over 24 h old with no `SessionEnd` becomes `partial` with `no-session-end`; a pre-existing transcript with no state file is backfilled; a second sweep within 15 min is skipped; an interrupted sweep resumes from the stored offsets.
  - **Scenarios covered**: US1-AC2, US1-AC3; FR-006, FR-011
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-sweep.test.mjs` → expected: every test failing — `cc-usage.mjs: no such command hook` / `not implemented`
- [ ] T016 [P] [US1] Write the concurrency test `scripts/__tests__/cc-usage-concurrency.test.mjs`: run 5 hook processes in parallel (mixed `SessionStart` and `Stop`, same fixtures) against a local recording HTTP server that applies upsert semantics in memory, then compare row counts and per-session totals with one serial run — identical; also two flushers on one spool directory deliver each batch exactly once in effect.
  - **Scenarios covered**: US1-AC5; FR-008, FR-009, SC-003
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-concurrency.test.mjs` → expected: failing — `AssertionError: parallel row count != serial row count` (or `no such command hook`)
- [ ] T017 [P] [US1] Write the settings pin `scripts/__tests__/cc-usage-settings.guard.test.mjs`: `.claude/settings.json` contains exactly the three hook entries of contracts/hooks-and-skill.md (with the key spellings T001 confirmed), and `extraKnownMarketplaces` and `enabledPlugins` are unchanged from `main`.
  - **Scenarios covered**: US1-AC1; FR-001
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-settings.guard.test.mjs` → expected: failing — `AssertionError: missing hooks.SessionStart`
- [ ] T018 [P] [US1] Write `scripts/__tests__/cc-usage-doctor.test.mjs`: `doctor` reports `configured: no` when the URL is unset, the last successful ship time, spool depth, back-off state and every transcript with unshipped bytes, in ≤ 10 lines, exit 0.
  - **Scenarios covered**: US2-AC5 (capture health, used by US1's exit check); FR-016
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-doctor.test.mjs` → expected: failing — `cc-usage.mjs: no such command doctor`
- [ ] T019 [P] [US1] Write the store contract integration test `infrastructure-as-code/docker/dev-usage/tests/store-contract.test.mjs` against a **real** Postgres + PostgREST brought up from `infrastructure-as-code/docker/dev-usage/compose.yaml` (no mocks): upserts on every natural key are idempotent (posting a batch twice leaves counts unchanged); `DELETE` and `TRUNCATE` refused for `usage_writer`; a request with no token or a wrong-role token refused; an undefined column → 400; `v_session_totals` equals the sums of the posted `model_calls`; enum columns reject unknown values (`data-model.md` `sessions.capture_status`, `turns.origin`). Skips only when `MCM_REQUIRE_LIVE_STACK` is unset.
  - **Scenarios covered**: US1-AC5 (idempotent store), US1-AC1; FR-008, FR-013, FR-014
  - **Verify RED**: `MCM_REQUIRE_LIVE_STACK=1 pnpm nx dev-usage-integration infrastructure-as-code` → expected: failing — `Cannot find project target dev-usage-integration` then, once the target exists, `connect ECONNREFUSED` / schema missing

### Implementation for User Story 1

- [ ] T020 [US1] Implement `scripts/lib/cc-usage/local-state.mjs` (prerequisite: T012 verified RED).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-local-state.test.mjs` → expected: 0 failures, 0 skipped
- [ ] T021 [US1] Implement `scripts/lib/cc-usage/ship-records.mjs` on the global `fetch`, applying `privacy-shape.mjs` to every batch (prerequisite: T013 verified RED; depends on T009, T020).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-ship.test.mjs scripts/__tests__/cc-usage-privacy.guard.test.mjs` → expected: 0 failures, 0 skipped
- [ ] T022 [US1] Implement the `hook` command and the sweep in `scripts/cc-usage.mjs` per contracts/cli.md (event dispatch from stdin, interval check before any parse, sweep across all project directories, `capture_status` transitions per `data-model.md` `sessions.capture_status` state machine, structured JSON logging to `cc-usage.log` with session id as correlation id; every path exits 0 and writes nothing to stdout) (prerequisite: T014, T015, T016 verified RED; depends on T007, T020, T021).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-hook.guard.test.mjs scripts/__tests__/cc-usage-sweep.test.mjs scripts/__tests__/cc-usage-concurrency.test.mjs` → expected: 0 failures, 0 skipped
- [ ] T023 [US1] Implement the `doctor` command in `scripts/cc-usage.mjs` (prerequisite: T018 verified RED).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-doctor.test.mjs` → expected: 0 failures, 0 skipped
- [ ] T024 [US1] Add the `hooks` block to `.claude/settings.json` exactly as contracts/hooks-and-skill.md (adjusted by T001), leaving the existing keys untouched (prerequisite: T017 verified RED).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-settings.guard.test.mjs` → expected: 0 failures, 0 skipped
- [ ] T025 [US1] Create the store schema as ordered SQL in `infrastructure-as-code/docker/dev-usage/schema/` (`01-schema.sql`, `02-tables.sql`, `03-roles.sql`, `04-views.sql`): every table and column of data-model.md with its keys and enums (`data-model.md` `sessions.capture_status`, `turns.origin`, `turns.attribution_rule`, `features.kind`, `features.pr_state`, `findings.status`); role `usage_writer` with `INSERT, UPDATE, SELECT` only, role `usage_reader` with `SELECT` on views only, an `authenticator` role for PostgREST, no anonymous role; views `v_call_weighted`, `v_session_totals`, `v_turn_totals` (the remaining views come with US3/US4). Then `infrastructure-as-code/docker/dev-usage/compose.yaml` (postgres 18 + postgrest, digest-pinned, ephemeral volume, health checks, schema mounted into `/docker-entrypoint-initdb.d`) and the Nx target `dev-usage-integration` in `infrastructure-as-code/project.json` (compose up, wait healthy, mint a test JWT, run T019's file with `node --test`, compose down) (prerequisite: T019 verified RED).
  - **Verify GREEN**: `MCM_REQUIRE_LIVE_STACK=1 pnpm nx dev-usage-integration infrastructure-as-code` → expected: 0 failures, 0 skipped
- [ ] T026 [US1] Update the naming gate's premise in `scripts/check-resource-naming.mjs` (premise change, rule kept — AGENTS.md "guard updated at the cause"): admit the `dev-usage` context in `VOLUME_RE` and `IDENTIFIER_RE`, with a comment naming feature 105; extend the gate's `--selftest` so a `dev-usage-*` name passes and a `devusage-*` name still fails.
  - **Verify RED**: before the edit, `node scripts/check-resource-naming.mjs` over a scratch copy holding the T027 compose → expected: exit 1 naming `dev-usage-postgres-data`
  - **Verify GREEN**: `node scripts/check-resource-naming.mjs && node scripts/check-resource-naming.mjs --selftest` → expected: exit 0 both
- [ ] T027 [US1] Create `infrastructure-as-code/docker/dev-usage/compose.prod.yaml` (project `prod-dev-usage`): `dev-usage-postgres` and `dev-usage-postgrest`, digest-pinned upstream images, `restart: always`, health checks, json-file log rotation, external volume `dev-usage-postgres-data`, PostgREST published `"19040:3000"` (no other published port), Postgres on an internal network plus `backend-network` (external) so Grafana can read it, secrets from `.env.prod` (`DEV_USAGE_PG_PASSWORD`, `DEV_USAGE_JWT_SECRET`, `DEV_USAGE_READER_PASSWORD`); and the `[[stack]] name = "prod-dev-usage"` entry in `infrastructure-as-code/komodo/stacks.toml` with those Komodo Variables (depends on T025, T026).
  - **Type**: Config | **Spec reference**: FR-013, FR-014
  - **Done when**: `node scripts/check-prod-restart-policy.mjs`, `node scripts/check-prod-ci-port-collision.mjs`, `node scripts/check-resource-naming.mjs` all exit 0, and `docker compose -f infrastructure-as-code/docker/dev-usage/compose.prod.yaml config -q` succeeds with dummy env values.
- [ ] T028 [US1] Add the dev-usage database to the nightly backup in `infrastructure-as-code/backup/backup.sh` (a `run_dump dev-usage … dump_postgres dev-usage-postgres -Fc` step with a sensible minimum size; renumber the `[N/M]` step echoes) and extend `scripts/__tests__/backup-script.test.mjs` to assert the step exists. Write the test change first.
  - **Scenarios covered**: FR-013 (daily backup)
  - **Verify RED**: `node --test scripts/__tests__/backup-script.test.mjs` → expected: 1 failing — `AssertionError: no dev-usage dump step`
  - **Verify GREEN**: `node --test scripts/__tests__/backup-script.test.mjs scripts/__tests__/backup-alert.test.mjs` → expected: 0 failures, 0 skipped
- [ ] T029 [US1] Plumb the two variables into the dev container: `MCM_USAGE_INGEST_TOKEN` into `VARS` in `.devcontainer/gen-container-secrets-env.sh` (updating its comment's credential count), and `MCM_USAGE_INGEST_URL` as `${localEnv:MCM_USAGE_INGEST_URL}` in `containerEnv` of `.devcontainer/devcontainer.json` and `.devcontainer/sandbox/devcontainer.json`, each with a comment saying it is a tailnet URL injected at runtime and never committed (research R11). Run whatever existing `.devcontainer/verify` checks assert the `VARS` list.
  - **Type**: Config | **Spec reference**: FR-015
  - **Done when**: `git grep -n 'MCM_USAGE_INGEST' .devcontainer/` shows the three entries; `bash -n .devcontainer/gen-container-secrets-env.sh` passes; `node scripts/check-*.mjs` gates touching `.devcontainer` still exit 0; no URL value appears in any committed file.
- [ ] T030 [US1] Write the operator runbook `docs/runbooks/dev-usage.md`: what is captured and what never is; the Komodo Variables and the one command to sign the capture JWT; adding the two values to `~/.mcm-sandbox-env` and recreating the container; the sandbox network-policy step (per T001(h)); the host firewall rule for 19040; `cc-usage.mjs doctor` and what each line means; restoring from the nightly dump; the transcript-format-drift procedure (re-run `cc-usage-oracle`, check `partial` reasons). Add the concept page `openwiki/runbooks/dev-usage.md` citing it as `resource`, its line in `openwiki/runbooks/index.md`, and one index line under **Runbooks** in `AGENTS.md`.
  - **Type**: Documentation | **Spec reference**: FR-013–FR-016, Assumptions (operator steps)
  - **Done when**: `pnpm nx okf-lint infrastructure-as-code` and `pnpm nx okf-governance infrastructure-as-code` exit 0, and the new wiki page has a recorded fingerprint (`node scripts/wiki-refresh.mjs --record` for it).

**Checkpoint**: capture works end to end; deploy the stack, set the env, and let data accumulate (quickstart §4).

---

## Phase 4: User Story 2 — Ask about usage during a session (Priority: P2)

**Goal**: compact, session-correct answers mid-session, working offline for "now".

**Independent Test**: quickstart.md §5.

### Tests for User Story 2 (REQUIRED — TDD checkpoint format) ⚠️

- [ ] T031 [P] [US2] Write `scripts/__tests__/cc-usage-render.test.mjs` for `scripts/lib/cc-usage/render-table.mjs` (stub first): fixed-width tables capped at 10 rows with a `… N more` line; `--json` returns every row; any host name or tailnet name in a value is redacted.
  - **Scenarios covered**: US2-AC3; FR-021
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-render.test.mjs` → expected: every test failing — `Error: not implemented`
- [ ] T032 [P] [US2] Write `scripts/__tests__/cc-usage-query.test.mjs` for the interactive commands with an injected fetch serving canned view rows: `now --session` answers from local state (tokens by type, context now, top 5 tool outputs, subagent share) and adds the same-activity median only when the store answers; with two live sessions each `now` shows only its own; `sessions`, `trend`, `compare` with the store unreachable print exactly `usage history: store unreachable (spooled N)` and exit 0; `now`, `sync`, `tag` without `--session` exit 2; `sync --session` ships immediately despite a fresh interval and resets the timer; `tag` patches `sessions.manual_tag`.
  - **Scenarios covered**: US2-AC1, US2-AC2, US2-AC3, US2-AC4; FR-018, FR-019, FR-020, FR-022, SC-006
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-query.test.mjs` → expected: failing — `cc-usage.mjs: no such command now`
- [ ] T033 [P] [US2] Write the skill pin `scripts/__tests__/cc-usage-skill.guard.test.mjs`: `.claude/skills/usage/SKILL.md` exists, its frontmatter `name` is `usage`, every command line in it passes `--session ${CLAUDE_SESSION_ID}` (or the T001(g) fallback), it states that `sync` runs only on the user's request, and it is ≤ 60 lines.
  - **Scenarios covered**: US2-AC1, US2-AC4, US2-AC6; FR-019, FR-022
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-skill.guard.test.mjs` → expected: failing — `ENOENT .claude/skills/usage/SKILL.md`
- [ ] T034 [P] [US2] Extend `infrastructure-as-code/docker/dev-usage/tests/store-contract.test.mjs` with the read paths the commands use: filtered, ordered, limited `GET /v_session_totals` and `/v_turn_totals` return the expected rows for seeded data; `PATCH /sessions?session_id=eq.` can set `manual_tag` and cannot change token columns (no token columns on `sessions`).
  - **Scenarios covered**: US2-AC3; FR-018
  - **Verify RED**: `MCM_REQUIRE_LIVE_STACK=1 pnpm nx dev-usage-integration infrastructure-as-code` → expected: the new cases failing — e.g. `AssertionError: expected 3 rows, got 0`

### Implementation for User Story 2

- [ ] T035 [US2] Implement `scripts/lib/cc-usage/render-table.mjs` (prerequisite: T031 verified RED).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-render.test.mjs` → expected: 0 failures, 0 skipped
- [ ] T036 [US2] Implement `now`, `sessions`, `trend` (`week|activity|spec|area`), `compare`, `sync`, `tag` in `scripts/cc-usage.mjs` per contracts/cli.md, keeping the per-session incremental summary in local state so `now` never re-parses a whole transcript (prerequisite: T032 verified RED; depends on T035). Seed any view the integration test needs in `04-views.sql`.
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-query.test.mjs && MCM_REQUIRE_LIVE_STACK=1 pnpm nx dev-usage-integration infrastructure-as-code` → expected: 0 failures, 0 skipped
- [ ] T037 [US2] Write `.claude/skills/usage/SKILL.md` per contracts/hooks-and-skill.md (prerequisite: T033 verified RED).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-skill.guard.test.mjs` → expected: 0 failures, 0 skipped

**Checkpoint**: in-session questions answered from the same data, offline-tolerant.

---

## Phase 5: User Story 3 — Attributed to the kind of work, the feature, and its outcome (Priority: P3)

**Goal**: every turn carries one activity label and one feature (or "no feature"); every feature branch,
with or without a spec, has outcomes; feature metrics are exact sums across sessions.

**Independent Test**: quickstart.md §6.

### Tests for User Story 3 (REQUIRED — TDD checkpoint format) ⚠️

- [ ] T038 [P] [US3] Write `scripts/__tests__/cc-usage-label.test.mjs` for `scripts/lib/cc-usage/label-activity.mjs` (stub first): one table-driven case per row of data-model.md "Labelling", in order, asserting the first match wins and `activity_rule` is the firing rule's id (`data-model.md` `turns.activity`, `turns.activity_rule`); a turn matching nothing is `unclassified`; a turn matching two rules gets the earlier one.
  - **Scenarios covered**: US3-AC1, US3-AC2; FR-023, FR-024
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-label.test.mjs` → expected: every case failing — `Error: not implemented`
- [ ] T039 [P] [US3] Write `scripts/__tests__/cc-usage-feature-attribution.test.mjs` for `scripts/lib/cc-usage/attribute-feature.mjs` (stub first), using the T003 main-checkout fixture and `worktrees.json`: each rule of data-model.md "Feature attribution" in order (`data-model.md` `turns.attribution_rule`); a main-checkout session whose turns work in `feat-a` then `docs-b` is split between the two features with nothing dropped; a turn with no tool call inherits; a two-worktree turn goes to the majority, ties to the last touched; a `main` turn yields `feature_id` null (`data-model.md` `turns.feature_id`); per-feature token sums plus no-feature equal the session total (conservation, unit level).
  - **Scenarios covered**: US3-AC3, US3-AC4, US3-AC7; FR-036, FR-037, SC-011
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-feature-attribution.test.mjs` → expected: every test failing — `Error: not implemented`
- [ ] T040 [P] [US3] Write `scripts/__tests__/cc-usage-feature-identity.test.mjs` for `scripts/lib/cc-usage/resolve-feature-identity.mjs` (stub first): a first turn on a new branch creates `<branch>@<date>` (`data-model.md` `features.feature_id`); later turns join the open feature; a PR found is recorded without changing the id; after `merged` the next turn on the same name creates a new feature and the merged one's totals are unchanged (`data-model.md` `features.pr_state`); two ids minted offline for one branch with no PR between them are reconciled to the earlier one (research R17); a deleted branch with no PR becomes `abandoned`.
  - **Scenarios covered**: edge cases "reused branch name", "deleted without PR"; FR-035
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-feature-identity.test.mjs` → expected: every test failing — `Error: not implemented`
- [ ] T041 [P] [US3] Write `scripts/__tests__/cc-usage-outcomes.test.mjs` for `scripts/lib/cc-usage/collect-feature-outcomes.mjs` (stub first) with injected git and forge readers: spec link resolved from `.specify/feature.json`, then a matching `specs/*` directory, then an `NNN-` prefix (`data-model.md` `features.spec_dir`, `features.kind`); a no-spec feature has `tasks_total` and `tasks_done` **null**, never 0 (`data-model.md` `features.tasks_total`); a spec feature counts `tasks.md` checkboxes; PR state, CI red/green, `first_red_at` and backlog closures mapped from forge responses; collection skipped when done less than 15 min ago.
  - **Scenarios covered**: US3-AC5, US3-AC6; FR-025, FR-034
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-outcomes.test.mjs` → expected: every test failing — `Error: not implemented`
- [ ] T042 [P] [US3] Write `scripts/__tests__/cc-usage-feature-query.test.mjs` for the commands with canned rows: `feature <branch|spec:NNN|feature_id>` prints kind, spec, PR state, contributing sessions, tokens by type, main vs subagent, weighted, activity mix and outcomes with `tasks: n/a` for a no-spec feature; a reused branch name shows the open feature and `--all` lists all; `features --kind no-spec` filters and ends with a `no feature` row; `sessions --feature f` shows attributed beside total tokens; `trend --by feature`; `compare branch:a spec:105`.
  - **Scenarios covered**: US3-AC3, US3-AC5, US3-AC6, US3-AC7; FR-038
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-feature-query.test.mjs` → expected: failing — `cc-usage.mjs: no such command feature`
- [ ] T043 [P] [US3] Extend `infrastructure-as-code/docker/dev-usage/tests/store-contract.test.mjs`: seed three sessions on one feature, one split session, main-branch turns, a no-spec feature and a reused branch; assert `v_feature_totals` equals the sum of attributed turns per feature, `v_no_feature_totals` holds the main turns, and **all features + no feature = all sessions** for every token type (SC-010); `v_feature_efficiency` reports per-task figures only where `tasks_total` is not null and groups by `kind`; `v_weekly_trend` has feature and spec dimensions; `token_weights` upsert by `as_of` changes `v_call_weighted`.
  - **Scenarios covered**: US3-AC3, US3-AC4, US3-AC7, US3-AC9; FR-026, FR-037, FR-039, SC-010
  - **Verify RED**: `MCM_REQUIRE_LIVE_STACK=1 pnpm nx dev-usage-integration infrastructure-as-code` → expected: new cases failing — `relation "usage.v_feature_totals" does not exist`

### Implementation for User Story 3

- [ ] T044 [P] [US3] Implement `scripts/lib/cc-usage/label-activity.mjs` (prerequisite: T038 verified RED).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-label.test.mjs` → expected: 0 failures, 0 skipped
- [ ] T045 [P] [US3] Implement `scripts/lib/cc-usage/attribute-feature.mjs` with the worktree → branch cache in local state (`git -C <worktree> rev-parse --abbrev-ref HEAD`, injected in tests) (prerequisite: T039 verified RED).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-feature-attribution.test.mjs` → expected: 0 failures, 0 skipped
- [ ] T046 [P] [US3] Implement `scripts/lib/cc-usage/resolve-feature-identity.mjs`, including the sweep-time reconciliation (prerequisite: T040 verified RED).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-feature-identity.test.mjs` → expected: 0 failures, 0 skipped
- [ ] T047 [P] [US3] Implement `scripts/lib/cc-usage/collect-feature-outcomes.mjs` on local git and the forge read path of `scripts/lib/forge-credential.mjs` (prerequisite: T041 verified RED).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-outcomes.test.mjs` → expected: 0 failures, 0 skipped
- [ ] T048 [US3] Wire labelling, attribution, identity and outcome collection into parsing and shipping in `scripts/cc-usage.mjs` (turns ship `activity`, `activity_rule`, `areas`, `rereads`, `feature_id`, `attribution_rule`; `features` rows ship before turns; outcomes collected at `SessionEnd` and in sweeps); bump `parser_version`; add the `features` table columns to `privacy-shape.mjs` (depends on T044–T047).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-*.test.mjs` → expected: 0 failures, 0 skipped
- [ ] T049 [US3] Add `features`, `token_weights` and the views `v_session_activity_mix`, `v_feature_totals`, `v_no_feature_totals`, `v_feature_efficiency`, `v_weekly_trend` to `infrastructure-as-code/docker/dev-usage/schema/` (as new ordered files so a deployed database can apply them; document the apply step in the runbook), and the `weights push` command in `scripts/cc-usage.mjs` that upserts `scripts/cc-usage-weights.json` (prerequisite: T043 verified RED).
  - **Verify GREEN**: `MCM_REQUIRE_LIVE_STACK=1 pnpm nx dev-usage-integration infrastructure-as-code` → expected: 0 failures, 0 skipped
- [ ] T050 [US3] Implement `feature`, `features`, `trend --by feature`, the feature/branch forms of `compare`, and `sessions --feature` in `scripts/cc-usage.mjs`; update `.claude/skills/usage/SKILL.md` with when to use them (prerequisite: T042 verified RED; depends on T049).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-feature-query.test.mjs scripts/__tests__/cc-usage-skill.guard.test.mjs` → expected: 0 failures, 0 skipped
- [ ] T051 [US3] Add the Grafana dashboard: a Postgres datasource (role `usage_reader`, password from `DEV_USAGE_READER_PASSWORD`) and a "Claude Code usage" dashboard (weekly trend by activity, feature, spec, area; features table with kind and outcomes; no-feature share; unclassified share) under `infrastructure-as-code/docker/observability/grafana/`, mounted into `otel-lgtm` by `infrastructure-as-code/docker/observability/compose.prod.yaml`, and `DEV_USAGE_READER_PASSWORD` added to the `prod-observability` entry in `infrastructure-as-code/komodo/stacks.toml`.
  - **Type**: Config | **Spec reference**: FR-027, US3-AC9
  - **Done when**: the dashboard JSON parses and references only views; `docker compose -f infrastructure-as-code/docker/observability/compose.prod.yaml config -q` succeeds with dummy env; the restart-policy, port-collision and naming gates exit 0.

**Checkpoint**: feature-level and session-level questions both answerable; conservation holds.

---

## Phase 6: User Story 4 — Evidence-backed recommendations, tracked as experiments (Priority: P4)

**Goal**: findings against the developer's own per-activity baseline, with experiments and
counter-metrics. Rules are active only after two weeks of data; the spec closes on SC-008.

**Independent Test**: quickstart.md §7.

### Tests for User Story 4 (REQUIRED — TDD checkpoint format) ⚠️

- [ ] T052 [P] [US4] Write `scripts/__tests__/cc-usage-rules.test.mjs` for `scripts/lib/cc-usage/efficiency-rules.mjs` (stub first) over canned `v_baseline` / efficiency rows: each metric of FR-028 has a rule; below the rule's minimum sample size, or with under 14 days of data, the result is `not enough data`; above p90 with enough samples a finding is produced with rule, scope, evidence (numbers only), sample size, suggestion, watch metric and a counter-metric (`data-model.md` `findings.watch_metric`, `findings.counter_metric`); `finding_id` is deterministic (`data-model.md` `findings.finding_id`); an accepted finding whose counter-metric worsened becomes `regressed`, one whose watch metric improved with the counter not worse becomes `confirmed` (`data-model.md` `findings.status`).
  - **Scenarios covered**: US4-AC1, US4-AC2, US4-AC4; FR-028–FR-031
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-rules.test.mjs` → expected: every test failing — `Error: not implemented`
- [ ] T053 [P] [US4] Write `scripts/__tests__/cc-usage-findings.test.mjs` for the `findings`, `accept`, `reject` commands with an injected fetch: `findings` lists open findings with sample sizes or `not enough data`; `accept <id>` sets `accepted_at` and the baseline values; `findings --all` shows before/after for both metrics.
  - **Scenarios covered**: US4-AC3; FR-032
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-findings.test.mjs` → expected: failing — `cc-usage.mjs: no such command findings`
- [ ] T054 [P] [US4] Write `scripts/__tests__/cc-usage-statusline.test.mjs`: `statusline` with statusline JSON on stdin stores the latest `rate_limits` in `ratelimits.json`, prints exactly the output of the command in `CC_USAGE_STATUSLINE_NEXT` (or nothing when unset), never exits non-zero, and per-activity limit burn is derived from two successive snapshots.
  - **Scenarios covered**: US4-AC5; FR-033
  - **Verify RED**: `node --test scripts/__tests__/cc-usage-statusline.test.mjs` → expected: failing — `cc-usage.mjs: no such command statusline`
- [ ] T055 [P] [US4] Extend `infrastructure-as-code/docker/dev-usage/tests/store-contract.test.mjs` for `v_baseline`: median, p90 and `n` per activity over a trailing window for seeded turns; `findings` upsert by `finding_id`; `PATCH /findings` can change `status` and `accepted_at`.
  - **Scenarios covered**: US4-AC2, US4-AC3; FR-028, FR-032
  - **Verify RED**: `MCM_REQUIRE_LIVE_STACK=1 pnpm nx dev-usage-integration infrastructure-as-code` → expected: new cases failing — `relation "usage.v_baseline" does not exist`

### Implementation for User Story 4

- [ ] T056 [US4] Implement `scripts/lib/cc-usage/efficiency-rules.mjs` (prerequisite: T052 verified RED).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-rules.test.mjs` → expected: 0 failures, 0 skipped
- [ ] T057 [US4] Add `v_baseline` (and the `findings` table if not already applied) as a new ordered schema file in `infrastructure-as-code/docker/dev-usage/schema/` (prerequisite: T055 verified RED).
  - **Verify GREEN**: `MCM_REQUIRE_LIVE_STACK=1 pnpm nx dev-usage-integration infrastructure-as-code` → expected: 0 failures, 0 skipped
- [ ] T058 [US4] Implement `findings`, `accept`, `reject` in `scripts/cc-usage.mjs`, and the skill guidance for interpreting findings in `.claude/skills/usage/SKILL.md` (prerequisite: T053 verified RED; depends on T056, T057).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-findings.test.mjs scripts/__tests__/cc-usage-skill.guard.test.mjs` → expected: 0 failures, 0 skipped
- [ ] T059 [US4] Implement the opt-in `statusline` command in `scripts/cc-usage.mjs` and document enabling it (with `CC_USAGE_STATUSLINE_NEXT` chaining) in `docs/runbooks/dev-usage.md`; it is **not** added to committed settings (prerequisite: T054 verified RED).
  - **Verify GREEN**: `node --test scripts/__tests__/cc-usage-statusline.test.mjs` → expected: 0 failures, 0 skipped

**Checkpoint**: findings available once the baseline exists.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T060 Run `node scripts/wiki-refresh.mjs --stale` and refresh every page it reports (the `--diff` then edit then `--record` loop of `.claude/skills/wiki-refresh/SKILL.md`), beyond the pages T062–T067 already name.
  - **Done when**: `node scripts/wiki-refresh.mjs --stale` reports nothing and `pnpm nx okf-lint infrastructure-as-code` exits 0.
- [ ] T061 [P] Add the stack's data-tier note to `docs/runbooks/dev-usage.md` (restore drill steps for the dev-usage dump) and link the runbook from `infrastructure-as-code/docker/dev-usage/` with a short `README.md`.
  - **Done when**: both files exist and link each other.
- [ ] T062 [P] Update the published-port enumeration to four ports (add `prod-dev-usage` PostgREST `19040`) in `openwiki/invariants/published-port-reservation.md` (description, lines ~20 and ~37–38, and the compose-file count) and `openwiki/invariants/index.md:9`; this page is canonical-adjacent, so check `openwiki/protected.yaml` fingerprints and record.
  - **Done when**: no "three" port statement remains on either page; `pnpm nx okf-governance infrastructure-as-code` exits 0.
- [ ] T063 [P] Update `docs/runbooks/prod-reboot-resilience.md` — the published-port table at ~86 gains `19040`, the post-reboot checks gain "PostgREST over the tailnet `http://<tailnet-host>:19040` → 401 without a token" and check 9 becomes four ports — then refresh `openwiki/runbooks/prod-reboot-resilience.md` (service and compose-file counts at ~141, ~204, ~427).
  - **Done when**: both files name four ports and eight prod compose files; the wiki page's fingerprint is recorded.
- [ ] T064 [P] Update `docs/runbooks/Server-Setup-Runbook.md`: the ResourceSync stack list (~954), the Backups dump table (~1128–1150, a `dev-usage` row), the published-port survivability list (~1412, a `19040` item) and the stack table (~1431).
  - **Done when**: each of the four places names `prod-dev-usage`/`19040`/the dump, and any wiki page citing this runbook is refreshed (T060).
- [ ] T065 [P] Add `prod-dev-usage` to `openwiki/projects/infrastructure-stacks.md` (stack list ~118, dependency diagram ~128 — no `after` dependency — and the `dev-usage` naming context), refreshing from its sources.
  - **Done when**: the page lists eight stacks and records its fingerprint.
- [ ] T066 [P] Add `MCM_USAGE_INGEST_URL` (forwarded via `${localEnv}`) and `MCM_USAGE_INGEST_TOKEN` (via the env file) to `docs/runbooks/devcontainer.md` (heading at ~141 and the bullets at ~232–245, with "unset → capture spools locally, nothing fails"), then refresh `openwiki/runbooks/devcontainer.md` (~166, ~202).
  - **Done when**: both pages list the two variables and the wiki fingerprint is recorded.
- [ ] T067 [P] Add `MCM_USAGE_INGEST_TOKEN` to the credential lists in `docs/runbooks/devcontainer-sandbox.md` (~170–172, ~691, ~766 example), then refresh `openwiki/runbooks/devcontainer-sandbox.md` (~234) and `openwiki/projects/repository.md` (~724–732).
  - **Done when**: the three lists name the token and both wiki fingerprints are recorded.
- [ ] T068 **Close-out re-search**: re-run every T002 search; every hit in a document that states current procedure now reflects four ports, eight prod compose files, the `prod-dev-usage` stack, the new backup step and the two new variables, or is justified in this task.
  - **Done when**: this task lists the re-run command and one line per remaining hit with its disposition.
- [ ] T069 Run the gates the diff touches (AGENTS.md "run the tiers your diff touches"): `node --test scripts/__tests__/*.test.mjs` (watch the skip count), `MCM_REQUIRE_LIVE_STACK=1 pnpm nx dev-usage-integration infrastructure-as-code`, `node scripts/cc-usage.mjs oracle-check`, `pnpm nx okf-lint infrastructure-as-code`, `pnpm nx okf-governance infrastructure-as-code`, `node scripts/check-resource-naming.mjs`, `node scripts/check-prod-restart-policy.mjs`, `node scripts/check-prod-ci-port-collision.mjs`, then the cheap pre-push target of `infrastructure-as-code/project.json`; record `pnpm nx show projects --affected` to confirm no app project is affected (so the consuming-app E2E regression is not in scope — this feature touches no app code; if any app project appears, run its E2E per `openwiki/invariants/feature-validation-checklist.md`).
  - **Done when**: every command exits 0 with 0 skipped, and the affected-project list is recorded here.
- [ ] T070 Run quickstart.md §1–§3 in the worktree, and §4–§6 after the stack is deployed and the env is set (operator steps in `docs/runbooks/dev-usage.md`).
  - **Done when**: each section's expected outcome is observed and noted here with the date.
- [ ] T071 **Open the PR** from a real branch (`git push origin HEAD:105-cc-token-usage-capture`, then `node scripts/forge-pr.mjs open`, per `docs/runbooks/ci-diagnostics.md`). Tick this task in the branch's LAST commit and quote the branch, the PR number and that commit's sha. CI evidence is never recorded here: the run ids, the `ci-status.mjs` verdict and the merge sha go in the PR's closing comment, posted with `MCM_FORGE_ISSUE_TOKEN`.
- [ ] T072 After two weeks of captured data: run `findings`, accept at least one, and after further sessions confirm its before/after (SC-008). Record the finding id and dates in the PR's closing comment or a follow-up backlog item; the spec's status moves to Done only then.
  - **Done when**: SC-008 is met and recorded.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 first (its results may adjust the contracts); T003–T005 in parallel after it.
- **Foundational (Phase 2)**: depends on T003; blocks every story.
- **US1 (Phase 3)**: depends on Phase 2. It is the MVP and should be merged and deployed first so data accumulates.
- **US2 (Phase 4)**: depends on Phase 2 and on US1's local state (T020) and schema views (T025); independently testable with canned rows.
- **US3 (Phase 5)**: depends on Phase 2 and US1 (shipping, schema). T048 changes `cc-usage.mjs` after US2's commands exist — run after T036 to avoid edit conflicts.
- **US4 (Phase 6)**: depends on US3 (activity labels and feature outcomes feed the baselines); its rules are inert until 14 days of data exist.
- **Polish (Phase 7)**: doc tasks T062–T067 can run any time after T027/T029; T068–T071 last; T072 after the baseline.

### Within Each User Story

- Test tasks verified RED before their paired implementation; implementation verified GREEN.
- Pure modules before the CLI wiring that uses them; schema before the views' integration cases.

### Parallel Opportunities

- T003, T004, T005 together.
- T006, T008, T010 together (different test files and modules).
- All US1 test tasks T012–T019 together; then T020 → T021 → T022 in sequence, with T023–T030 in parallel where files differ (T026/T027 sequential).
- US2 tests T031–T034 together.
- US3 tests T038–T043 together; implementations T044–T047 together.
- US4 tests T052–T055 together.
- Doc tasks T062–T067 together.

## Parallel Example: User Story 3

```bash
# Tests, all at once:
Task: "Write cc-usage-label.test.mjs (T038)"
Task: "Write cc-usage-feature-attribution.test.mjs (T039)"
Task: "Write cc-usage-feature-identity.test.mjs (T040)"
Task: "Write cc-usage-outcomes.test.mjs (T041)"

# Pure modules, all at once once RED is confirmed:
Task: "Implement label-activity.mjs (T044)"
Task: "Implement attribute-feature.mjs (T045)"
Task: "Implement resolve-feature-identity.mjs (T046)"
Task: "Implement collect-feature-outcomes.mjs (T047)"
```

---

## Implementation Strategy

### MVP first (User Story 1)

1. Phase 1 (spike, sweep, fixtures) → Phase 2 (parser, privacy, oracle).
2. Phase 3 (US1): capture, store, plumbing, runbook.
3. **Stop and validate**: quickstart §1–§4; merge; deploy `prod-dev-usage`; set the env. Data now accumulates — the clock for US4's baseline starts here.

### Incremental delivery

US2 → US3 → US4 each as its own increment, validated by its quickstart section. Per
`openwiki/process/pull-request-batching.md`, split into separate PRs only where a failure would be
ambiguous; US1 is the natural first PR because deploying it starts the baseline.

---

## Completion Checklist

Before marking `105-cc-token-usage-capture` complete, verify every success criterion from [spec.md](spec.md):

- [ ] **SC-001**: after a week, 100% of dev-container sessions in the store; `doctor` shows nothing unshipped older than a day
- [ ] **SC-002**: parser totals match the reference tool exactly on the fixtures (`oracle-check`)
- [ ] **SC-003**: overlapping capture runs give the same rows and totals as one serial run (T016)
- [ ] **SC-004**: no shipped record contains content, verified on every change (T008 in CI)
- [ ] **SC-005**: no visible output; a non-shipping end-of-turn hook < 1 s (T014, plus `stop_hook_summary` durations live)
- [ ] **SC-006**: "this session so far" in one request, < 5 s, store reachable or not
- [ ] **SC-007**: ≤ 10% of turns by weighted tokens unclassified after the baseline
- [ ] **SC-008**: first findings report with evidence and sample size; one accepted change tracked with before/after (T072)
- [ ] **SC-009**: history survives a container rebuild and a sandbox removal
- [ ] **SC-010**: feature totals = sum of attributed turns; all features + no feature = all sessions (T043)
- [ ] **SC-011**: 100% of worktree turns attributed to that worktree's feature on the fixtures, including main-checkout sessions; no-spec features listed (T039, T042)
- [ ] Platform parity table — N/A: no UI surface (developer tooling)
- [ ] All test tasks used the TDD checkpoint format (Verify RED confirmed before implementation)
- [ ] `node --test scripts/__tests__/*.test.mjs` — 0 failures, 0 skipped
- [ ] `MCM_REQUIRE_LIVE_STACK=1 pnpm nx dev-usage-integration infrastructure-as-code` — 0 failures, 0 skipped
- [ ] Repository gates (T069) exit 0; `okf-lint` and `okf-governance` exit 0
- [ ] Consuming-app E2E regression — N/A unless `nx show projects --affected` lists an app project (T069 records it)
- [ ] `rtk gain` — >80% token compression confirmed (run last)

## Notes

- Requirement ids appear only in task text and comments, never in identifiers (constitution).
- Commit after each task or logical group, from the worktree; push before any container rebuild.
