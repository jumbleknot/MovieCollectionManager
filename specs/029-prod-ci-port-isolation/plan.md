# Implementation Plan: Prod/CI Shared-Host Port Isolation & Keycloak DB-Network Resilience

**Branch**: `029-prod-ci-port-isolation` | **Date**: 2026-07-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/029-prod-ci-port-isolation/spec.md`

## Summary

Harden prod against the 2026-07-06 outage where feature 028's `0.0.0.0:8099` keycloak-admin bind collided with the CI app-e2e Keycloak's `127.0.0.1:8099` on the shared homelab host. Four changes:

1. **Partition prod admin ports off the CI/dev port space** — move the three prod `0.0.0.0`-published admin ports into a **prod-reserved range `19000–19099`**: Keycloak admin `8099→19099`, LangFuse web `3030→19030`, Grafana/otel-lgtm `3002→19002`. Keep the `0.0.0.0` bind (028's boot-race fix) + ufw default-deny. Update `KC_HOSTNAME_ADMIN` to `:19099`.
2. **Collision gate** — `scripts/check-prod-ci-port-collision.mjs`: statically scan prod `compose.prod.yaml` published host-ports vs dev/CI compose published host-ports; fail on any overlap; `--selftest`. Wire into `guardrails.yml`.
3. **Keycloak DB-network resilience** — change `keycloak-network` from `external: true` to **compose-managed** in `keycloak/compose.prod.yaml` (it's intra-stack: only keycloak-service + keycloak-store-postgres join it — verified). Compose then creates+attaches it atomically on every `up`, so Keycloak always reaches its own Postgres even if the shared external networks (`backend-network`/`edge-network`) hit the rootless re-attach race. Those two stay external (genuinely cross-stack).
4. **CI teardown hygiene** — add an `if: always()` teardown step to `app-ci.yml`'s `app-e2e` job that tears down every stack it brought up (auth, mcm, agent gateway/MCP) even on failure/cancel, so a leftover CI stack can never hold a host port.

## Technical Context

**Language/Version**: Docker Compose v2 (YAML); Node.js ESM (`.mjs`) for the gate (matches the other `scripts/check-*.mjs` gates); Forgejo Actions YAML. No application code.

**Primary Dependencies**: rootless Docker (two daemons on one host: prod uid 1002, CI uid 1001, shared host port space); Komodo ResourceSync (`stacks.toml`, branch `main`); host `ufw` (default-deny non-tailnet) + `tailscaled`; the existing repo gate harness (`scripts/*.mjs` + `guardrails.yml`).

**Storage**: N/A. Keycloak's Postgres data is on external volume `keycloak-store-postgres-data` — untouched by the network-management change (external volumes survive `down`).

**Testing**: (1) The **collision gate is itself the RED→GREEN test** for US1+US3 — on the current tree it FAILS (prod 8099/3030/3002 overlap CI's 8099/3030/3002); after the port move it PASSES; plus a `--selftest` with a planted collision. (2) `docker compose config` structural render of the edited prod stacks (new ports on `0.0.0.0`/empty HostIp; `keycloak-network` renders compose-managed with both services attached). (3) Static grep guards. (4) The existing gates (topology-scrub, secret-scan, no-inline-secrets, resource-naming). (5) US2 behavioral acceptance (survives recreate) + US4 (CI teardown on failure) = operator/CI validation, documented in quickstart. Full behavioral acceptance is the operator's clean Komodo `prod-auth` redeploy after merge.

**Target Platform**: Self-hosted rootless-Docker homelab (Linux), Komodo-deployed from `main`; CI on the same host under a second rootless daemon.

**Project Type**: Infrastructure-as-code (prod Docker Compose + a Node gate + a CI workflow step + runbook). Not frontend/backend service code.

**Performance Goals**: N/A (recovery correctness). Success = the SC-001..SC-007 outcomes.

**Constraints**: No secret/topology literal in git; deployable via Komodo; PR to `main`. The public auth issuer/hostname MUST be unchanged (only the private admin port moves). Prod keycloak currently runs via a **manual network re-attach** — `prod-auth` MUST NOT be redeployed until this merges.

**Scale/Scope**: ~7 files — `keycloak/compose.prod.yaml` (port + network), `observability/compose.prod.yaml` (2 ports), `keycloak/.env.prod.example` (`KC_HOSTNAME_ADMIN` port note), new `scripts/check-prod-ci-port-collision.mjs`, `guardrails.yml` (wire gate), `app-ci.yml` (teardown step), + update `docs/runbooks/prod-reboot-resilience.md`.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
| --- | --- |
| **Security → Secrets/Topology in git** | **PASS.** No literals added. Ports `19099/19030/19002` are non-sensitive. All existing gates run; a NEW gate is added. |
| **Security → Deny by Default / exposure** | **PASS.** Ports stay `0.0.0.0`-bound + ufw default-deny (unchanged posture, documented). No new public exposure; public issuer unchanged. |
| **Docker-Native Operations** (health/graceful) | **PASS / advances it.** Makes recreate/reboot recovery deterministic (stack-owned DB network; no host-port contention). CI teardown improves hygiene. |
| **TDD (NON-NEGOTIABLE)** | **PASS.** The collision gate is a genuine RED→GREEN test (RED on today's tree with the overlap; GREEN after the port move) + `--selftest`. Network/teardown changes get `docker compose config` + workflow-structure assertions. |
| **Test Type Integrity** | **PASS.** Gate runs against the real compose files; no mocks. |
| **Behavior-Descriptive Identifiers** | **PASS.** `check-prod-ci-port-collision.mjs` names behavior; no spec IDs in identifiers. |
| **Frontend Platform Parity Table** | **N/A (justified).** No Frontend App / E2E scenario touched. |
| **Clean Architecture / Rust stack** | **N/A.** No service code. |

**Result: PASS — no violations, no Complexity Tracking entries.**

## Project Structure

### Documentation (this feature)

```text
specs/029-prod-ci-port-isolation/
├── plan.md · spec.md · research.md · data-model.md · quickstart.md
├── checklists/requirements.md
└── tasks.md   (/speckit-tasks — not this command)
```

*No `contracts/` — no external API/CLI/UI. The "contract" is the prod-reserved-port convention + the gate's pass/fail rule, in data-model.md + quickstart.md.*

### Source Code (repository root)

```text
infrastructure-as-code/docker/
├── keycloak/
│   ├── compose.prod.yaml        # EDIT: 8099→19099 bind; keycloak-network external→compose-managed
│   └── .env.prod.example        # EDIT: KC_HOSTNAME_ADMIN example → :19099 + note
└── observability/
    └── compose.prod.yaml        # EDIT: 3030→19030, 3002→19002

scripts/
└── check-prod-ci-port-collision.mjs   # NEW: prod↔CI/dev published-host-port overlap gate (+ --selftest)

.forgejo/workflows/
├── guardrails.yml               # EDIT: wire the new gate (selftest + scan) into the naming/secret-scan job
└── app-ci.yml                   # EDIT: app-e2e `if: always()` teardown of auth/mcm/agent stacks

docs/runbooks/
└── prod-reboot-resilience.md    # EDIT: replace the 8099-bind story with the prod-reserved-port model + DB-net note
```

**Structure Decision**: Pure IaC + tooling change under `infrastructure-as-code/docker/`, `scripts/`, `.forgejo/workflows/`, `docs/runbooks/`. No `src/` tree.

## Complexity Tracking

*No Constitution Check violations — intentionally empty.*

## Key Decisions (see research.md)

- **Prod-reserved range = `19000–19099`** — disjoint from the entire CI/dev published-port set (3000s/4000s/5000s/6000s/8000s/9000s/27000s). Mapping echoes the originals: `8099→19099`, `3030→19030`, `3002→19002`.
- **Partition by port-number, keep `0.0.0.0`** (the Option-3 decision) — timing-immune, fully in-repo, no host state; the residual (port discipline) is enforced by the new gate. Rejected Option 2 (tailnet-IP + host systemd) as re-adopting the timing/host-state fragility that caused the outage.
- **`keycloak-network` → compose-managed** — verified no cross-stack consumer (the prod BFF reaches keycloak over `backend-network`, not `keycloak-network`; the `bff` grep hit was a comment). Compose will name it `prod-auth_keycloak-network`; the stale external `keycloak-network` becomes orphaned cruft the operator prunes post-cutover (runbook step). `backend-network`/`edge-network` stay external.
- **Gate compares host-published ports** across `*/compose.prod.yaml` (prod) vs `stacks/*.compose.yaml` + `*/compose.yaml` + `keycloak/compose.ci.yaml` (dev/CI); parses `HOST`, `IP:HOST:CONTAINER`, `HOST:CONTAINER`; fails on host-port set intersection.
- **CI teardown** — `app-e2e` gains a final `if: always()` step tearing down the `auth`, `mcm`, and agent compose projects it brought up (mirrors their bring-up invocations).
