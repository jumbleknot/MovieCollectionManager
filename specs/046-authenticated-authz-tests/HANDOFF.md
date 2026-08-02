# HANDOFF — feature 046, ready for `/speckit-plan`

**Written**: 2026-08-02 · **Branch**: `046-authenticated-authz-tests` (real branch, sequentially
numbered by the Spec Kit `before_specify` hook) · **Head**: `33c1292`

**State**: `spec.md` written, validated (16/16 checklist), committed. **Nothing implemented.**

**Your next command**: `/speckit-plan`. Do not re-run `/speckit-specify` — the spec is approved by
the owner. `.specify/feature.json` already points at `specs/046-authenticated-authz-tests`.

---

## 1. What this feature is

The authenticated half of `docs/proposals/PRD-McServiceHttpAuthzIntegration.md` (**G2**, its sole
remaining goal). Feature 045 got the mc-service integration suite to **zero ignored tests**, but every
assertion in it is unauthenticated — the suite proves `401` without a token and nothing else.

046 adds: an authenticated happy path, **cross-tenant `404`** (the security-critical assertion), and
RFC 9457 shape checks on authenticated error paths.

## 2. Measured facts — do not re-derive, do not contradict

Each of these cost real time to establish. They are verified, not inferred.

| Fact | Evidence |
|---|---|
| **ROPC works today.** `e2e-test-user` via client `mcm-bff-test` → `200`; token carries `aud` containing `movie-collection-manager` and `resource_access.movie-collection-manager.roles = ["mc-user"]`. | Minted live during design. **This was the PRD's flagged unknown ("ensure the audience mapper") and it is already solved.** |
| **A second real login is NOT available.** `e2e-admin-user` → `400 invalid_grant`. The hardcoded `E2eAdminP@ss123!` in `frontend/mcm-app/tests/e2e/web/setup/keycloak-admin.ts` is the password that file assigns to users **it creates**, not the seeded realm user's. | Measured. |
| **So cross-tenant needs no second identity.** Seed a collection through the repository with `ownerId = "<some other subject>"`, then request it over HTTP with the one real token. This is the established pattern in `movies/dac_authorization_test.rs` (`OWNER_A` / `USER_B`). | Design decision, owner-approved. |
| **Cross-tenant returns `404 CollectionNotFound`, never `403`.** Deliberate — "no existence leak", stated in `dac_authorization_test.rs`'s own file header. | Read from source. **The PRD's "403 for a non-owner" is wrong; spec FR-004 requires `404` and explicitly fails a `403`.** |
| **`DomainError::AccessDenied` (→403) has no production producer.** It appears only in mocked unit tests. The one reachable `403` is `require_app_role` (valid JWT lacking both `mc-user` and `mc-admin`). | `grep` across `src/`. |
| **`mc-admin` does not bypass owner scoping.** It appears only in the auth layer; no application or adapter code branches on it. | `grep` across `src/`. |
| **The realm is runtime-managed.** `grumpyrobot` lives only in the dev box's Postgres volume; there is **no committed realm source**. `ci-realm.json` is a sanitized export produced by `scripts/export-ci-realm.mjs`, which needs `KC_ADMIN_PASSWORD`. | Stated in that script's header. **This is why the `403` is deferred** — a role-less identity cannot be self-provisioned. |

## 3. Owner decisions already made — treat as settled

Three questions were asked and answered during brainstorming. Do not reopen them without asking:

1. **Scope** → assert *measured* behaviour (`404` cross-tenant, authenticated `200`, RFC 9457), and
   correct the PRD's `403` claim in writing. **Not** the PRD's original wording.
2. **Role-less user** → would have been seeded in the realm, but that was chosen *before* the
   runtime-managed-realm constraint surfaced. Net effect: **the `403` is deferred**, recorded under
   spec § Out of Scope with its prerequisite.
3. **Missing credentials** → **fail hard, always.** No skip, no conditional gate, no reintroduced
   `#[ignore]`. Rust has no skip and the 041 guard bans bare `#[ignore]`; more importantly feature 045
   established that passing for the wrong reason is worse than not running.

## 4. Approved design (approach A) — plan against this

- **Token helper** at `backend/mc-service/tests/integration/common/auth.rs`: one public
  `async fn user_token() -> String`. ROPC against `mcm-bff-test`, cached per test binary in a
  `tokio::sync::OnceCell`. Fails hard naming the missing variable.
- **`reqwest` → `[dev-dependencies]`.** Already in `Cargo.lock` at **0.12.28** (transitive via
  `axum-keycloak-auth`), so no new build cost. Do not add a second HTTP client.
- **Tests** in a **new** file `tests/integration/collections/http_authz_test.rs` (inside the existing
  `collections_test` binary), so the unauthenticated suite stays untouched and a red is unambiguous.
- **Reuse `common::build_test_app()`** — it already waits for JWKS discovery to succeed. Do not
  bypass or reimplement that gate; see §6.
- **Credentials**: helper reads `E2E_ROPC_CLIENT_ID`, `E2E_ROPC_CLIENT_SECRET`, `E2E_TEST_USER`,
  `E2E_TEST_PASSWORD` from the process env (`dotenvy` on `backend/mc-service/.env.local`). The
  mc-service CI step in `.forgejo/workflows/app-ci.yml` must gain the same four. Values currently live
  in `frontend/mcm-app/.env.e2e.local`; the owner accepted duplicating them into
  `backend/mc-service/.env.local` rather than having a Rust test read the frontend project's env file.

## 5. Environment

- Stacks are up in the devcontainer: `keycloak-service` (`127.0.0.1:8099`, realm `grumpyrobot`) and
  `mc-service-store-mongo` (`27017`, replica set `rs0`).
- **Do not** load `.env.e2e.local` with `set -a; . file` — a value contains characters that break
  shell sourcing (it emits `line 4: … command not found`). Use `dotenvy` in Rust, or a real parser.
- Run tests through Nx: `pnpm nx test:integration mc-service`.

## 6. Traps that already bit this work

- **A cached Nx run hides the real counts.** `pnpm nx test:integration mc-service` printed only
  "Successfully ran target" on a cache hit. Add `--skip-nx-cache` when you need the numbers. Verify by
  result, never by exit status.
- **The readiness gate must assert *success*, not merely yield.** OIDC discovery that ends in `Err`
  still marks the auth layer ready, so a bare `yield_now()` leaves the whole suite passing green
  against a dead Keycloak. Two guards at the end of `health_test.rs` keep this executable — leave them
  alone.
- **PRs: real branch + API. Never AGit.** `git push origin HEAD:046-authenticated-authz-tests`, then
  `POST /pulls` with the `git credential fill` token (**not** `MCM_FORGE_TOKEN`, which is read-only).
  An AGit head (`refs/pull/N/head`) receives **no Actions secrets** and fails as a bogus nx
  "Misconfigured remote cache endpoint". Authority: `docs/runbooks/ci-diagnostics.md` § Opening a pull
  request, indexed from the `CLAUDE.md` gates section.
- **SDD is a gate, not a formality.** 045 shipped code before its spec and had to be backfilled. The
  spec for 046 exists precisely so that does not repeat — write `plan.md` and `tasks.md` before any
  implementation code.

## 7. Verification bar to hit

- `node scripts/mc-service-integration-guard.mjs` — currently **164 executed / 0 ignored / 0 failed**
  on `main`. That count must go **up**, and ignored must stay **0**.
- **SC-003 broken-on-purpose**: remove owner scoping from one read path → the suite must go red;
  restore → green. 045 did the equivalent for the unauthenticated half (deleting `.layer(auth_layer)`
  turned 7 tests red).
- Flake bar: ≥20 consecutive runs, zero failures. 045's baseline was 20 rounds × 3 binaries = 60 runs,
  0 failures.
- `pnpm nx lint mc-service` (clippy `-D warnings`) clean. Note `--all-targets` has **9 pre-existing**
  failures on clean `main`; that is not the gate. Likewise `cargo fmt --check` drifts in 7 untouched
  files — format only what you touch.

## 8. Not pushed, deliberately

The branch is **local only**. Pushing it would trigger a full CI run on the single runner for a
docs-only change. Push when there is code worth testing.

## 9. Optional, skipped

The `after_specify` hooks are both `optional: true`: the git auto-commit (done manually, with a
fuller message) and `speckit.agent-context.update`. Run the latter if you want the managed agent
context refreshed.
