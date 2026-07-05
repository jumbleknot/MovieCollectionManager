# Contract: Production MongoDB Authentication

**Feature**: 026-prod-data-auth-vault | **Phase**: 1

This is the interface contract for the authenticated data tier — the connection strings, the identity/role matrix, the server command shape, and the observable behaviors that acceptance tests assert against. It is the oracle for Workstream A.

## C1 — Server command shape (target, prod compose)

| Store | Enforced-auth command |
|---|---|
| `mc-service-store-mongo` | `mongod --replSet rs0 --keyFile /etc/mongo/keyfile --bind_ip_all` |
| `mcm-bff-store-mongo` | `mongod --auth --bind_ip_all` |

During the Phase-1 window only, each command additionally carries `--transitionToAuth` (accepts authenticated **and** anonymous connections). Phase 2 removes it (anonymous rejected). The keyfile (movie store only) is **not** a host file or volume: an entrypoint wrapper materializes it from the `MONGO_MC_KEYFILE` env var into an in-container `0400`, mongod-uid-owned file at start-up (env-only, feature-022-compliant), then `exec`s mongod.

## C2 — Identity & role matrix

| Store | Admin (setup-only) | App (runtime) | App role | App scope | authSource |
|---|---|---|---|---|---|
| movie (`mc_db`) | `mc_root` / `root` | `mc_service_app` | `readWrite` | `mc_db` | `admin` |
| bff (`bff_db`) | `bff_root` / `root` | `bff_app` | `readWrite` | `bff_db` | `admin` |

**Rule**: no root/administrative identity is used by a running service. Only the app user appears in a running service's connection string.

## C3 — Connection-string contract (consumers)

```
# mc-service  (env MC_DB_URL)
mongodb://mc_service_app:${MONGO_MC_APP_PASSWORD}@mc-service-store-mongo:27017/mc_db?replicaSet=rs0&authSource=admin&directConnection=true

# BFF  (env MONGO_URL; db name still via MONGO_DB_NAME=bff_db)
mongodb://bff_app:${MONGO_BFF_APP_PASSWORD}@mcm-bff-store-mongo:27017/?authSource=admin
```

**Rules**:
- The password is always a `${VAR}` interpolation in the URL password position — never a literal (keeps `check-no-inline-secrets` green).
- `authSource=admin` on both; movie store retains `replicaSet=rs0&directConnection=true`.
- No application code change: `config.rs`/`adapters/mongodb/client.rs` and `config/env.ts`/`bff-server/mongo-client.ts` already consume these env values verbatim.

## C4 — Healthcheck contract (steady state, under auth)

```
mongosh --quiet --eval "db.adminCommand('ping').ok"   # both stores; no credentials required
```

`ping`/`hello` run without authentication even under `--auth`. The movie store's prior self-initializing `rs.status()`/`rs.initiate()` probe is removed (fails under auth; unnecessary on an initialized set). Replica-set initialization on a genuinely fresh volume is an explicit authenticated bootstrap step, not a healthcheck side effect.

## C5 — Observable behaviors (acceptance oracles)

| ID | Behavior |
|---|---|
| B1 (SC-001) | An anonymous connection to either store (`mongosh <host>:27017` with no credential) is **rejected** with an authentication error after Phase 2. |
| B2 (SC-002) | Each service authenticates with its least-privilege app user; the app user **cannot** perform admin operations (e.g., create a user) — verified by a negative check. |
| B3 (SC-003) | Record/collection counts are **identical** before and after the cutover, per store. |
| B4 (SC-004) | End-user application behavior is unchanged — the web E2E regression passes against the re-authenticated stores. |
| B5 (member auth) | The movie replica set enforces member auth — a member without the keyfile cannot join; a group/world-readable keyfile causes `mongod` startup failure (negative test). |
| B6 (SC-005) | No credential or keyfile material is present in git; `secret-scan` + `check-no-inline-secrets` + `check-resource-naming` stay green. |
| B7 (FR-009) | The plain dev stacks (`compose.yaml`) remain unauthenticated — auth flags exist only in prod compose + the scratch/rehearsal env. |
