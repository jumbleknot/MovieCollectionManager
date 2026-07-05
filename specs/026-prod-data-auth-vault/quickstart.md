# Quickstart / Validation: Production Data-Tier Authentication

**Feature**: 026-prod-data-auth-vault | **Phase**: 1

Runnable validation scenarios that prove the feature works end-to-end. This is a validation guide — the exact cutover scripts live in `tasks.md` / implementation. Contract IDs (B1–B7) refer to [contracts/mongo-auth-contract.md](contracts/mongo-auth-contract.md).

> **Shell**: PowerShell on the dev box; the prod host is Linux/Docker. Bash snippets below run on the prod/scratch host.

---

## Scenario 0 — Rehearse on a restored snapshot (MANDATORY before prod)

**Prereq**: a scratch environment (separate Docker host/project) and a snapshot of each prod Mongo volume.

1. Restore the prod-volume snapshot into a scratch external volume of the same name.
2. Generate scratch secrets + keyfile locally (`node scripts/gen-dev-secrets.mjs` extended for the new Mongo vars; generate the movie keyfile).
3. Run the cutover script (Scenario 1) against the scratch stack.
4. **Expected**: anonymous rejected (B1), app user works (B2), counts match baseline (B3), rollback rehearsed. Only after a green rehearsal is the production window scheduled.

## Scenario 1 — Enable auth on a store (the cutover, per store)

Run inside the scheduled ≤60-minute window. Movie store shown; BFF store is identical minus the keyfile/replSet.

```bash
# baseline counts (rollback reference)
mongosh "mongodb://mc-service-store-mongo:27017/mc_db?directConnection=true" --quiet \
  --eval 'db.getCollectionNames().map(c=>({c, n: db[c].countDocuments()}))'

# Phase 1: redeploy mongod with keyfile + auth + --transitionToAuth  (accepts auth'd + anon)
# → create users:
mongosh --quiet <<'JS'
db = db.getSiblingDB('admin');
db.createUser({user:'mc_root', pwd:process.env.MONGO_MC_ROOT_PASSWORD, roles:['root']});
db.auth('mc_root', process.env.MONGO_MC_ROOT_PASSWORD);
db.createUser({user:'mc_service_app', pwd:process.env.MONGO_MC_APP_PASSWORD,
               roles:[{role:'readWrite', db:'mc_db'}]});
JS

# switch consumer: set MC_DB_URL to the authenticated form, redeploy mc-service

# Phase 2: redeploy mongod WITHOUT --transitionToAuth  (anonymous now rejected)
```

**Expected**: mc-service reconnects and serves reads/writes normally.

## Scenario 2 — Anonymous connection is rejected (B1 / SC-001)

```bash
mongosh "mongodb://mc-service-store-mongo:27017/mc_db?directConnection=true" --quiet \
  --eval 'db.runCommand({listCollections:1})'
# Expected: MongoServerError: command listCollections requires authentication
```

Repeat for `mcm-bff-store-mongo`. **Expected**: both reject anonymous access.

## Scenario 3 — Least-privilege app user (B2 / SC-002)

```bash
# app user CAN read/write its DB:
mongosh "mongodb://mc_service_app:$MONGO_MC_APP_PASSWORD@mc-service-store-mongo:27017/mc_db?replicaSet=rs0&authSource=admin&directConnection=true" \
  --quiet --eval 'db.movies.findOne()'                       # Expected: ok

# app user CANNOT do admin ops:
mongosh ".../mc_db?authSource=admin..." --quiet \
  --eval 'db.getSiblingDB("admin").createUser({user:"x",pwd:"y",roles:["root"]})'
# Expected: not authorized on admin to execute command
```

## Scenario 4 — Data preserved (B3 / SC-003)

Compare post-cutover counts to the Scenario 1 baseline (per collection). **Expected**: exact match, both stores.

## Scenario 5 — Keyfile negative test (B5)

```bash
chmod 0444 <keyfile>   # group/world readable
# redeploy movie mongod → Expected: mongod exits: "permissions on keyfile are too open"
chmod 0400 <keyfile>   # restore
```

## Scenario 6 — End-user regression unchanged (B4 / SC-004)

After both stores are re-authenticated and the services redeployed against the containerized BFF:

```bash
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app
```

**Expected**: full web E2E green — no functional difference attributable to auth (per the constitution's "web E2E required for every feature, incl. backend-only", rebuild changed containers first).

## Scenario 7 — Secret gates stay green (B6 / SC-005)

```bash
node scripts/secret-scan.mjs --selftest && node scripts/secret-scan.mjs
node scripts/check-no-inline-secrets.mjs --selftest && node scripts/check-no-inline-secrets.mjs
node scripts/check-resource-naming.mjs --section=all
```

**Expected**: all exit 0. No keyfile/password literal in git; `git status` shows the rendered keyfile + generated `.env` as ignored.

## Scenario 8 — Dev stays unauthenticated (B7 / FR-009)

Bring up the plain dev stack (`pnpm nx up-mcm infrastructure-as-code`) and confirm local dev Mongo still accepts an unauthenticated connection — the auth flags live only in the prod compose + scratch env.

## Scenario 9 — Workstream B decision record exists (SC-006)

Confirm the committed ADR (per [contracts/secrets-decision-record-template.md](contracts/secrets-decision-record-template.md)) names exactly one mechanism, maps 100% of secret categories, and reconciles the agent-layer Vault path.

---

## Definition of done (validation)

- [ ] Rehearsed on a restored snapshot before prod (Scenario 0).
- [ ] Both stores reject anonymous access (Scenario 2 / SC-001).
- [ ] App users are least-privilege; no root at runtime (Scenario 3 / SC-002).
- [ ] Counts preserved on both stores (Scenario 4 / SC-003).
- [ ] Keyfile negative test passes (Scenario 5).
- [ ] Web E2E regression green against re-authenticated stores (Scenario 6 / SC-004).
- [ ] All secret/naming gates green (Scenario 7 / SC-005).
- [ ] Dev remains unauthenticated (Scenario 8 / FR-009).
- [ ] Workstream B ADR committed and complete (Scenario 9 / SC-006).
