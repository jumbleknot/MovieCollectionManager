# Quickstart: validating feature 098

Run these from a worktree (see [devcontainer runbook](../../docs/runbooks/devcontainer.md)) after
`CI=true pnpm install --frozen-lockfile`. A `pnpm nx` target will not run against a symlinked `node_modules`.

## 1. Unit tests (both stories)

```bash
pnpm nx test mcm-app --skip-nx-cache
```

Expect the new suites to pass: `use-open-panel`, `use-keyboard-inset`, `view-options-dock`, and the updated
`collection-screen` and `assistant-dock`. **Check the skip count**: a skipped test is not a pass.

## 2. Lint, types and bundle budget (the entry chunk gains the provider and the dock bar)

```bash
pnpm nx run-many -t lint typecheck bundle-budget -p mcm-app
```

`bundle-budget` must stay under 2,000,000 bytes, with zero `@copilotkit/*` modules in the entry chunk.

## 3. Web E2E: Story 1 and the regression (SC-005)

Follow [e2e-testing](../../docs/runbooks/e2e-testing.md), Playwright in its official image:

- `tests/e2e/web/collection-view-options.spec.ts` (new). At 360×640: the bar is visible, no `movie-filter-panel`
  is shown, and at least 3 list rows are inside the viewport (SC-001). Open, choose a filter, close: the list
  is filtered and the badge reads 1. Escape closes. Opening the assistant closes the panel.
- `tests/e2e/web/movies.spec.ts`: every test passes, the only change being `openViewOptions(page)`.
- Assistant specs run with `E2E_REQUIRE_AGENT_STACK=1`, so a missing stack fails instead of skipping.

## 4. Android: Story 2 and the mobile regression

Use the devcontainer KVM emulator ([android-emulator](../../openwiki/runbooks/android-emulator.md)):

1. **Verify RED first (T001):** on `main`, run `assistant-keyboard.yaml`. It must fail with the input hidden.
   Record the screenshot.
2. On the branch: `scripts/maestro-run.sh tests/e2e/mobile/assistant-keyboard.yaml`. Expected result: with the
   keyboard up, `assistant-dock-input` and `assistant-dock-send` are visible, and the typed text is
   readable in the screenshot.
3. `movie-sort.yaml`, `movie-browse.yaml`, `movie-count.yaml` and `movie-search-filter.yaml` pass with the added
   `view-options-toggle` tap.

## 5. Manual check (iOS has no runner here)

On an iOS device or simulator, if one is available: open the assistant, type, and confirm the input sits above
the keyboard. If none is available, record "iOS unverified" in the PR rather than claiming it.
