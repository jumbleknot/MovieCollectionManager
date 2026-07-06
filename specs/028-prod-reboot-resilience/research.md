# Phase 0 Research: Prod Reboot-Resilience Follow-ups

All Technical Context unknowns are resolved; no `NEEDS CLARIFICATION` remained. This records the decisions and their evidence.

## R1 — Tailnet-IP port-bind race: bind to 0.0.0.0 vs. host systemd ordering

**Decision**: Convert the three tailnet-IP-scoped published ports to plain `HOST:CONTAINER` (`0.0.0.0`) binds in-repo. Do **not** rely on a host systemd drop-in.

**Root cause**: The rootless Docker daemon starts at boot *before* `tailscaled`, so rootlesskit never learns the tailnet IPv4. A published port scoped to `<tailnet-ip>:host:container` then silently fails to bind — the container shows `Up` with an empty Ports column and nothing listening. A container restart does not fix it; only a `0.0.0.0` bind or a full rootless-daemon restart (after tailscaled is up) does. Ports already bound to `0.0.0.0` were unaffected (Forgejo on `0.0.0.0:3000` stayed reachable through the reboot).

**Rationale**:
- Fully in-repo → survives every Komodo deploy (option b, a host systemd drop-in, is uncommitted host state that a rebuild/re-provision loses).
- No exposure regression: host `ufw` default-denies all non-tailnet inbound, so a `0.0.0.0` bind is still only reachable over the tailnet. Confirmed in the handoff; recorded as a load-bearing dependency in the runbook (FR-003).
- Removes an entire class of boot-ordering fragility rather than papering over the ordering with a unit dependency.

**Alternatives considered**:
- *Host systemd drop-in* (`After=tailscaled.service` on the rootless user manager) — rejected as primary: host-only, uncommitted, not deployable via Komodo. Mentioned in the runbook as optional defense-in-depth only.
- *Keep tailnet-IP bind + restart the daemon on boot* — rejected: still fragile, still host state, still manual.

**Affected ports** (the only three tailnet-IP-scoped published ports in the whole prod tree; every other prod port is `0.0.0.0` or unpublished):
| Service | File:line | Current | After |
| --- | --- | --- | --- |
| Keycloak admin | `keycloak/compose.prod.yaml:49` | `${KC_ADMIN_BIND_IP:?}:8099:8080` | `8099:8080` |
| LangFuse web | `observability/compose.prod.yaml:38` | `${TS_ADMIN_IP:?}:3030:3000` | `3030:3000` |
| Grafana/otel-lgtm | `observability/compose.prod.yaml:224` | `${TS_ADMIN_IP:?}:3002:3000` | `3002:3000` |

## R2 — Orphaned bind variables after the change

**Decision**: Remove `KC_ADMIN_BIND_IP` from `keycloak/.env.prod.example`. Leave `TS_ADMIN_IP` handling to the operator (Komodo Variable); no repo file forces it.

**Evidence**: Grep of the tracked tree shows `KC_ADMIN_BIND_IP` is referenced (for binding) only in `keycloak/compose.prod.yaml` + its `.env.prod.example` + `stacks.toml`/docs. The Keycloak admin *URL* uses a **separate** var, `KC_HOSTNAME_ADMIN` (still needed). So `KC_ADMIN_BIND_IP` is fully orphaned by this change → prune it from the example to avoid cruft. `TS_ADMIN_IP` is used only by the two observability binds and has **no** `.env.prod.example` (observability sources it purely from Komodo/`stacks.toml`), so there is no repo file to prune; the runbook notes the operator may retire the Variable.

**Constraint check (FR-011)**: Removing the `${VAR:?}` bind-prefix cannot break `compose config` — the fail-fast reference is deleted along with the value requirement. No remaining `${KC_ADMIN_BIND_IP:?}` / `${TS_ADMIN_IP:?}` reference will exist, so no deploy aborts on an unset var.

## R3 — Mongo keyfile idempotency

**Decision**: Insert `rm -f "$KEYFILE_PATH"` immediately before the `umask 377`-guarded write in `mongo-entrypoint.sh`.

**Root cause**: The entrypoint writes `$MONGO_MC_KEYFILE` to `/tmp/mongo-keyfile` then `chmod 0400`. On a plain container **restart** (not recreate) the prior run's `0400` file persists in the container's writable layer; the redirect `> "$KEYFILE_PATH"` opens the file for write and fails with `EACCES` (`Permission denied`) even for the owner, because `0400` has no write bit. `mongod` never execs → crash-loop under `restart: unless-stopped`.

**Why `rm -f`**: It is the minimal, portable fix. `rm -f` succeeds whether or not the file exists (idempotent, no error on first run) and removing a file needs write permission on the *directory* (`/tmp`, world-writable / owner-writable), not the file — so it works despite the file being `0400`. After removal the `umask 377` write recreates it cleanly. Alternatives `install -m 400` (not guaranteed present in the minimal image) and "write to a fresh path each run" (needs matching `--keyFile` path, more moving parts) were rejected as heavier.

**First-run safety (FR-005)**: `rm -f` on a non-existent path is a no-op with exit 0, so fresh-container behavior is unchanged.

**Test approach**: `mongo-entrypoint.test.sh` drives the real script with `MONGO_MC_KEYFILE=test`, `MONGO_KEYFILE_PATH=$tmp`, and a no-op command (`true`) as the exec target. RED (pre-fix): pre-create `$tmp` at `0400`, run → expect non-zero exit + "Permission denied". GREEN (post-fix): same setup runs clean, and a second consecutive run also succeeds (proves idempotency across restarts).

## R4 — Keycloak backend-network durability

**Decision**: No compose change. Document the operator redeploy.

**Evidence**: `keycloak/compose.prod.yaml` already lists `backend-network` under `keycloak-service.networks` (line 95) and declares it `external: true` (lines 110–111). The post-reboot "missing backend-network" symptom was a runtime rootless re-attach gap, not a declaration gap. The durable remediation is a Komodo `prod-auth` redeploy (which recreates the container with the declared network set), replacing the temporary manual `docker network connect`. Captured as a runbook step (FR-006).

## R5 — Restart-policy coverage

**Decision**: Verify-only; no change expected.

**Evidence**: Grep of `**/compose.prod.yaml` shows `restart: unless-stopped` on every service across all prod stacks (bff, agents, mc-service, observability, vault, keycloak, opensearch). The one-shot init containers (`langfuse-minio-init`, `agent-audit-init`, `unleash-seed`) also carry `restart: unless-stopped` and idle on `sleep infinity`, and their init actions are idempotent (PUT-upsert / `touch` / `mc mb --ignore-existing`) — safe to re-run on reboot. A grep guard in `tasks.md` asserts no gap remains.

## R6 — No-secrets / topology gates

**Decision**: Run all five gates before commit; expect zero findings.

**Evidence**: The edits introduce no literal host/domain/IP (they *remove* `${VAR}` prefixes). `check-topology-scrub.mjs` (tree-wide `*.ts.net`), `check-komodo-sync.mjs` (komodo TOML topology — untouched here), `secret-scan.mjs` (credential shapes), `check-no-inline-secrets.mjs` (compose inline literals), `check-resource-naming.mjs` (container/network names — unchanged). The new runbook must use placeholders (`<tailnet-host>`, `${BASE_DOMAIN}`, `100.x.y.z`) only — same discipline as existing runbooks.

## R7 — Behavioral acceptance is a manual reboot

**Decision**: CI covers structure + entrypoint idempotency; the reboot-level acceptance (US1/US2/US3 end-to-end) is the operator's single validation reboot, scripted in `quickstart.md` and the runbook.

**Rationale**: The bind-race only reproduces when the rootless daemon starts before `tailscaled` at real boot — not reproducible in CI. `docker compose config` proves the *shape* (0.0.0.0 bind, backend-network attached); the shell test proves entrypoint idempotency; the reboot proves the *behavior*. This split is stated openly (no hidden coverage gap, per the TDD gate).
