# Phase 0 research — authenticated HTTP authorization tests

**Feature**: 046 · **Date**: 2026-08-02

The Technical Context in [plan.md](./plan.md) carries **no `NEEDS CLARIFICATION` markers**. That is
not because the questions were skipped — it is because they were answered by measurement during
brainstorming, before the spec was written. This file records those answers, the decisions built on
them, and what was rejected.

Facts marked **measured** were established by running something, not by reading or inferring.

---

## R1 — How does the test suite obtain a real end-user credential? (FR-001, FR-009)

**Decision**: OAuth2 **Resource Owner Password Credentials** (ROPC) against the `grumpyrobot` realm,
using client `mcm-bff-test` with its secret, for user `E2E_TEST_USER`.

**Rationale**:

- **Measured**: the login succeeds today and returns `200`. The issued access token carries
  `aud ∋ movie-collection-manager` and
  `resource_access.movie-collection-manager.roles = ["mc-user"]` — precisely the two things
  `build_auth_layer`'s `expected_audiences` and `require_app_role` check. The parent PRD flagged
  "ensure the audience mapper exists" as an open unknown; **it is already solved**, and no realm
  change is needed.
- Requires no operator action per run and no administrative privilege on Keycloak (FR-009).
- It is the same grant the frontend E2E suite and the BFF integration suite already use, so the
  credential plumbing in CI exists and is proven.

**Alternatives considered**:

| Alternative | Verdict |
|---|---|
| Mint a token via the Keycloak **Admin API** (impersonation / direct grant on behalf of a user) | **Rejected.** Needs administrative credentials, violating FR-009, and the service account is scoped for user administration, not token issuance. |
| **Client-credentials** grant (service account token) | **Rejected.** Its `sub` is the service account, not an end user, and the DAC model this feature tests is user-subject-scoped. It would test a different thing and quietly. |
| **Hand-craft a JWT** signed by a test key | **Rejected outright.** It would mean pointing the service at a fake issuer — the test would then prove that a fake token is accepted, which is the opposite of the assurance wanted, and it violates Test Type Integrity. |
| **Skip** when no credential is available | **Rejected, emphatically.** Feature 045's whole lesson is that a suite passing for the wrong reason is worse than one that is ignored; Rust has no skip primitive, and the 041 guard bans a bare `#[ignore]`. FR-007 makes fail-hard a requirement. |

---

## R2 — Which HTTP client makes the token request, and at what build cost?

**Decision**: `reqwest`, promoted to `[dev-dependencies]` as
`{ version = "0.12", default-features = false, features = ["json", "rustls-tls"] }`.

**Rationale**:

- **Measured**: `reqwest` **0.12.28 is already in the workspace `Cargo.lock`** (line 2768),
  transitively via `axum-keycloak-auth` — which uses it to fetch OIDC discovery and JWKS. Declaring
  it adds **no new `[[package]]`**; the only lock change is `reqwest` appearing in `mc-service`'s own
  dependency list.
- `rustls`, `hyper-rustls` and `webpki-roots` are likewise already in the lock, so `rustls-tls` costs
  nothing new either. Declaring features explicitly rather than relying on Cargo's feature
  unification means the helper keeps working if `axum-keycloak-auth` later changes its own feature
  selection (plan R3).
- The service under test is **not** reached over the network — `tower::ServiceExt::oneshot` drives
  the router in-process, as every existing HTTP test does. `reqwest` talks to Keycloak only.

**Alternatives considered**: hand-rolling the token POST on `hyper` (already a dependency) — rejected
as more code for no gain; adding a second client such as `ureq` — rejected, it would be the only new
package in the lock and duplicates a capability already compiled in.

**Verification**: `git diff Cargo.lock` after the change must show no added `[[package]]` block.

---

## R3 — Where does the "other tenant" come from? (FR-004, FR-005)

**Decision**: seed the foreign-owner fixture **through the repository** with an owner id that is not
the test identity's subject, then request it over HTTP with the one real token.

**Rationale**:

- **Measured**: a second real login is **not available**. `e2e-admin-user` returns
  `400 invalid_grant`. The hardcoded `E2eAdminP@ss123!` in
  `frontend/mcm-app/tests/e2e/web/setup/keycloak-admin.ts` is the password that file assigns to users
  **it creates**, not the seeded realm user's password.
- A second identity is **not needed**. Ownership is a stored string compared against the JWT
  subject; a foreign owner is any subject that is not the authenticated one. This is the established
  pattern in `movies/dac_authorization_test.rs` (`OWNER_A` / `USER_B`) — this feature lifts it to the
  HTTP boundary.
- The fixture cannot be created over HTTP: every write path stamps `owner_id = token.subject`, so an
  HTTP-created collection is by construction owned by the test identity.

**Consequence for the harness** (this is what forced a design change rather than a pure addition):
the fixture must be written into **the same database the router is wired to**, and
`common::build_test_app()` creates that database internally and drops the handle. Hence the new
`build_test_app_with_db()` accessor — see plan § Design 2.

**Guard against a vacuous pass**: the fixture must assert that its owner differs from
`user_subject()`, and that the row exists in Mongo at the moment the `404` is observed. Without both,
a `404` proves nothing.

---

## R4 — Is `404` correct, or should a non-owner get `403`?

**Decision**: `404`, and the parent PRD's `403` claim is **wrong** and is corrected in writing.

**Rationale** — read from source, not inferred:

- `movies/dac_authorization_test.rs`'s own file header states the design: cross-tenant access is
  denied with `CollectionNotFound` — "no existence leak". Every DAC test in that file asserts
  `CollectionNotFound`.
- `error_handler.rs` maps `DomainError::CollectionNotFound` → `404` with type
  `…/errors/COLLECTION_NOT_FOUND`.
- **Measured by `grep` across `src/`**: `DomainError::AccessDenied` (→ `403`) has **no production
  producer** — it appears only in mocked unit tests. The single reachable `403` is `require_app_role`
  rejecting a valid JWT that lacks both `mc-user` and `mc-admin`.
- **Measured by `grep` across `src/`**: `mc-admin` does **not** bypass owner scoping. It appears only
  in the auth layer; no application or adapter code branches on it. So an administrator identity is
  not a special case for isolation.

**Consequence**: FR-004 requires `404` **and explicitly fails a `403`**. The tests assert both the
positive and the negative (`assert_ne!(…, FORBIDDEN)`), so a future change that "helpfully" starts
returning `403` — reintroducing the existence leak — turns the build red rather than quietly passing
a laxer check.

---

## R5 — Why is the insufficient-role `403` deferred?

**Decision**: out of scope, with the prerequisite recorded.

**Rationale**: proving `require_app_role` refuses a role-less credential needs a role-less identity.
**Measured**: the `grumpyrobot` realm is **runtime-managed** — it lives only in the dev box's Postgres
volume and there is **no committed realm source**. `ci-realm.json` is a sanitized export produced by
`scripts/export-ci-realm.mjs`, which itself needs `KC_ADMIN_PASSWORD`. Creating the identity
therefore requires either an operator step on Keycloak plus a re-export, or an administrative
credential deliberately unavailable to a developer session.

The trade is stated plainly in the spec: `require_app_role` is a small, centralized check; the
isolation boundary this feature does cover is the security-critical one. Deferring the smaller item
to keep the larger one shippable is the right call, and the prerequisite is written down so it is a
decision rather than an omission.

---

## R6 — How is the authenticated subject known independently of the service?

**Decision**: base64url-decode the access token's payload segment and read the `sub` claim, using the
`base64` and `serde_json` crates already in `[dependencies]`.

**Rationale**: FR-003 requires that the **recorded owner matches the authenticated identity**. Taking
the `ownerId` out of the service's own response and comparing it to itself would be circular — it
would pass even if the service stamped a constant. The subject must come from the credential.

No signature verification is performed in the helper, and none is wanted: the token's authenticity is
proven by the *service* accepting it, which is exactly what US2 asserts. A verifying decoder in the
test would only duplicate the layer under test.

**Alternative considered**: call Keycloak's `userinfo` endpoint for the subject — rejected as a
second network round trip for information already inside the token the test is holding.

---

## R7 — Fail-hard, and how to make that assertion executable

**Decision**: panic with a message naming the missing variable; extract the env read and the payload
decode as **pure functions returning `Result<_, String>`** so the failure text can be asserted
directly.

**Rationale**: FR-007 and SC-005 demand that an absent credential produces a failure that names the
cause. A test that verifies this by unsetting a process-wide variable mid-suite would work under the
guard's `--test-threads=1` but is a landmine for any future parallel run, and mutating process env in
Rust is racy by nature. Testing the pure function tests the same message with none of that.

The identity-provider-unreachable half of SC-005 is **already covered** and must not be
re-implemented: `common::build_test_app()` asserts that OIDC discovery became *operational*, and the
two guards at the end of `health_test.rs` keep that executable. 045 established that a bare
`yield_now()` leaves the whole suite green against a dead Keycloak — leave those guards alone.

---

## R8 — What environment does the suite need, and where does CI get it?

**Decision**: four variables — `E2E_ROPC_CLIENT_ID`, `E2E_ROPC_CLIENT_SECRET`, `E2E_TEST_USER`,
`E2E_TEST_PASSWORD` — read from process env, loaded locally from
`backend/mc-service/.env.local` via `dotenvy`.

**Rationale**:

- CI already has all four in the `app-e2e` job: the bring-up step mints `E2E_ROPC_CLIENT_SECRET` and
  writes it to `$GITHUB_ENV` (app-ci.yml:389-390), and the job env supplies `E2E_TEST_USER` /
  `E2E_TEST_PASSWORD` from repository secrets (app-ci.yml:256-257). Forwarding them into the existing
  `docker run` with the bare `-e NAME` form restates no secret in the workflow file.
- Locally the values live in `frontend/mcm-app/.env.e2e.local`. The owner accepted **duplicating**
  them into `backend/mc-service/.env.local` rather than having a Rust test reach into the frontend
  project's env file. Both files are gitignored.
- `dotenvy` must be used rather than shell sourcing: **measured** — `set -a; . .env.e2e.local` breaks
  on a value containing shell metacharacters (`line 4: … command not found`).
- The helper attempts both `backend/mc-service/.env.local` and the default `.env`, ignoring failure,
  because the test binary's working directory differs between a repo-root `--manifest-path` run and a
  package-root run. `common::test_db()` already does exactly this; the helper matches it rather than
  inventing a second convention.

---

## R9 — New test binary, or a new module in an existing one?

**Decision**: a new **module** — `collections/http_authz_test.rs` — inside the existing
`collections_test` binary.

**Rationale**: the 045 suite stays byte-identical, so a red is unambiguously this feature's. And the
guard derives its binary list from the `[[test]]` targets and requires every discovered binary to
execute ≥ 1 test — a new binary adds a new way for the count to be wrong; a new module cannot.

**Alternative considered**: a dedicated `authz_test` binary for clean isolation — rejected. It would
pay a full second link + JWKS discovery cycle for a presentational benefit, and it would add a
`[[test]]` target that the guard must then account for.
