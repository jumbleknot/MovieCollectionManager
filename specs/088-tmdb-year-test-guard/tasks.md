# Tasks: The live Avatar test stops depending on how many films TMDB lists for a year

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

**Tests**: This feature changes only tests, so each task proves its result directly.

- [X] **T001** Reproduce the failure on the unchanged test, against live TMDB, with
  `MCM_REQUIRE_LIVE_STACK=1`. **Expected RED**: `Year-bearing pick resolved to wrong film: 'Avatar'`.
- [X] **T002** Add the bare-title-plus-year unit test (FR-002). Prove it fails with the year step in
  `resolve_option` disabled, then restore the code and prove it passes (SC-002).
- [X] **T003** Guard the year-bearing assertion on exactly one option having that year (FR-001, FR-003).
  Run the live test with the same flag (SC-001).
- [X] **T004** Run `pnpm nx test movie-assistant` and `pnpm nx lint movie-assistant`, and file item #941
  for the resolver's behaviour (FR-004).

## Evidence

Measured 2026-11-06, in the dev container, with `web-api-mcp` on port 8765 and live TMDB.

| Task | Result |
| --- | --- |
| T001 | `AssertionError: Year-bearing pick resolved to wrong film: 'Avatar'`, `1 failed` (same as app-ci run 6824) |
| T002, year step disabled | `5 failed, 144 passed`, including the new test |
| T002, restored | `149 passed` in `test_resolvers_adversarial.py` |
| T003 | `1 passed`, not skipped |
