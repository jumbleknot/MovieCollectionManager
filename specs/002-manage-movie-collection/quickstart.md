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
KEYCLOAK_REALM=grumpyrobot
KEYCLOAK_CLIENT_ID=movie-collection-manager
MC_SERVICE_PORT=3001
RUST_LOG=info
```

For Docker-internal networking (mc-service inside Docker), all required vars are set directly in
`infrastructure-as-code/docker/mc-service/compose.yaml` — no additional env file is needed.

---

## 3. Configure BFF Environment

### Local development

The BFF reads `MC_SERVICE_URL` to proxy collection and movie API calls to mc-service. Add to `frontend/mcm-app/.env.local`:

```env
MC_SERVICE_URL=http://localhost:3001
```

`MC_SERVICE_URL` defaults to `http://localhost:3001` if not set, so local dev will work without this line.

### Docker deployment

The BFF Docker container connects to mc-service via the `backend-network` internal hostname. `MC_SERVICE_URL=http://mc-service:3001` **must** be set in `.env.docker`:

```env
MC_SERVICE_URL=http://mc-service:3001
```

This is already included in `frontend/mcm-app/.env.docker` and `.env.docker.example`.

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

---

## 10. Known Gaps and Status (T162 Validation)

Gaps found and **fixed** during T162 validation:

**Gap 1 — `MC_SERVICE_URL` missing from BFF env files**

- Impact: BFF Docker deployment used the `http://localhost:3001` default — wrong hostname inside Docker network.
- Fix: Added `MC_SERVICE_URL` to `.env.local`, `.env.example`, `.env.docker`, `.env.docker.example`.

**Gap 2 — mc-service `compose.yaml` referenced a non-existent `backend/mc-service/.env` file**

- Impact: `docker compose up` would fail with "env_file not found".
- Fix: Removed the `env_file` entry; all required vars are already declared in the `environment` section.

Outstanding gaps requiring full-stack run to verify (T067, T107, T138, T152):

- Collection E2E tests (create, browse, edit*, delete*) — *edit and delete tests are RED until HomeScreen wires edit modal and delete confirmation dialog
- Movie add/edit E2E tests
- Movie browse/search/filter E2E tests
- Movie delete E2E tests

> **RED tests**: `collection-edit.yaml`, `collection-delete.yaml`, and the corresponding web Playwright scenarios in `collections.spec.ts` are intentionally failing (TDD RED) — `handleEdit` in `home-screen.tsx` is a stub, and `DeleteConfirmationDialog` is not yet wired to the home screen delete action.
