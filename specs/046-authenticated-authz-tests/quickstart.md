# Quickstart — validating feature 046

**Feature**: 046 · **Date**: 2026-08-02

How to run and prove the authenticated authorization tests. Design details live in
[plan.md](./plan.md); the asserted HTTP behaviour is in
[contracts/authenticated-http-authorization.md](./contracts/authenticated-http-authorization.md).

---

## Prerequisites

**1. Stacks up.** The auth and mcm stacks must be running — Keycloak (realm `grumpyrobot`) and the
replica-set Mongo (`rs0`). See [openwiki/runbooks/local-dev.md](../../openwiki/runbooks/local-dev.md).

**2. `backend/mc-service/.env.local`** must contain the five existing variables **plus four new
ones**:

```dotenv
# existing
MC_DB_URL=…
KEYCLOAK_URL=…
KEYCLOAK_REALM=grumpyrobot
KEYCLOAK_CLIENT_ID=movie-collection-manager
MC_SERVICE_PORT=…

# added by feature 046 — copy the values from frontend/mcm-app/.env.e2e.local
E2E_ROPC_CLIENT_ID=…
E2E_ROPC_CLIENT_SECRET=…
E2E_TEST_USER=…
E2E_TEST_PASSWORD=…
```

The file is gitignored (`.gitignore:506`). **Never commit it.**

> **Do not** load `.env.e2e.local` with `set -a; . file` to copy the values across — a value contains
> characters that break shell sourcing and it emits `line 4: … command not found`. Copy them by hand
> or use a real dotenv parser.

---

## Run

```bash
pnpm nx test:integration mc-service --skip-nx-cache
```

`--skip-nx-cache` is not optional when the counts matter: a cached run prints only "Successfully ran
target" and hides the numbers entirely. Verify by result, never by exit status.

**Expected**: three integration binaries, **more than 164 executed tests, 0 ignored, 0 failed**, and
the guard's closing line:

```text
[mc-service-integration-guard] OK: 3 integration binaries executed <N> tests.
```

To iterate on just this module during development:

```bash
pnpm nx test:integration mc-service -- --test collections_test http_authz
```

Passing a filter puts the guard in delegate mode — it skips the executed-count assertion (a targeted
run legitimately executes a subset) but still forbids a bare `#[ignore]`. **A filtered run is never
sufficient evidence that the feature is done.**

---

## Validation scenarios

Each maps to a success criterion in [spec.md](./spec.md).

### SC-001 / SC-002 — isolation holds, and reports "not found"

Covered by the suite itself: the US1 tests assert `404` and explicitly assert **not** `403` for read,
update, delete and the nested movie read. A change that turns any of them into `403` fails the build.

### SC-003 — broken-on-purpose (the real RED)

The behaviour under test already works, so a newly written assertion goes green immediately. Mutation
is what proves the tests bite:

1. In the read path, drop the owner scoping (e.g. remove the owner predicate from the collection
   lookup filter in `adapters/mongodb/collection_repository.rs`).
2. `pnpm nx test:integration mc-service --skip-nx-cache` → the cross-tenant tests **must fail**.
3. Restore the change (`git checkout -- backend/mc-service/src`) → **green** again.

If step 2 stays green, the tests are decorative and must be corrected before the feature is done.

Do the same for the control: corrupt one character of the bearer value and confirm
`authenticated_request_is_never_unauthorized` turns `401`.

### SC-004 — still zero ignored, negligible added runtime

Read the guard's own summary lines. `0 ignored` on every binary, and the wall clock should rise by
under ~2 s — one ROPC round trip per binary, cached.

### SC-005 — missing credentials fail loudly

```bash
env -u E2E_TEST_PASSWORD pnpm nx test:integration mc-service --skip-nx-cache
```

Must **fail**, naming `E2E_TEST_PASSWORD`. It must not skip, and it must not report success.

> Unsetting the variable in the shell is not enough on its own if the value is also present in
> `backend/mc-service/.env.local` — `dotenvy` loads it back. Comment the line out for this check, or
> run against a temporarily renamed file.

The identity-provider-unreachable half of SC-005 is already covered by the two guards at the end of
`health_test.rs`. Leave them alone.

### Flake bar

≥ 20 consecutive runs, zero failures — matching 045's baseline of 20 rounds × 3 binaries.

```bash
for i in $(seq 1 20); do
  pnpm nx test:integration mc-service --skip-nx-cache || { echo "FAILED on round $i"; break; }
done
```

---

## Lint and format

```bash
pnpm nx lint mc-service     # clippy -D warnings — must be clean
```

Note: `--all-targets` has **9 pre-existing failures** on clean `main`; that is not this feature's
gate. `cargo fmt --check` likewise drifts in 7 untouched files — **format only what you touch.**

---

## Lock discipline

```bash
git diff Cargo.lock
```

Must show only `mc-service`'s own dependency list gaining `reqwest`. **No new `[[package]]` block** —
`reqwest` 0.12.28 is already resolved transitively via `axum-keycloak-auth`. A new package in the diff
means the dev-dependency was declared with features that pull something extra; fix the features
rather than accepting the lock change.

---

## CI

The tests run in the existing `mc-service integration tests` step of the `app-e2e` job in
`.forgejo/workflows/app-ci.yml` — the same step that already gates a merge (FR-008). It gains four
`-e` flags forwarding the credentials; all four already exist in that job, so no new secret is
required.

When opening the PR: **push a real branch and use the API.** Never AGit — an AGit head
(`refs/pull/N/head`) receives no Actions secrets, which surfaces as a bogus nx "Misconfigured remote
cache endpoint" and has already cost two sessions a day. See
[docs/runbooks/ci-diagnostics.md](../../docs/runbooks/ci-diagnostics.md) § Opening a pull request.
