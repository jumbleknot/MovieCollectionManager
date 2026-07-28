---
type: Service
title: mc-service (Rust/Axum movie-collection service)
description: The Rust/Axum microservice that owns all movie-collection domain logic — CRUD, business-rule validation, and RBAC/DAC enforcement — for MovieCollectionManager, built as four Clean Architecture layers with CQRS, repository, and specification patterns.
resource: docs/MCM-Architecture.md
tags: [rust, axum, clean-architecture, cqrs, mongodb]
timestamp: 2026-06-20T21:57:08-04:00
---

# mc-service (Rust/Axum movie-collection service)

`backend/mc-service` is the sole authority for collection and movie domain logic. The
[BFF](/openwiki/projects/bff.md) proxies every client request to it — the client never calls it
directly — forwarding the caller's JWT as a bearer token. It persists to its own dedicated MongoDB
instance and validates JWTs locally against a Keycloak JWKS cached at startup (see
[Auth chain](/openwiki/invariants/auth-chain.md)).

Four Clean Architecture layers, outer-to-inner import rule enforced (`domain` never imports from
`application`, `adapters`, or `api`):

| Layer | Path | Responsibility |
|---|---|---|
| Domain | `src/domain/` | Entities (`collection.rs`, `movie.rs`), `domain/specifications/` |
| Application | `src/application/` | Commands (`application/commands/`), queries (`application/queries/`), repository trait ports (`application/ports/`), DAC helper (`access_control.rs`) |
| Adapters (infrastructure) | `src/adapters/mongodb/` | MongoDB repository implementations, BSON↔domain DAOs, index setup |
| API (presentation) | `src/api/` | Axum route handlers, middleware, router assembly |

**CQRS**: one file per command (`create_collection.rs`, `delete_movie.rs`, …) and per query
(`list_movies.rs`, `get_filter_options.rs`, …) under `application/commands/` and
`application/queries/`. Handlers depend only on repository *traits*
(`Arc<dyn CollectionRepository>`), never the concrete Mongo adapter, which is what makes them
mockable in unit tests.

**Specification pattern**: `domain/specifications/spec.rs` defines a generic
`Specification<T>` trait with `AndSpec`/`OrSpec`/`NotSpec` combinators; concrete rules
(`collection_name.rs`, `rip_quality.rs`, `owned_media.rs`, …) are invoked from command handlers
before the repository is touched — business validation is checked in the application layer, not
the database.

## Gotchas

- **Auth is a tower layer, not a per-handler check.** `KeycloakAuthLayer<Role>` sits on the
  `protected` sub-router, so a new `/api/v1/` route is automatically protected without writing any
  auth code in the handler body. Per-handler `KeycloakToken<Role>` extractors exist only to *read*
  already-validated claims — they must never be the primary guard. `axum-keycloak-auth` by itself
  only checks signature and audience; the OR-logic `mc-user` OR `mc-admin` role check is a separate
  `require_app_role` middleware applied inside the layer.
- **JWKS is fetched once at startup — the service will not start without Keycloak.** JWT validation
  is entirely local after that (no per-request Keycloak round trip), but if Keycloak's JWKS endpoint
  or `MC_DB_URL` is unreachable at boot, mc-service fails to start rather than degrading. Always
  bring the auth stack up before the `app` profile.
- **Cascade delete needs a replica-set-enabled MongoDB.** `collection_repository.rs::delete()` runs
  the collection delete and its movies' delete inside one multi-document transaction, which
  transactions require. A bare `docker run mongo` (not the compose stack) will not work, and can
  even initialize the replica set with an internal-only hostname that host-side tests then can't
  resolve.
- **Vendored OpenSSL must stay musl-conditional.** The Alpine/musl Docker build needs a statically
  linked OpenSSL (`Cargo.toml`'s `[target.'cfg(target_env = "musl")'.dependencies]` block), because
  Alpine's `openssl-dev` only ships `.so` files. Do not move `openssl` with `features = ["vendored"]`
  into the unconditional `[dependencies]` section — that breaks `cargo test` on Windows, where `perl`
  (required to compile OpenSSL from source) is absent.
- **Errors are RFC 9457 `application/problem+json`, never a stack trace.** The catch-all handler in
  `src/api/middleware/error_handler.rs` maps every domain error to a Problem Details body — the BFF's
  `handleMcApiError()` on the other side expects exactly this shape.
- **~29% unit-test coverage is intentional, not a gap.** Clean Architecture concentrates the
  branching logic that's worth testing in the adapters/integration paths; those are exercised by
  integration tests instead. The CI coverage *floor* combines unit + integration to 70%.

See [Auth chain](/openwiki/invariants/auth-chain.md) for how mc-service fits into the end-to-end
authorization sequence, and `docs/MCM-Architecture.md` (dedicated "mc-service Architecture" section)
for the full layer/CQRS diagrammed description.
