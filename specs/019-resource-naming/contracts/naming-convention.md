# Contract — Resource Naming Gate

The convention is enforced by a static gate (a unit/CI test) so it cannot silently regress. This file is the contract that gate implements.

## Inputs

All compose files: root `compose.yaml` + `infrastructure-as-code/docker/**/compose*.yaml`. The gate parses each `volumes:`/`networks:`/`services:` block and inspects `name:`, network keys, and `container_name:`.

## Assertions

1. **Volume names** match `^(keycloak|mc-service|mcm-bff|movie-assistant|agent|observability)-[a-z0-9]+(-[a-z0-9]+)*-data$` (a `<context>-<role>-<engine>-data` shape). FR-007 relaxed form: multi-volume vendor stacks under the `observability` context may end in `-logs` (e.g. `observability-langfuse-clickhouse-logs`).
2. **External network names** match `^([a-z0-9-]+)-network$` and are drawn from the approved set (`backend-network`, `keycloak-network`, `mcm-bff-network`, `movie-assistant-mcp-network`).
3. **`container_name:`** (Stage B) match `^(keycloak|mc-service|mcm-bff|movie-assistant)(-[a-z0-9]+)*$`.
4. **No legacy forms**: no name contains a compose-project prefix (`localdev-auth_`, `mc-service_`, `mcm_`) and no bare engine-only volume name (e.g. `redis-data`, `opensearch-data`).
5. **Qualifier rule**: a name may begin with `mcm-` **only** when its context is the BFF (`mcm-bff-…`).
6. **Removed objects absent**: no reference to the removed *containerized* `ollama` service (a compose `ollama:` service, a `depends_on: ollama`, or the container URL `http://ollama:<port>`) or the `ollama-models` volume remains in any live compose/script/CI file. **Host Ollama is the supported path** — `OLLAMA_BASE_URL`, `MODEL_PROVIDER=ollama`, and `host.docker.internal:11434` are explicitly allowed and MUST NOT be flagged.

## Phased enforcement

The renames land incrementally, so the gate MUST support a `--section` flag and not require all assertions to pass at once:

- `--section=volumes`    → assertions 1, 4, 5 (volume names)
- `--section=networks`   → assertion 2 (network names)
- `--section=ollama`     → assertion 6 (no removed objects)
- `--section=containers` → assertion 3 (`container_name:`)
- `--section=all` (default) → every assertion; only expected GREEN after the Stage-B service rename (tasks Phase 6) completes.

Each section is independently RED→GREEN, preserving the TDD checkpoint per phase. The gate inspects `name:` only inside `volumes:`/`networks:` blocks — never the top-level compose project `name:` (every component compose file declares one).

## Failure behavior

The gate fails the build and names the offending file + token, instructing the author to either rename to the convention or extend the approved-context set in this contract (a deliberate, reviewed change — not an ad-hoc exception).

## Out of scope

Vendor-internal container names the gate does not own (e.g. images' own processes) and historical `specs/**` artifacts.
