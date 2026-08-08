# Test-harness remediation — three decided pieces of work

**Raised**: 2026-08-06, after 047 PR B merged · **Status**: decided by the product owner, not yet specced

Three independent workstreams, all approved. They share a theme — *a check that cannot fail is not a
check* — but they touch different projects and can ship separately.

## Read this first: the strategy is already written

[MCM-Testing-Strategy.md](./MCM-Testing-Strategy.md) is the canonical, repo-wide testing strategy —
what each tier proves and where it runs. **Read it before proposing any change to the test topology.**
Two of its statements bound everything below, and both were already true before this document existed:

- **§5.6 already specifies the pre-deploy live gate** — *"`LLM_CASSETTE_MODE=replay` … the **mergeable**
  gate … a live-model run is the **pre-deploy** gate."* Work item 1 **implements documented strategy**;
  it does not invent policy. The [constitution](../../.specify/memory/constitution.md) agrees (§469,
  §493: the golden suite must gate deployment and alert on quality degradation).
- **§2 fixes what each tier is for**: golden = the LLM's *model decisions*, cassetted; integration =
  service↔service contracts with **all real** collaborators; E2E = critical user flows on the real
  client. The live model in the E2E tiers is incidental to their purpose — they test wiring.

### Owner constraint — no scheduled quality gates

**Quality checks gate at merge or at deploy, never on a timer.** The product owner's reasoning:
*"if it finds a problem it has already been missed and potentially allowed into prod."* Every green
merge to `main` auto-dispatches `cd-deploy`, so a nightly or weekly run can only ever report damage
already shipped. Do not propose a scheduled variant of any gate below.

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
gone. Note this is a **three-way gap between docs and reality** — the strategy doc (§5.6), the
constitution (§469/§493) and the golden docstring all assert this gate exists. Only the code disagrees.

**Consider moving the test, not just cassetting it.** `test_out_of_domain.py` asserts a *model
decision* (FR-005 topic confinement), which by §2 of the strategy doc is what the **golden** tier is
for — it is currently a golden-shaped test living in the integration tier, which is how it imported a
live-model dependency into a tier whose purpose is service↔service contracts. Moving it into
`tests/golden/` makes it inherit replay-in-CI and live-at-deploy from the existing runner with no new
machinery. Weigh this against the cost of relocating; it is a recommendation, not a decision.

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

## Work item 3 — measure what a CI run actually costs in tokens

**Decision: measure before optimising.** No change to which suites use a live model is approved, and
none should be proposed, until this number exists.

### Why this is open

A routine `app-ci` run drives **at most ~61 flows against a live Anthropic model** — counted
2026-08-06, treat as an upper bound (a few specs, e.g. `agent-cors.spec.ts`, may never reach a model
turn; nobody has confirmed per-spec):

| Surface | Live-model flows | Where |
|---|---|---|
| Agent integration (`test_out_of_domain`) | **9** — 8 parametrized prompts + 1 full-graph | `app-ci.yml:444` |
| Web E2E `agent-*`/`assistant-*` | **43** test fns / 24 spec files | `app-ci.yml:543` |
| Mobile agent flows on the emulator | **9** (`flows=()` array, ×3 retry on CCT crash) | `app-ci.yml:605`, `scripts/ci-mobile-agent-flows.sh:65` |
| Golden | **0** — keyless replay, 41 pairs in 0.36 s | `guardrails.yml:225` |

Whether that is worth changing depends entirely on the dollar figure, which **nobody has measured**.
Recommendations made without it have already been wrong twice — and the mobile row was itself
mis-stated as 19 in an earlier draft, which is exactly why the measurement, not the estimate, decides.

### The instrument already exists and is live-verified

Do not build a new one. [`src/observability.py`](../../agents/movie-assistant/src/observability.py)
attaches a LangFuse v3 callback per run (env-gated on `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`, so
the default dev/test/E2E path is a no-op), and
[`tests/integration/test_observability_sc008.py`](../../agents/movie-assistant/tests/integration/test_observability_sc008.py)
already performs this exact measurement — real Claude turns → `client.api.trace.list(session_id=…)` →
`total_cost` + `latency` per trace, asserted against a budget. Live-verified 2026-06-09 (012 T067).

### Three tiers — do tier 0 first, it may settle the question

**Tier 0 — Anthropic Console, zero code.** Read spend for the key CI uses.

> ⚠️ **The single shared key makes this misleading on its own.** `app-ci.yml:255` and
> `wiki-maintain.yml:156` both use `secrets.ANTHROPIC_API_KEY`. A wiki-generation run is very likely
> far larger than 71 short agent turns, so console spend against that key conflates the two and will
> **overstate CI test cost**. **Issuing a separate key per surface is the cheapest fix on this list
> and needs no code** — do that first, then read the console.

**Tier 1 — a usage sink at the cassette seam (per-suite attribution).**
[`build_chat_model`](../../agents/movie-assistant/src/models.py) is the single seam every LLM call
passes through, and `RecordingChatModel` already proves a wrapper works there. A sibling wrapper that
appends `{model, input_tokens, output_tokens}` to JSONL — gated on its own env var, so it is
additive and off by default — gives per-suite attribution, because each CI step is a distinct window.
Upload the JSONL as an artifact and price it in a script. No infra.

**Tier 2 — LangFuse in CI.** Real per-trace cost with **zero test changes**, since
`inject_observability` reads env at run time and tags the trace with `thread_id` as the session. But
the local stack is **7 containers** (`langfuse-web`, `-worker`, `-postgres`, `-clickhouse`, `-redis`,
`-minio`, `-minio-init`) added to a job already running ~35 min.

> **Tier 2 is probably unnecessary.** Production **already runs LangFuse** —
> `infrastructure-as-code/docker/agents/compose.prod.yaml:61-63` carries the keys. A pre-deploy live
> gate (work item 1) running against the prod-shaped stack therefore gets cost attribution **for
> free**. Prefer tier 0 → tier 1, and let work item 1 supply the deploy-side number.

### Known traps (recorded in 012 T067 — do not rediscover)

- **LangFuse does not price recent Claude models out of the box** → cost silently computes as `0`.
  Register a **prefix-match** price (`(?i)^<model_id>`, no `$`): the response model carries a date
  suffix, e.g. `claude-haiku-4-5-20251001`, which an anchored pattern misses.
- **Ingestion is async** (worker → ClickHouse). You must `get_client().flush()` and then **poll** the
  API; reading immediately returns nothing.
- **The v3 self-host needs the MinIO `langfuse` bucket pre-created** (`langfuse-minio-init`).
- **Ollama is free**, so a cost measurement must run against a priced provider or it reads `$0`.

### What this measurement is *for*

The open question it feeds: **should the ~52 E2E agent flows (43 web + 9 mobile) keep using a live
Anthropic model?**
Both directions have real evidence, and it should not be decided on instinct:

- **For keeping it:** 047 PR A found a guard bug that *passed on local Ollama and failed on Anthropic
  in CI*. Anthropic-in-E2E has caught a genuine provider-dependent defect.
- **Against:** by strategy §2, E2E exists to prove *wiring*; the model is a dependency it drags in.
- **Constraint:** CI has **no Ollama** — `_LEGITIMATE_SKIPS` states *"CI runs the runtime model as
  Anthropic and has no Ollama."* Switching providers is infrastructure work, not a config flag.

---

## Before starting

- **SDD gate applies to items 1, 2 and tier 1 of item 3** — they write code under `agents/`,
  `mcp-servers/` or `.forgejo/`, so a numbered `specs/NNN-*/` **spec → plan → tasks** set must exist
  first — see [the lifecycle](../../openwiki/process/spec-driven-development.md). These proposal docs
  are the input to it, not a substitute.
  **Item 3 tier 0 is exempt** — splitting an API key and reading a console writes no code.
- **Do item 3 tier 0 first, before speccing anything.** It is free, takes minutes, and its result may
  change the scope of what is worth building.
- **PR batching**: the items are independently attributable, so a red build could be traced to the
  right one — [batch them](../../openwiki/process/pull-request-batching.md) unless something makes
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
- **`rg -rn` / `rg -ril` silently returns nothing.** `-r` is `--replace` and swallows the next
  characters as its value, so the flag cluster parses but the search is meaningless — it returned
  clean false negatives for `langfuse` and `usage_metadata` in this session and nearly produced a
  "not implemented" conclusion about code that *is* implemented. Use `rg -n`/`rg -l`, or `grep -rn`.
  **A search returning nothing is a claim that needs a second method before you act on it.**

---

## Prompt for the fresh session

```text
Pick up docs/proposals/PRD-TestHarnessRemediation.md. Three approved workstreams; nothing is specced yet.

READ FIRST, in this order — do not propose any change to the test topology before finishing them:
  1. docs/proposals/MCM-Testing-Strategy.md   — the canonical strategy. §2 (what each tier proves),
     §5.6 (golden: replay = mergeable gate, live = PRE-DEPLOY gate), §6 (E2E/deploy discipline).
  2. docs/proposals/PRD-TestHarnessRemediation.md  — the three items and their traps.
  3. docs/proposals/PRD-UnrunMcpIntegrationTests.md — full analysis behind item 2.

TWO HARD CONSTRAINTS FROM THE PRODUCT OWNER:
  - Quality checks gate at MERGE or at DEPLOY, never on a schedule. Every green merge to main
    auto-dispatches cd-deploy, so a timed run can only report damage already shipped.
  - Do not relitigate the decisions already made (adopt the full golden pattern; fix the MCP tests
    AND add them to CI). They are decided. Implement them.

START WITH ITEM 3 TIER 0 — it is free, takes minutes, and may resize the other work:
  app-ci.yml:255 and wiki-maintain.yml:156 share ONE secrets.ANTHROPIC_API_KEY, so console spend
  conflates CI test runs with wiki generation (likely the larger consumer). Splitting the key per
  surface needs no code. Report the measured $/CI-run before recommending anything about the ~52
  live-model E2E flows. Do NOT build a new measurement instrument — src/observability.py +
  tests/integration/test_observability_sc008.py already do this and are live-verified; the PRD lists
  the four traps (unpriced Claude models -> silent $0, async ingestion, MinIO bucket, Ollama is free).

THEN: SDD gate. Items 1, 2 and item-3-tier-1 write code, so a numbered specs/NNN-*/ spec -> plan ->
tasks set must exist before any implementation. These PRDs are its input, not a substitute.

HOW TO WORK (this cost the last two sessions real time):
  - Verify by RESULT, not exit status. Watch the SKIP COUNT; set MCM_REQUIRE_LIVE_STACK=1 and
    E2E_REQUIRE_AGENT_STACK=1 — a skip otherwise reads as a pass.
  - A test that fails when you break it is SENSITIVE, not CORRECT. Confirm it exercises the code path
    you think it does (a whole suite here "passed" while calling zero tools).
  - Both images are BAKED. A client change needs `pnpm nx docker-build mcm-app`; an agent change needs
    `node scripts/agent-stack.mjs`. A stale image fails exactly like the bug you are hunting.
  - `pnpm nx e2e mcm-app` cannot run in this dev container, but Playwright CAN — official image,
    --network host, --user "$(id -u):$(id -g)" -e HOME=/tmp. See docs/runbooks/e2e-testing.md.
  - Never use `rg -rn` or `rg -ril` — `-r` is --replace and eats the next chars, returning silent
    false negatives. Use `rg -n` / `grep -rn`, and treat any empty search result as unconfirmed.
  - Opening the PR: push a REAL branch (`git push origin HEAD:<branch>`) then POST .../pulls with the
    `git credential fill` credential. An AGit push runs CI with NO Actions secrets.

State your confidence and your assumptions when you recommend something. Three recommendations in the
previous session were stated confidently and were wrong because a repo document had already answered
the question. If a strategy doc, the constitution or a runbook covers the area, read it before advising.
```
