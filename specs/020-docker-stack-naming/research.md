# Phase 0 Research: Docker Compose Stack & Container Naming Cleanup

All major design decisions were resolved with the user before planning. This document records each decision, its rationale, and the alternatives rejected — plus the one genuinely open research item (the discovery-sweep method, since live hostnames live in gitignored env files).

## Decision 1 — Rename both `container_name` AND service key to one unified identifier

**Decision**: For every service, set `container_name` and the compose service key to the same target name from the mapping.

**Rationale**: The user wants a single self-describing identifier that is both what `docker ps` shows and the in-network DNS name. Feature 019's lesson is that `container_name` is *additive* to Compose DNS — the **service key** is the authoritative in-network alias. Unifying them removes the current divergence (`mc-db` key vs `mc-service-db` container; `caddy` key vs `mcm-bff-proxy` container).

**Consequence**: Renaming a service key changes its DNS hostname, so every config reference must move in lockstep (see Decision 5).

**Alternatives rejected**:
- *Container-name-only rename* (lower blast radius): leaves the service key — the real DNS alias — inconsistent, defeating the feature's purpose.
- *Add old keys as network aliases for safety*: would silently mask a missed reference, hiding exactly the failure the E2E gate is meant to catch. Explicitly disallowed.

## Decision 2 — Four named Compose projects via thin `include:`-only aggregators

**Decision**: Create `infrastructure-as-code/docker/stacks/{auth,mcm,audit,observability}.compose.yaml`, each with its own top-level `name:` and an `include:` of only its member per-service files. Retire the single root `compose.yaml` aggregation.

**Rationale**: Per-stack lifecycle isolation. Today everything is one `mcm` project, so `docker compose --profile X down` tears the whole project down (a documented footgun in the auto-memory). Separate projects let an operator bring up/tear down `auth`, `mcm`, `audit`, or `observability` independently. Keeping the modular per-service files (vs collapsing into four monoliths) minimizes churn and preserves the existing structure.

**Alternatives rejected**:
- *Single project + profiles* (status quo): cannot isolate lifecycle per stack.
- *Four hand-written monolithic compose files*: massive duplication, loses the per-service modularity 019 established.

## Decision 3 — Drop the one cross-stack `depends_on` (manual ordering instead)

**Decision**: Accept losing the `mc-service` → `keycloak-service` `service_healthy` gate (the only `depends_on` that crosses a proposed stack boundary). Document manual ordering: bring up `auth` before the `mcm` `app` profile.

**Rationale**: Docker Compose does not support `depends_on` across projects. The user explicitly accepted this. The ordering is already documented (CLAUDE.md: "start `--profile keycloak` before `--profile app`; `--profile app` alone hangs waiting for Keycloak"). All other `depends_on` edges are intra-stack and are preserved.

**Alternatives rejected**:
- *Keep one project to preserve the gate*: contradicts Decision 2.
- *External healthcheck/wait wrapper script*: added complexity for a gate the user is fine losing.

## Decision 4 — Move Vault into `auth`, profile-gated (optional dev / required prod)

**Decision**: Relocate the `vault` service definition out of `observability/compose.yaml` into the `auth` stack as `vault-service`, behind a profile so dev omits it and prod includes it.

**Rationale**: Vault is a secrets/identity concern, not observability — it was only colocated there historically. Gating preserves the existing no-op-by-default posture for dev while making it available (required) for prod. Services that consume Vault already degrade cleanly when it is absent (env-gated secret injection).

**Alternatives rejected**:
- *Leave Vault in observability*: keeps the conceptual mismatch.
- *Make Vault mandatory in auth*: would force every dev `up-auth` to run Vault unnecessarily.

## Decision 5 — Discovery sweep FIRST, including gitignored env files (OPEN research item)

**Decision**: Before any edit, enumerate every reference to every old container name and service key, across version-controlled files AND the dev-machine gitignored env files (`frontend/mcm-app/.env.docker`, `agents/movie-assistant/.env.local`, `mcp-servers/*/.env.local`). Produce the authoritative change list, then edit.

**Rationale**: Live connection URLs (`MC_DB_URL`, `REDIS_URL`, `AGENT_GATEWAY_URL`, MCP URLs, `OPA_URL`, `UNLEASH_*`, `OPENSEARCH_URL`, `VAULT_ADDR`, `KC_DB_URL`) reside in env files that are not in version control — a missed one surfaces only at runtime as a connection failure. The `.example` siblings are in VCS and reveal the variable names, but the *actual* files must be edited on the dev machine. The web E2E regression is the catch-all that proves none were missed.

**Method** (resolves the open item):
1. For each old name, grep the repo (compose, Caddyfile, scripts, CI, `src/config/env.ts`, integration env, mobile flows, docs, CLAUDE.md, memory). The pre-plan spike found 60+ candidate files.
2. On the dev machine, grep the gitignored env files for old service-key hostnames; update the live files and their `.example` siblings together.
3. Treat the mongo replica-set member host and the CLAUDE.md `rs.reconfig` recovery snippet as special cases (host string, not just a URL).
4. After edits, run a final repo-wide search asserting zero residual old names (SC-006), then bring up each stack and run the web E2E regression (SC-002/SC-003).

**Reference-category taxonomy** is captured in [data-model.md](./data-model.md).

## Decision 6 — Keep the BFF image tag `mcm-bff:latest`

**Decision**: Both `mcm-bff-service-secure` and `mcm-bff-service-nonsecure` continue to build from / reference `mcm-bff:latest`; `nx docker-build` is unchanged; the image is not renamed.

**Rationale**: The two BFF services differ only by `NODE_ENV` (cookie posture), not by image. Renaming the image would ripple into the build target and Dockerfile for no benefit. Out of scope.

## Decision 7 — Networks and volumes are untouched (owned by feature 019)

**Decision**: No network or volume renames; external network declarations and volume `name:` values stay byte-for-byte.

**Rationale**: 019 already standardized these; re-touching them risks a regression (SC-007) and is explicitly a non-goal. Volumes are declared `external` precisely so renames here cannot affect them.

## Validation strategy

- **Naming gate (RED→GREEN)**: extend `scripts/check-resource-naming.mjs` to assert `container_name == service key == convention`. It fails on the current tree (RED) and passes after the renames (GREEN). Runs in CI.
- **Per-stack lifecycle**: bring up each stack independently; tear one down and confirm the others survive (SC-004).
- **Inter-service connectivity**: web E2E regression via the dev-container path against `mcm-bff-service-nonsecure` (SC-002/SC-003) — the integration proof that every renamed DNS hostname still resolves.
- **No residual references**: final repo-wide search for old names (SC-006).
