---
type: Runbook
title: E2E testing (BFF container modes & flakiness diagnosis)
description: The three BFF-fronting modes for end-to-end tests (Metro dev, dev-container HTTP, prod-container HTTPS), why the dev-container run is the deterministic baseline for flaky-vs-broken triage, and the CI integration-tier gate that now blocks a merge.
resource: docs/runbooks/e2e-testing.md
tags: [e2e, testing, playwright, ci, flakiness, runbook]
timestamp: 2026-08-09T00:00:00+00:00
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
- **Killing the shell does NOT kill a containerised `docker run`.** The container detaches from the
  CLI process, so cancelling the command leaves Playwright still running — consuming the same shared
  test user and gateway as any subsequent run. Measured 2026-08-09: an abandoned full-suite run was
  still at test 24/174 fifteen minutes after being "stopped". Always confirm and kill:
  `docker ps --filter ancestor=mcr.microsoft.com/playwright:v1.60.0-noble`.
- **Include the assistant's *decline* copy in the negatives.** The same routing bug can surface as
  "I couldn't find…" on one model and "I can only help with your movie collections." on another. A
  test that knows only one symptom misses the same defect on a different provider.

For mobile-specific tunneling and APK-rebuild decisions, see
[Android emulator & APK builds](/openwiki/runbooks/android-emulator.md). Full container-mode
commands, the complete flakiness-diagnosis protocol, and the integration-tier CI enforcement detail:
`docs/runbooks/e2e-testing.md`.
