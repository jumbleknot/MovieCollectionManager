# Quickstart: Manage Movie Collection

**Prerequisites**: Feature 001 infrastructure must be running (Keycloak on port 8099, Redis on port 6379). See `specs/001-user-login/quickstart.md`.

---

## 1. Start MongoDB and mc-service (Docker)

mc-service and mc-db are managed by their own compose file (separate from the BFF):

```bash
docker compose -f infrastructure-as-code/docker/mc-service/compose.yaml up -d
```

MongoDB will be available at `mongodb://localhost:27017` from the host.

> **Internal Docker hostnames**: `mc-db:27017` (MongoDB), `mc-service:3001` (mc-service API) — used within the `backend-network`.

---

## 2. Configure mc-service Environment

Create `backend/mc-service/.env.local` (gitignored):

```env
MC_DB_URL=mongodb://localhost:27017/mc_db
KEYCLOAK_URL=http://localhost:8099
KEYCLOAK_REALM=jumbleknot
KEYCLOAK_CLIENT_ID=movie-collection-manager
MC_SERVICE_PORT=3001
RUST_LOG=info
```

For Docker-internal networking (mc-service inside Docker):

```env
MC_DB_URL=mongodb://mc-db:27017/mc_db
KEYCLOAK_URL=http://keycloak-service:8080
KEYCLOAK_REALM=jumbleknot
KEYCLOAK_CLIENT_ID=movie-collection-manager
MC_SERVICE_PORT=3001
RUST_LOG=info
```

---

## 3. Configure BFF Environment

Add to `frontend/mcm-app/.env.local`:

```env
MC_SERVICE_URL=http://localhost:3001
```

For Docker deployment (BFF inside Docker):

```env
MC_SERVICE_URL=http://mc-service:3001
```

---

## 4. Run mc-service (Development)

```bash
pnpm nx serve mc-service
```

mc-service will be available at `http://localhost:3001`.

---

## 5. Build and Deploy mc-service (Docker)

```bash
pnpm nx build mc-service       # builds Docker image
pnpm nx deploy mc-service      # starts mc-service + mc-db containers
```

Or directly with Docker Compose:

```bash
docker compose -f infrastructure-as-code/docker/mc-service/compose.yaml up -d
```

---

## 6. Start the Frontend

```bash
cd frontend/mcm-app && pnpm start
# Press w for web, a for Android
```

> `pnpm start` is the documented exception to using Nx — there is no Nx target for the Expo Metro dev server. All other operations use `pnpm nx`.

---

## 7. Verify the Stack

Check mc-service health:

```bash
curl http://localhost:3001/health
# Expected: {"status":"ok"}
```

Check BFF can reach mc-service (after login):

```bash
curl -b "session=..." http://localhost:8081/bff-api/collections
# Expected: {"items":[]}  (empty list for a new user)
```

---

## 8. Running Tests

The `@monodon/rust` Nx plugin provides native `test` and `test:integration` executors for mc-service. Nx determines the correct crate automatically from `project.json`. Cargo arguments can be passed through using `--`:

```bash
# mc-service unit tests
pnpm nx test mc-service

# mc-service integration tests (requires MongoDB running)
pnpm nx test:integration mc-service

# Pass cargo flags through (e.g., run a specific test by name)
pnpm nx test mc-service -- --test collection_create

# Frontend unit tests
pnpm nx test mcm-app

# Frontend integration tests (requires full stack running)
pnpm nx test:integration mcm-app

# Web E2E tests (requires Expo running on :8081)
pnpm nx e2e mcm-app

# Mobile E2E tests (requires Android emulator)
pnpm nx e2e:mobile mcm-app
```

---

## 9. MongoDB Access (Debugging)

Connect to the local MongoDB instance:

```bash
mongosh mongodb://localhost:27017/mc_db
```

Useful queries:

```js
// List all collections
db.movie_collections.find().pretty()

// Count movies per collection
db.movies.aggregate([{ $group: { _id: "$collectionId", count: { $sum: 1 } } }])

// Drop all data (dev reset)
db.movie_collections.drop()
db.movies.drop()
```
