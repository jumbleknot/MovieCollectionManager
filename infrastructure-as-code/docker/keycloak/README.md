# Keycloak Docker Compose Setup

## Setup Instructions

The compose file is configured to pull a postgres image and create a container for keycloak-db, and pull a keycloak image and create a container for keycloak-service, and pull a mailpit image and create a container for keycloak-mailpit.

### Prerequisites

- Docker Desktop installed and running.
- Docker Compose (included with Docker Desktop).

### Network

Docker Compose file expects an external docker network named `backend-network` to have already been created.  If this docker network does not exist in your docker environment, you must run the below command:

```bash
docker network create backend-network
```

Other compose files that have services running on the same docker network (`backend-network`) can connect to this keycloak container by referencing `keycloak-service:8080` (feature 020 unified the service key and container_name to `keycloak-service`; the old bare `keycloak` name no longer resolves).

### Database

This setup uses a separate Postgres container for Keycloak's database with a docker volume to persist data across container instances.

### Creating Required Secrets

Credentials are externalized to the per-stack env file `infrastructure-as-code/docker/stacks/auth.env`
(gitignored), interpolated as fail-fast `${VAR:?}` refs. Feature 022 made the DB password a **single
source of truth**: both `keycloak-store-postgres` (`POSTGRES_PASSWORD`) and `keycloak-service`
(`KC_DB_PASSWORD`) interpolate the SAME `${KC_DB_PASSWORD}` — no `secrets/*.txt` file-secret, no
`.env.local`.

Mint the dev values once (creates `stacks/auth.env` from `auth.env.example`, including a random
`KC_DB_PASSWORD`):

```bash
node scripts/gen-dev-secrets.mjs
```

> On an EXISTING Postgres volume, the DB keeps its original password — set `KC_DB_PASSWORD` in
> `stacks/auth.env` to that value (or wipe `keycloak-store-postgres-data` to re-init with a fresh one).

### Running Keycloak

Preferred (resolves `${KC_DB_PASSWORD}` etc. from `stacks/auth.env` via the Nx target):

```bash
pnpm nx up-auth infrastructure-as-code
```

Or directly — you MUST pass the env file so the `${VAR:?}` refs interpolate:

```bash
docker compose -f compose.yaml --env-file ../stacks/auth.env up -d
```

### Accessing Keycloak

Once the container is running, access the Keycloak admin console at:

- **URL:** <http://localhost:8099>
- **Username:** admin
- **Password:** change_me (use only on first login, change password in Keycloak, then use whatever you changed it to in subsequent logins)

### Cleaning Up

To remove the containers and clean up:

```bash
# Stop and remove containers
docker compose down
```

## Notes

- Keycloak is started in development mode (`start-dev`) which is suitable for local development only.
- Keycloak will be accessible from the host on `http://localhost:8099`.  
- For the admin console and API access, port 8099 is exposed externally, but containers running on the same docker network should use port 8080.
- The test mail client for use with keycloak will be accessible from the host on `http://localhost:8025/`.
- Other compose files that have services running on the same docker network (`backend-network`) can connect to this keycloak container by referencing `keycloak-service:8080` (feature 020 unified the service key and container_name to `keycloak-service`; the old bare `keycloak` name no longer resolves).
- For more information on running Keycloak in a container, please see <https://www.keycloak.org/server/containers>
- For more information on configuring Keycloak, please see <https://www.keycloak.org/server/configuration>
- For more information on Keycloak health checks, please see <https://www.keycloak.org/observability/health>
- To track progress of Keycloak being able to accept docker secrets via _FILE, please see <https://github.com/keycloak/keycloak/issues/43958>

## ⚠️ Realm JSON takes NO comments — not even a `_comment` key

Keycloak's import deserializes these files into `RealmRepresentation` with unknown fields **rejected**.
An extra key does not get ignored; the import fails, the server refuses to start, the container goes
`unhealthy`, and every job that depends on it dies at bring-up:

```text
ERROR: Unrecognized field "_comment_accessTokenLifespan" (class org.keycloak.representations.idm.RealmRepresentation)
ERROR: Failed to run import
```

Measured on app-ci run 1611 (feature 052), where a one-line explanatory key cost a full CI run. Note
that `python -c "import json"` says the file is **valid** — JSON syntax is not the constraint here, the
Keycloak schema is. So a local parse check proves nothing about whether the realm will import.

Document a realm setting **here**, not in the JSON. `scripts/__tests__/keycloak-realm-schema.test.mjs`
fails on any `_`-prefixed key at any depth.

### Why `ci-realm.json` sets `accessTokenLifespan: 5400` while `dev-realm.json` keeps `300`

Feature 052. Playwright creates a fresh `BrowserContext` per test, each reloading the `storageState`
snapshot global setup froze at the start of the run. With a 300 s token that snapshot is expired five
minutes in, so **every later test had to refresh before it could do anything** — a measured 1.9 s
median interval against the BFF's per-session refresh limit of 2 per 30 s, which rejected 35 of 115
attempts and bounced those tests to the login screen. A token that outlives the job's 75-minute
timeout removes the driver.

CI only. `dev-realm.json` keeps 300 s so local development still sees realistic expiry, and production
is untouched — no security control is relaxed. The refresh path keeps deliberate coverage:
`agent-session-refresh.spec.ts` clears the access cookie explicitly rather than waiting for expiry.

### Proving a realm edit actually imports (one minute, no CI)

The guard catches `_`-prefixed keys; only Keycloak can tell you the realm truly deserializes. Run the
importer against the real image before pushing a realm change:

```bash
mkdir -p /tmp/kcimport && cp ci-realm.json /tmp/kcimport/grumpyrobot-realm.json   # name must match the realm
docker run --rm \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  -e KEYCLOAK_CLIENT_SECRET=x -e KEYCLOAK_SERVICE_CLIENT_SECRET=x \
  -e AGENT_SUBJECT_TOKEN_CLIENT_SECRET=x -e E2E_TEST_PASSWORD=x -e MCM_BFF_TEST_CLIENT_SECRET=x \
  -v /tmp/kcimport:/opt/keycloak/data/import:ro \
  quay.io/keycloak/keycloak:26.7.0 import --dir /opt/keycloak/data/import
# want: "Realm 'grumpyrobot' imported"
```

The `${VAR}` placeholders are resolved from container env at import time, so any non-empty values do
for a syntax/schema proof.
