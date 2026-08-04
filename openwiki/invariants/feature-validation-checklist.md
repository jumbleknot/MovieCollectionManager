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
- [ ] `pnpm nx e2e mcm-app` — web E2E passes (single login via global setup)
- [ ] **`node scripts/agent-stack.mjs` then `node scripts/agent-e2e.mjs`** — the AGENT web specs.
      `pnpm nx e2e mcm-app` alone does **not** run them: every `agent-*.spec.ts` self-skips unless
      `E2E_AGENT_PRODUCTION=1`, so the line above reports green having exercised none of them.
      Set `E2E_REQUIRE_AGENT_STACK=1` to turn that skip into a hard failure.
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
- **`pnpm nx e2e mcm-app` does not cover the assistant.** All ten `agent-*.spec.ts` files gate on
  `E2E_AGENT_PRODUCTION=1` — without the containerized production-node stack they cannot run, so
  they skip. Playwright reports the run green and nothing says the agent flows were never
  exercised. **Set `E2E_REQUIRE_AGENT_STACK=1` on any pre-PR or CI run**: the shared gate
  (`tests/e2e/web/setup/agent-stack-gate.ts`) then FAILS with instructions instead of skipping.
  This is the same no-false-green discipline as `MCM_REQUIRE_LIVE_STACK` in the Python integration
  tiers and the `mc-service-integration-guard`'s executed-test assertion — a suite that passes for
  the wrong reason is worse than one that does not run.
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
