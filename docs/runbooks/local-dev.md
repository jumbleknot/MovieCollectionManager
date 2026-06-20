# Runbook: Local Dev Infrastructure & Environment Variables

> Setup and operational reference, loaded on demand — referenced from CLAUDE.md. The load-bearing gotchas (Redis-or-500, replica-set MongoDB, Keycloak-before-app) and the config *rules* (`.env` no-inline-comments, `TRUSTED_PROXY`, `@/*` alias) stay inline in CLAUDE.md; this runbook holds the full procedures and the env-var tables.

## Local Dev Infrastructure

All dev/test infrastructure is managed from the repo-root **`compose.yaml`** using Docker Compose profiles and `include:` to incorporate individual service compose files.

**First-time setup** (run once per machine before the first `docker compose up`):

```bash
docker network create backend-network
docker network create keycloak-network
docker network create movie-assistant-mcp-network
docker volume create mc-service-store-mongo-data
docker volume create keycloak-store-postgres-data
docker volume create mcm-bff-cache-redis-data
```

Copy `infrastructure-as-code/docker/keycloak/.env.local.example` → `.env.local` and fill in the KC_DB_PASSWORD and client secret values.

**Profiles:**

| Profile flag | Services |
| --- | --- |
| *(none — default)* | `mc-db` (MongoDB replica set) + `mcm-redis` |
| `--profile app` | + `mc-service` |
| `--profile keycloak` | + `keycloak-db` + `keycloak-service` + `keycloak-mailpit` |
| `--profile app --profile keycloak` | full stack |

Direct compose commands (from repo root):

```bash
docker compose up -d                                          # test infra (MongoDB + Redis)
docker compose --profile app up -d                           # + mc-service (without Keycloak — mc-service will fail OIDC discovery)
docker compose --profile keycloak up -d                      # + Keycloak stack
docker compose --profile app --profile keycloak up -d        # full stack (correct order — mc-service waits for Keycloak healthy)
docker compose --profile app --profile keycloak down         # stop (keep volumes)
docker compose --profile app --profile keycloak down --volumes  # stop + wipe transient volumes only (persistent data is in external volumes)
docker compose ps                                            # status
```

> **Note:** `--profile` flags must come BEFORE `up`/`down` with Docker Compose v2. `docker compose up -d --profile app` is not supported.
>
> **Note:** mc-service `depends_on: keycloak-service: condition: service_healthy` ensures mc-service never starts before Keycloak is ready to serve JWKS. Running `--profile app` alone (without `--profile keycloak`) will hang waiting for Keycloak.

Or via Nx (from repo root):

```bash
pnpm nx up-test infrastructure-as-code      # MongoDB + Redis
pnpm nx up-app infrastructure-as-code       # + mc-service
pnpm nx up-keycloak infrastructure-as-code  # + Keycloak stack
pnpm nx up-all infrastructure-as-code       # full stack
pnpm nx down infrastructure-as-code         # stop (keep volumes)
pnpm nx down-all infrastructure-as-code     # stop + wipe transient volumes
pnpm nx ps infrastructure-as-code           # status
```

**Endpoints when running:**

| Service | URL |
| --- | --- |
| MongoDB | `mongodb://localhost:27017` |
| Redis | `redis://localhost:6379` |
| mc-service | `http://localhost:3001` |
| Keycloak Admin UI | `http://localhost:8099` (admin / change_me) |
| Mailpit | `http://localhost:8025` |

**Volume architecture**: The root `compose.yaml` uses `include:` to incorporate individual service compose files. Persistent data volumes are declared `external: true` with explicit names in each service's compose file so they keep their names after `include:` merges them (Docker Compose would otherwise prefix them with `mcm_`):

| Volume name | Declared in | Owned by |
| --- | --- | --- |
| `mc-service-store-mongo-data` | `infrastructure-as-code/docker/mc-service/compose.yaml` | mc-service compose |
| `keycloak-store-postgres-data` | `infrastructure-as-code/docker/keycloak/compose.yaml` | keycloak compose |
| `mcm-bff-cache-redis-data` | `infrastructure-as-code/docker/bff/compose.yaml` | bff compose |
| `mcm-bff-store-mongo-data` | `infrastructure-as-code/docker/bff/compose.yaml` | bff compose |

The transient volume `keycloak-mailpit-data` (stores emails) gets the `mcm_` prefix (`mcm_keycloak-mailpit-data`) — that is acceptable since emails are ephemeral.

`docker compose down --volumes` only wipes transient volumes (`mcm_keycloak-mailpit-data`); all three persistent external volumes are untouched. To wipe persistent data, remove the external volumes manually after `docker compose down`.

**Without Redis, the BFF /login endpoint returns 500 "Authentication failed"** because the rate-limiter's first Redis call fails before returning a typed error.

**Integration tests require a replica-set-enabled MongoDB** — `MongoCollectionRepository::delete()` uses a multi-document transaction. Standalone MongoDB does not support transactions. The root `compose.yaml` starts `mc-db` with `--replSet rs0` and runs `rs-init` automatically. For CI environments not using compose, start MongoDB manually:

```bash
# Start (or replace an existing standalone container)
docker run -d --name mc-db-test -p 27017:27017 \
  mongodb/mongodb-community-server:8.0.8-ubi9 mongod --replSet rs0 --bind_ip_all
# Initiate the replica set (once after first start)
docker exec mc-db-test mongosh --quiet \
  --eval "try { rs.status() } catch(e) { rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]}) }"
```

**MongoDB replica set hostname — always use `docker compose up -d`**: The `rs-init` service initialises the replica set with `host: 'localhost:27017'`. This hostname works from the host (via Docker port binding) and from mc-service in Docker (which uses `directConnection=true` to bypass rs-member discovery). Never start `mc-db` with a bare `docker run` command — doing so can result in the rs being initialised with `mc-db:27017` (Docker-internal only), causing host-side integration tests to fail with "No such host is known".

**Fixing a bad replica set hostname** (if `cargo test` fails with "No such host is known" or "mc-db:27017" in the error):

```bash
docker exec mc-db mongosh --quiet --eval "rs.reconfig({ _id: 'rs0', members: [{ _id: 0, host: 'localhost:27017' }] }, { force: true })"
```

**mc-service requires Keycloak running** — it fetches the JWKS endpoint on startup to cache the public key for JWT validation. Start `--profile keycloak` before `--profile app`.

Typical dev loop: `pnpm nx up-keycloak infrastructure-as-code` → `pnpm start` in `frontend/mcm-app` → test in browser. For mc-service development, also run `pnpm nx up-app infrastructure-as-code`.

## Environment Variables

> The config *rules* — `.env` no-inline-comments, `TRUSTED_PROXY` semantics, the `@/*` path alias — live in CLAUDE.md's Configuration section. These tables are the reference values.

### BFF server-side env vars (BFF only, never exposed to client)

| Variable | Default |
|---|---|
| `KEYCLOAK_URL` | `http://localhost:8099` |
| `KEYCLOAK_REALM` | `grumpyrobot` |
| `KEYCLOAK_CLIENT_ID` | `movie-collection-manager` |
| `KEYCLOAK_CLIENT_SECRET` | — |
| `KEYCLOAK_SERVICE_CLIENT_ID` | service account for Admin API |
| `KEYCLOAK_SERVICE_CLIENT_SECRET` | — |
| `REDIS_URL` | `redis://localhost:6379` |
| `COOKIE_SECRET` | — |
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` (30 min) |
| `SESSION_ABSOLUTE_TIMEOUT_MS` | `86400000` (24 hr) |
| `MAX_CONCURRENT_SESSIONS` | `10` |
| `TRUSTED_PROXY` | `false` |
| `AGENT_CONFIG_ENC_KEY` | — (required; 32-byte base64 — see below) |
| `MONGO_URL` | `mongodb://localhost:27018` (Metro); `mongodb://mcm-bff-db:27017` (container) |
| `MONGO_DB_NAME` | `bff_db` |

**Per-user agent config (feature 018).** The BFF stores each user's encrypted assistant credentials in the `user_agent_config` collection on its **OWN dedicated MongoDB instance, `mcm-bff-db`** — deliberately **separate** from mc-service's `mc-db` (the BFF must not reach across a service boundary into a backend service's database — constitution §Decoupling; it mirrors the BFF's already-separate Redis). `mcm-bff-db` starts by default with `docker compose up -d` (host port `27018`). Env vars:

- `AGENT_CONFIG_ENC_KEY` — the AES-256-GCM key for at-rest encryption of the per-user provider/TMDB secrets. **Required**; the BFF throws on startup in production if it is missing. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. The **same** value must be set wherever the BFF runs (Metro `.env.local` **and** the dev container `.env.docker`) or encrypt/decrypt across restarts/containers breaks. Never commit it (NFR-Sec-1).
- `MONGO_URL` — the BFF→`mcm-bff-db` connection: `mongodb://localhost:27018` from Metro/host, `mongodb://mcm-bff-db:27017` from the dev container. `mcm-bff-db` is a **plain standalone `mongod`** (the BFF store does single-doc upserts only — no transactions), so there is **no replica set and no `directConnection`** to worry about (unlike `mc-db`). `MONGO_DB_NAME` defaults to `bff_db`. First-time: `docker volume create mcm-bff-store-mongo-data`.

> **No shared model/TMDB credentials (FR-021/SC-002).** Feature 018 removed `MODEL_PROVIDER` / `OLLAMA_BASE_URL` / `ANTHROPIC_API_KEY` / `TMDB_API_KEY` from the **user-facing** assistant runtime — each user brings their own, injected per-run via the `X-Agent-Config` / `X-TMDB-Key` headers (decrypted in memory, never persisted/logged). Those env vars remain only for the keyless golden cassette gate and non-user-facing paths. Do **not** add a shared `TMDB_API_KEY` to `.env.docker`.

`TRUSTED_PROXY` (feature 009, finding #4): set to `true` only when the BFF runs behind a trusted reverse proxy (e.g., Caddy) that sets `X-Forwarded-For`. When `true`, the rate-limit client IP is the **right-most** XFF hop (the peer the proxy observed; left entries are client-spoofable). When `false` (default), client-supplied XFF is **not** trusted and IP-scoped rate limiting is skipped with a warning rather than collapsing all clients into one shared bucket. Non-loopback deployments MUST set `TRUSTED_PROXY=true` behind the proxy for per-IP limiting to be active.

### mc-service env vars

| Variable | Default | Notes |
| --- | --- | --- |
| `MC_DB_URL` | — | `mongodb://localhost:27017/mc_db` local (replica set required — see the Local Dev Infrastructure startup note above); `mongodb://mc-db:27017/mc_db?replicaSet=rs0&directConnection=true` Docker |
| `KEYCLOAK_URL` | — | `http://localhost:8099` local; `http://keycloak-service:8080` Docker |
| `KEYCLOAK_REALM` | `grumpyrobot` | — |
| `KEYCLOAK_CLIENT_ID` | `movie-collection-manager` | — |
| `MC_SERVICE_PORT` | `3001` | — |
| `RUST_LOG` | `info` | `mc_service=debug,axum=info` for targeted filtering |

Local dev: `backend/mc-service/.env.local` (gitignored). Docker values set in `infrastructure-as-code/docker/mc-service/compose.yaml`.

**mc-service fails to start if `MC_DB_URL` is unreachable or if Keycloak JWKS endpoint cannot be fetched** (JWKS is cached on startup for JWT validation).
