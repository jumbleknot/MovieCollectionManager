# Implementation Plan: The live Avatar test stops depending on how many films TMDB lists for a year

**Spec**: [spec.md](./spec.md) | **Branch**: `088-tmdb-year-test-guard`

## Summary

One condition on one live assertion, plus one hermetic unit test, so the protected behaviour no longer
relies on live data alone. No product code changes.

## Design

| File | Change |
| --- | --- |
| `agents/movie-assistant/tests/integration/test_resolution_realistic.py` | Run the year-bearing assertion only when one option has that year |
| `agents/movie-assistant/tests/unit/test_resolvers_adversarial.py` | Add a bare-title-plus-year test on `PREFIX_COLLISION_OPTIONS` |

Years are compared as strings in the guard, because options can carry a year as an int or a string, and
the test should not import the resolver's private `_as_int`.

The guard does not call `pytest.skip`: everything before it has already run and passed, and a skip would
report those assertions as not run.

**Rejected**: changing the resolver now. That is a product decision, and it is tracked as item #941.
Pinning today's wrong result in a test would make item #941 harder to fix.

## Verification

- Live test: `web-api-mcp` running, `MCM_REQUIRE_LIVE_STACK=1`, so a skip cannot read as a pass.
- Unit test: temporarily disable the year step to prove that the test fails, then restore it.
- `pnpm nx test movie-assistant` and `pnpm nx lint movie-assistant`, since this diff touches Python.
