# Feature Specification: The live Avatar test stops depending on how many films TMDB lists for a year

**Feature Branch**: `088-tmdb-year-test-guard`

**Created**: 2026-11-06

**Status**: Approved by the operator, 2026-11-06

**Input**: `app-e2e` failed on PR 940 (app-ci run 6824) in a test that PR does not touch. Item #941
holds the product question this feature leaves open.

## Measured Baseline

- `test_avatar_resolve_option_prefers_full_title_over_bare_prefix` asks live TMDB for "Avatar", then
  asserts that `Avatar (<year of The Way of Water>)` resolves to *The Way of Water*.
- That assertion needs 2022 to name one option. TMDB now lists three 2022 films for "Avatar": *Avatar:
  The Way of Water*, *Whispering Avatar* and *Avatar: The Deep Dive - A Special Edition of 20/20*.
- So `resolve_option`'s year step does not match, the title step does, and the result is a film called
  `Avatar`: `1 failed, 64 passed, 12 skipped`.
- `agent-integration` stops the `app-e2e` job, so web E2E never runs. Every PR that runs this step is
  expected to fail the same way until TMDB's results change.
- Unit tests already fix the year step's behaviour against stored options, but none uses a bare title
  plus a year, which is what the live assertion checks.

## User Story: A merge is not blocked by TMDB adding a film (P1)

A contributor's PR that does not touch the resolver is not failed by a change in TMDB's listings, and
the behaviour the assertion protects is still tested.

**Acceptance Scenarios**:

1. **Given** live TMDB lists several options for that year, **When** the test runs, **Then** it passes,
   and its title assertions still run.
2. **Given** live TMDB lists one option for that year, **When** the test runs, **Then** the year-bearing
   assertion still runs.
3. **Given** the year step is broken, **When** the unit tests run, **Then** a test that uses no live data
   fails on a bare title plus a year.

## Requirements

- **FR-001**: The year-bearing assertion runs only when exactly one live option has that year.
- **FR-002**: A hermetic unit test asserts that a bare title plus a year naming one option returns that
  option, not the bare-titled film.
- **FR-003**: The rest of the live test is unchanged. It is not skipped, and no assertion is weakened.
- **FR-004**: `resolve_option` is not changed. Its guess on a shared year is item #941.

## Out of Scope

Deciding or fixing what the resolver does with a shared year (item #941), and item #932.

## Success Criteria

- **SC-001**: The live test passes against today's TMDB results, not skipped, with the MCP server running.
- **SC-002**: The new unit test fails when the year step is disabled, and passes when it is restored.
