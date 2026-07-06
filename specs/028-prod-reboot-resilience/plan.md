# Implementation Plan: Prod Reboot-Resilience Follow-ups

**Branch**: `028-prod-reboot-resilience` | **Date**: 2026-07-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/028-prod-reboot-resilience/spec.md`

## Summary

Land the remaining repo/deploy-side fixes so the rootless-Docker prod homelab recovers hands-off after a host reboot, and survives every Komodo ResourceSync deploy. Three code changes + one doc:

1. **Tailnet-IP port-bind race** — the rootless Docker daemon starts before `tailscaled`, so rootlesskit never learns the tailnet IP and silently fails to bind any published port scoped to `<tailnet-ip>:host:container`. Convert the three tailnet-IP-scoped published ports (Keycloak admin `8099`, LangFuse web `3030`, Grafana/otel-lgtm `3002`) to plain `HOST:CONTAINER` (`0.0.0.0`) binds. ufw already default-denies non-tailnet inbound, so they stay tailnet-only.
2. **Mongo keyfile crash-loop** — `mc-service/mongo-entrypoint.sh` writes the replica-set keyfile at `0400`; on a plain restart it cannot overwrite the leftover read-only file (`Permission denied`) and crash-loops. Make it idempotent (`rm -f` the path before the `umask`-guarded write).
3. **Keycloak backend-network durability** — the `prod-auth` compose **already** declares and attaches `keycloak-service` to `backend-network`; no code change. Capture the durable remediation (a Komodo `prod-auth` redeploy, replacing the manual `docker network connect`) as a runbook step.
4. **Reboot-resilience runbook** — a new `docs/runbooks/prod-reboot-resilience.md` documenting the already-completed host-side fixes (shutdown-drain unit, expanded DB backups, UPS/NUT), the repo-side fixes above, the Keycloak redeploy, and a single validation-reboot checklist.

## Technical Context

**Language/Version**: Docker Compose v2 spec (YAML); POSIX `sh` (`mongo-entrypoint.sh`); Markdown (runbook). No application code changes (no Rust/TS/Python).

**Primary Dependencies**: Docker Engine (rootless), Docker Compose v2; the movie-collection Mongo container (`mongodb/mongodb-community-server:8.0.8-ubi9`) start-up wrapper; Komodo ResourceSync (`infrastructure-as-code/komodo/stacks.toml`, branch `main`) as the sole prod deploy mechanism; host `ufw` (default-deny non-tailnet inbound) and `tailscaled` (topology, not a repo dep).

**Storage**: N/A (no schema/data changes). The `mc-service-store-mongo-data` external volume is untouched; the keyfile lives in the container's ephemeral `/tmp`.

**Testing**: (1) A POSIX shell unit test for `mongo-entrypoint.sh` idempotency (RED→GREEN, runs in Bash locally/CI). (2) `docker compose config` structural render of the two edited stacks with a throwaway placeholder env (asserts the target ports bind on `0.0.0.0` — empty HostIp — and that `keycloak-service` lists `backend-network`). (3) Static grep guards (no `${TS_ADMIN_IP}:`/`${KC_ADMIN_BIND_IP}:` bind prefixes remain; every prod service has a `restart:` policy). (4) The repo gate scripts: `check-topology-scrub.mjs`, `secret-scan.mjs`, `check-no-inline-secrets.mjs`, `check-komodo-sync.mjs`, `check-resource-naming.mjs`. Full behavioral acceptance (US1/US2/US3 end-to-end) is the operator's single validation reboot, scripted in `quickstart.md` + the runbook — it cannot run in CI (needs a real rootless-daemon-before-tailscaled boot).

**Target Platform**: Self-hosted rootless-Docker homelab (Linux), deployed via Komodo from `main`.

**Project Type**: Infrastructure-as-code (Docker Compose + entrypoint shell + operator runbook). Not a frontend or backend service change.

**Performance Goals**: N/A (recovery correctness, not throughput). Success is measured by the reboot-recovery criteria in the spec's Success Criteria, not latency.

**Constraints**: No secret and no real topology value (base domain, tailnet host, Tailscale IP) may enter git — all remain Komodo Variables / `${VAR:?}` placeholders. Changes must render under `docker compose config` with fail-fast `${VAR:?}` vars supplied by env, and deploy through Komodo with zero manual host-state edits.

**Scale/Scope**: 2 compose files edited (keycloak, observability), 1 entrypoint script edited (mc-service), 1 `.env.prod.example` pruned (keycloak — orphaned `KC_ADMIN_BIND_IP`), 1 new runbook, 1 new shell test. ~6 files touched.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
| --- | --- |
| **Security → Secrets Management** (no secrets/topology in git) | **PASS.** No new literals. The change *removes* `${VAR}` bind-prefixes and prunes one orphaned placeholder var. All five gate scripts run in Phase 0/validation; zero findings required (SC-005). |
| **Security → Deny by Default / exposure surface** | **PASS.** Moving a bind from `<tailnet-ip>:` to `0.0.0.0:` does not widen the reachable surface: host `ufw` default-denies all non-tailnet inbound (documented dependency in the runbook, FR-003). No authenticated endpoint is newly exposed. |
| **Docker-Native Operations** (health checks + graceful shutdown) | **PASS / advances it.** Health checks already present on every prod service; this feature hardens *restart/reboot* recovery (idempotent entrypoint, verified restart policies) — squarely the "graceful shutdown always implemented" intent. Host-side graceful-shutdown drain is documented (already done). |
| **TDD (NON-NEGOTIABLE)** | **PASS where testable.** The entrypoint fix gets a genuine RED→GREEN shell unit test (fails on a pre-seeded `0400` keyfile before the fix; passes after). Compose/network changes get `docker compose config` structural assertions + grep guards. The reboot-level behaviors are inherently non-CI-testable (need a real boot race); they are covered by the operator validation-reboot in `quickstart.md`, documented as such — no hidden gap. |
| **Test Type Integrity** | **PASS.** The entrypoint test exercises the real script (no mocks); the compose render test uses the real compose files. |
| **Behavior-Descriptive Identifiers** | **PASS.** Test/file names describe behavior (e.g. `mongo-entrypoint.test.sh`), no `FR-`/`SC-` IDs in identifiers; spec-ID traceability goes in comments. |
| **Frontend Platform Parity Table** | **N/A (justified).** This feature touches no Frontend App and adds no web/mobile E2E scenario; the parity-table requirement is scoped to frontend features. `tasks.md` will state this explicitly. |
| **Clean Architecture / API-First / Rust stack** | **N/A.** No backend service code, no API surface, no Rust changes. |

**Result: PASS — no violations, no Complexity Tracking entries required.**

## Project Structure

### Documentation (this feature)

```text
specs/028-prod-reboot-resilience/
├── plan.md              # This file
├── spec.md              # Feature spec (/speckit-specify)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (config entities — no DB schema)
├── quickstart.md        # Phase 1 output (operator validation-reboot guide)
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

*No `contracts/` directory — this feature exposes no external API/CLI/UI interface. The "contracts" here are the compose port-binding shape and the entrypoint's idempotency behavior, captured in data-model.md + quickstart.md.*

### Source Code (repository root)

```text
infrastructure-as-code/docker/
├── keycloak/
│   ├── compose.prod.yaml        # EDIT: 8099 bind → 0.0.0.0 (drop ${KC_ADMIN_BIND_IP}: prefix)
│   └── .env.prod.example        # EDIT: remove orphaned KC_ADMIN_BIND_IP entry
├── observability/
│   └── compose.prod.yaml        # EDIT: 3030 + 3002 binds → 0.0.0.0 (drop ${TS_ADMIN_IP}: prefix)
└── mc-service/
    ├── mongo-entrypoint.sh      # EDIT: rm -f "$KEYFILE_PATH" before the umask write (idempotent)
    └── mongo-entrypoint.test.sh # NEW: POSIX-sh RED→GREEN idempotency test

docs/runbooks/
└── prod-reboot-resilience.md    # NEW: host-side fixes + repo fixes + redeploy + validation checklist
```

**Structure Decision**: Pure infrastructure-as-code change confined to `infrastructure-as-code/docker/` (three service dirs) + `docs/runbooks/`. No `src/` tree is involved. The one new test colocates with the script it verifies (`mc-service/`), matching the constitution's "unit tests placed with the code they test" intent for a shell artifact that has no Nx/Jest home.

## Complexity Tracking

*No Constitution Check violations — this section intentionally empty.*

## Open Decisions Resolved (see research.md)

- **Task 1 fix = option (a)** in-repo `0.0.0.0` binds (not the host systemd drop-in). Confirmed with the user during brainstorming.
- **Orphaned bind vars** — `KC_ADMIN_BIND_IP` and `TS_ADMIN_IP` are used *only* as the port-bind prefix (Keycloak's admin *URL* uses the separate `KC_HOSTNAME_ADMIN`). Remove `KC_ADMIN_BIND_IP` from `keycloak/.env.prod.example`; `TS_ADMIN_IP` has no `.env.prod.example` (comes only from Komodo/`stacks.toml`), so the operator may retire that Variable — noted in the runbook, no repo edit forced. Neither removal is fail-fast-breaking (FR-011).
- **Task 4 = verify + document**, no compose edit (declaration already correct).
- **Renovate = out of scope** (already shipped: `.forgejo/workflows/renovate.yml` + `renovate.json`).
