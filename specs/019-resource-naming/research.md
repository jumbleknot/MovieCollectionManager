# Phase 0 Research — Resource Naming & Rename

## D1 — Naming scheme & where the `mcm-` prefix applies

**Decision**: `<context>-<role>-<engine>-data` for volumes, `<scope>-network` for networks, `<context>-<role>` for services. The `mcm-` qualifier applies **only to the BFF** (`mcm-bff-*`).

**Rationale**: External Docker volumes/networks share a flat host-global namespace, so names must be self-disambiguating. The BFF is the one *frontend-bound* component ("bff" is a role every frontend has); a future sibling frontend would ship its own BFF, so this one is qualified by the frontend-app name `mcm`. Singular backend/infra services (`keycloak`, `mc-service`, `movie-assistant`, `observability`) use their own name as the namespace.

**Alternatives considered**: (a) prefix everything with `mcm-` — rejected: over-qualifies shared backend services and reads as a redundant global prefix. (b) no prefix anywhere — rejected: the BFF would collide with future frontends' BFFs.

## D2 — Resolved naming choices (operator decisions)

| Question | Decision |
|---|---|
| Keycloak volume | `keycloak-store-postgres-data` (aligned to `<role>-<engine>`, not bare `keycloak-db-data`) |
| Agent MCP network | `movie-assistant-mcp-network` (unified with the assistant context) |
| BFF network | `mcm-bff-network` (BFF context fully `mcm-bff`, network included) |
| OpenSearch audit | `agent-audit-opensearch-data` — **platform-level** `agent` context (the feature-012 audit sink is a shared agent-audit log usable by future agents), distinct from `movie-assistant` (this specific assistant's own resources) |

## D3 — Phase 2 service/container identity: `container_name:` vs compose-generated

**Decision**: Set explicit `container_name:` on each service to the convention name.

**Rationale**: Stable, predictable DNS (`mcm-bff-cache` not `mcm-mcm-bff-cache-1`); avoids the double-prefix that a `mcm-bff` service key in project `mcm` would otherwise produce. This local/CI/prod stack runs **one instance per service** — `docker compose --scale` is not used — so the only cost of `container_name:` (losing scale-out) does not apply. Global uniqueness is guaranteed by the convention's component namespacing.

**Alternatives considered**: rely on compose-generated `<project>-<service>-N` — rejected: yields `mcm-mcm-bff-1`-style names and couples DNS to the project name.

## D4 — Migration safety: copy, never in-place rename

**Decision**: A Docker volume rename is a **data migration** — create the new volume, `cp -a` the contents, cut over compose, verify, then decommission the old volume. Take a host-side backup (tarball + Keycloak realm export) first. Old volumes are retained until an explicit final step, making every phase reversible.

**Rationale**: A volume's `name:` *is* its identity; editing it makes Compose provision a new empty `external` volume and orphan the old data (or hard-fail if not pre-created). The three stateful stores (Keycloak realm/users/secrets, mc-service movies/collections, BFF encrypted agent-configs) must survive byte-for-byte. Disposable volumes (cache, checkpoints, audit) are recreated empty.

**Alternatives considered**: `docker volume rename` — does not exist. In-place `name:` edit — rejected (orphans data). Live `docker cp` while running — rejected (inconsistent snapshot for the DB engines; copy with the stack down).

## D5 — Remove the containerized Ollama service

**Decision**: Delete `infrastructure-as-code/docker/ollama/compose.yaml`, its `include:`/profile entry, the `ollama-models` volume, and the agent-gateway `depends_on: ollama`; keep host Ollama (`host.docker.internal:11434`) as the only model-serving path.

**Rationale**: The committed dev/E2E flow (`scripts/agent-stack.mjs`) already uses host Ollama; the containerized service was never on the happy path (it caused the missing-`ollama-models`-volume error on `--profile agents up`) and required a ~19 GB in-container pull.

**Alternatives considered**: keep it as a turnkey option — rejected: dead scaffolding and a documented foot-gun; host Ollama is the supported approach.

## D6 — Enforcement: a static naming gate

**Decision**: Add a test/CI gate that parses every compose file and asserts each `name:` (and network/`container_name:`) matches the convention, failing on any drift or any reintroduced legacy/project-prefixed name.

**Rationale**: Prevents regression to ad-hoc names; makes the convention executable rather than aspirational (mirrors the repo's existing static-scan gates, e.g. design-system + route-coverage).
