# Test-harness remediation — two decided pieces of work

**Raised**: 2026-08-06, after 047 PR B merged · **Status**: decided by the product owner, not yet specced

Two independent workstreams, both approved. They share a theme — *a check that cannot fail is not a
check* — but they touch different projects and can ship separately.

---

## Work item 1 — put `test_out_of_domain.py` on the full golden pattern

**Decision: adopt the FULL pattern — `replay` in CI, `off` at the pre-deploy gate.** Not the
cassette half alone.

### Why

`agents/movie-assistant/tests/integration/test_out_of_domain.py` drives the **live** supervisor
model to verify FR-005 topic confinement. On 2026-08-06 the Anthropic balance ran out and all 9
tests errored in `app-e2e` — the model was unreachable, the tests skipped, and
`MCM_REQUIRE_LIVE_STACK=1` correctly escalated each skip to an error. CI green therefore depends on
an account balance.

### How the pattern works

One seam: `models.build_chat_model` returns a record/replay wrapper when `LLM_CASSETTE_MODE` is set
(`src/eval/cassette.py`). Cassettes are keyed on **`sha256(model_id + normalized prompt)`**, so a
prompt edit or a model bump produces a `CassetteMissError` — a loud miss, never a stale pass.

| Mode | Provider | Where |
|---|---|---|
| `replay` | **none** — `ReplayChatModel` never imports a provider | CI gate (keyless, offline) |
| `record` | live Claude | deliberate regeneration |
| `off` | live Claude | the pre-deploy live gate |

`test_golden_pairs.py` is the reference implementation; cassettes live in
`agents/movie-assistant/tests/golden/cassettes/`.

### ⚠️ The part that is NOT already built

**The `off`-mode pre-deploy live gate does not exist.** `test_golden_pairs.py`'s docstring calls it
"the pre-deploy live gate (T063)", but nothing invokes it: `guardrails.yml:225` runs `replay`, and
`cd-deploy.yml` has **no** live-model gate at all. That original T063 was feature 012's and is long
gone.

So this item is two things, and **shipping only the first is the failure mode to avoid** — it would
convert a behavioural check into a regression check and silently drop the live verification the test
exists for:

1. Convert `test_out_of_domain.py` to the cassette seam and run it `replay` in CI.
2. **Build** the `off`-mode live gate and wire it into the pre-deploy path.

### The counter-argument, already considered

`_LEGITIMATE_SKIPS` (`tests/integration/conftest.py`) deliberately allows an HTTP **529** (provider
overloaded) to skip, while a **4xx fails loudly** — "so a 4xx (bad key, malformed request) still
fails loudly". The credit exhaustion was a `400`, so CI behaved exactly as someone intended: it told
us loudly that the balance had run out. Cassetting removes that signal. **The product owner has
weighed this and chosen the golden pattern** — do not relitigate it, but do keep the live gate
genuinely live, because that is what preserves the signal.

---

## Work item 2 — fix two tests AND put the MCP servers in CI

**Decision: fix both, and add them to CI.** Fixing without adding was explicitly rejected — it
restores the illusion that produced this.

Full analysis: [PRD-UnrunMcpIntegrationTests.md](./PRD-UnrunMcpIntegrationTests.md). Summary:

**Neither failure is a regression.** The test, the parser and the fixture share exactly one commit
(`33eba4c`, 2026-06-14) — they have never passed, because **no MCP server's `test:integration` runs
anywhere in CI**. `app-ci` covers `movie-assistant`, `mc-service`, `mcm-app` only.

| Project | In CI | Today |
|---|---|---|
| `movie-mcp` | no | 20 passed |
| `web-api-mcp` | no | 5 failed — `ConnectTimeout` to TMDB, **probably** dev-container egress, unconfirmed |
| `spreadsheet-mcp` | no | 2 failed — both genuine |

**Failure 1 — stale assertion.** `rowCount == 200`; the sheet has **204**. Verified with openpyxl:
205 rows including header, 204 non-empty, the last four `Test Movie 4…7` appended for the import
tests. The parser counts data rows correctly. Fix the assertion, and derive it from the fixture so
appending a row cannot silently break it again.

**Failure 2 — shared client vs per-test loops.** `store.py`'s module-level `_shared_client` is
**correct for the server** (one long-lived process, one loop) but collides with pytest-asyncio's
per-test loop. Fix the fixture (reset the singleton), **not** the singleton.

**CI scope**: add `movie-mcp` + `spreadsheet-mcp` now (both keyless once fixed); add `web-api-mcp`
once its TMDB-credential-in-CI question is settled, and confirm the egress theory first.

---

## Before starting

- **SDD gate applies.** Both items write code under `agents/` and `mcp-servers/`, so a numbered
  `specs/NNN-*/` **spec → plan → tasks** set must exist first — see
  [the lifecycle](../../openwiki/process/spec-driven-development.md). These proposal docs are the
  input to it, not a substitute.
- **PR batching**: the two items are independently attributable, so a red build could be traced
  either way — [batch them](../../openwiki/process/pull-request-batching.md) unless something makes
  attribution ambiguous.

## Traps that cost the 047 PR B session real time

- **Both images are baked, not mounted.** A client change is invisible to E2E until
  `pnpm nx docker-build mcm-app`, and an agent change until
  `SPECIALIST_MODEL=qwen2.5 node scripts/agent-stack.mjs`. A stale image fails as "the feature does
  not work", which reads exactly like the bug you are hunting.
- **`pnpm nx e2e mcm-app` cannot run here, but Playwright can** — official image, `--network host`,
  and `--user "$(id -u):$(id -g)" -e HOME=/tmp` is not optional. See
  [e2e-testing.md](../runbooks/e2e-testing.md).
- **Watch the SKIP COUNT**, and set both `MCM_REQUIRE_LIVE_STACK=1` and `E2E_REQUIRE_AGENT_STACK=1`.
- **Verifying a test can fail proves it is sensitive, not correct** — see
  [test-authoring-conventions](../../openwiki/process/test-authoring-conventions.md).
- **Process-wide singletons make tests order-dependent.** Work item 2's failure 2 is one instance;
  the agent's metadata cache was another. If a fault-injection test passes alone and fails in the
  suite, the cache is what is being tested.
