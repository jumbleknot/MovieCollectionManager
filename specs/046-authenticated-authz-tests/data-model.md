# Phase 1 data model — test fixtures and their invariants

**Feature**: 046 · **Date**: 2026-08-02

This feature adds **no domain entity**. `MovieCollection`, `Movie` and `DomainError` are unchanged —
see [openwiki/architecture/data-model.md](../../openwiki/architecture/data-model.md) for the real
domain model. What follows is the *test-fixture* model: the three things the spec names under Key
Entities, expressed concretely, plus the invariants that keep each assertion meaningful.

---

## 1. Test identity

The seeded end-user account whose credential the suite obtains.

| Property | Value / source |
|---|---|
| Username | `E2E_TEST_USER` (process env) |
| Password | `E2E_TEST_PASSWORD` (process env) |
| Realm | `KEYCLOAK_REALM` — `grumpyrobot` |
| Application role | `mc-user`, via `resource_access.movie-collection-manager.roles` |
| Stable subject | the token's `sub` claim, surfaced as `common::auth::user_subject()` |

**Invariants**

- **I-1.1** The identity resolves to the same `sub` for every request in a run — it is read once from
  the cached token, so this holds by construction.
- **I-1.2** The identity holds `mc-user` or `mc-admin`. Not asserted directly; it is proven
  transitively, because `require_app_role` would otherwise answer `403` and the US2 control test
  (`authenticated_request_is_never_unauthorized`) would fail.

**Lifecycle**: pre-existing in every environment where the suite runs. The suite never creates,
modifies or deletes it.

---

## 2. Credential

The short-lived bearer token proving the test identity.

| Property | Value / source |
|---|---|
| Grant | OAuth2 ROPC (`grant_type=password`) |
| Client | `E2E_ROPC_CLIENT_ID` (`mcm-bff-test`) + `E2E_ROPC_CLIENT_SECRET` |
| Endpoint | `{KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}/protocol/openid-connect/token` |
| Audience | must contain `movie-collection-manager` (the service's `KEYCLOAK_CLIENT_ID`) |
| Scope of caching | one per **test binary**, in a `tokio::sync::OnceCell` |

**Invariants**

- **C-2.1** Acquired at most once per test binary. Contention is safe — `OnceCell` serializes
  initialization.
- **C-2.2** Never logged, never printed, never embedded in an assertion message. A failure names the
  *variable* or the *endpoint*, never a value. (Constitution: Sensitive Data Prohibition.)
- **C-2.3** Not refreshed. The suite completes far inside the token lifetime — declared as an
  assumption in the spec, and the failure mode if it were ever violated is a loud `401` on the US2
  control test, not a silent pass.
- **C-2.4** Its `sub` is derived by decoding the payload, **not** by reading it back out of a service
  response — otherwise FR-003's owner check would be circular.

**Lifecycle**: minted on first use in a binary; discarded when the process exits. Nothing persists it.

---

## 3. Foreign-owner fixture

A collection — and for the movie case, a movie inside it — recorded against a subject that is
deliberately not the test identity. It exists solely to be refused.

| Property | Value / source |
|---|---|
| Owner id | a fixed non-subject string, e.g. `other-tenant-subject` |
| Created via | `MongoCollectionRepository::create(owner, dto)` / `MongoMovieRepository`, against the database returned by `common::build_test_app_with_db()` |
| Visible to | the router under test, because it is the *same* database the router is wired to |
| Cleaned up by | `common::cleanup_db(&db)` before the test asserts |

**Invariants** — these are what stop the whole exercise from being vacuous, and each is asserted:

- **F-3.1 The owner must differ from the test identity's subject.** If they were equal the
  "cross-tenant" requests would be reading the user's own data and would pass for entirely the wrong
  reason. Asserted explicitly against `user_subject()`.
- **F-3.2 The fixture must exist in Mongo when the `404` is observed.** A `404` against a
  non-existent row proves nothing about isolation. Tests 5 and 6 re-read the document after the
  refusal to confirm it is both still there and unmodified.
- **F-3.3 Each test owns its own database.** `test_db()` names the database with a fresh UUID per
  call, so one test's foreign fixture is unreachable from another — the spec's concurrency edge case
  is closed by construction, independently of `--test-threads`.

**Lifecycle**: created inside a single test, dropped with the database at the end of that test. The
suite leaves no residue.

---

## Relationships

```text
Test identity ──(ROPC)──▶ Credential ──(Bearer)──▶ router under test
      │                        │                          │
      │                     sub claim                      │ owner-scoped query
      ▼                        ▼                          ▼
  expected owner  ═══ compared ═══▶  stored ownerId   Foreign-owner fixture
                                     (FR-003)          (owner ≠ sub → 404, FR-004/FR-005)
```

## State transitions

None. Every entity here is either read-only (test identity), write-once (credential), or
create-then-drop within one test (fixture). No entity changes state during a test, which is why the
"credential expires mid-run" case could be ruled out of scope rather than handled.
