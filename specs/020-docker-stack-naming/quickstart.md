# Quickstart & Validation: Docker Compose Stack & Container Naming Cleanup

Runnable validation that the rename + stack split is complete and inter-service connectivity survived. Prereqs: Docker Desktop running; the pre-created external networks/volumes from feature 019 already exist; on Windows use PowerShell.

> Commands below use the **new** stack/project names. Replace `<stack>` with `auth|mcm|audit|observability`. Per-stack compose files live in `infrastructure-as-code/docker/stacks/`.

## 0. Discovery sweep is done (precondition)

Before any container can come up clean, the reference sweep (research.md Decision 5) must have updated the gitignored env files. Sanity-check no old service-key hostname remains in the live env files on this machine:

```powershell
# Expect ZERO hits (old keys fully migrated):
Select-String -Path frontend/mcm-app/.env.docker, agents/movie-assistant/.env.local, mcp-servers/*/.env.local `
  -Pattern 'mc-db|mcm-redis|mcm-bff-db|\bagent-db\b|\bagent-gateway\b|\bmovie-mcp\b|spreadsheet-mcp|web-api-mcp|\bopensearch\b|\bvault\b|\bopa\b|\bunleash\b|keycloak-db'
```

## 1. Naming gate (RED → GREEN)

```powershell
node scripts/check-resource-naming.mjs
```

- **Before renames**: FAILs, listing services whose `container_name` ≠ service key or that violate the convention (RED).
- **After renames**: PASSes (GREEN). This is the primary unit-level checkpoint.

## 2. Per-stack bring-up (SC-001, SC-002)

Bring up `auth` first (the `mcm` app needs Keycloak; no cross-project `depends_on` anymore — order manually):

```powershell
pnpm nx up-auth infrastructure-as-code      # keycloak-service + keycloak-store-postgres + keycloak-mailpit
pnpm nx up-mcm infrastructure-as-code        # test infra; add profiles for app/bff/agents
```

Confirm every container carries its target name and no legacy name appears:

```powershell
docker ps --format '{{.Names}}' | Sort-Object
# Expect: keycloak-service, keycloak-store-postgres, mc-service-store-mongo, mcm-bff-cache-redis, ...
# Expect NONE of: keycloak, mc-service-db, mcm-bff-cache, movie-assistant-db, opensearch, opa, unleash
```

Verify a renamed-key connection resolves (example: the BFF reaching its Mongo store):

```powershell
docker exec mcm-bff-store-mongo mongosh --quiet --eval "db.adminCommand('ping').ok"   # → 1
```

## 3. Independent stack lifecycle (SC-004)

```powershell
# observability and audit are independent projects:
pnpm nx up-observability infrastructure-as-code
pnpm nx up-audit infrastructure-as-code

# Tear ONE stack down; the others must keep running:
docker compose -p audit -f infrastructure-as-code/docker/stacks/audit.compose.yaml down
docker ps --format '{{.Names}}'   # mcm/auth/observability containers still listed
```

## 4. Vault profile gating (auth stack, FR-008)

```powershell
# dev (no vault profile) — vault-service absent:
pnpm nx up-auth infrastructure-as-code
docker ps --format '{{.Names}}' | Select-String 'vault-service'   # → no match

# prod posture (vault profile on) — vault-service present:
docker compose -p auth -f infrastructure-as-code/docker/stacks/auth.compose.yaml --profile vault up -d
docker ps --format '{{.Names}}' | Select-String 'vault-service'   # → match
```

## 5. Mongo replica set + integration tests (US1 scenario 4)

```powershell
pnpm nx test:integration mc-service
```

If the RS member host needs the documented recovery, the snippet now references the renamed container:

```powershell
docker exec mc-service-store-mongo mongosh --quiet --eval "rs.reconfig({ _id: 'rs0', members: [{ _id: 0, host: 'localhost:27017' }] }, { force: true })"
```

## 6. Web E2E regression — the connectivity proof (SC-002, SC-003, FR-014)

Build the BFF image (tag unchanged) and run the dev-container E2E path against `mcm-bff-service-nonsecure`:

```powershell
pnpm nx docker-build mcm-app
docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml --profile bff-nonsecure up -d
$env:E2E_BFF_TARGET = 'dev-container'; pnpm nx e2e mcm-app
```

**Expected**: passes at the known-green baseline (~93 tests). A failure here = a missed DNS reference (Decision 5 catch-all) — fix the hostname, rebuild, re-run.

## 7. No residual legacy names (SC-006)

```powershell
# Repo-wide; expect zero hits outside intentional historical notes:
Select-String -Path . -Recurse -Pattern 'container_name:\s*(keycloak|keycloak-db|mc-service-db|mcm-bff\b|mcm-bff-dev|mcm-bff-proxy|mcm-bff-store|mcm-bff-cache|movie-assistant-db|opensearch|opa|unleash)\b'
```

## 8. Networks & volumes unchanged (SC-007)

```powershell
docker network ls --format '{{.Name}}'   # backend-network, keycloak-network, movie-assistant-mcp-network — unchanged
docker volume ls --format '{{.Name}}'    # *-data names identical to pre-feature
```

---

**Done when**: §1 GREEN, §2 all target names present / no legacy, §3 independent teardown confirmed, §4 vault gating both ways, §6 web E2E green, §7 zero residual, §8 networks/volumes unchanged.
