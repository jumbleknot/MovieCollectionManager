---
description: "Task list for feature 028 — prod reboot-resilience follow-ups"
---

# Tasks: Prod Reboot-Resilience Follow-ups

**Input**: Design documents from `specs/028-prod-reboot-resilience/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: TDD is mandatory (constitution). The entrypoint fix (US2) has a genuine RED→GREEN shell unit test. US1/US3 are configuration changes whose RED→GREEN is a `grep` guard + `docker compose config` structural render (a config change has no unit-test seam, but it is still verifiable RED-before / GREEN-after). US4 is documentation (no RED/GREEN).

**Organization**: Grouped by user story (from spec.md) for independent implementation and testing.

## Platform Parity Table

This feature touches **no Frontend App** and adds **no web/mobile E2E scenario** — it is infrastructure-as-code (prod Docker Compose + a Mongo entrypoint shell script + an operator runbook). The constitution's Platform Parity Table requirement is scoped to frontend features; there is nothing to parity-test across web/mobile here.

| Test Scenario | Web (Playwright) | Mobile (Maestro) | Justification |
| --- | --- | --- | --- |
| Entrypoint keyfile idempotency | N/A | N/A | POSIX-sh unit test (`mongo-entrypoint.test.sh`); no UI surface. |
| Tailnet-IP → 0.0.0.0 port binds | N/A | N/A | `docker compose config` structural assertion; host-networking, no UI. |
| Keycloak backend-network attach | N/A | N/A | `docker compose config` declaration check; no UI. |
| Reboot recovery (US1–US3 end-to-end) | N/A | N/A | Operator validation reboot (quickstart §D); not CI/UI-testable. |

## Path Conventions

Infrastructure-as-code feature — paths under `infrastructure-as-code/docker/` and `docs/runbooks/`. Scratchpad for throwaway render env: `C:\Users\Steve\AppData\Local\Temp\claude\...\scratchpad\` (never committed).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the render/verification harness used by later phases.

- [X] T001 Create throwaway placeholder env files for `docker compose config` rendering of the two edited prod stacks in the scratchpad dir (one per stack: `keycloak.env`, `observability.env`), populating every `${VAR:?}` referenced in `infrastructure-as-code/docker/keycloak/compose.prod.yaml` and `infrastructure-as-code/docker/observability/compose.prod.yaml` with dummy non-secret placeholder values (e.g. `BASE_DOMAIN=example.com`, passwords = `x`, `TS_ADMIN_IP`/`KC_ADMIN_BIND_IP` unset/omitted). These files are never tracked in git.
- [X] T002 [P] Baseline gate run — execute `node scripts/check-topology-scrub.mjs`, `node scripts/check-komodo-sync.mjs`, `node scripts/secret-scan.mjs`, `node scripts/check-no-inline-secrets.mjs`, `node scripts/check-resource-naming.mjs` on the current tree and confirm all exit 0 (green starting point, so any later failure is attributable to this feature's edits).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Confirm the reboot-recovery invariant that underpins every user story — every prod service auto-restarts.

**⚠️ CRITICAL**: Establishes SC-007 (restart-policy coverage) before any change.

- [X] T003 Verify restart-policy coverage — run `grep -REl 'services:' infrastructure-as-code/docker/*/compose.prod.yaml` then confirm every service in every `compose.prod.yaml` declares `restart: unless-stopped` (no gaps). Record the result in the PR description. Expected: zero gaps (research R5). If a gap is found, add `restart: unless-stopped` to that service.

**Checkpoint**: Recovery baseline confirmed — user story work can begin.

---

## Phase 3: User Story 1 - Admin & observability UIs reachable after reboot (Priority: P1) 🎯 MVP

**Goal**: Convert the three tailnet-IP-scoped published ports to `0.0.0.0` binds so they still bind when the rootless daemon starts before `tailscaled`, while staying tailnet-only via ufw.

**Independent Test**: `docker compose config` for both edited stacks renders the three target ports with an empty/`0.0.0.0` HostIp and no unresolved var; a grep guard finds no `${...IP...}:` bind prefix anywhere under `infrastructure-as-code/docker/`.

### Tests for User Story 1 (RED first) ⚠️

- [X] T004 [US1] **Verify RED** — run `grep -REn '\$\{(KC_ADMIN_BIND_IP\|TS_ADMIN_IP)[^}]*\}:' infrastructure-as-code/docker` and confirm it currently matches the 3 bind lines (keycloak:49, observability:38, observability:224). This is the pre-change state the fix must eliminate. Expected: 3 matches.

### Implementation for User Story 1

- [X] T005 [P] [US1] Edit `infrastructure-as-code/docker/keycloak/compose.prod.yaml` — change the Keycloak admin port bind (line ~49) from `"${KC_ADMIN_BIND_IP:?...}:8099:8080"` to `"8099:8080"`. Update the adjacent `#PROD` comment to state the bind is `0.0.0.0` and stays tailnet-only via the host ufw default-deny (record the ufw dependency, FR-003).
- [X] T006 [P] [US1] Edit `infrastructure-as-code/docker/observability/compose.prod.yaml` — change the LangFuse web bind (line ~38) from `"${TS_ADMIN_IP:?...}:3030:3000"` to `"3030:3000"` and the Grafana/otel-lgtm bind (line ~224) from `"${TS_ADMIN_IP:?...}:3002:3000"` to `"3002:3000"`. Update the two `#PROD` comments + the file header networking note (lines ~9–15) to describe the `0.0.0.0`-bind + ufw posture instead of the tailnet-IP bind.
- [X] T007 [US1] Prune the now-orphaned `KC_ADMIN_BIND_IP` entry (and its comment) from `infrastructure-as-code/docker/keycloak/.env.prod.example` (research R2 — the admin *URL* uses the separate `KC_HOSTNAME_ADMIN`, which stays). Do not touch `KC_HOSTNAME_ADMIN`, `TS_ADMIN_IP` (no example file), or any Komodo Variable.

### Verification for User Story 1 (GREEN)

- [X] T008 [US1] **Verify GREEN** — (a) re-run the T004 grep; expected: **0 matches**. (b) `docker compose -f infrastructure-as-code/docker/keycloak/compose.prod.yaml --env-file <scratch>/keycloak.env config` renders `8099:8080` with empty HostIp; (c) `docker compose -f infrastructure-as-code/docker/observability/compose.prod.yaml --env-file <scratch>/observability.env config` renders `3030:3000` and `3002:3000` with empty HostIp; (d) all three renders succeed with no unresolved-variable error.

**Checkpoint**: US1 complete — the three admin/observability ports bind independently of tailnet-IP timing.

---

## Phase 4: User Story 2 - Data service auto-recovers on container restart (Priority: P1)

**Goal**: Make `mongo-entrypoint.sh` idempotent so a restart over a leftover `0400` keyfile succeeds instead of crash-looping.

**Independent Test**: `mongo-entrypoint.test.sh` passes: fresh run creates the keyfile; a run over a pre-seeded `0400` file succeeds; two consecutive runs both exit 0; unset `MONGO_MC_KEYFILE` still fails fast.

### Tests for User Story 2 (RED first) ⚠️

- [ ] T009 [US2] Write `infrastructure-as-code/docker/mc-service/mongo-entrypoint.test.sh` — a POSIX-sh test that drives the real `mongo-entrypoint.sh` with `MONGO_MC_KEYFILE=testcontent`, `MONGO_KEYFILE_PATH=$tmpfile`, and `true` as the exec target (append `true` as the passed command). Cases: (1) fresh path → exit 0, file exists mode 0400; (2) **restart over a pre-created `0400` file at `$tmpfile` → exit 0** (the bug case); (3) two consecutive runs both exit 0; (4) unset `MONGO_MC_KEYFILE` → non-zero exit with the fail-fast message. Include a spec-ID provenance comment (FR-004/FR-005, INV-5..INV-8). **Verify RED**: run it against the current (unfixed) `mongo-entrypoint.sh`; expected: case (2) FAILS with `Permission denied` / non-zero exit.

### Implementation for User Story 2

- [ ] T010 [US2] Edit `infrastructure-as-code/docker/mc-service/mongo-entrypoint.sh` — insert `rm -f "$KEYFILE_PATH"` immediately before the `( umask 377; ... )` write (after the `mkdir -p`). Add a one-line comment: idempotency for plain restarts (a leftover `0400` file cannot be reopened for write; `rm -f` needs only dir write perm) — FR-004.

### Verification for User Story 2 (GREEN)

- [ ] T011 [US2] **Verify GREEN** — run `bash infrastructure-as-code/docker/mc-service/mongo-entrypoint.test.sh`; expected: all cases pass, final `OK`. Mark both shell files executable for the Linux runner/host via `git update-index --chmod=+x infrastructure-as-code/docker/mc-service/mongo-entrypoint.test.sh` (the script itself is already `chmod +x` in git; confirm with `git ls-files -s`) — Windows-authored files lose the +x bit otherwise (project lesson).

**Checkpoint**: US2 complete — the Mongo data store survives restarts without a crash-loop.

---

## Phase 5: User Story 3 - Auth service retains backend connectivity after reboot (Priority: P2)

**Goal**: Confirm `keycloak-service` durably attaches to `backend-network`; document the operator redeploy as the durable remediation.

**Independent Test**: `docker compose config` for `prod-auth` shows `keycloak-service` on `backend-network` (external); the runbook records the redeploy step.

### Verification for User Story 3

- [ ] T012 [US3] **Verify (no code change expected)** — run `docker compose -f infrastructure-as-code/docker/keycloak/compose.prod.yaml --env-file <scratch>/keycloak.env config` and confirm `keycloak-service.networks` includes `backend-network` and the top-level `networks.backend-network.external: true` (research R4, INV-10). If — and only if — the attachment is missing, add `backend-network` to `keycloak-service.networks`. Record the finding.
- [ ] T013 [US3] Capture the durable remediation text (a Komodo `prod-auth` redeploy recreates the container with the full declared network set, replacing the temporary manual `docker network connect`) for inclusion in the runbook (feeds T014). No repo file other than the runbook changes for this story.

**Checkpoint**: US3 complete — backend-network attachment verified durable + documented.

---

## Phase 6: User Story 4 - Reboot-resilience runbook (Priority: P3)

**Goal**: One authoritative operator runbook covering host-side + repo-side recovery controls and a validation-reboot checklist.

**Independent Test**: A reviewer can follow the runbook end-to-end and execute the validation-reboot checklist without external context; it contains no real topology/secret literal.

### Implementation for User Story 4

- [ ] T014 [US4] Write `docs/runbooks/prod-reboot-resilience.md` covering: (1) the already-completed host-side fixes — graceful-shutdown drain unit, expanded DB backup coverage, UPS/NUT (documented, not implemented here); (2) the repo-side fixes in this feature (US1 `0.0.0.0` binds + the ufw-default-deny dependency; US2 entrypoint idempotency); (3) the US3 `prod-auth` Komodo redeploy step (from T013), explicitly replacing the manual `docker network connect`; (4) an optional defense-in-depth note on the host systemd `After=tailscaled.service` ordering; (5) the note that `KC_ADMIN_BIND_IP` is retired and `TS_ADMIN_IP` may be retired as a Komodo Variable; (6) the single validation-reboot checklist (mirror quickstart §D table with an explicit pass/fail per SC-001..SC-004, SC-007). Use placeholders only (`<tailnet-host>`, `${BASE_DOMAIN}`, `100.x.y.z`) — INV-15.
- [ ] T015 [P] [US4] Add a one-line pointer to `docs/runbooks/prod-reboot-resilience.md` from the runbook index / the CLAUDE.md "Local Dev Infrastructure" or "CI/CD" area if a runbook list exists there (keep it discoverable; do not duplicate content).

**Checkpoint**: US4 complete — recovery posture is documented and repeatable.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Full verification and delivery.

- [ ] T016 [P] Run all five gate scripts with `--selftest` then plain (`check-topology-scrub`, `check-komodo-sync`, `secret-scan`, `check-no-inline-secrets`, `check-resource-naming`); expected: every gate `✅`, exit 0, zero findings (SC-005). Pay special attention that the new runbook trips none.
- [ ] T017 [P] Re-run the full quickstart verification tiers A (`mongo-entrypoint.test.sh`), B (both compose renders + grep guards), C (gates) — all green.
- [ ] T018 Web E2E regression — **DECIDED: skip, with justification** (maintainer approved 2026-07-05). This feature changes **no** dev/app runtime (no BFF or mc-service image, no `compose.yaml`; only prod `compose.prod.yaml` port binds, the prod Mongo entrypoint, and docs), so the dev-path web E2E would exercise entirely unchanged behavior with no container to rebuild. Do **not** run `pnpm nx e2e mcm-app`. Record this justification explicitly in the PR body (constitution Final Validation Checklist deviation, documented rationale).
- [ ] T019 Open a PR from `028-prod-reboot-resilience` to `main` on the `origin` (Forgejo) remote, not the GitHub mirror (`guardrails*` + `app-ci*` checks) via the GCM-credential API call in CLAUDE.md. PR body: summary of US1–US4, the T003 restart-policy result, the T012 backend-network finding, the T018 E2E decision, and a note that the operator performs the single validation reboot (quickstart §D) after merge + Komodo sync.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately.
- **Foundational (Phase 2)**: after Setup — establishes the restart-policy invariant; blocks nothing structurally but should precede the changes.
- **User Stories (Phase 3–6)**: after Setup. US1, US2, US3 are fully independent (different files). US4 depends on US1/US2/US3 findings (T013 → T014) for its content, so run it last among the stories.
- **Polish (Phase 7)**: after all desired stories complete.

### User Story Dependencies

- **US1 (P1)**: independent — touches `keycloak/compose.prod.yaml`, `observability/compose.prod.yaml`, `keycloak/.env.prod.example`.
- **US2 (P1)**: independent — touches `mc-service/mongo-entrypoint.sh` (+ new test).
- **US3 (P2)**: independent — verification of `keycloak/compose.prod.yaml` (read-only unless a gap is found).
- **US4 (P3)**: depends on US1–US3 outcomes for accurate documentation (soft dependency).

### Within Each User Story

- Tests/guards written and verified RED before the change (US1 T004→T005–7→T008; US2 T009→T010→T011).
- Config edits before their compose-config verification.

### Parallel Opportunities

- T005 and T006 (different compose files) run in parallel.
- US1, US2, US3 can proceed in parallel (disjoint files) once Setup is done.
- T016 and T017 (independent verification passes) run in parallel.

---

## Parallel Example: User Story 1

```bash
# After T004 (Verify RED), edit the two compose files in parallel:
Task: "Edit keycloak/compose.prod.yaml — 8099 bind → 0.0.0.0"       # T005
Task: "Edit observability/compose.prod.yaml — 3030 + 3002 → 0.0.0.0" # T006
```

---

## Implementation Strategy

### MVP First (US1 + US2 — both P1)

1. Phase 1 Setup → Phase 2 Foundational (restart-policy confirmed).
2. US1 (reachable UIs) + US2 (no data-store crash-loop) — the two P1 stories are the functional core of hands-off recovery.
3. **STOP and VALIDATE**: run quickstart tiers A + B locally.

### Incremental Delivery

1. Setup + Foundational → baseline confirmed.
2. US1 → verify (compose render) → the admin/observability UIs are reboot-safe.
3. US2 → verify (shell test) → the data store is restart-safe.
4. US3 → verify (declaration) → auth-network durability confirmed.
5. US4 → the runbook ties it together for the operator's validation reboot.

---

## Notes

- [P] = different files, no dependencies.
- TDD: US2 has a real RED→GREEN unit test; US1/US3 use grep + `docker compose config` as their RED→GREEN (a config change has no unit seam).
- No secrets/topology literals in any tracked file — the throwaway render env lives only in scratchpad; the runbook uses placeholders.
- Behavioral acceptance (US1–US3 end-to-end) is the operator's single validation reboot after merge + Komodo sync — not CI-runnable by design (research R7).
- Commit after each story; keep US4 last so the runbook reflects final findings.
