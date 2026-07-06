---
description: "Task list for feature 029 — prod/CI shared-host port isolation + Keycloak DB-network resilience"
---

# Tasks: Prod/CI Shared-Host Port Isolation & Keycloak DB-Network Resilience

**Input**: Design documents from `specs/029-prod-ci-port-isolation/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: TDD mandatory. The **collision gate is a genuine RED→GREEN test** (RED on today's tree: prod 8099/3030/3002 overlap CI; GREEN after the port move) with a `--selftest`. Compose/network/workflow changes are verified by `docker compose config` renders + grep + workflow-structure assertions. US2/US4 behavioral acceptance is the operator/CI validation in quickstart §D/§E.

**Organization**: Grouped by user story (US1 port partition, US2 DB-net, US3 gate, US4 CI teardown). Note the deliberate ordering nuance: the **gate (US3) is written first** so it serves as US1's RED→GREEN oracle.

## Platform Parity Table

Infrastructure-as-code + tooling feature — **no Frontend App, no web/mobile E2E scenario**. The constitution's Platform Parity Table is scoped to frontend features; nothing to parity-test here.

| Test Scenario | Web (Playwright) | Mobile (Maestro) | Justification |
| --- | --- | --- | --- |
| prod↔CI port-collision gate | N/A | N/A | Node gate over compose files; no UI. |
| prod admin ports → 19000–19099 | N/A | N/A | `docker compose config` assertion; host-networking. |
| keycloak-network compose-managed | N/A | N/A | `docker compose config` declaration check. |
| CI app-e2e teardown | N/A | N/A | Workflow-structure assertion; observed on a real CI run. |
| Redeploy survives CI Keycloak up (US1/US2 e2e) | N/A | N/A | Operator clean Komodo redeploy (quickstart §D); not CI/UI-testable. |

## Path Conventions

Paths under `infrastructure-as-code/docker/`, `scripts/`, `.forgejo/workflows/`, `docs/runbooks/`. Scratch render env: `C:\Users\Steve\AppData\Local\Temp\claude\...\scratchpad\` (never committed).

---

## Phase 1: Setup

- [X] T001 Create throwaway placeholder env files in the scratchpad (`keycloak.env`, `observability.env`) covering every `${VAR:?}` in `keycloak/compose.prod.yaml` + `observability/compose.prod.yaml` (reuse feature 028's; add nothing secret), for `docker compose config` renders. Never tracked in git.
- [X] T002 [P] Baseline gate run — `node scripts/check-topology-scrub.mjs`, `check-komodo-sync.mjs`, `secret-scan.mjs`, `check-no-inline-secrets.mjs`, `check-resource-naming.mjs` all exit 0 (green start).

---

## Phase 2: Foundational (Blocking Prerequisite)

**Purpose**: Establish the authoritative CI/dev port inventory the gate + port choice depend on.

- [X] T003 Confirm the CI/dev published-host-port set from `infrastructure-as-code/docker/stacks/*.compose.yaml` + `infrastructure-as-code/docker/*/compose.yaml` + `keycloak/compose.ci.yaml` (research R2 lists it: 101,1025,3001,3002,3030,4242,4317,4318,5432,6379,8025,8081,8082,8099,8123,8181,8200,8443,9000,9200,27017,27018) and re-verify `19000–19099` is disjoint. Record any drift in the PR.

**Checkpoint**: prod-reserved range validated → US work can begin.

---

## Phase 3: User Story 3 - Collision gate (Priority: P2, built FIRST as US1's oracle) 🎯

**Goal**: A gate that fails on any prod↔CI/dev published-host-port overlap, doubling as US1's RED→GREEN test.

**Independent Test**: `--selftest` detects a planted overlap + passes a disjoint sample; scan fails on today's tree (8099/3030/3002 overlap) and will pass after US1.

### Implementation for User Story 3

- [X] T004 [US3] Write `scripts/check-prod-ci-port-collision.mjs` (style of the other `check-*.mjs`: `--selftest` + scan; exit 0 clean / 1 collision / 2 bad args). Prod set = published host-ports in `infrastructure-as-code/docker/*/compose.prod.yaml`; CI/dev set = published host-ports in `stacks/*.compose.yaml` + `*/compose.yaml` + `keycloak/compose.ci.yaml`. Parse `H:C`, `IP:H:C`, bare `H`, strip `/proto`, ignore `${VAR}`-only host-IP prefixes, skip all-`${VAR}` entries (data-model E2 rules). Fail (exit 1) if the sets intersect, printing each colliding port + a prod file + a CI file. `--selftest`: planted `19099` overlap detected AND disjoint sample clean. Spec-ID provenance comment (FR-006, INV-5..INV-8).
- [X] T005 [US3] **Verify RED (also proves US1's bug)** — run `node scripts/check-prod-ci-port-collision.mjs`; expected **exit 1** naming `8099` (and `3030`,`3002`) as prod↔CI collisions on today's tree. Run `--selftest`; expected exit 0 (detector correct).

**Checkpoint**: gate exists and correctly RED on the current (pre-move) tree.

---

## Phase 4: User Story 1 - Partition prod admin ports off CI (Priority: P1) 🎯 MVP

**Goal**: Move the three prod admin ports into `19000–19099` so a prod redeploy never contends with CI for a host port.

**Independent Test**: gate goes GREEN; `docker compose config` renders `19099/19030/19002` on `0.0.0.0`; no old ports remain.

### Implementation for User Story 1

- [X] T006 [P] [US1] Edit `infrastructure-as-code/docker/keycloak/compose.prod.yaml` — change the admin port bind `"8099:8080"` → `"19099:8080"`. Update the adjacent `#PROD` comment: prod-reserved port (shared-host CI-collision fix, feature 029); still `0.0.0.0`, tailnet-only via ufw.
- [X] T007 [P] [US1] Edit `infrastructure-as-code/docker/observability/compose.prod.yaml` — `"3030:3000"`→`"19030:3000"` (LangFuse) and `"3002:3000"`→`"19002:3000"` (Grafana/otel-lgtm); update the two `#PROD` comments + the header networking note to cite the prod-reserved range + the CI-collision reason.
- [X] T008 [US1] Edit `infrastructure-as-code/docker/keycloak/.env.prod.example` — update the `KC_HOSTNAME_ADMIN` example/comment to the `:19099` admin port (e.g. `http://prod-host.tailnet.ts.net:19099`); note the operator must set the real `.env.prod` to `:19099`. Do not touch the public `KC_HOSTNAME`.
- [X] T009 [US1] **Verify GREEN** — (a) `node scripts/check-prod-ci-port-collision.mjs` → **exit 0** ("no prod↔CI port collisions"). (b) `docker compose config` for both stacks (with scratch env-files) renders `19099:8080`, `19030:3000`, `19002:3000` each with empty HostIp (0.0.0.0). (c) grep guard: `grep -REn '"(8099|3030|3002):' infrastructure-as-code/docker/*/compose.prod.yaml` → 0 matches. (d) confirm public `KC_HOSTNAME` issuer unchanged (SC-006).

**Checkpoint**: US1 complete — prod admin ports no longer collide with CI; gate GREEN.

---

## Phase 5: User Story 2 - Keycloak always reaches its DB on recreate (Priority: P1)

**Goal**: Make `keycloak-network` compose-managed so the identity service always reaches its Postgres even if external nets race on recreate.

**Independent Test**: `docker compose config` shows `keycloak-network` without `external: true`, both keycloak services attached; `backend-network`/`edge-network` stay external.

### Implementation for User Story 2

- [X] T010 [US2] Edit `infrastructure-as-code/docker/keycloak/compose.prod.yaml` top-level `networks:` — remove `external: true` from `keycloak-network` (make it compose-managed; do NOT add a `name:` override — adopting the old unlabeled external net errors). Keep `backend-network` + `edge-network` `external: true`. Add a comment: intra-stack DB link is stack-owned so keycloak↔postgres is attached atomically on every up (feature 029, INV-9..INV-13); the old external `keycloak-network` is pruned at cutover (runbook).
- [X] T011 [US2] **Verify** — `docker compose -f keycloak/compose.prod.yaml --env-file <scratch>/keycloak.env config`: (a) `keycloak-network` has **no** `external: true`; (b) both `keycloak-service` and `keycloak-store-postgres` list `keycloak-network`; (c) `backend-network` + `edge-network` still `external: true`; (d) the `keycloak-store-postgres-data` volume is still `external` (data preserved, INV-12).

**Checkpoint**: US2 complete — DB link is stack-owned.

---

## Phase 6: User Story 4 - CI always tears down its stacks (Priority: P2)

**Goal**: `app-e2e` removes every stack it started, even on failure/cancel, so no leftover CI stack holds a host port.

**Independent Test**: workflow has a final `app-e2e` step `if: ${{ always() }}` tearing down auth/mcm/agent projects; observed leaving zero CI stacks on the next run.

### Implementation for User Story 4

- [X] T012 [US4] Edit `.forgejo/workflows/app-ci.yml` `app-e2e` job — add a final step `name: Tear down CI stacks (always)` with `if: ${{ always() }}` running `docker compose -p <project> down -v --remove-orphans` for each stack the job brought up (mirror the "Bring up … auth stack" + "Bring up containerized agent gateway + MCP" invocations — auth, mcm, and the agent gateway/MCP project). Provenance comment: FR-011 (leftover CI stack held prod's 8099 for 6h, 2026-07-06).
- [X] T013 [US4] **Verify (static)** — the new step exists after the E2E steps, has `if: ${{ always() }}`, and its `down` project names + compose files match the bring-up steps exactly (no typo'd project name → a real teardown). Confirm YAML parses.

**Checkpoint**: US4 complete — CI teardown is unconditional.

---

## Phase 7: Polish & Cross-Cutting

- [X] T014 [P] Wire the gate into CI — edit `.forgejo/workflows/guardrails.yml` to run `node scripts/check-prod-ci-port-collision.mjs --selftest` then `node scripts/check-prod-ci-port-collision.mjs` in the job that runs the other `check-*.mjs` gates (FR-007, SC-004).
- [X] T015 [P] Update `docs/runbooks/prod-reboot-resilience.md` — replace the keycloak `8099`/`0.0.0.0` bind story with the prod-reserved-port model (Part 2a): the shared-host CI-collision root cause, the `19000–19099` range + the three new ports, the `KC_HOSTNAME_ADMIN :19099`, the `keycloak-network`→compose-managed change + the `docker network rm keycloak-network` cutover step, and a pointer to the collision gate. Placeholders only (topology-scrub clean).
- [X] T016 Run ALL gates (`--selftest` then scan) — topology-scrub, komodo-sync, secret-scan, no-inline-secrets, resource-naming, **prod-ci-port-collision** — every one `✅` exit 0 (SC-005/SC-007).
- [X] T017 Re-run quickstart tiers A (gate RED→GREEN), B (both compose renders + guards) — all green.
- [X] T018 Open a PR from `029-prod-ci-port-isolation` to `main` on the `origin` (Forgejo) remote, not the GitHub mirror. PR body: the outage root cause (028 `0.0.0.0:8099` vs CI `127.0.0.1:8099` on the shared host), the four changes, the T003 CI-port drift result, and a **prominent operator note**: after merge + Komodo sync, do the clean `prod-auth` destroy → `docker network rm keycloak-network` → redeploy (quickstart §D); until then prod keycloak runs via a manual network re-attach and MUST NOT be redeployed. No web E2E (no dev/app runtime changed; app-ci `app-e2e` still runs the containerized suite via the paths gate since `.forgejo/workflows/**` is now in its pull_request paths).

---

## Dependencies & Execution Order

- **Setup (P1)** → **Foundational (P2, T003)** → stories.
- **US3 gate (T004–T005) FIRST** — it's US1's RED→GREEN oracle. US1 (T006–T009) depends on the gate existing to verify GREEN.
- **US2 (T010–T011)** independent of US1/US3 (different concern in the same keycloak file — sequence T006 then T010 to avoid edit overlap, or do T010 in the same pass).
- **US4 (T012–T013)** fully independent (`app-ci.yml`).
- **Polish (T014–T018)** after the stories.

### Within stories

- Gate written (T004) → RED verified (T005) → ports moved (T006–T008) → GREEN verified (T009).
- Same-file note: T006 and T010 both edit `keycloak/compose.prod.yaml` (ports vs networks) → run sequentially, not `[P]` with each other.

### Parallel Opportunities

- T006 (keycloak ports) ‖ T007 (observability ports) — different files.
- T014 (guardrails wire) ‖ T015 (runbook) — different files.
- US4 (app-ci.yml) can proceed in parallel with US1/US2/US3 (disjoint file).

---

## Implementation Strategy

### MVP (US1 + US2 — both P1)

1. Setup + Foundational (CI-port inventory).
2. US3 gate (oracle) → US1 port move (gate GREEN) → US2 DB-net.
3. **STOP & VALIDATE**: quickstart A + B locally.

### Incremental

1. Gate (US3) → makes the collision measurable + enforced.
2. US1 → the outage's structural fix (no port contention).
3. US2 → the independent DB-net resilience.
4. US4 → CI hygiene (removes the common trigger).
5. Polish: wire gate + runbook + PR → operator clean redeploy is the end-to-end acceptance.

---

## Notes

- The gate is BOTH the US3 deliverable and US1's TDD oracle — write it first, watch it go RED (8099/3030/3002) then GREEN (19099/19030/19002).
- No secrets/topology literals; scratch render env only in scratchpad; runbook uses placeholders.
- **Operator gate**: prod keycloak is live via a manual network re-attach — do NOT redeploy `prod-auth` until this merges; then follow quickstart §D (includes `docker network rm keycloak-network`).
- Commit per story; keep the runbook update (T015) reflecting final port numbers.
