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

Other compose files that have services running on the same docker network (`backend-network`) can connect to this keycloak container by referencing `keycloak-service:8080`.

### Database

This setup uses a separate Postgres container for Keycloak's database with a docker volume to persist data across container instances.

### Creating Required Secrets

The compose file is configured to use Docker Compose secrets and .env variables for managing sensitive credentials. This keeps secrets out of your source code.

- `secrets/keycloak_db_password.txt` - The postgres db password referenced by the keycloak-db container.
- `.env.local` - The postgres db password referenced by the keycloak-service container.  The environment file is used because Keycloak doesn't currently support _FILE method of Docker Secrets.  This approach is not secure as password can be found in container using docker inspect.

Before running the compose.yaml, you need to create the required secrets for the postgres db. Replace "supersecretpassword" with your desired db password and run these commands from this directory:

```bash
mkdir -p secrets
echo "supersecretpassword" > secrets/keycloak_db_password.txt
echo "KC_DB_PASSWORD=supersecretpassword" > .env.local
```

### Running Keycloak

```bash
# Start the Keycloak containers
docker compose -f compose.yaml up -d
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
- Other compose files that have services running on the same docker network (`backend-network`) can connect to this keycloak container by referencing `keycloak-service:8080`.
- For more information on running Keycloak in a container, please see <https://www.keycloak.org/server/containers>
- For more information on configuring Keycloak, please see <https://www.keycloak.org/server/configuration>
- For more information on Keycloak health checks, please see <https://www.keycloak.org/observability/health>
- To track progress of Keycloak being able to accept docker secrets via _FILE, please see <https://github.com/keycloak/keycloak/issues/43958>
