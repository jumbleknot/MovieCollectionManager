# Contract: Container / Service-Key Naming Convention

This is the contract the naming gate (`scripts/check-resource-naming.mjs`) enforces after this feature, and the rule contributors follow when adding services. It extends the feature-019 network/volume convention to **container names and service keys**.

## Rule 1 — Unified identifier

For every service in every per-service compose file:

```
container_name == <service key> == <target identifier>
```

A service whose `container_name` differs from its service key is a violation (except where a documented, justified exemption exists).

## Rule 2 — Identifier format

`<component>[-<role>-<technology>]`, kebab-case.

- **component**: the owning subsystem (`keycloak`, `mc-service`, `mcm-bff`, `movie-assistant`, `agent-audit`, `opa`, `unleash`).
- **role** (when the service is a backing resource): `store` (durable DB), `cache` (ephemeral), `tls-proxy`, `service`, `service-secure` / `service-nonsecure` (cookie posture), `mcp-<name>`, `rs-init`.
- **technology** (when a backing resource): the engine — `postgres`, `mongo`, `redis`.

Examples: `mc-service-store-mongo`, `mcm-bff-cache-redis`, `movie-assistant-store-postgres`, `mcm-bff-tls-proxy`, `keycloak-store-postgres`, `agent-audit-opensearch`.

## Rule 3 — Vendor-bundle exemption

Third-party bundles MAY keep upstream names where renaming would fight the vendor's own compose/image conventions: `langfuse-web`, `langfuse-worker`, `langfuse-postgres`, `langfuse-clickhouse`, `langfuse-redis`, `langfuse-minio`, `langfuse-minio-init`, `otel-lgtm`. The gate treats these as an allowlist. (The user reserves the right to tweak these later.)

## Rule 3b — Auxiliary / bundle-member exemption

A small set of auxiliary, dev-only, or bundle-member services keep their existing names rather than being forced into the `<component>-<role>-<technology>` form. These are on the gate's allowlist alongside Rule 3:

- `keycloak-mailpit` — a dev-only mail catcher attached to the auth stack; not a first-class application store.
- `unleash-postgres`, `unleash-seed` — the backing store and one-shot seeder that ship as members of the Unleash bundle; they are versioned/owned as a unit with `unleash-service` and not exposed as independent application stores.

**Rationale for the asymmetry** (why `keycloak-db` is renamed to `keycloak-store-postgres` but `unleash-postgres` is not): the Keycloak database is a first-class, long-lived application store that the platform operates directly (backups, the documented IAM lifecycle), so it earns a convention-conformant name. `unleash-postgres`/`unleash-seed`/`keycloak-mailpit` are auxiliary support services bound to their parent bundle's lifecycle, so renaming them adds churn without operator value. The gate encodes this as an explicit, named allowlist so the exemption is deliberate rather than an accidental gap.

## Rule 4 — No legacy aliases

A renamed service MUST NOT retain its old service key as a network `alias`. The old name must not resolve after the rename, so that any missed reference fails loudly (caught by the web E2E regression) rather than silently resolving.

## Rule 5 — Networks & volumes unchanged

This contract does NOT govern network or volume names — those are owned by feature 019 and MUST remain unchanged. The gate continues to assert the 019 network/volume rules unmodified.

## Rule 6 — Stack membership & project name

Each per-service compose file belongs to exactly one stack aggregator (`auth`, `mcm`, `audit`, `observability`), and each aggregator declares a top-level `name:` equal to its stack. No service appears in two stacks.

## Gate behavior (acceptance)

| Input tree | Expected gate result |
|---|---|
| Renamed tree (this feature complete) | PASS |
| An allowlisted auxiliary/vendor name (`keycloak-mailpit`, `unleash-postgres`, `unleash-seed`, `langfuse-*`, `otel-lgtm`) | PASS (Rule 3 / Rule 3b) |
| A service with `container_name` ≠ service key | FAIL, naming the offending service + expected value |
| A service violating the format (e.g. `mc-service-database`) | FAIL, naming the offender + the convention |
| A non-allowlisted vendor name | FAIL |
| A renamed service re-adding its old key as an alias | FAIL (Rule 4) |
| Any network/volume name changed vs 019 | FAIL (Rule 5, existing assertion) |

The gate runs in CI (`.github/workflows/naming-gate.yml`) and is the RED→GREEN checkpoint for the rename work.
