# PRD — mc-service HTTP-Layer Authorization Integration Tests (Un-ignore the Auth-Negative Cases)

**Status:** **Implemented** 2026-08-01 — G1, G3, G4, G5 done. **G2a (ROPC token helper + authenticated
authorization tests) done 2026-08-02** by feature 046; **G2b (insufficient-role `403`) deferred**, blocked
on a role-less identity. See [§3b](#3b-g2-closed-by-feature-046--and-the-403-claim-above-is-wrong) —
which also corrects this document's repeated "403 for a non-owner" claim: the design returns **`404`**.
and now known not to block the coverage win. See §3.1a (spike) and §3.2a (implementation).

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

### 3.1a Spike outcome (2026-08-01) — **GO**

Evidence: `backend/mc-service/tests/integration/authz_spike_test.rs` (8 tests, all green).

**The premise was wrong in a useful way: this is not a flake.** It is a deterministic ordering bug that
only *looks* flaky. Read from the 0.8.3 source rather than inferred:

- `Action::dispatch()` (`action.rs:120`) performs **all** of its work — including
  `pending.store(true)` — *inside* `tokio::spawn`.
- `KeycloakAuthService::poll_ready` (`service.rs:62`) asserts `discovery.is_pending()` whenever
  `discovery.version() == 0`.
- `#[tokio::test]` defaults to a **current-thread** runtime, and nothing yields between
  `KeycloakAuthInstance::new()` and the first request — so the discovery task has never been polled:
  `pending == false` **and** `version == 0` → the assert fires.

Run in isolation the ignored test fails **100% of the time, in 0.05s** — reproduced first try. Any
incidental yield point hides it, which is what made it look intermittent.

**Option B is unavailable, not merely undesirable:** `cargo search` confirms **0.8.3 is the latest
published version**. There is no newer release to bump to, so Option A was the only path — and it works.

**Option A, implemented as a condition-based readiness gate:**

- `KeycloakAuthLayer::instance` is a public `Arc<KeycloakAuthInstance>` with a `setter(into)` builder, so
  the instance can be shared with the caller.
- `api::router::build_with_auth_handle()` (new) returns `(Router, Arc<KeycloakAuthInstance>)`;
  `build()` now delegates to it and drops the handle. **Wiring and behaviour are identical** —
  `build_auth_layer` takes `Arc<KeycloakAuthInstance>` instead of the value. No production auth
  behaviour changes.
- Tests poll `instance.is_operational()` until true (bounded by a timeout, no arbitrary sleeps). Once
  it is true, `version() > 0` **for the life of the process**, so the assert branch is never evaluated
  again.

**Measured (SC1/SC4):**

| Measurement | Result |
|---|---|
| Spike binary, `--test-threads=1`, 20 consecutive runs | **0 failures / 20** |
| Spike binary, default parallel threads, 20 consecutive runs | **0 failures / 20** |
| Per-test wall clock with the gate (incl. process start) | **~90–96 ms** |
| Full `mc-service-integration-guard.mjs` after the change | **OK — 4 binaries, 151 tests, 0 failures** |

**Two findings that change the plan:**

1. **The cheap fix is a trap — it manufactures a false green.** A bare `tokio::task::yield_now()`
   also silences the assert (proved: `bare_yield_also_avoids_the_panic`) and needs no production
   change. But `version` is incremented **even when discovery ends in `Err`**, so the service reports
   ready against a *dead* Keycloak and an unauthenticated request still returns 401. Proved against
   `http://127.0.0.1:1` in `without_the_gate_a_dead_keycloak_still_produces_a_green_401`: the whole
   401 suite passes **with no identity provider at all**. §3.2 must therefore gate on
   `is_operational()`, not merely yield — otherwise the un-ignored suite is decorative. The gate
   catches it (`the_gate_detects_a_dead_keycloak_instead_of_passing`).
2. **The route-wiring assertions are worth more than assumed.** An unrouted `/api/v1` path returns
   **404**, measured — the auth layer does not blanket the nest fallback. So `401` genuinely
   distinguishes "route exists and is protected" from `404` "not wired", and the `assert_ne!(status,
   404)` cases are real signal rather than near-vacuous.

**Note (out of scope, flagged not fixed):** the same assert is reachable in production if a request
arrives before the discovery task is first polled. Practically unreachable — the server binds and
awaits first, giving a large yield window, and prod uses a multi-thread runtime — but
`build_with_auth_handle` now makes a production readiness gate possible should it ever be wanted.

**Carry-over for G2 (the ROPC token helper): unstarted and still the main unknown.** The gate proves
the *layer* can run in-process deterministically; it does not prove tokens validate. The audience
mapper requirement in §3.2(1) remains untested.

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

### 3.2a Implementation outcome (2026-08-01)

**The §1 scope table was wrong about the shape of the ignored set.** Enumerated from the tree rather
than from memory, the 21 ignores were:

| §1 claimed | Actually present |
|---|---|
| ~6–8 auth-negative to un-ignore | **18**, and every one of them token-free |
| ~11 happy-path CRUD, keep ignored (redundant) | **zero — no such ignored tests exist** |
| 2 wrong-layer `create_test` to delete | 2 ✓ |
| (uncounted) `health_test` tracing conflict | 1 |

Consequence: **G2 was never a prerequisite.** Every ignored auth test asserts 401/route-wiring with no
JWT, so the readiness gate alone unblocked all of them. G2 is needed only for *new* 403
ownership/role tests, which do not exist yet. The "spike passes → 1–2 days" estimate was priced
against a scope that was not there.

**What shipped:**

1. **Shared gated harness** — `tests/integration/common/{build_test_app, build_test_app_with_auth_instance,
   wait_until_operational}`. The **five duplicated `build_test_app()` copies** (health_test,
   http_list_test, http_create_update_test, http_delete_test, collections/http_test) now share one
   implementation, so the gate cannot be forgotten in a single binary.
2. **G3 — 18 tests un-ignored.** No token helper required.
3. **G4 — the 2 wrong-layer `create_test` cases deleted.** Their doc comments already conceded the
   assertions could only pass if Clean Architecture were violated; the specs stay covered by
   `http_create_update_test` and the `create_movie` unit tests.
4. **G5 — the `health_test` logging test fixed and un-ignored, but not for the stated reason.** There
   is no global tracing subscriber anywhere in `src/` or `tests/`, so the advertised "subscriber
   conflict" was fiction. Two real defects: the test looked for a flat event `message == "request"`,
   while the middleware emits a `request` **span** plus a `request completed` **event**; and
   `duration_ms` was serialised as the **string** `"0"` because `Duration::as_millis()` returns `u128`,
   which `tracing` has no primitive encoding for and renders via `Debug`. Fixed in
   `logging.rs` (`as u64`) so the field is a JSON number as T015b requires — the openwiki logging
   invariant confirms the span/event split is correct, so the emitter was wrong on the number and the
   test was wrong on the shape.
5. **Permanent false-green guard** — `unauthenticated_401_is_returned_even_when_keycloak_is_unreachable`
   and `readiness_gate_reports_not_operational_for_unreachable_keycloak` in `health_test.rs` keep the
   §3.1a finding executable, so the gate cannot be "simplified" into a bare yield. The spike binary
   itself was removed.

**Not done — G2.** No ROPC helper, therefore no 403 ownership test, no OR-role (`mc-user` OR
`mc-admin`) assertion, and no `application/problem+json` assertion on an authenticated error. The
audience-mapper requirement remains untested. This is the whole of the remaining work and is now the
only reason to reopen this PRD.

---

## 3b. G2 closed by feature 046 — and the `403` claim above is wrong

**Status: G2a done, 2026-08-02** ([specs/046-authenticated-authz-tests/](../../specs/046-authenticated-authz-tests/)).
Three corrections to the sections above, all measured rather than inferred.

**1. The audience-mapper unknown was already solved.** §3.2(1) and the carry-over note above call the
audience mapper "the main unknown" and "untested". It needed no work: a ROPC token minted for
`e2e-test-user` through the `mcm-bff-test` client already carries `aud ∋ movie-collection-manager`
and `resource_access.movie-collection-manager.roles = ["mc-user"]`, so it validates against
`KeycloakAuthLayer` as-is. Feature 046 asserts this executably —
`authenticated_request_is_never_unauthorized` fails on both `401` **and** `403`, so a regression in
either the audience mapper or the role mapper turns the suite red.

**2. "403 for a non-owner" is WRONG, and this PRD should stop asserting it.** Lines 41, 52, 63, 180
and 183–184 above all expect `403` for a non-owner on an owned resource. The service does not do
that and must not: a cross-tenant request returns **`404`, with no existence leak** — a `403` would
confirm the resource exists. This is deliberate and documented at
[`access_control.rs`](../../backend/mc-service/src/application/access_control.rs) ("deny-by-default
and reports an unauthorized caller as `CollectionNotFound` (404)"). Feature 046's FR-004 asserts
`404` and **explicitly fails a `403`**, so the wrong expectation can never be re-introduced as a
passing test. Related: `DomainError::AccessDenied` (→403) has **no production producer** at all —
the one reachable `403` in the service is `require_app_role`.

**3. G2b — the insufficient-role `403` — remains open**, with two prerequisites now recorded in
[spec.md § Out of Scope](../../specs/046-authenticated-authz-tests/spec.md):

- a **role-less identity** to mint a token for. Blocked: the realm is runtime-managed with no
  committed source ([`scripts/export-ci-realm.mjs`](../../scripts/export-ci-realm.mjs)), and the only
  other seeded identity (`e2e-admin-user`) cannot complete a ROPC login (`400 invalid_grant`,
  measured).
- aligning `require_app_role` with `problem_response`. Its `403` is returned as `axum::Json`
  (→ `application/json`) with type `https://httpstatuses.io/403`, unlike every other refusal in the
  service ([`auth.rs:97-105`](../../backend/mc-service/src/api/middleware/auth.rs#L97)) — so a
  `403` shape assertion written today would encode that inconsistency.

**What feature 046 shipped:** 11 integration tests (suite total 164 → 175, zero ignored) covering
cross-tenant `404` for read/update/delete plus a nested movie, owner-stamping verified at both the
response and storage layers, and the RFC 9457 shape and no-diagnostic-leak assertions on an
authenticated error — the last of which this section's opening paragraph lists as missing.

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

### 4a. Results (2026-08-01)

- **SC1 — met locally, twice over.**
  - **Full suite: 20 consecutive rounds × 3 binaries = 60 runs, 0 failures, 0 panics** — every round
    `health_test` 8 / `collections_test` 30 / `movies_test` 126, i.e. **3,280 test executions**.
  - **Auth surface alone: a further 20 rounds × 3 = 60 runs, 0 failures** (8 `health_test`,
    11 `collections::http_test`, 18 `movies::http_*` per round = 740 executions).

  The underlying claim is stronger than "no flakes observed": once `is_operational()` is true,
  `version() > 0` permanently, so the asserting branch in `poll_ready` is unreachable for the rest of
  the process. The gate removes the race rather than narrowing it.
- **SC2 — met, demonstrated.** Deleting `.layer(auth_layer)` from the protected sub-router in
  `router.rs` turned **7 tests red** — `health_test::protected_routes_require_auth` plus 6 in
  `collections::http_test` — and the suite returned to green when it was restored. Worth noting for
  future scope: `list_collections_route_is_wired_not_404` stayed **green** under that break, which is
  correct (it asserts wiring, not auth) but confirms the wiring tests alone would not catch a dropped
  auth layer.
- **SC3 — met, though the premise was wrong.** No happy-path CRUD test was un-ignored because none was
  ignored (see §3.2a). The 2 wrong-layer tests are deleted.
- **SC4 — met locally.** Gated HTTP tests cost ~90–96 ms each including process start. Across the 20
  full-suite rounds the per-round wall clock was stable at **~48–58 s** (`health_test` 3.57–3.70 s,
  `collections_test` 5.1–7.7 s, `movies_test` 38.5–46.0 s) — no drift or creep from the readiness
  gate. Not yet observed across ≥10 *CI* runs; that evidence only exists once this lands on a branch
  and app-e2e runs it.

| Gate | Before | After |
|---|---|---|
| `mc-service-integration-guard.mjs` | 151 executed, **21 ignored** | **164 executed, 0 ignored** |
| `cargo clippy -p mc-service -- -D warnings` | clean | clean |

**Caveat on the CI dependency.** These tests now *require* a reachable Keycloak in the app-ci
mc-service step, where previously every HTTP test was ignored and the step was effectively
Keycloak-independent. The step already exports `KEYCLOAK_URL=http://localhost:8099`, the realm, the
client id, and runs `--network host`, so this is satisfied — but a Keycloak regression in that job
will now fail the mc-service step loudly instead of silently skipping. That is the intended trade.

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
