# Contract — Resource Naming Gate

The convention is enforced by a static gate (a unit/CI test) so it cannot silently regress. This file is the contract that gate implements.

## Inputs

All compose files: root `compose.yaml` + `infrastructure-as-code/docker/**/compose*.yaml`. The gate parses each `volumes:`/`networks:`/`services:` block and inspects `name:`, network keys, and `container_name:`.

## Assertions

1. **Volume names** match `^(keycloak|mc-service|mcm-bff|movie-assistant|agent|observability)-[a-z0-9]+(-[a-z0-9]+)*-data$` (a `<context>-<role>-<engine>-data` shape).
2. **External network names** match `^([a-z0-9-]+)-network$` and are drawn from the approved set (`backend-network`, `keycloak-network`, `mcm-bff-network`, `movie-assistant-mcp-network`).
3. **`container_name:`** (Phase 2) match `^(keycloak|mc-service|mcm-bff|movie-assistant)(-[a-z0-9]+)*$`.
4. **No legacy forms**: no name contains a compose-project prefix (`localdev-auth_`, `mc-service_`, `mcm_`) and no bare engine-only volume name (e.g. `redis-data`, `opensearch-data`).
5. **Qualifier rule**: a name may begin with `mcm-` **only** when its context is the BFF (`mcm-bff-…`).
6. **Removed objects absent**: no reference to `ollama` service or `ollama-models` volume remains in any live compose/script/CI file.

## Failure behavior

The gate fails the build and names the offending file + token, instructing the author to either rename to the convention or extend the approved-context set in this contract (a deliberate, reviewed change — not an ad-hoc exception).

## Out of scope

Vendor-internal container names the gate does not own (e.g. images' own processes) and historical `specs/**` artifacts.
