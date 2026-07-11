# Runbook: Local Dev Infrastructure & Environment Variables

> Setup and operational reference, loaded on demand — referenced from CLAUDE.md. The load-bearing gotchas (Redis-or-500, replica-set MongoDB, Keycloak-before-app) and the config *rules* (`.env` no-inline-comments, `TRUSTED_PROXY`, `@/*` alias) stay inline in CLAUDE.md; this runbook holds the full procedures and the env-var tables.

## Local Dev Infrastructure

All dev/test infrastructure is split (feature 020) into **four independently operable named Compose stacks** under `infrastructure-as-code/docker/stacks/` — `auth`, `mcm`, `audit`, `observability`. Each is its own Compose project (`-p <stack>`) defined by a thin `include:`-only aggregator that pulls in only that stack's per-service files. The single root `compose.yaml` aggregator is **retired** (now a pointer). Stacks share the pre-created external networks for cross-stack traffic.

**First-time setup** (run once per machine):

```bash
docker network create backend-network
docker network create keycloak-network
docker network create movie-assistant-mcp-network
docker volume create mc-service-store-mongo-data
docker volume create keycloak-store-postgres-data
docker volume create mcm-bff-cache-redis-data
docker volume create mcm-bff-store-mongo-data
docker volume create movie-assistant-store-postgres-data   # agents
docker volume create agent-audit-opensearch-data           # audit
```

The Keycloak DB password (`KC_DB_PASSWORD`) is no longer a separate `.env.local` / file-secret
(feature 022) — it is one of the per-stack credentials minted into `stacks/auth.env` below and
interpolated by both Postgres and Keycloak.

**Generate local stack credentials (feature 021 — run once, before any `up-*`):**

```bash
node scripts/gen-dev-secrets.mjs
```

Every credential in the four stacks is externalized to a `${VAR:?…}` interpolation reference — no clear-text secret lives in a tracked compose file. The generator mints real per-machine values from the committed `infrastructure-as-code/docker/stacks/<stack>.env.example` templates into gitignored `<stack>.env` files, which Compose reads via each stack's `include` `env_file:` (and the Nx target's `--env-file`).

- **Idempotent**: a second run skips any stack whose `.env` already exists (your running stacks keep their values). `--force` rotates; `--stack=<auth|mcm|audit|observability>` scopes to one.
- **Fail-fast**: if a required value is missing/blank, `docker compose up`/`config` aborts naming the var (e.g. `required variable KC_BOOTSTRAP_ADMIN_PASSWORD is missing a value: set in stacks/auth.env`). Run the generator and retry.
- **Boundary**: `<stack>.env` is gitignored; `<stack>.env.example` is tracked (a `!*.env.example` carve-out in `.gitignore`). **Never commit a `<stack>.env`.** A CI gate (`scripts/check-no-inline-secrets.mjs`, wired into `naming-gate.yml`) fails the build if any literal credential is re-inlined into a compose file.
- See `infrastructure-as-code/docker/stacks/README.md` and `specs/021-externalize-compose-secrets/` for the full model.

> **Rotating a password-on-first-init credential** (postgres / OpenSearch / minio): these images bake the password into their data volume on first init and ignore later env changes. To actually rotate one, regenerate the `.env` (`--force`) **and** recreate the service with a fresh volume (`docker volume rm <name>` then re-create) — otherwise the container keeps the volume's original password and auth fails. Redis/Unleash-token/app-secret values have no such persistence and rotate on a plain restart.
>
> **Historical-credential scrub (`git filter-repo`)**: purging the pre-feature-021 literals from git *history* is a separate, coordinated post-merge step (see `specs/021-externalize-compose-secrets/` US3). It needs `git-filter-repo` (a dev-machine tool, **not** a repo dependency): install via `pipx install git-filter-repo` (or `pip install git-filter-repo`). Run only on a fresh mirror clone, never on your working branch.

**Stacks & profiles:**

| Stack (project) | Default services | Profiles |
| --- | --- | --- |
| `auth` | `keycloak-service` + `keycloak-store-postgres` + `keycloak-mailpit` | `vault` → + `vault-service` (prod) |
| `mcm` | test infra: `mc-service-store-mongo` (+ rs-init) + `mcm-bff-cache-redis` + `mcm-bff-store-mongo` | `app` → + `mc-service`; `bff-nonsecure` → + `mcm-bff-service-nonsecure` (:8082); `bff-secure` → + `mcm-bff-service-secure` (:8081) + `mcm-bff-tls-proxy` (:8443); `agents` → gateway + 3 MCP + `movie-assistant-store-postgres`; `agents-metro` → `movie-assistant-gateway-metro` |
| `audit` | — | `audit` → `agent-audit-opensearch` |
| `observability` | — | `observability` → LangFuse + otel-lgtm + `opa-service` + `unleash-service` |

> **Bring `auth` up BEFORE the `mcm` `app` profile** — mc-service fetches Keycloak JWKS on startup. There is no cross-project `depends_on` (feature 020); the ordering is manual. `--profile app` without Keycloak running hangs.

Via Nx (from repo root):

```bash
pnpm nx up-auth infrastructure-as-code           # keycloak trio (add --args=--profile=vault for vault-service)
pnpm nx up-mcm infrastructure-as-code            # mcm test infra + mc-service (--profile app)
pnpm nx up-audit infrastructure-as-code          # agent-audit-opensearch
pnpm nx up-observability infrastructure-as-code  # LangFuse + otel + opa + unleash
pnpm nx up-all infrastructure-as-code            # auth then mcm app, in order
pnpm nx down-mcm / down-auth / down-audit / down-observability / down-all
pnpm nx ps infrastructure-as-code                # status
```

Direct compose (e.g. to add the BFF or agents profile to the mcm stack):

```bash
docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml --profile app --profile bff-nonsecure up -d
docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml --profile agents up -d
docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml down   # tears down ONLY the mcm stack
```

> **Note:** `--profile` flags must come BEFORE `up`/`down` with Docker Compose v2.
>
> **Note:** Each stack is its own project, so `down` on one stack no longer tears down the others (the old single-project footgun is gone).

**Agents under the mcm stack (`--profile agents`) — the heavy variant (postgres checkpointer):** this is distinct from `scripts/agent-stack.mjs`, which is the *light* E2E variant (`docker run` + in-memory checkpointer, no postgres). The `--profile agents` gateway needs its Keycloak client secret for tool calls (token exchange) — there is no committed source, so supply it from the running Keycloak:

```bash
# fetch the agent-gateway client secret (Keycloak must be up)
SECRET=$(cd agents/movie-assistant && uv run python -c "import sys;sys.path.insert(0,'tests/integration');import kc_admin;print(kc_admin.gateway_secret(kc_admin.admin_token()))")
AGENT_GATEWAY_CLIENT_SECRET="$SECRET" docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml --profile agents up -d
```

Without the secret the gateway runs but tool calls fail-closed (chat works, add/query/organize don't). Host Ollama must be serving `qwen2.5`/`qwen2.5:32b` (or set `MODEL_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`). `spreadsheet-mcp` reaches Redis over `mcm-bff-network` (wired into its compose).

**Endpoints when running:**

| Service | URL |
| --- | --- |
| MongoDB | `mongodb://localhost:27017` |
| Redis | `redis://localhost:6379` |
| mc-service | `http://localhost:3001` |
| Keycloak Admin UI | `http://localhost:8099` (admin / change_me) |
| Mailpit | `http://localhost:8025` |

**Volume architecture**: Each stack aggregator uses `include:` to incorporate individual service compose files. Persistent data volumes are declared `external: true` with explicit names in each service's compose file so they keep their names after `include:` merges them (Docker Compose would otherwise prefix them with the project name):

| Volume name | Declared in | Owned by |
| --- | --- | --- |
| `mc-service-store-mongo-data` | `infrastructure-as-code/docker/mc-service/compose.yaml` | mc-service compose |
| `keycloak-store-postgres-data` | `infrastructure-as-code/docker/keycloak/compose.yaml` | keycloak compose |
| `mcm-bff-cache-redis-data` | `infrastructure-as-code/docker/bff/compose.yaml` | bff compose |
| `mcm-bff-store-mongo-data` | `infrastructure-as-code/docker/bff/compose.yaml` | bff compose |

The transient volume `keycloak-mailpit-data` (stores emails) gets the `mcm_` prefix (`mcm_keycloak-mailpit-data`) — that is acceptable since emails are ephemeral.

`docker compose down --volumes` only wipes transient volumes (`mcm_keycloak-mailpit-data`); all three persistent external volumes are untouched. To wipe persistent data, remove the external volumes manually after `docker compose down`.

**Without Redis, the BFF /login endpoint returns 500 "Authentication failed"** because the rate-limiter's first Redis call fails before returning a typed error.

**Integration tests require a replica-set-enabled MongoDB** — `MongoCollectionRepository::delete()` uses a multi-document transaction. Standalone MongoDB does not support transactions. The mcm stack starts `mc-service-store-mongo` with `--replSet rs0` and runs `mc-service-store-mongo-rs-init` automatically. For CI environments not using compose, start MongoDB manually:

```bash
# Start (or replace an existing standalone container)
docker run -d --name mc-db-test -p 27017:27017 \
  mongodb/mongodb-community-server:8.0.8-ubi9 mongod --replSet rs0 --bind_ip_all
# Initiate the replica set (once after first start)
docker exec mc-db-test mongosh --quiet \
  --eval "try { rs.status() } catch(e) { rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]}) }"
```

**MongoDB replica set hostname — always bring the mcm stack up**: The `mc-service-store-mongo-rs-init` service initialises the replica set with `host: 'localhost:27017'`. This hostname works from the host (via Docker port binding) and from mc-service in Docker (which uses `directConnection=true` to bypass rs-member discovery). Never start `mc-service-store-mongo` with a bare `docker run` command — doing so can result in the rs being initialised with `mc-service-store-mongo:27017` (Docker-internal only), causing host-side integration tests to fail with "No such host is known".

**Fixing a bad replica set hostname** (if `cargo test` fails with "No such host is known" or "mc-service-store-mongo:27017" in the error):

```bash
docker exec mc-service-store-mongo mongosh --quiet --eval "rs.reconfig({ _id: 'rs0', members: [{ _id: 0, host: 'localhost:27017' }] }, { force: true })"
```

**mc-service requires Keycloak running** — it fetches the JWKS endpoint on startup to cache the public key for JWT validation. Bring up the `auth` stack before the `mcm` stack's `app` profile.

Typical dev loop: `pnpm nx up-auth infrastructure-as-code` → `pnpm start` in `frontend/mcm-app` → test in browser. For mc-service development, also run `pnpm nx up-mcm infrastructure-as-code`.

## Service rename — update your local `.env` (feature 020)

Feature 020 unifies every service's `container_name` AND compose **service key** to one convention-conformant id (the Docker-internal DNS name). The committed compose/scripts/`.env*.example` already use the new names, but **gitignored `.env` files are per-environment** — each machine (and prod/Komodo) must apply this mapping by hand once. After editing, recreate the affected containers (`docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml --profile … up -d --force-recreate`; `node scripts/agent-stack.mjs` for the agent stack). The BFF reads `.env.docker` via `env_file` at container **create**, so a recreate is enough — no image rebuild.

| New DNS host (container == key) | Prior name(s) | Where it appears |
|---|---|---|
| `keycloak-service` | `keycloak` | `KEYCLOAK_URL` (frontend `.env.docker`, `agents/movie-assistant/.env.local`) |
| `keycloak-store-postgres` | `keycloak-db` | `KC_DB_URL` (keycloak compose) |
| `mc-service-store-mongo` | `mc-db` / `mc-service-db` | `MC_DB_URL` / any mongosh `--host` |
| `mcm-bff-cache-redis` | `mcm-redis` / `mcm-bff-cache` | `REDIS_URL` (frontend `.env.docker`) |
| `mcm-bff-store-mongo` | `mcm-bff-db` / `mcm-bff-store` | `MONGO_URL` in-container host (frontend `.env.docker`; host/Metro stays `localhost:27018`) |
| `movie-assistant-gateway` | `agent-gateway` (key) | `AGENT_GATEWAY_URL` (frontend `.env.docker`) |
| `movie-assistant-store-postgres` | `agent-db` / `movie-assistant-db` | `AGENT_DB_URL` (gateway) |
| `agent-audit-opensearch` | `opensearch` | `OPENSEARCH_URL` |
| `opa-service` | `opa` | `OPA_URL` |
| `unleash-service` | `unleash` | `UNLEASH_URL` (in-container) |

Host-port mappings are unchanged (`localhost:8099/8082/27017/27018/6379/5433`) — only the **container DNS names** changed, so host-side tools and tests that connect via `localhost:<port>` need no edits. Keycloak client IDs / token audiences (`agent-gateway`, `mcm-bff-service`, …) are **not** DNS and stay as-is. A non-updated `.env` fails with a clear DNS/connection error naming the old host — not a silent outage (no legacy aliases, by design).

> Host-side `docker exec`/`docker ps` now use the new names too: `docker exec mc-service-db …`, `docker ps --filter name=mcm-bff-cache`, etc.

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
| `MONGO_URL` | `mongodb://localhost:27018` (Metro); `mongodb://mcm-bff-store-mongo:27017` (container) |
| `MONGO_DB_NAME` | `bff_db` |

**Per-user agent config (feature 018).** The BFF stores each user's encrypted assistant credentials in the `user_agent_config` collection on its **OWN dedicated MongoDB instance, `mcm-bff-db`** — deliberately **separate** from mc-service's `mc-db` (the BFF must not reach across a service boundary into a backend service's database — constitution §Decoupling; it mirrors the BFF's already-separate Redis). `mcm-bff-db` starts by default with `docker compose up -d` (host port `27018`). Env vars:

- `AGENT_CONFIG_ENC_KEY` — the AES-256-GCM key for at-rest encryption of the per-user provider/TMDB secrets. **Required**; the BFF throws on startup in production if it is missing. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. The **same** value must be set wherever the BFF runs (Metro `.env.local` **and** the dev container `.env.docker`) or encrypt/decrypt across restarts/containers breaks. Never commit it (NFR-Sec-1).
- `MONGO_URL` — the BFF→`mcm-bff-store-mongo` connection: `mongodb://localhost:27018` from Metro/host, `mongodb://mcm-bff-store-mongo:27017` from the dev container. `mcm-bff-store-mongo` is a **plain standalone `mongod`** (the BFF store does single-doc upserts only — no transactions), so there is **no replica set and no `directConnection`** to worry about (unlike `mc-service-store-mongo`). `MONGO_DB_NAME` defaults to `bff_db`. First-time: `docker volume create mcm-bff-store-mongo-data`.

> **No shared model/TMDB credentials (FR-021/SC-002).** Feature 018 removed `MODEL_PROVIDER` / `OLLAMA_BASE_URL` / `ANTHROPIC_API_KEY` / `TMDB_API_KEY` from the **user-facing** assistant runtime — each user brings their own, injected per-run via the `X-Agent-Config` / `X-TMDB-Key` headers (decrypted in memory, never persisted/logged). Those env vars remain only for the keyless golden cassette gate and non-user-facing paths. Do **not** add a shared `TMDB_API_KEY` to `.env.docker`.

`TRUSTED_PROXY` (feature 009, finding #4): set to `true` only when the BFF runs behind a trusted reverse proxy (e.g., Caddy) that sets `X-Forwarded-For`. When `true`, the rate-limit client IP is the **right-most** XFF hop (the peer the proxy observed; left entries are client-spoofable). When `false` (default), client-supplied XFF is **not** trusted and IP-scoped rate limiting is skipped with a warning rather than collapsing all clients into one shared bucket. Non-loopback deployments MUST set `TRUSTED_PROXY=true` behind the proxy for per-IP limiting to be active.

### mc-service env vars

| Variable | Default | Notes |
| --- | --- | --- |
| `MC_DB_URL` | — | `mongodb://localhost:27017/mc_db` local (replica set required — see the Local Dev Infrastructure startup note above); `mongodb://mc-service-store-mongo:27017/mc_db?replicaSet=rs0&directConnection=true` Docker |
| `KEYCLOAK_URL` | — | `http://localhost:8099` local; `http://keycloak-service:8080` Docker |
| `KEYCLOAK_REALM` | `grumpyrobot` | — |
| `KEYCLOAK_CLIENT_ID` | `movie-collection-manager` | — |
| `MC_SERVICE_PORT` | `3001` | — |
| `RUST_LOG` | `info` | `mc_service=debug,axum=info` for targeted filtering |

Local dev: `backend/mc-service/.env.local` (gitignored). Docker values set in `infrastructure-as-code/docker/mc-service/compose.yaml`.

**mc-service fails to start if `MC_DB_URL` is unreachable or if Keycloak JWKS endpoint cannot be fetched** (JWKS is cached on startup for JWT validation).
