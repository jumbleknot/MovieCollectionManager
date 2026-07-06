# Quickstart & Validation: Prod Reboot-Resilience Follow-ups

How to validate the feature. Three tiers: (A) local, CI-runnable checks; (B) the compose-render structural checks; (C) the operator's single validation reboot (behavioral acceptance). Prereqs, commands, and expected outcomes only — implementation lives in `tasks.md`.

> **Topology discipline**: every command below uses placeholders. Never paste the real tailnet host, base domain, or Tailscale IP into a tracked file. `<tailnet-host>` = the prod host's `*.ts.net` name.

## A. Entrypoint idempotency test (RED → GREEN, CI-runnable)

**Prereq**: Bash (Git Bash on Windows is fine).

```bash
# From repo root — drives the REAL mongo-entrypoint.sh with a temp keyfile path and a no-op exec target.
bash infrastructure-as-code/docker/mc-service/mongo-entrypoint.test.sh
```

**Expected**:
- **Before the fix (RED)**: the "restart over a leftover 0400 keyfile" case FAILS with a non-zero exit and a `Permission denied` message — proving the bug is real.
- **After the fix (GREEN)**: all cases pass — fresh run creates the keyfile; a restart over a pre-seeded `0400` file succeeds; two consecutive runs both exit 0; `MONGO_MC_KEYFILE` unset still fails fast. Final line: `OK`.

## B. Compose structural render (CI-runnable with throwaway env)

Renders the edited stacks with placeholder values and asserts the port shape + network attachment. Supply a throwaway env so the fail-fast `${VAR:?}` vars resolve (never real values).

```bash
# Keycloak admin port now binds 0.0.0.0 (no HostIp), keycloak-service still on backend-network:
docker compose -f infrastructure-as-code/docker/keycloak/compose.prod.yaml \
  --env-file <throwaway.env> config | grep -A2 '8099'      # → published 8099:8080, HostIp empty
docker compose -f infrastructure-as-code/docker/keycloak/compose.prod.yaml \
  --env-file <throwaway.env> config | grep -A6 'keycloak-service' | grep backend-network

# Observability: LangFuse 3030 + Grafana 3002 bind 0.0.0.0:
docker compose -f infrastructure-as-code/docker/observability/compose.prod.yaml \
  --env-file <throwaway.env> config | grep -E '3030:3000|3002:3000'
```

**Expected**: each target port renders with an empty/`0.0.0.0` HostIp; `keycloak-service` lists `backend-network`; no `${...IP...}:` prefix remains; no unresolved-variable error.

**Static guards** (no Docker needed):

```bash
# No tailnet-IP bind prefixes remain anywhere in prod composes:
grep -REn '\$\{(KC_ADMIN_BIND_IP|TS_ADMIN_IP)[^}]*\}:' infrastructure-as-code/docker && echo "FAIL: prefix remains" || echo "OK: no bind prefixes"

# Every prod service has a restart policy (count services vs restart: lines per file, or just eyeball):
grep -REc 'restart: unless-stopped' infrastructure-as-code/docker/*/compose.prod.yaml
```

## C. No-secrets / topology gates (CI-runnable, REQUIRED before commit)

```bash
node scripts/check-topology-scrub.mjs --selftest && node scripts/check-topology-scrub.mjs
node scripts/check-komodo-sync.mjs      --selftest && node scripts/check-komodo-sync.mjs
node scripts/secret-scan.mjs            --selftest && node scripts/secret-scan.mjs
node scripts/check-no-inline-secrets.mjs
node scripts/check-resource-naming.mjs
```

**Expected**: every gate prints its `✅` line and exits 0. Zero findings (SC-005).

## D. Operator validation reboot (behavioral acceptance — runs on the prod host)

Performed **after** the PR merges and Komodo syncs. This is the end-to-end acceptance of US1/US2/US3. Full step-by-step lives in `docs/runbooks/prod-reboot-resilience.md`; the pass/fail summary:

1. **Redeploy** `prod-auth` through Komodo (durable `backend-network` re-attach; retires the manual `docker network connect`).
2. **Reboot** the prod host once (unattended path — do not manually start anything).
3. After boot, **without any manual intervention**, verify:

| Check | Expected | Success Criterion |
| --- | --- | --- |
| Keycloak admin console over the tailnet (`:8099`) | reachable | SC-001 |
| LangFuse web over the tailnet (`:3030`) | reachable | SC-001 |
| Grafana over the tailnet (`:3002`) | reachable | SC-001 |
| `mc-service-store-mongo` container | healthy, **zero** crash-loop restarts | SC-002 |
| App loads collections end-to-end | works, **zero** manual `docker network connect` | SC-003 |
| The three ports from outside the tailnet | refused (ufw) | SC-004 |
| Every prod container | came back via its restart policy | SC-007 |

**Expected**: all rows pass on the first reboot — the box comes back fully clean and hands-off. Any failing row is a defect to fix before closing the feature.
