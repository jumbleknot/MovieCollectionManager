# Quickstart: validating account deletion

**Feature**: 076-account-deletion · **Date**: 2026-09-24

How to prove this feature works. The load-bearing scenario is **V3** — everything else is
supporting. If you run one thing, run that.

See [contracts/bff-api.md](contracts/bff-api.md) for endpoint shapes and
[data-model.md](data-model.md) for the destruction order; neither is repeated here.

---

## Prerequisites

```bash
# The auth + mcm stacks, with a replica-set Mongo (cascade delete is a transaction)
pnpm nx run infrastructure-as-code:up-auth
pnpm nx run infrastructure-as-code:up-mcm
```

`.env.local` must exist. If a tier reports "creds not set", that is a **missing file, not a missing
capability** — run the documented generator before concluding the environment cannot run the tier:

```bash
node scripts/gen-dev-env.mjs
```

### Before running any of these

`--testPathPattern` matches the **whole path**, and this worktree is
`/home/coder/worktrees/076-account-deletion` — so an unanchored pattern like `account-deletion`
matches every suite in the repository, runs all of them, and looks like it passed. Every pattern
below is anchored to a filename with `$` for that reason; do not loosen them.

Integration tests run under `test:integration` (config `jest.integration.config.js`). The default
`test` target's `testPathIgnorePatterns` **excludes `/tests/integration/`**, so running them through
`nx test` matches zero files and reports success.

---

## V0 — Settle the open research item first

Research R1 could not confirm, without a running stack, that Keycloak emits `auth_time` for this
client. The whole step-up verification rests on it, so establish it before writing the verifier.

Complete one step-up round trip by hand and decode the ID token.

**Expected**: `auth_time` present, within seconds of now. `amr` present is a bonus, not a
requirement.

**If `auth_time` is absent**: stop. The verification design needs revisiting before any code is
written — do not substitute `iat`, which measures when the token was minted rather than when the
user authenticated, and would be satisfied by a silent SSO-cookie reuse.

---

## V1 — Unit: the pipeline aborts in the right places

```bash
pnpm nx test mcm-app -- --testPathPattern='account-deletion-(order|no-driver|failure)\.test\.ts$'
```

Injects a failure at each step in turn and asserts:

- A revocation failure destroys **nothing** and throws (FR-015)
- A failure at step N leaves steps N+1… untouched
- Every step before the account delete is safe to run twice
- A `404` from the per-collection delete and from `deleteUser` counts as **success**
- Nothing on the path imports `backup-destination-driver` or `backup-retention`

That last one is an import assertion, not a behavioural one. FR-023 is the requirement most likely
to be violated by a well-meaning later edit, and it is cheap to pin.

---

## V2 — Unit: step-up verification refuses correctly

```bash
pnpm nx test mcm-app -- --testPathPattern='account-step-up-(request|verify)\.test\.ts$'
```

Each of these must refuse and destroy nothing: no pending record; `state` mismatch; `sub` mismatch;
`auth_time` older than 300s; `auth_time` not greater than `authTimeFloor`; **`auth_time` absent**;
a pending record replayed after being consumed.

The absent-`auth_time` case is the one worth writing first. It is the failure that would pass
silently.

---

## V3 — Integration: the standing permission is actually dead

**This is the scenario the feature exists for.** It is the only one that closes backlog item #544,
and it must run against a real Keycloak — a mocked IdP cannot demonstrate a token is dead, and the
constitution forbids mocking it in this tier anyway.

```bash
MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration mcm-app -- --testPathPattern='account-deletion\.integration\.test\.ts$'
```

1. Create a user; grant the backup standing permission; create collections, a destination, a
   schedule and run history.
2. Capture the stored refresh token before deletion.
3. Run the deletion.
4. **Present the captured refresh token to Keycloak and require rejection.** A local `$unset` is not
   evidence — that is precisely the failure mode item #544 describes (SC-001).
5. Assert the user is gone, sign-in fails, and no store returns anything for that userId (SC-002,
   SC-004).
6. Assert the objects at the destination are unchanged in count and content (SC-003).
7. Assert the elapsed time from confirmation to completion is under 30 seconds at this fixture size
   (SC-009). The per-collection loop is sequential, so this is the figure that degrades first if the
   loop ever gains a round trip.

**Watch the skip count.** `MCM_REQUIRE_LIVE_STACK=1` turns a skip into a failure; without it a
skipped test reads as a pass. A green run with the suite skipped proves nothing.

---

## V4 — Integration: failure and retry

```bash
MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration mcm-app -- --testPathPattern='account-deletion\.integration\.test\.ts$'
```

- Point revocation at an unreachable IdP → nothing destroyed, account fully usable (SC-005)
- Fail mid-collection-loop, then retry → the retry completes (SC-006)
- Delete, then register again with the same email → a new, empty account (SC-014)
- Attempt with the last remaining `mc-admin` → refused (SC-010)

---

## V5 — E2E: the round trip a user actually performs

Settings → Account → Delete → dialog (both lists visible) → confirm → Keycloak login → returns to
`/account-deleted`. Then: the session is dead, and signing in with those credentials fails.

**`pnpm nx e2e mcm-app` does not work in the dev container.** Playwright's browsers are not
installed (`~/.cache/ms-playwright` is empty) and the default target also tries to start Metro,
timing out after 120s. Both are environment facts, not failures of this feature. Run it in the
official image against the already-running BFF instead.

From a **worktree**, the runbook's `-v /workspaces/mcm` bind mount silently yields a near-empty
directory — only `/workspaces/mcm` is shared with the Docker daemon — so stage a named volume:

```bash
docker volume create mcm-e2e-wt
docker create --name e2e-stage -v mcm-e2e-wt:/work alpine:3 true
tar -C /home/coder/worktrees/076-account-deletion \
    --exclude=./target --exclude=./.nx --exclude=./.git -cf - . | docker cp - e2e-stage:/work
docker rm e2e-stage

SVC_SECRET=$(grep '^KEYCLOAK_SERVICE_CLIENT_SECRET=' \
  ../../infrastructure-as-code/docker/stacks/auth.env | cut -d= -f2-)
KEYCLOAK_SERVICE_CLIENT_SECRET="$SVC_SECRET" docker run --rm --network host \
  --env-file ./.env.e2e.local --env-file ./.env.local \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -v mcm-e2e-wt:/work \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e E2E_BFF_TARGET=dev-container -e CI=true \
  -e KEYCLOAK_URL=http://localhost:8099 -e KEYCLOAK_REALM=grumpyrobot \
  -e KEYCLOAK_SERVICE_CLIENT_ID=mcm-bff-service -e KEYCLOAK_SERVICE_CLIENT_SECRET \
  -e KEYCLOAK_CLIENT_ID=movie-collection-manager \
  -w /work/frontend/mcm-app mcr.microsoft.com/playwright:v1.63.0-noble \
  node_modules/.bin/playwright test tests/e2e/web/account-deletion.spec.ts \
    --project=chromium --workers=1 --reporter=line
```

**Expected**: 4 passed. TWO env files are required — Playwright loads `.env.e2e.local` but not
`.env.local`, and the backup-target credentials live in the latter.

**The BFF container must be running the image you just built**, or a stale container answers
`404` for a new route and the failures read as code bugs. Diff the ids before believing any
result: `docker inspect mcm-bff-service-nonsecure --format '{{.Image}}'` against
`docker images mcm-bff:latest`.

**This tier is worth the trouble.** It caught a defect the unit and integration tiers could not:
`auth_time` has second granularity, so a step-up completing in the same second as the challenge
was refused as stale. Only a browser doing the real round trip in real time reaches that.

**The disconnect case (SC-012)** belongs in V3, not here: drop the client immediately after
confirmation and assert from outside that the deletion still completed. Driving that through a
browser is flakier and proves less.

---

## What a pass does not prove

- **Native.** Every scenario above is web. The Android step-up path is deferred (plan.md Structure
  Decision); until it lands, confirm Android **fails closed** rather than silently doing nothing.
- **A user with MFA enrolled**, unless you enrol one. The conditional 2FA subflow only triggers for
  users with a credential configured, so the default test user never exercises FR-007's
  second-factor branch. Enrol TOTP on one fixture user or that requirement is untested.
- **Scale beyond the fixture.** V3 asserts SC-009's 30-second budget at 10 collections / 1,000
  movies. The per-collection loop is sequential, so that figure does not extrapolate — a user with
  many more collections is unmeasured.
