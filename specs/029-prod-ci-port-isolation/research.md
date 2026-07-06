# Phase 0 Research: Prod/CI Shared-Host Port Isolation & Keycloak DB-Network Resilience

All Technical Context unknowns are resolved. Evidence gathered live from the repo + the prod/CI hosts during the 2026-07-06 incident.

## R1 — Root cause (why 028's 0.0.0.0:8099 broke prod)

**Finding**: One physical homelab host runs **two rootless Docker daemons** — prod (uid 1002) and the CI runner (uid 1001) — both publishing into the **same host port space**. A published port collides on `(host-IP, port)`: `0.0.0.0:X` overlaps *any* bind on port X (including `127.0.0.1:X`); two *different* IPs on port X do not.

- Pre-028: prod keycloak bound `${KC_ADMIN_BIND_IP}:8099` (tailnet IP). CI keycloak binds `127.0.0.1:8099`. Different IPs → coexisted.
- Feature 028 changed prod to `0.0.0.0:8099` (fixing the tailnet-IP boot race) → now overlaps CI's `127.0.0.1:8099`. Whenever a CI Keycloak is up, a prod recreate fails `bind: address already in use` → container stuck/crash-loop, and the failed port bind rolls back the container's networking (hence the observed zero/partial networks + `UnknownHostException`).
- A leftover CI app-e2e stack had held `127.0.0.1:8099` for 6h, so **every** prod recreate failed.

**Decision**: Treat this as a **shared-host port-partition** problem, plus an independent **network-attach** fragility. Fix both structurally.

## R2 — Port partition strategy (Option 3, decided with the operator)

**Decision**: Keep prod's `0.0.0.0` bind; move prod admin ports into a **prod-reserved range `19000–19099`**, disjoint from CI/dev ports. Enforce with a gate.

**Rationale** (Option 3 vs Option 2, per the operator discussion): Option 2 (revert to tailnet-IP bind + host systemd `After=tailscaled`) re-adopts the exact fragilities that caused the outage — tailnet-IP-availability timing + un-committed host state. Option 3 is timing-immune (`0.0.0.0` always binds), fully in-repo (single source of truth), and its one weakness (port discipline) is static and gate-enforceable. The `0.0.0.0` exposure is already contained by ufw default-deny (028 posture).

**CI/dev published-port set** (authoritative, from `stacks/*.compose.yaml` + `*/compose.yaml` + `keycloak/compose.ci.yaml`): `101, 1025, 3001, 3002, 3030, 4242, 4317, 4318, 5432, 6379, 8025, 8081, 8082, 8099, 8123, 8181, 8200, 8443, 9000, 9200, 27017, 27018`. **`19000–19099` is entirely clear.**

**Port mapping** (echoes originals, `19000 + orig%1000`):
| Service | File | Old | New |
| --- | --- | --- | --- |
| Keycloak admin | `keycloak/compose.prod.yaml` | `8099:8080` | `19099:8080` |
| LangFuse web | `observability/compose.prod.yaml` | `3030:3000` | `19030:3000` |
| Grafana/otel-lgtm | `observability/compose.prod.yaml` | `3002:3000` | `19002:3000` |

`19000–19099` is below the Linux ephemeral range (32768+), so no ephemeral-port contention.

**Also update** `KC_HOSTNAME_ADMIN` (the tailnet admin-console URL) from `:8099` → `:19099` in `keycloak/.env.prod.example` (and the operator's `.env.prod`). LangFuse/Grafana have no committed hostname var (topology comes from Komodo), so only the published port changes for those.

## R3 — Public issuer is unaffected (SC-006)

**Finding**: The public auth surface is `KC_HOSTNAME: https://auth.${BASE_DOMAIN}` via cloudflared → `keycloak-service:8080` (internal, over `edge-network`). The `8099`/`19099` port is **only** the tailnet admin console (`KC_HOSTNAME_ADMIN`). Moving it does not touch the issuer, JWKS, or discovery. `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` keeps the internal discovery advertising the public issuer. **No client/backend reconfiguration.**

## R4 — keycloak-network can be compose-managed (US2)

**Decision**: Remove `external: true` from `keycloak-network` in `keycloak/compose.prod.yaml` so compose owns it.

**Evidence**: Only `keycloak-service` (line 96) and `keycloak-store-postgres` (line 30) join `keycloak-network`; only `keycloak/compose.prod.yaml` declares it (line 110). The prod BFF reaches keycloak over **`backend-network`** (`KEYCLOAK_URL: http://keycloak-service:8080`, BFF networks = `mcm-bff-network, backend-network, edge-network, agent-audit-network`) — the earlier `bff/compose.prod.yaml` grep hit was a **comment** ("mirrors keycloak-network in prod-auth"), not a membership. So `keycloak-network` has **no cross-stack consumer** → safe to make stack-owned.

**Effect**: Compose creates+attaches `prod-auth_keycloak-network` atomically on every `up`. Even if the rootless race drops the external `backend-network`/`edge-network`, Keycloak still reaches its Postgres over the compose-managed DB network → **it always starts** (the crash-loop cause is removed). `backend-network`/`edge-network` stay `external` (cross-stack).

**Cutover note**: compose-managed default name is project-prefixed (`prod-auth_keycloak-network`); the old external `keycloak-network` becomes orphaned cruft. The operator does the clean destroy+redeploy (already planned) and then `docker network rm keycloak-network` (runbook step). Data volume `keycloak-store-postgres-data` is external → untouched. (Do NOT set `name: keycloak-network` on the managed net — adopting a pre-existing unlabeled external net errors "network has incorrect label"; let compose use its prefixed name.)

## R5 — Collision gate design (US3)

**Decision**: `scripts/check-prod-ci-port-collision.mjs`, styled like the other `check-*.mjs` gates (`--selftest` + scan; exit 0/1/2).

- **Prod ports**: parse published-port entries in `infrastructure-as-code/docker/*/compose.prod.yaml`.
- **CI/dev ports**: parse published-port entries in `infrastructure-as-code/docker/stacks/*.compose.yaml`, `infrastructure-as-code/docker/*/compose.yaml`, `infrastructure-as-code/docker/keycloak/compose.ci.yaml`.
- **Parse** each `- "…"` ports entry to the HOST port: forms `HOST:CONTAINER`, `IP:HOST:CONTAINER`, bare `HOST`, ignoring `${VAR}`-only host-IP prefixes; support `HOST/proto`.
- **Fail** (exit 1) if `prodHostPorts ∩ ciHostPorts ≠ ∅`, printing each colliding port + the prod file and CI file.
- **`--selftest`**: plant a prod entry `19099:x` + a CI entry `19099:x` → must detect; and a clean disjoint pair → must not false-positive.

**Wire into** `guardrails.yml` (the job that runs the other `check-*.mjs` gates), selftest then scan. This makes the fix self-enforcing (SC-004): a future prod or CI port that overlaps fails the required check.

## R6 — CI teardown (US4)

**Finding**: `app-ci.yml`'s `app-e2e` job brings up the `auth`, `mcm`, and agent (gateway+MCP) compose stacks but has **no teardown step** → leftover stacks persist (the 6h stack that held 8099). The only `always()` in the file is on `trigger-cd`.

**Decision**: Add a final step to `app-e2e` with `if: ${{ always() }}` that tears down every stack the job started — `docker compose -p <project> down -v --remove-orphans` for auth, mcm, and the agent project(s), mirroring the bring-up invocations (steps "Bring up … auth stack", "Bring up containerized agent gateway + MCP"). `-v` is safe (CI stacks are ephemeral, fresh per run). Runs on the `kvm` host runner (same daemon that started them). This guarantees no leftover CI stack can hold a host port.

## R7 — No-secrets / topology gates + behavioral acceptance

- The edits add no host/domain/IP literal (ports are non-sensitive). Existing gates (topology-scrub, secret-scan, no-inline-secrets, resource-naming) run and stay green; the new collision gate is added.
- CI-runnable: the collision gate (RED→GREEN), `docker compose config` renders, grep guards, `--selftest`s.
- Not CI-runnable (documented in quickstart): US1/US2 end-to-end = the operator's clean Komodo `prod-auth` redeploy (destroy old external `keycloak-network`, redeploy, confirm keycloak binds `19099`, reaches Postgres over the compose-managed net, healthy); US4 failure-teardown = observed on the next real app-e2e run.
