# The MCP servers' integration tests have never run in CI — and two have been failing since June

**Raised**: 2026-08-06, after 047 PR B · **Status**: proposal — needs a decision, no work started

## The finding

`spreadsheet-mcp` has two integration tests that fail. Both were introduced by
`33eba4c feat(014)` on **2026-06-14** and **neither has ever passed** — the test file, the parser
and the fixture all have exactly that one commit between them, so nothing regressed. They were
simply never run.

The reason is structural: **`app-ci` runs `test:integration` for three projects only** —
`movie-assistant`, `mc-service`, `mcm-app` ([app-ci.yml](../../.forgejo/workflows/app-ci.yml)).
All three MCP servers declare a `test:integration` target and none of them is invoked anywhere in
CI.

| Project | `test:integration` declared | Run in CI | Result today |
|---|---|---|---|
| `movie-mcp` | yes | **no** | 20 passed |
| `web-api-mcp` | yes | **no** | 5 failed — `ConnectTimeout` to TMDB |
| `spreadsheet-mcp` | yes | **no** | **2 failed — genuine defects** |

## Failure 1 — a stale assertion (decide: fix the test)

`test_parse_via_real_transient_store_is_single_use` asserts the sample workbook's `Sample` tab has
`rowCount == 200`. It has **204**.

Verified against the file directly with openpyxl: 205 rows including the header, **204 non-empty
data rows**. The last four are `Test Movie 4…7`, appended for the import tests — so the sheet is
~200 films plus four fixtures, and the assertion was written to the intent rather than the content.

`rowCount` is `len(data_rows)` in `_build_tab`, which is correct: it counts data rows. **The parser
is right and the expectation is wrong.**

> **Recommended: change the assertion to 204**, and derive it from the fixture rather than
> restating it, so appending a row to the sheet cannot silently break it again.

## Failure 2 — a shared client vs per-test event loops (decide: fix the test)

`test_missing_handle_raises_not_found` dies with:

```
RuntimeError: Task ... got Future attached to a different loop
RuntimeError: Event loop is closed
```

`store.py` holds a module-level `_shared_client` — a lazily-created, process-wide Redis client.
That is **correct for the server**, which is one long-lived process on one event loop. But
pytest-asyncio gives each test its own loop: test 1 creates the client on loop A, test 2 runs on
loop B and reuses the singleton, and the future belongs to a closed loop.

So this is a **test-isolation defect, not a product defect** — the shared client is the right design
for production and must not be changed to suit the tests.

> **Recommended: reset `store._shared_client` between tests** (an autouse fixture), the same way
> the agent tier now clears its process-wide metadata cache. Note the shape: *a module-level
> singleton makes a test order-dependent, and the symptom points at the wrong layer.*

## The decision that actually matters

Fixing two assertions is half an hour. The question worth deciding is **whether the MCP servers'
integration tests should run in CI at all**, because right now writing one has no effect on anything.

| Option | For | Against |
|---|---|---|
| **A. Add all three to `app-ci`** | The tests start meaning something; `movie-mcp` already passes | `web-api-mcp` needs TMDB egress + a key in CI, so it either gets a credential or stays excluded. Adds runtime to an already ~35-minute job |
| **B. Add `movie-mcp` + `spreadsheet-mcp` only** | Both are keyless once fixed; small runtime cost | Leaves `web-api-mcp` in the same unverified state, and the gap recurs quietly |
| **C. Fix the two tests, add none to CI** | Cheapest | Restores the illusion without the safety — they will rot again, and the next person will find them the same way |
| **D. Delete them** | Honest about what is actually maintained | Loses real coverage of the single-use handle contract, which is a security-relevant property |

**Recommendation: B now, A when `web-api-mcp`'s CI credential question is settled.** C is the one to
avoid — it is what produced this situation.

## Not investigated

`web-api-mcp`'s 5 failures are `ConnectTimeout` to TMDB and are **probably** the dev container's
egress firewall rather than defects: the same TMDB path works through the `web-api-mcp` *container*
during agent E2E. Not confirmed, and it should be before that project is added to CI.

## Related

The same root cause — a suite that never runs looks identical to a suite that passes — is what
`E2E_REQUIRE_AGENT_STACK` and `MCM_REQUIRE_LIVE_STACK` exist to prevent inside a suite. Neither
helps when the suite is not invoked at all. See the gate in [CLAUDE.md](../../CLAUDE.md) and the
skip-count sections in [e2e-testing.md](../runbooks/e2e-testing.md).
