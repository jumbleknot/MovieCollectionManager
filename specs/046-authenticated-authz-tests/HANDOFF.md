# HANDOFF — feature 046, implemented

**Written**: 2026-08-02 · **Branch**: `046-authenticated-authz-tests`
· **Supersedes** the previous handoff, which covered the plan→tasks step and said "run
`/speckit-implement` next".

**State**: `/speckit-implement` has **run to completion**. All 28 tasks in
[tasks.md](./tasks.md) are marked `[x]` and every one was verified by running something.
**The feature is code-complete and green.**

**Your next step**: open the PR (§6). The branch is still local.

---

## 1. What was built

11 new integration tests plus the harness they need, proving mc-service's authorization behaviour
**at the HTTP boundary with a real credential**. Feature 045 got the suite to zero ignored tests, but
every assertion in it was unauthenticated — it proved `401` without a token and nothing else.

| File | What it is |
|---|---|
| [`tests/integration/common/auth.rs`](../../backend/mc-service/tests/integration/common/auth.rs) | **New.** ROPC credential helper — `user_token()` / `user_subject()` cached per test binary, plus the two pure functions their failure messages are asserted through. |
| [`tests/integration/collections/http_authz_test.rs`](../../backend/mc-service/tests/integration/collections/http_authz_test.rs) | **New.** The 11 tests. |
| [`tests/integration/common/mod.rs`](../../backend/mc-service/tests/integration/common/mod.rs) | `build_test_app_with_db()` added; all three builders now delegate to one private constructor so the JWKS readiness gate cannot be forgotten. |
| [`.forgejo/workflows/app-ci.yml`](../../.forgejo/workflows/app-ci.yml) | The four ROPC credentials forwarded into the mc-service integration step. |
| [`Cargo.toml`](../../backend/mc-service/Cargo.toml) | `reqwest` dev-dependency. |

## 2. Verified results — measured, not inferred

| Claim | Evidence |
|---|---|
| **175 executed / 0 ignored / 0 failed** (164 baseline + 11) | `pnpm nx test:integration mc-service` — `[guard] OK: 3 integration binaries executed 175 tests`. Read the counts, never the exit status. |
| **Every Verify RED was observed failing** before its GREEN | All six mutations M1–M6 applied, observed, reverted. Each produced the exact failure tasks.md predicted — see §3. |
| **SC-003 — removing owner scoping turns the suite red** | M3 (drop `ownerId` from the three repository filters) → read `200`, PATCH `200`, DELETE `204` instead of `404`. 3 failed. |
| **The fixture guards themselves bite** (T016) | Setting the foreign owner equal to the authenticated subject failed **all four** US1 tests on `the foreign fixture's owner must differ from the authenticated subject`. Reverted and diffed byte-for-byte against a pre-T016 copy. |
| **Missing credentials fail hard, never skip** | With `E2E_TEST_PASSWORD` commented out: **exit code 1**, `9 failed; 0 ignored`, message `E2E_TEST_PASSWORD is not set (or is empty)…`. 9 = the 11 new tests minus the 2 pure-function ones. |
| **No production source changed** | `git diff main --name-only -- backend/mc-service/src/` → **0 files**. This is what makes the E2E and coverage exemptions valid. |
| **Lock discipline** | `git diff main -- Cargo.lock` is **one line** (`+ "reqwest"`), **zero** new `[[package]]` blocks. |

## 3. The mutation catalogue, as executed

Each was applied, observed failing, and reverted inside the task pair naming it. `git diff --name-only
backend/mc-service/src/` was re-confirmed empty after every one.

| # | Observed failure |
|---|---|
| M1 | `a valid credential must never be rejected: got 401 Unauthorized` |
| M2 | `left: Some("not-the-caller")` vs the real subject; read-back `404` |
| M3 | `got 200 OK` (read), `200 OK` (PATCH), `204 No Content` (DELETE) — all must be `404` |
| M4 | `cross-tenant movie read must be 404: got 200 OK` |
| M5 | `error responses must use application/problem+json: got Some("application/json")` |
| M6 | `must not leak internal diagnostics: found "src/"` |

## 4. Deviations from tasks.md — three, all deliberate

Recorded in full in [tasks.md § Deviations from the plan](./tasks.md).

1. **`reqwest` features are `["json"]`, not `["json", "rustls-tls"]`.** `rustls-tls` pulls
   `webpki-roots` + `web-time`, which are not in the lock — that would have broken T001's own
   "no new `[[package]]`" gate, which anticipated this and says to fix the features. No TLS feature is
   needed: unification already compiles `reqwest` with `default-tls` for other crates in the graph
   (`cargo tree -e features`), and Keycloak is plain `http` in both environments.
2. **M1 was reverted against a commit, not against `HEAD` at the time.** When M1 runs, `common/auth.rs`
   is untracked, so the prescribed `git checkout -- backend/mc-service/tests/` would have no-opped on
   it while discarding the tracked T003–T005 edits. Phase 1–2 was committed first (`dc229d5`) to make
   every later revert safe. M2–M6 target `src/` and used the prescribed command unchanged.
3. **T016's revert was verified byte-for-byte**, not merely re-run green.

## 5. Traps that still apply

- **A test that passes for the wrong reason is worse than one that doesn't run.** There is no
  conditional gate anywhere in this design — do not add one.
- **The JWKS readiness gate must assert *success*, not merely yield.** `build_test_app_with_db()`
  delegates through the existing gate rather than copying it. The two guards at the end of
  `health_test.rs` keep this executable — **leave them alone**.
- **A foreign-owned fixture cannot be created over HTTP** — every write path stamps
  `owner_id = token.subject` (which US2 now proves). It is seeded through the repository into *the
  database the router is wired to*, which is why `build_test_app_with_db()` exists.
- **Never log the token, secret, or password.** Messages name variables and endpoints only. The
  Keycloak token-response body is deliberately never echoed — it can carry credential material.
- **`backend/mc-service/.env.local` is gitignored and must never be committed.** It now holds the four
  ROPC credentials. Confirmed absent from every commit on this branch.

## 6. What is left: open the PR

**PRs: real branch + API. Never AGit.**

```bash
git push origin HEAD:046-authenticated-authz-tests
# then POST …/pulls with the `git credential fill` token — NOT MCM_FORGE_TOKEN (read-only)
```

An AGit head (`HEAD:refs/for/main`) yields a `refs/pull/N/head` head, which Forgejo runs with **no
Actions secrets**: every `${{ secrets.* }}` is empty and nx reports the empty cache token as
`Misconfigured remote cache endpoint`. It cost two sessions a day on #126.
Authority: [ci-diagnostics](../../docs/runbooks/ci-diagnostics.md) § Opening a pull request.

**State the empty `src/` diff in the PR description** — it is what makes the full-stack E2E exemption
valid (T028), and a reviewer needs to see the claim to check it.

**CI will exercise this**: `backend/**` and `.forgejo/workflows/app-ci.yml` are both in the `app`
paths filter (app-ci.yml:83, 86), so the `app-e2e` job — and the mc-service step inside it — runs on
this PR. That step now needs the four ROPC credentials, which T021 wired in.

## 7. Still deferred (unchanged, and now recorded upstream)

The **`403` insufficient-role test**, with two prerequisites, written into
[spec.md § Out of Scope](./spec.md), the [PRD § 3b](../../docs/proposals/PRD-McServiceHttpAuthzIntegration.md)
and [045's Not-done list](../045-mc-service-http-authz-tests/tasks.md):

1. a **role-less identity** — blocked on the runtime-managed realm (no committed source), and
   `e2e-admin-user` cannot complete a ROPC login (`400 invalid_grant`, measured);
2. aligning `require_app_role` with `problem_response` — its `403` is `application/json`, not
   `application/problem+json` ([auth.rs:97-105](../../backend/mc-service/src/api/middleware/auth.rs#L97)).
   That is a production change, which FR-010 forbids in this feature.

**The PRD's "403 for a non-owner" was wrong and has been corrected** in place: the design returns
`404` with no existence leak, and this feature asserts `404` while explicitly failing a `403`.

## 8. Environment

- Keycloak on `127.0.0.1:8099` (realm `grumpyrobot`), `mc-service-store-mongo` on `27017` (rs `rs0`).
- `cargo metadata` needs `--offline` in this devcontainer — the crates.io index fetch times out
  behind the firewall. Everything needed is already in the lock, so `--offline` resolves fine.
- Commands:
  ```bash
  pnpm nx test:integration mc-service                                    # the gate, ~60 s
  pnpm nx test:integration mc-service -- collections::http_authz_test    # the new module, ~2.5 s
  pnpm nx lint mc-service                                                # clippy -D warnings
  ```
