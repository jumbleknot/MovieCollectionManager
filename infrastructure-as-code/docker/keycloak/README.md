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
