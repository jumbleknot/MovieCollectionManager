# Phase 1 Data Model: Prod Reboot-Resilience Follow-ups

This feature has **no database schema and no application data model**. The "entities" are configuration constructs whose invariants the change must preserve. They are documented here so the tasks and tests have precise, checkable contracts.

## E1 — Published port binding

**Represents**: the host-side exposure of a container port.

| Field | Before (fragile) | After (resilient) |
| --- | --- | --- |
| Host IP scope | `<tailnet-ip>` (from `${KC_ADMIN_BIND_IP}` / `${TS_ADMIN_IP}`) | unset → `0.0.0.0` |
| Host port | `8099` / `3030` / `3002` | unchanged |
| Container port | `8080` / `3000` / `3000` | unchanged |
| Reachable from | tailnet only (when bind succeeds) | tailnet only (via `ufw` default-deny) |

**Invariants**:
- INV-1: After the change, no published-port entry in a `compose.prod.yaml` carries a `${...IP...}:` host-IP prefix.
- INV-2: The container-side port and host-side port numbers are unchanged (no client/tunnel reconfig).
- INV-3: `docker compose config` for the edited stack renders each target port with an empty/`0.0.0.0` `HostIp` and no unresolved fail-fast var.
- INV-4: Actual reachability from outside the tailnet remains denied (host firewall responsibility; verified in the reboot checklist, not in CI).

## E2 — Mongo keyfile materialization (entrypoint contract)

**Represents**: the start-up wrapper that turns the `MONGO_MC_KEYFILE` env value into an on-disk `0400` file for `mongod --keyFile`.

**State transitions**:
```
[container start]
   → (NEW) rm -f $KEYFILE_PATH        # idempotent: no-op if absent, clears a leftover 0400 file
   → umask 377; write $MONGO_MC_KEYFILE > $KEYFILE_PATH
   → chmod 0400 $KEYFILE_PATH
   → exec mongod ... --keyFile $KEYFILE_PATH
```

**Invariants**:
- INV-5: Fresh start (no prior file) → keyfile created `0400`, `mongod` execs. (unchanged from today)
- INV-6: Restart over an existing `0400` file → wrapper succeeds (no `Permission denied`), keyfile re-created `0400`, `mongod` execs. (the fix)
- INV-7: Two consecutive runs against the same `$KEYFILE_PATH` both exit 0 (idempotency).
- INV-8: `MONGO_MC_KEYFILE` unset still fails fast with the existing `:?` message (no regression to the fail-fast guard).
- INV-9: Final keyfile mode is exactly `0400` and owned by the exec'ing user (mongod refuses otherwise).

## E3 — Shared backend network attachment

**Represents**: `keycloak-service`'s membership of the external `backend-network` that lets `mc-service` discover it by DNS name for OIDC/JWKS.

**Invariants**:
- INV-10: `keycloak-service.networks` includes `backend-network`, declared `external: true`. (already true — verify, don't change)
- INV-11: A Komodo `prod-auth` redeploy restores full attachment durably (operator step; not a repo assertion).

## E4 — Restart-policy coverage

**Represents**: each prod service's boot-recovery policy.

**Invariants**:
- INV-12: Every service in every `compose.prod.yaml` declares `restart: unless-stopped` (verify — no gap).

## E5 — Reboot-resilience runbook

**Represents**: the operator document.

**Invariants**:
- INV-13: Documents all host-side fixes (drain unit, DB backups, UPS/NUT), all repo-side fixes (E1–E4), and the E3 redeploy step.
- INV-14: Contains a validation-reboot checklist with an explicit pass/fail line per spec Success Criterion (SC-001..SC-004, SC-007).
- INV-15: Contains no real topology/secret literal — placeholders only (passes topology-scrub + secret-scan).
