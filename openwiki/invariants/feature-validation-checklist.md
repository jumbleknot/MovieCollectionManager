---
type: Convention
title: Final validation checklist
description: The full sequence of checks every feature must pass before it is marked complete — including the web E2E regression required even for backend-only mc-service changes, and the 70 percent line-coverage thresholds enforced for both mcm-app (Jest) and mc-service (tarpaulin).
tags: [testing, ci, checklist, coverage, e2e]
timestamp: 2026-07-30T13:00:00+00:00
---

# Final validation checklist

Run all of the following before marking any feature complete. **The web E2E regression (`pnpm nx e2e mcm-app`) is REQUIRED for EVERY feature — including backend-only (mc-service) changes** — because a backend change is exercised by the clients through the BFF → service; only E2E proves the real user path still works end-to-end. **If a deployed service/BFF container was changed, rebuild + redeploy it first** (`pnpm nx build <service>` then recreate the container) or the E2E validates a stale image. (Feature 011 lesson.)

- [ ] `docs/templates/feature-test-tasks-template.md` format followed for all test tasks
- [ ] Platform parity table updated for this feature
- [ ] `pnpm nx test mc-service` — Rust unit tests pass
- [ ] `pnpm nx test:integration mc-service` — Rust integration tests pass
- [ ] `pnpm nx lint mcm-app` — no lint errors
- [ ] `pnpm nx typecheck mcm-app` — `tsc --noEmit` clean (also run in CI by app-ci's `affected` job)
- [ ] `pnpm nx test mcm-app` — unit tests pass (≥70% line coverage)
- [ ] `pnpm nx test:integration mcm-app` — integration tests pass
- [ ] `pnpm nx e2e mcm-app` — web E2E passes (single login via global setup).
      **A full local suite IS a valid gate again as of feature 054** — `dev-realm`'s
      `accessTokenLifespan` now matches `ci-realm` (5400 s), so a run past ~5 minutes no longer
      re-enters the refresh contention that made two 44-minute attempts meaningless (62
      `refresh_rate_limited`, collapsing into `gotoHome: home screen did not render`). You do not have
      to check the counters by hand: a `globalTeardown` fails the run if any refresh was rate-limited,
      naming the token lifespan. **A realm change needs a re-import** — a running Keycloak keeps the
      old value. See `docs/runbooks/e2e-testing.md`.
- [ ] **`node scripts/agent-stack.mjs` then `node scripts/agent-e2e.mjs`** — the AGENT web specs.
      `pnpm nx e2e mcm-app` alone does **not** run them: every gated `agent-*.spec.ts` self-skips
      unless `E2E_AGENT_PRODUCTION=1`, so the line above reports green having exercised none of them.
      Set `E2E_REQUIRE_AGENT_STACK=1` to turn that skip into a hard failure.
      **Since feature 051 `app-ci / app-e2e` forwards both flags into the Playwright container**, so
      CI exercises these specs too — it had never run one before. That does not retire this item: CI
      runs them against the deployed stack, and this item is what proves them before the push.
- [ ] `pnpm nx e2e:mobile mcm-app` — mobile E2E passes
      (in the dev container: `scripts/devcontainer-android.sh boot` first;
      agent flows: `bash scripts/ci-mobile-agent-flows.sh`)
- [ ] `pnpm nx wiki-update infrastructure-as-code` — refresh the OKF wiki, include the diff in the PR (a no-op is valid), then `pnpm nx okf-lint infrastructure-as-code` passes
- [ ] `rtk gain` — >80% token compression confirmed (run last; measures the runs above)

## Coverage thresholds

Both client-facing and service-side test tiers enforce the same ≥70% line-coverage bar, measured by
different tools per stack:

- **mcm-app**: `pnpm nx test mcm-app` (Jest) enforces ≥70% line coverage as part of the unit-test run
  itself — coverage is not a separate opt-in step.
- **mc-service**: measured separately with `cargo tarpaulin` (SC-011):

  ```bash
  cargo tarpaulin --manifest-path backend/mc-service/Cargo.toml --ignore-tests --out Lcov
  ```

  `cargo-tarpaulin` is a dev dependency in `backend/mc-service/Cargo.toml`, not a standalone install.

## Gotchas

- **The web E2E item is not skippable for a backend-only change.** A Rust-only or Python-only change
  is only proven end-to-end by driving it through the BFF from the client's perspective — the client
  and service layers are validated together, never independently, by this checklist.
- **`pnpm nx e2e mcm-app` does not cover the assistant.** Of the 13 `agent-*.spec.ts` files, 11 call
  `requireAgentStack` and gate on `E2E_AGENT_PRODUCTION=1` — without the containerized
  production-node stack they cannot run, so they skip. (`agent-cors.spec.ts` and
  `agent-session-refresh.spec.ts` do not gate: they exercise transport and session behaviour that
  needs no model.) Playwright reports the run green and nothing says the agent flows were never
  exercised. **Set `E2E_REQUIRE_AGENT_STACK=1` on any pre-PR run**: the shared gate
  (`tests/e2e/web/setup/agent-stack-gate.ts`) then FAILS with instructions instead of skipping.
  This is the same no-false-green discipline as `MCM_REQUIRE_LIVE_STACK` in the Python integration
  tiers and the `mc-service-integration-guard`'s executed-test assertion — a suite that passes for
  the wrong reason is worse than one that does not run.
- **CI now does this too — it did not until feature 051, and that was the point.** This page told
  people to set the flag "on any pre-PR or CI run", but `app-ci / app-e2e` set
  `E2E_AGENT_PRODUCTION` at job level and never passed it through `docker run -e`, so it was
  invisible inside the Playwright container. Every agent spec skipped on every CI run for the
  lifetime of that job, behind a green REQUIRED gate. The same omission hid
  `KEYCLOAK_SERVICE_CLIENT_SECRET`, so `admin-card.spec.ts` and `admin-registration.spec.ts` skipped
  as well. **`docker run` forwards only what `-e` names**: a variable set in a job's `env:` block is
  not in the container unless it is listed, and the resulting skip is silent. Both are now forwarded
  and asserted by `scripts/__tests__/app-e2e-env.guard.test.mjs`, because guidance on a page cannot
  keep a workflow honest — only a gate can.
- **In the dev container, Playwright runs IN A CONTAINER and the integration tiers read their
  credentials from `stacks/auth.env`, not `frontend/mcm-app/.env.local`** (which does not exist on
  that path). Both incantations, including the mandatory `--user "$(id -u):$(id -g)"`, are in
  [Containerized dev environment](/openwiki/runbooks/devcontainer.md).
- **A changed deployed service/BFF container must be rebuilt and redeployed before the E2E run runs
  against it**, or the suite silently validates a stale image and reports false confidence (the
  feature 011 lesson cited above).
- **`rtk gain` runs last, deliberately** — see
  [RTK token compression](/openwiki/invariants/rtk-token-compression.md) — because it measures the
  token cost of every check that ran before it, not the checklist item itself.
- **The wiki-update step is part of the checklist, not an optional add-on**: `pnpm nx wiki-update
  infrastructure-as-code` must run and its diff (even a no-op) belongs in the PR, followed by
  `pnpm nx okf-lint infrastructure-as-code` passing.

See [Testing tiers and what gates a merge](/openwiki/invariants/testing-tiers.md) for how these same
tiers map to what actually blocks CI versus what is exercised locally before a PR, and
[Nx as the universal task runner](/openwiki/invariants/nx-task-runner.md) for why every item here is
invoked through `pnpm nx <target>` rather than the underlying tool directly.
