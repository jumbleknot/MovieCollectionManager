# PRD — mc-service HTTP-Layer Authorization Integration Tests (Un-ignore the Auth-Negative Cases)

**Status:** Proposed

**Created:** 2026-07-18

**Context:** Discovered while implementing **feature 041** (Integration-Test CI Enforcement, PR #80). Wiring
`mc-service test:integration` into `app-e2e` surfaced that **~21 mc-service integration tests are
`#[ignore]`d** — the mc-service analog of the agent-suite rot that PR #77 exposed. Unlike the agent quarantine,
these carry *documented* reasons and pre-date this work; most are legitimately parked. But a **subset** — the
HTTP-boundary **authorization-negative** cases — is a genuine coverage gap that app-e2e's now-live Keycloak makes
runnable for the first time. This PRD scopes only that subset; it deliberately does **not** try to un-ignore
everything.

**Related:**
[backend/mc-service/tests/integration/collections/http_test.rs](../../backend/mc-service/tests/integration/collections/http_test.rs),
[backend/mc-service/tests/integration/movies/](../../backend/mc-service/tests/integration/movies/),
[backend/mc-service/tests/integration/health_test.rs](../../backend/mc-service/tests/integration/health_test.rs),
[backend/mc-service/src/api/](../../backend/mc-service/src/api/) (`KeycloakAuthLayer` + `require_app_role`),
[specs/041-integration-test-ci-enforcement/IMPLEMENTATION-STATUS.md](../../specs/041-integration-test-ci-enforcement/IMPLEMENTATION-STATUS.md) (where this was recorded),
[PRD-IntegrationTestCIEnforcement.md](./PRD-IntegrationTestCIEnforcement.md) (parent),
`CLAUDE.md` §"mc-service auth is layer-not-handler" (the invariant this protects).

---

## 1. Problem Statement

mc-service's authorization is **layer-not-handler** by design (constitution §Centralized Access Control): a
`KeycloakAuthLayer<Role>` tower layer + a `require_app_role` `from_fn` middleware protect the whole `/api/v1`
sub-router, so a **new route is auto-protected without any auth code in its handler**. The strength of that design
is also its risk: its failure mode is **silent**. A misconfigured layer, a route accidentally mounted outside the
protected sub-router, or a broken OR-role check can still pass every happy-path test (a valid token works) while a
negative case quietly regresses — e.g. a route returns `200` where it must `403`, or `401` degrades to `500`.

Today those negative paths are verified **almost nowhere**:

- **Adapter/application integration tests** (the ones that pass, 23/0 for collections) test the repository +
  handler logic against real Mongo — but they build no HTTP stack and no auth layer.
- **Web/mobile E2E** drives real user flows through the BFF — but only **happy paths with a valid token**. It
  never exercises "no token → 401", "wrong owner → 403", "wrong role → 403", or the exact RFC 9457 error body.
- **US3 (mcm-app BFF integration, feature 041)** exercises the mc-service HTTP layer through the BFF, but again
  centered on authorized flows; the BFF's own RBAC short-circuits most negatives before mc-service sees them.

So the **HTTP-boundary authorization-negative behavior of mc-service is effectively untested.** The tests that
*would* cover it already exist — they are `#[ignore]`d.

### The ignored tests (21), and which ones this PRD targets

| Group | Count | Files | Verdict |
|---|---|---|---|
| **HTTP auth-negative + route-wiring** (401 without JWT, 403 ownership/role, 404-vs-401 wiring, RFC 9457 shape) | ~6–8 | `collections/http_test.rs`, `movies/http_*` | **Target — un-ignore** |
| HTTP happy-path CRUD over the full stack | ~9–11 | same files | **Leave ignored** — redundant with adapter tests + E2E + US3 |
| `health_test` liveness/readiness | 2 | `health_test.rs` | Opportunistic — fix the `is_pending()`/tracing blocker, then decide |
| Wrong-layer adapter tests | 2 | `movies/create_test.rs` | **Delete** — `OwnedMediaWhenNotOwned`/`RipQualityWhenNotRipped` are enforced in `CreateMovieHandler`, not the adapter; correctly verified in `http_create_update_test.rs`. Running them would fail; they test the wrong layer. |

### Why they're ignored (three real blockers, not laziness)

1. **`axum-keycloak-auth 0.8.x` JWKS-timing flake.** `build_test_app()` constructs the real `KeycloakAuthLayer`,
   whose JWKS background discovery can complete *between* consecutive `build_test_app()` calls in the same process,
   tripping an internal `is_pending()` assertion. This is an **in-process/sequential-run** artifact, not a
   mc-service bug — the documented reason `"verified in E2E"`.
2. **No JWT-minting helper exists in the Rust suite.** The happy-path/403 tests need a *valid* Keycloak token; the
   mcm-app and agent suites mint ROPC tokens against Keycloak, but the mc-service integration harness never has.
3. **Global tracing-subscriber conflict** (`health_test`): two tests both call the tracing init → panic when run in
   one process.

---

## 2. Goals / Non-Goals

### Goals

- **G1.** Make `build_test_app()`'s JWKS initialization **deterministic** (no `is_pending()` flake) so the auth
  layer can be exercised in-process without reintroducing the flakiness feature 041 exists to eliminate.
- **G2.** Add a **ROPC token helper** to the mc-service integration harness (mint an `mc-user` / `mc-admin` / a
  second non-owner user token against the live Keycloak, mirroring the `mcm-bff-test` pattern; ensure the audience
  mapper so tokens validate).
- **G3.** **Un-ignore the ~6–8 auth-negative + route-wiring tests** so they run in the feature-041 `app-e2e`
  mc-service step against live Keycloak.
- **G4.** **Delete** the 2 wrong-layer `create_test` cases.
- **G5.** Fix the `health_test` tracing-init conflict (`try_init()` / a `OnceLock` guard) and un-ignore what
  becomes deterministic.

### Non-Goals

- Un-ignoring the **happy-path CRUD** HTTP tests (G-out): redundant with the adapter suite + E2E + US3 — not worth
  the maintenance for near-zero marginal coverage.
- Replacing or reducing the web/mobile E2E legs.
- The feature-041 **agent un-quarantine** (buckets A/B/C) — separate track.
- Any change to production auth behavior — this is test-enablement only.

---

## 3. Proposed Solution

### 3.1 Spike first (go/no-go gate)

The whole proposal hinges on G1. **Before any test work**, spike whether the `is_pending()` JWKS timing can be
made deterministic on `axum-keycloak-auth 0.8.x`:

- **Option A (preferred):** build the app **once** per test binary (a shared `OnceCell<Router>` / lazily-built
  app), and add a **readiness gate** that blocks the first request until JWKS discovery has completed (poll a
  known-401 route until the layer stops returning the pending state, or use any readiness hook the crate exposes).
- **Option B:** bump `axum-keycloak-auth` past the 0.8.x behavior if a newer release fixes the pending-assertion
  race. Assess the API churn.
- **Kill criterion:** if neither yields a deterministic in-process auth layer within the spike, **stop** — the
  coverage is not worth reintroducing a flaky gate (this is the exact anti-goal of feature 041). Record the
  finding and keep the tests ignored / rely on E2E.

### 3.2 If the spike passes

1. **Token helper** (`tests/integration/common/auth.rs` or similar): ROPC against `KEYCLOAK_URL` using the
   test client, minting: an owner `mc-user`, a second `mc-user` (non-owner, for 403-ownership), and an
   `mc-admin`. Ensure the audience mapper so the tokens pass `KeycloakAuthLayer` validation. Read creds from the
   env the app-e2e step already provides (no new secrets).
2. **Un-ignore the auth-negative subset** and assert: `401` without a token; `403` for a non-owner on an
   owned-resource write; `403`/allow per the OR-role check (`mc-user` OR `mc-admin`); `404`-vs-`401` route-wiring;
   and the **RFC 9457 `application/problem+json` shape + status** for each.
3. **Delete** the 2 wrong-layer `create_test` cases (their behavior stays covered by `http_create_update_test.rs`).
4. **Fix** `health_test`'s tracing init and un-ignore the deterministic case.
5. The feature-041 **cargo guard** (`scripts/mc-service-integration-guard.mjs`) already enforces executed-count
   and bans *bare* `#[ignore]`; the remaining documented ignores (happy-path CRUD) stay allowed.

No new CI step — these run inside the existing feature-041 mc-service `app-e2e` step.

---

## 4. Success Criteria

- **SC1.** The `is_pending()` JWKS flake is gone: the mc-service integration binaries run the auth layer in-process
  ≥20 consecutive times with zero flakes (measured), OR the spike concludes no-go and this PRD is closed with that
  rationale recorded.
- **SC2.** The auth-negative suite runs in `app-e2e` and **bites**: a deliberate regression (e.g. mount a `/api/v1`
  route outside the protected sub-router, or weaken `require_app_role`) turns the mc-service step red.
- **SC3.** No happy-path CRUD test is un-ignored (scope discipline); the 2 wrong-layer tests are deleted.
- **SC4.** mc-service integration wall-clock stays bounded (the auth-negative subset is seconds); the gate remains
  flake-free across ≥10 CI runs.

---

## 5. Risks

- **R1 (primary): reintroducing flakiness.** Un-ignoring these without a real JWKS-timing fix would undercut the
  exact trustworthiness feature 041 establishes. Mitigation: the §3.1 spike is a hard go/no-go; kill if it can't be
  made deterministic.
- **R2: dep-bump churn.** If Option B (version bump) is needed, `axum-keycloak-auth` is load-bearing for all
  mc-service auth — a bump needs the full integration + E2E regression. Mitigation: prefer Option A (no dep change).
- **R3: scope creep** back toward "un-ignore all 17". Mitigation: the table in §1 is the contract; happy-path CRUD
  stays ignored.

---

## 6. Effort (rough)

- Spike (§3.1): **~0.5–1 day** — the decisive unknown.
- If go: token helper + un-ignore + assertions + delete wrong-layer + health fix: **~1–2 days**.
- If no-go: **~0.5 day** to document and close.

**Recommendation:** worth doing **only if the spike passes cleanly** (Option A, no dep bump). The payoff is closing
a genuine, security-relevant **authorization-regression blind spot** at the mc-service boundary — the one place the
happy-path E2E structurally cannot cover. If the spike shows the flake is intrinsic to 0.8.x and a bump is
disruptive, the honest call is to **not** do it and leave the coverage to E2E.
