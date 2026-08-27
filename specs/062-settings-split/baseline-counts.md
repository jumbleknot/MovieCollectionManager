# Baseline counts — `062-settings-split` (T001)

Recorded on the unmodified branch at `79d29af5`, before any implementation task ran.
Both the **pass count and the skip count** are recorded: a skipped test reads as a pass, and
without the starting skip count there is no way to notice one appearing later.

Run date: 2026-08-23

| Tier | Command | Suites | Pass | Skip | Fail |
| --- | --- | --- | --- | --- | --- |
| Frontend unit | `pnpm nx test mcm-app` | 123 passed / 123 total | **1194** | **0** | 0 |
| Design system unit | `pnpm nx test design-system` | 11 passed / 11 total | **86** | **0** | 0 |
| Agent gateway unit | `pnpm nx test movie-assistant` | — (pytest) | **1164** | **2** | 0 |
| Typecheck | `pnpm nx typecheck mcm-app` | — | 0 errors | — | 0 |

## The two pre-existing gateway skips, named

Both are property-based generators rejecting a generated case, not disabled tests. They are
data-dependent, so the count can legitimately vary on a given run; a skip appearing anywhere else
is a change:

- `tests/unit/test_resolvers_properties.py:231` — "Generated pick accidentally contains an option title — skip"
- `tests/unit/test_resolvers_properties.py:414` — "Identical years — not the ambiguous case"

## Web E2E

Not baselined by count here. The web tier is not runnable from this dev container without the
Playwright image recipe in [quickstart.md](./quickstart.md) §3, and each Verify RED/GREEN in
[tasks.md](./tasks.md) states its own expected failed/skipped pair. The rule that matters is
carried per-task: **a Verify RED reporting skips instead of failures has not been run** — see T023,
where an absent `KEYCLOAK_SERVICE_CLIENT_SECRET` turns two of three cases into a green-looking
no-op.
