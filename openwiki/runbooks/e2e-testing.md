---
type: Runbook
title: E2E testing (BFF container modes & flakiness diagnosis)
description: The three BFF-fronting modes for end-to-end tests (Metro dev, dev-container HTTP, prod-container HTTPS), why the dev-container run is the deterministic baseline for flaky-vs-broken triage, and the CI integration-tier gate that now blocks a merge.
resource: docs/runbooks/e2e-testing.md
tags: [e2e, testing, playwright, ci, flakiness, runbook]
timestamp: 2026-09-05T00:00:00+00:00
---

# E2E testing (BFF container modes & flakiness diagnosis)

The same app + BFF code runs in three modes that differ only in which server fronts the BFF and the
cookie/TLS posture: **local dev** (Metro's `@expo/server`, HTTP, non-Secure cookies — the default for
iterative work), **dev container** (`mcm-bff-service-nonsecure`, HTTP, non-Secure — the standard
final local E2E run), and **prod container** (`mcm-bff-service-secure` + TLS proxy, HTTPS, Secure
cookies — reserved for a future CI/CD job, not a routine local step). See
[Testing tiers](/openwiki/invariants/testing-tiers.md) for how this E2E tier fits alongside unit,
integration, and golden tests, and how CI enforces the integration tier ahead of the E2E legs.

## Gotchas

- **Diagnose flaky-vs-broken with the dev-container run, not Metro.** Metro has JIT/long-session
  variance that produces convincing "environment" red herrings; the dev-container run is
  deterministic (~54s for the current suite). If that run is slower or fails, treat it as a real
  regression — do not reach for "flaky" first. A real historical case: a strict-validation 400 was
  repeatedly misattributed to machine/Metro degradation because the handler didn't log 4xx errors.
- **A client→BFF response can be silently lost through the exported server's pipe stack**, most often
  over the emulator's tunnel. This is usually benign for login (the session lands anyway) but can
  make a server-authorized action look client-denied for other flows — diagnose by comparing the
  BFF's own audit log against the client-visible outcome, not by re-running.
- **Bounded E2E retry is at most one retry per test, never more** — masking flakiness with additional
  retries risks hiding a real defect; a genuine regression must still fail both attempts.
- **Agent E2E flows must never assert on a specific TMDB-ranked title.** Live TMDB popularity rankings
  drift, so a hardcoded title can silently leave the candidate list entirely — assert by list
  *position*, never by name.
- **A CI agent-flow failure ships full per-service container logs and health-check JSON as the
  `agent-e2e-container-logs` artifact before teardown** — the containers are gone by the time you'd
  try to `docker logs` them post-hoc, so that artifact (not a live re-run) is the required first
  diagnostic step.
- **The prod-container (HTTPS) mode is not a routine local step** — it's kept only as a proven
  reference path for a future CI/CD job; don't reach for it in day-to-day validation.
- **`agent-e2e.mjs` does NOT work inside the dev container.** It shells out to `nx e2e`, which
  launches Playwright on the host — chromium cannot be installed inside the dev container (CDN and apt
  mirrors are outside the egress allowlist), so `globalSetup` dies on
  `browserType.launch: Executable doesn't exist`. Run agent specs through the Playwright image instead
  (full recipe in `docs/runbooks/devcontainer.md`). `agent-stack.mjs` itself works fine inside the
  container and is still the correct bring-up path.
- **`agent-stack.mjs` needs `KEYCLOAK_SERVICE_CLIENT_SECRET` exported from `stacks/auth.env` before
  it runs** — without it the script fails with `service-account admin token failed (401)`, a message
  that names neither the variable nor the source file. Export it manually or source the file before
  calling the script.
- **Rebuild the BFF image when CLIENT code changes.** The Expo web bundle is baked into the BFF
  image, so any change under `frontend/mcm-app/src/` is invisible to a containerized E2E run until
  `pnpm nx run mcm-app:build` + a container recreate. This is the same stale-image rule the
  validation checklist states for services — it applies to the client too, which is easy to miss
  because "the client" does not feel like a deployed container (measured 2026-08-03: a new Cancel
  button was unit-tested and present in the gateway payload, yet the E2E failed `element(s) not found`
  because the container served the previous bundle).
- **Always run the integration tier with `MCM_REQUIRE_LIVE_STACK=1` and ALL MCP servers up.** A
  missing server makes dependent tests SKIP — it does not fail the suite. Measured 2026-08-03: running
  with web-api-mcp down yielded `89 passed, 17 skipped`, which reported as a pass but contained a
  real regression in `test_gateway_add_e2e.py`. With all three servers up the same suite is
  `95 passed, 11 skipped`. **The skip COUNT is the signal**: if it moves, something stopped being
  tested. `MCM_REQUIRE_LIVE_STACK=1` converts any non-allowlisted skip into a failure naming the
  missing dependency.
- **After driving an agent control, assert on what the assistant *said* — not on client-local
  state.** The Add button's `disabled` state is set by `setActioned(true)` in the tap handler,
  BEFORE the agent has replied at all — it cannot distinguish any two agent responses. "No approval
  request appeared" is also true of a *failed* search; the absence of a write proves nothing when
  the wrong behaviour also writes nothing. Measured 2026-08-09: `agent-search` cancel was green for
  two days while the feature was broken. Test: would this assertion still pass if the assistant said
  the opposite? If yes, it is not coverage.
- **Scope the reply assertion to ONE new reply — not the whole transcript panel.** A panel-wide
  `not.toContainText(/couldn't find/i)` fails *forever* because the transcript already contains that
  phrase from earlier turns. Count replies before and after the action, wait for `count + 1`, then
  read only the last one. On mobile (Maestro), scope to signatures the bug *alone* produces — a bare
  `.*couldn't find.*` matches legitimate transcript text in both the passing and failing worlds.
- **The Playwright image tag MUST follow the lockfile's `@playwright/test` version — they are not
  independent.** The tag selects the browser build baked into the image; a lockfile bump that moves
  `@playwright/test` without moving the tag makes the browser launch fail outright —
  `browserType.launch: Executable doesn't exist at /ms-playwright/chromium_headless_shell-…` — ZERO
  tests run and the e2e gate reports `no Playwright summary found` rather than a count. The tag lives
  in three places that do NOT carry equal weight:

  | Where | Count | What it is |
  |---|---|---|
  | `.forgejo/workflows/app-ci.yml` | 2 | **authoritative** — the tag CI actually runs the suite in |
  | `docs/runbooks/devcontainer.md` | 3 | the operator's local `docker run` recipe |
  | `docs/runbooks/e2e-testing.md` | 1 | the `docker ps` cleanup filter |

  Updating only `devcontainer.md` fixes a local run and leaves CI broken — the workflow is the copy
  that matters for a merge. The two halves (pin bump + lockfile bump) MUST land in the same change:
  bumping the pin ahead of the lockfile bump on `main` breaks `main` the same way in reverse. Measured
  on PR #199: lockfile moved 1.60.0 → 1.62.1, the workflow tag stayed at `v1.60.0-noble`, and
  `app-e2e` burned a full ~35-minute cycle before failing. **The coupling is now enforced by
  `scripts/check-toolchain-consistency.mjs`** (feature 061): it reads the version `pnpm-lock.yaml`
  resolves and compares it against every occurrence of the tag in `app-ci.yml`, failing the `naming`
  guardrails job in ~0.4 s — before `app-e2e` starts. A partial bump (only one of the two occurrences
  moved) fails exactly like moving neither. Renovate now proposes both halves in one PR (the
  `playwright pin` group in `renovate.json`). Run it before you push:
  ```bash
  node scripts/check-toolchain-consistency.mjs
  ```
  **DIAGNOSTIC — `failed=0 flaky=0 passed=0` means check the image pin FIRST.** A drifted tag does
  not present as a test failure — it presents as the *absence* of results, and the e2e result gate's
  `no Playwright summary found` is the only signal. Run the gate above before opening a single
  container log. Current pin: **v1.62.1**.
- **Killing the shell does NOT kill a containerised `docker run`.** The container detaches from the
  CLI process, so cancelling the command leaves Playwright still running — consuming the same shared
  test user and gateway as any subsequent run. Measured 2026-08-09: an abandoned full-suite run was
  still at test 24/174 fifteen minutes after being "stopped". Always confirm and kill:
  `docker ps --filter ancestor=mcr.microsoft.com/playwright:v1.62.1-noble`.
- **Include the assistant's *decline* copy in the negatives.** The same routing bug can surface as
  "I couldn't find…" on one model and "I can only help with your movie collections." on another. A
  test that knows only one symptom misses the same defect on a different provider.
- **Six workers share ONE user — teardown deletes other workers' live data.** `playwright.config.ts`
  sets `fullyParallel: false` and up to six workers. That serialises tests *within a file* and runs
  different *files in parallel* — all as the same `E2E_TEST_USER`. `cleanupNonFixtureCollections`
  deleted every non-fixture collection the user owned from 21 spec files' `afterEach`; the median
  collection lifetime was 1.3 s while agent flows need them for a minute or more. The rule now:
  teardown deletes only what the test declared with `ownCollection()` (see
  `tests/e2e/web/setup/e2e-cleanup.ts`). **When you add a spec that creates a collection, declare
  it** — the guard (`scripts/__tests__/e2e-collection-ownership.guard.test.mjs`) fails the build if
  you POST `/bff-api/collections` without calling `ownCollection`. Other shared user state to
  account for: per-user agent config, the default collection (FR-009 redirect), and the `MUTATION`
  fixture emptied by `movies.spec.ts`.
- **"Green" told you nothing until the result gate existed.** Playwright exits 0 with tests
  skipped, the forge API exposes no job logs, and the digest publishes only on failure — so on a
  green run the counts were unreadable. Feature 040 validated green with 33 specs skipped. `app-ci`
  now runs `node scripts/e2e-failure-set.mjs gate` after the web E2E: fails on `skipped > 0`,
  `did not run > 0`, or a log with no summary. **`flaky` is still NOT observable on a green run**
  — do not claim "no flakes" from a green tick. **`N did not run` is not a skip**: the `lifecycle`
  project (`bff-prod-lifecycle` + `admin-registration`, 3 tests) never runs while the main project
  has any failure — they reported "3 did not run" for months without anyone noticing.
- **A local run is only evidence if you check the instrument.** Three measured failure modes: (1)
  `dev-realm` has `accessTokenLifespan: 300` — feature 052 scoped its 5400 s fix to `ci-realm` —
  so any local run past ~5 min re-enters refresh contention; read BFF contention counters alongside
  the result before attributing failures to the application. (2) A container can be "Up" and dead
  — `movie-assistant-gateway` once showed `Up 37 hours` while not answering `/health`; zero
  gateway requests for a turn means check liveness first:
  `docker exec mcm-bff-service-nonsecure wget -qO- http://movie-assistant-gateway:8000/health`.
  (3) A local subset pass is not evidence about a change to a shared hook — a fix that passed
  6/6 unit tests and 5/5 E2E produced 28 and 26 failures in the full CI suite because it exercised
  three spec files in isolation while the regression only appears under full concurrency.
- **A RED `app-e2e` is fast because it gives up early.** The mobile half (APK build + Maestro)
  runs after the web E2E; a failing web suite aborts the job before it. Measured: red runs take
  15–19 min (web E2E only), green runs take 30–35 min (web + APK + emulator). Fixing the suite
  roughly doubles the job's wall clock. Do not read job duration as a performance signal without
  checking the outcome.
- **Agent tests are split into two tiers by `E2E_TIER` — unclassified tests fail the gate.** `@gate` tests (155, blocking — what a PR pays for) and `@model-decision` tests (22, non-blocking, run only on `main` and dispatch) are separate slices. `E2E_TIER=gate pnpm exec playwright test` / `E2E_TIER=model pnpm exec playwright test`; without the flag all 177 run (local default). An agent test with no classification fails the gate rather than defaulting into a tier — enforced by `scripts/__tests__/agent-test-classification.test.mjs`.
- **`--grep-invert` is accepted by Playwright 1.60 but does nothing.** `--grep CORS` lists 1 test; `--grep-invert CORS` lists all 177. The tier split must be applied via `E2E_TIER` → `grep`/`grepInvert` in `playwright.config.ts`, not as a CLI flag. A CLI-based split would appear to run only the selected tier while silently running the whole suite.
- **`node --test <file> --test-name-pattern "x"` silently runs everything.** Node stops parsing its own flags at the script path; anything after the path becomes the script's `argv` and is ignored. `--test-name-pattern` never applied. Nothing warns; the filter simply does not exist. The safe form is flags-before-path: `node --test --test-name-pattern "x" tests/foo.test.js`. Always verify a filter by checking that the reported test COUNT actually dropped — a filter that changes nothing was not applied.
- **A container reporting `running` at 100% CPU on one core is wedged, not slow.** 100% CPU means a spin; a blocked await sits near 0%. `movie-assistant-gateway` has been caught in a livelock (`drain_audit_tasks` refilling its own loop) where `docker inspect` said `running`, logs were 40 minutes stale, and `/health` timed out — five specs "reproduced" against a dead stack, not a defect. The gateway now carries a healthcheck so `docker ps` says `unhealthy` instead of `Up`. It is NOT auto-restarted (a wedged gateway must stay visible). Stack dump in one command: `docker kill -s USR1 movie-assistant-gateway && docker logs --tail 100 movie-assistant-gateway`. Zero gateway requests for a turn means check liveness first: `docker exec mcm-bff-service-nonsecure wget -qO- http://movie-assistant-gateway:8000/health`.
- **A datastore volume that survives between runs fails the NEXT run, not the current one.** The `kvm` runner is persistent; `app-ci.yml`'s "Reset stateful CI data" step removes data volumes so each run starts clean — but `mcm-bff-cache-redis-data` was missing from that step. PR #362's `app-e2e` ran Redis 8.10.1 and wrote an RDB v15 dump into it; the next `app-e2e` on Redis 8.6.2 (the `main` merge of PR #361, run 2735) died at bring-up with `# Can't handle RDB format version 15 … dependency failed to start: container mcm-bff-cache-redis is unhealthy`. Nothing in either failing commit touched Redis — the failing run was poisoned by the previous run's container. **Two diagnostic rules:** (1) "unhealthy at bring-up" with the container `Restarting (1)` is the signature — read the datastore's own log (the bundle's `mcm-bff-cache-redis.log`) before blaming the change; (2) a redis version moving in EITHER direction between consecutive runs trips this — an older-version PR after a newer-version PR is the common case on a Renovate day. Fixed 2026-09-05 by adding the volume to both reset steps; `scripts/__tests__/app-ci-stateful-reset.guard.test.mjs` now asserts every volume the setup step creates is also removed by the reset step.

For mobile-specific tunneling and APK-rebuild decisions, see
[Android emulator & APK builds](/openwiki/runbooks/android-emulator.md). Full container-mode
commands, the complete flakiness-diagnosis protocol, and the integration-tier CI enforcement detail:
`docs/runbooks/e2e-testing.md`.
