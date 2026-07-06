# Phase 1 Data Model: Prod/CI Shared-Host Port Isolation & Keycloak DB-Network Resilience

No database schema / application data model. These are the configuration constructs whose invariants the change must hold, for precise, checkable contracts.

## E1 — Prod-reserved port range

**Represents**: the band of host ports production admin UIs publish from, guaranteed disjoint from CI/dev.

| Field | Value |
| --- | --- |
| Range | `19000–19099` |
| Members (post-change) | Keycloak admin `19099`, LangFuse `19030`, Grafana/otel-lgtm `19002` |
| Bind IP | `0.0.0.0` (all interfaces; tailnet-only via ufw) |

**Invariants**:
- INV-1: Every prod published host port ∈ `19000–19099`.
- INV-2: `prodHostPorts ∩ ciDevHostPorts = ∅` (enforced by the gate).
- INV-3: Container-side ports are unchanged (`8080`/`3000`); only host ports move.
- INV-4: Binds stay `0.0.0.0` (no `host_ip` in `compose config` render); tailnet-only via ufw (documented).

## E2 — Published host port (gate unit)

**Represents**: a host-side port a compose file exposes; the comparison unit.

**Parsing rules** (from a `ports:` list entry string):
- `"H:C"` → host `H`; `"IP:H:C"` → host `H`; `"H"` → host `H`; optional `/proto` stripped.
- A `${VAR}`-only host-IP prefix is ignored (host is still the middle field); an all-`${VAR}` port entry is skipped (can't resolve statically).

**Invariants**:
- INV-5: The gate's prod set = host ports from `*/compose.prod.yaml`.
- INV-6: The gate's CI/dev set = host ports from `stacks/*.compose.yaml` + `*/compose.yaml` + `keycloak/compose.ci.yaml`.
- INV-7: Gate exit 1 iff the two sets intersect; the output names each colliding port + a prod file and a CI file.
- INV-8: `--selftest` proves detection (planted overlap) and no false-positive (disjoint sample).

## E3 — Keycloak DB-link network (US2)

**Represents**: the network carrying `keycloak-service ↔ keycloak-store-postgres`.

**State transition**:
```
BEFORE: keycloak-network  external: true         (pre-created on host; recreate race can strand it)
AFTER:  keycloak-network  compose-managed        (compose creates+attaches atomically → prod-auth_keycloak-network)
```

**Invariants**:
- INV-9: `keycloak-service` and `keycloak-store-postgres` both attach `keycloak-network`; it is declared compose-managed (no `external: true`, no `name:` override).
- INV-10: `backend-network` + `edge-network` remain `external: true` (cross-stack).
- INV-11: No service outside `prod-auth` joins `keycloak-network` (verified — BFF uses `backend-network`).
- INV-12: `keycloak-store-postgres-data` (external volume) is untouched → data preserved.
- INV-13: On recreate, keycloak resolves `keycloak-store-postgres` and starts on the first attempt even if external nets are slow to attach.

## E4 — CI end-to-end teardown (US4)

**Represents**: the always-run cleanup in `app-ci.yml`'s `app-e2e`.

**Invariants**:
- INV-14: A final `app-e2e` step with `if: ${{ always() }}` tears down every stack the job started (auth, mcm, agent gateway/MCP).
- INV-15: Teardown runs on success, failure, AND cancel → no leftover CI stack holds a host port.

## E5 — prod-reboot-resilience runbook (doc)

**Invariants**:
- INV-16: The runbook's keycloak port story is updated from the `8099`/`0.0.0.0` narrative to the prod-reserved-port model, and adds the DB-network + `docker network rm keycloak-network` cutover step + the `19099` admin URL.
- INV-17: Placeholders only (no real domain/host/IP) — topology-scrub clean.
