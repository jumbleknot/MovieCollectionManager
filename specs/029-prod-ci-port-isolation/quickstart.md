# Quickstart & Validation: Prod/CI Shared-Host Port Isolation & Keycloak DB-Network Resilience

Validation in tiers: (A) the collision gate (RED→GREEN, CI-runnable), (B) compose structural renders + guards, (C) existing no-secrets gates, (D) the operator's clean Komodo redeploy (behavioral acceptance), (E) CI teardown observed on the next real run.

> Placeholders only. `<tailnet-host>` = the prod host's `*.ts.net` name; never paste real topology into a tracked file.

## A. Collision gate — RED → GREEN (CI-runnable)

```bash
# RED (before the port move): prod still publishes 8099/3030/3002, which overlap CI's — gate FAILS.
node scripts/check-prod-ci-port-collision.mjs        # → exit 1, names 8099 (+3030,3002) as colliding

# GREEN (after moving prod to 19099/19030/19002): no overlap — gate PASSES.
node scripts/check-prod-ci-port-collision.mjs --selftest   # planted overlap detected, disjoint sample clean → exit 0
node scripts/check-prod-ci-port-collision.mjs              # → exit 0, "no prod↔CI port collisions"
```

**Expected**: RED exit 1 (proves the bug is real on today's tree); after the edits, both selftest and scan exit 0.

## B. Compose structural render + guards (CI-runnable with throwaway env)

```bash
SP=<scratch>
# Keycloak admin now 19099 on 0.0.0.0 (no host_ip); keycloak-network is compose-managed (no external):
docker compose -f infrastructure-as-code/docker/keycloak/compose.prod.yaml --env-file "$SP/keycloak.env" config \
  | grep -A2 '19099'                                   # published 19099:8080, empty HostIp
docker compose -f infrastructure-as-code/docker/keycloak/compose.prod.yaml --env-file "$SP/keycloak.env" config \
  | grep -A3 'keycloak-network:'                       # NOT "external: true"

# Observability now 19030 + 19002:
docker compose -f infrastructure-as-code/docker/observability/compose.prod.yaml --env-file "$SP/observability.env" config \
  | grep -E '19030:3000|19002:3000'

# Guards:
grep -REn '"(8099|3030|3002):' infrastructure-as-code/docker/*/compose.prod.yaml && echo "FAIL old port remains" || echo "OK"
grep -c host_ip <(docker compose -f .../keycloak/compose.prod.yaml --env-file "$SP/keycloak.env" config)   # → 0
```

**Expected**: renders show `19099/19030/19002` on `0.0.0.0`; `keycloak-network` has no `external: true`; both keycloak services attach it; no old ports remain; zero `host_ip`.

## C. No-secrets / topology gates (REQUIRED before commit)

```bash
for g in check-topology-scrub check-komodo-sync secret-scan; do node scripts/$g.mjs --selftest && node scripts/$g.mjs; done
node scripts/check-no-inline-secrets.mjs
node scripts/check-resource-naming.mjs
node scripts/check-prod-ci-port-collision.mjs --selftest && node scripts/check-prod-ci-port-collision.mjs
```

**Expected**: every gate `✅`, exit 0.

## D. Operator clean redeploy — behavioral acceptance (prod host, AFTER merge + Komodo sync)

Prod keycloak currently runs via a **manual network re-attach** — do this only after the fix is on `main` and Komodo has synced.

1. In Komodo: `prod-auth` → **Stop** → **Destroy** (data volume + external nets preserved).
2. On the prod host, remove the now-orphaned external DB network so compose can own it:
   ```bash
   docker network rm keycloak-network        # gone; compose will create prod-auth_keycloak-network
   ```
3. In Komodo: `prod-auth` → **Deploy**.
4. Verify (with a CI app-e2e Keycloak up or not — must not matter now):

| Check | Expected | Criterion |
| --- | --- | --- |
| keycloak-service binds admin | `19099` bound `0.0.0.0`, no "address already in use" | SC-001 |
| keycloak-service state | `Up (healthy)`, `RestartCount` stable | SC-001 |
| DB resolve | `getent hosts keycloak-store-postgres` resolves over `prod-auth_keycloak-network` | SC-002 |
| networks | keycloak on `prod-auth_keycloak-network` + `backend-network` + `edge-network` | SC-002 |
| public issuer | `https://auth.<BASE_DOMAIN>/realms/grumpyrobot/.well-known/openid-configuration` unchanged | SC-006 |
| admin console | reachable at `http://<tailnet-host>:19099` | SC-001 |
| off-tailnet probe of 19099 | refused (ufw) | — |

**Expected**: all pass on the first redeploy, even with a CI Keycloak running (the collision is gone).

## E. CI teardown — observed on the next real app-e2e run

After merge, the next `app-ci` `app-e2e` run (or a deliberately-failed one) must leave **zero** CI stacks up:
```bash
# on the CI host after a run (as ci@):
docker compose ls | grep -E 'auth|mcm' && echo "LEFTOVER — teardown failed" || echo "OK: no leftover CI stacks"
```

**Expected**: no `auth`/`mcm`/agent CI projects remain (teardown ran under `if: always()`), so none can hold `19099`/`8099`/any host port against a prod redeploy.
