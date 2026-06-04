# Quickstart: Clean DAC Foundation — Verification Runbook

Backend-only feature (mc-service). Authorization is verified with real-MongoDB integration tests (constitution: no mocking in integration tests). Unit tests cover the domain method + handler logic with `mockall`.

## Prerequisites

```powershell
pnpm nx up-keycloak infrastructure-as-code   # Keycloak + Redis + Mongo (replica set) + mc-service deps
# RTK active (rtk gain >80% after the first run)
```

mc-service integration tests need a replica-set MongoDB (already provided by the root compose `mc-db --replSet rs0`).

## Unit tests (fast — domain + handlers)

```powershell
# Domain: role hierarchy
pnpm nx test mc-service -- authorizes

# Movie handlers: authorization + owner-ref stamping (mockall)
pnpm nx test mc-service -- create_movie
pnpm nx test mc-service -- update_movie
pnpm nx test mc-service -- delete_movie
pnpm nx test mc-service -- get_movie
pnpm nx test mc-service -- list_movies
```

Expected: `authorizes(owner, Contributor/Viewer)` true; `authorizes(viewer, Contributor)` false; handlers return `CollectionNotFound` when unauthorized and never reach the movie repository on denial.

## Integration tests (real MongoDB — the DAC proof)

```powershell
pnpm nx test:integration mc-service -- --test dac_authorization
```

Scenarios (US1/US2/US3):

- **US1** As user A (owner), create a collection. As user B, attempt create/update/delete a movie in A's collection → `404`, nothing written. As A → success.
- **US1** Write to a non-existent collection id → `404` (same as unauthorized).
- **US2** As A, list/filter/get movies → identical to today. As B → `404`. With a **seeded viewer** ACL entry for B → B can read.
- **US3** After any write, the movie's `ownerId` equals the collection owner. With a **seeded contributor** B performing a write → the movie's `ownerId` is the collection owner, not B.
- **Uniqueness** A duplicate `{title, year, contentType}` in the same collection is still rejected.

> Seeded contributor/viewer entries are written directly into the collection's `acl` by the test setup (granting endpoints are out of scope); they exercise the enforcement seam (SC-006).

## Full regression (final validation)

```powershell
pnpm nx test mc-service                 # unit
pnpm nx test:integration mc-service     # integration (movies + collections)
pnpm nx lint mc-service                 # clippy, no warnings
cargo tarpaulin --manifest-path backend/mc-service/Cargo.toml --ignore-tests --out Lcov   # ≥70%
rtk gain                                # >80%
```

Expected: all green; coverage ≥70%; existing movie/collection suites unaffected (owner behavior unchanged).
