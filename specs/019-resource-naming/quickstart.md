# Quickstart — Validate the Rename

This is the validation/run guide. The full step-by-step migration commands live in [docs/proposals/volume-network-rename-migration.md](../../docs/proposals/volume-network-rename-migration.md); names are authoritative in [data-model.md](data-model.md).

## Prerequisites

- Docker Desktop running; the stack currently up with real data (Keycloak `grumpyrobot` realm, mc-service catalogue, BFF agent-configs).
- A populated baseline to compare against (record the counts in step 1).

## Phase 1 — volumes & networks

1. **Record baseline** (before touching anything):
   ```bash
   docker exec mc-db mongosh --quiet --eval "const d=db.getSiblingDB('mc_db'); print('coll='+d.movie_collections.countDocuments({})+' mov='+d.movies.countDocuments({}))"
   curl -s http://localhost:8099/realms/grumpyrobot/.well-known/openid-configuration | grep -o '"issuer":"[^"]*"'
   ```
2. **Run the migration** Phases 0–5 from the runbook (backup → stack down → create+copy stateful volumes → create `movie-assistant-mcp-network` → edit compose `name:`/networks → bring up). Remove the `ollama` service in the same edit.
3. **Verify — must all pass**:
   - Keycloak `grumpyrobot` issuer resolves (200).
   - mc-service movie/collection counts **equal the baseline** (zero data loss).
   - BFF agent-config collections present: `docker exec mcm-bff-store mongosh --quiet --eval "print(db.getSiblingDB('bff_db').getCollectionNames())"`.
   - `docker volume ls` / `network ls` show **only** convention names; no `localdev-auth_*`, `mcm-redis-data`, `ollama-models`, or `agent-mcp`.
   - The **static naming gate** passes (see [contracts/naming-convention.md](contracts/naming-convention.md)).
   - Regression: `pnpm nx run-many --target=test`; `pnpm nx test:integration mc-service`; `BFF_BASE_URL=http://localhost:8082 pnpm nx test:integration mcm-app`; `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- auth.spec.ts collections.spec.ts movies.spec.ts` — all green.
4. **Decommission** old volumes + `agent-mcp` network only after the above pass.

## Phase 2 — services / containers (coordinated cutover)

1. Apply `container_name:` + service-key renames; update every `.env*.example` and the DNS references in `scripts/agent-stack.mjs` + healthchecks.
2. **Each environment** updates its own gitignored `.env` per the mapping (the cutover step the PR cannot perform).
3. Verify: full stack boots; login + movie CRUD + one agent run (`node scripts/agent-e2e.mjs assistant-add`) all green.

## Rollback

Old volumes are untouched through Phase 5; to revert, `git restore` the compose/script edits and bring the stack up — data is unchanged. If already decommissioned, restore from the `E:/tmp/volbackup/*.tgz` tarballs (runbook Rollback section).

## Success = spec Success Criteria

SC-001 (100% convention), SC-002 (zero data loss — counts match), SC-003 (gates green), SC-004 (no Ollama remnants), SC-005 (fresh-host provision works), SC-006 (reversible).
