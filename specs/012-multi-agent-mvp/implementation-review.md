# Implementation Review — 012 Multi-Agent MVP

**Date**: 2026-06-09 · **Branch**: `012-multi-agent-mvp` · **Reviewer**: Claude (Opus 4.8) high-effort local review

**Scope reviewed**: the feature-012 delta vs `main` — the additive Python agent layer
(`agents/movie-assistant`, `mcp-servers/movie-mcp`, `mcp-servers/web-api-mcp`) and the TypeScript
BFF agent layer + assistant UI (`frontend/mcm-app`). `mc-service` (Rust) is unchanged by this
feature and was out of scope. The latest substantive commit under review was `fdf9aa0`
(observability close-out); the docs commits after it touch no code.

**Outcome**: 2 real bugs found **and fixed** (one a credential leak, one an async hot-path
blocker), TDD-regression-tested and lint/type-clean. Security review found no vulnerability at the
reporting bar. One genuine **spec gap** surfaced (SC-011 cost-ceiling inert). In a follow-up pass
(same date) the two top backlog items were implemented (TDD): the **SC-011 cost ceiling** now
enforces via a per-turn estimate, and **`thread_id` is bound to the user** (cross-user resume →
403). The feature is otherwise sound, exceptionally well-tested, and additive (SC-005 holds); all
SC are now met.

---

## Part 1 — Code & Security Review

### Step 1 — Best practices (per project)

Method: a high-effort line-by-line review of `fdf9aa0`, plus two parallel best-practices review
agents over the Python agent/MCP layer and the TS BFF agent layer. Every candidate was verified
against the actual code before action (receiving-code-review discipline — several reviewer
candidates turned out to be by-design or already-tracked deferrals on this mature, heavily-tested
feature).

#### Fixed (TDD, regression-tested)

| # | Severity | File | Bug | Fix |
|---|----------|------|-----|-----|
| 1 | **HIGH (credential leak)** | `mcp-servers/web-api-mcp/src/observability.py` (`tool_span`) | OTel's `start_as_current_span` defaults `record_exception=True` **and** `set_status_on_exception=True`; **both embed `str(exc)`** into the exported span (an `exception` event message + the status description). web-api-mcp's `tool_span` wrapped TMDB calls whose `httpx.HTTPStatusError` (from `raise_for_status` on a 404/401/429) stringifies the request URL — which carries `?api_key=<TMDB_KEY>`. So on **any** TMDB error the API key reached the exported trace, directly defeating the commit's "name-only spans → zero credential surface" guarantee (SC-004/FR-016). The static token-leak scan (T031) cannot catch this — it's runtime exception recording, not a logged variable. | `tool_span` (both MCP servers) now passes `record_exception=False, set_status_on_exception=False`. Regression test exports a span via an in-memory exporter after raising an `httpx.HTTPStatusError` containing a sentinel key and asserts the sentinel is absent. **Verified RED → GREEN.** |
| 2 | MEDIUM (perf/correctness) | `mcp-servers/web-api-mcp/src/server.py` (`_tmdb_key`) | `_tmdb_key()` routed through `resolve_secret` on **every** async tool call; with Vault configured this runs a synchronous `hvac`/`requests` round-trip inside the asyncio event loop (stalling all concurrent requests) and re-fetches a static key each call. | Resolve once at `build_app()` startup (sync, off the event loop) and cache (`is None` sentinel so a missing key is cached too), with a lazy fallback. This also resolves the related log-spam concern (a Vault outage now logs once, not per request). |

Both fixes verified: `web-api-mcp` 9/9 + `movie-mcp` 9/9 tests pass; ruff + mypy clean.

#### Verified but NOT changed (with rationale)

These were raised by the review agents and deliberately **not** acted on — each is by-design,
already tracked, or a latent item whose fix would churn verified security/agent code without
clear benefit. They are recorded here as the hardening backlog.

- **Langfuse client built per turn** — *not a leak*. The langfuse v3 SDK client is a process-global
  singleton keyed by `public_key` (the docstring confirms idempotent init); repeated construction
  reuses resources. Reviewer claim was overstated.
- **Blocking `model.invoke` inside `async` curator/organizer nodes** — real best-practice gap
  (a sync LangChain call blocks the event loop during the LLM round-trip), but acceptable for the
  P1 single-process MVP gateway and a non-trivial change to the verified graph. Backlog:
  `await asyncio.to_thread(...)` or an async `ainvoke` seam.
- **`subject_user_id` returns `""` on JWT decode failure** → could collapse distinct users into one
  cache/rate bucket. Practically unreachable (the BFF supplies validated Keycloak JWTs which always
  carry a `sub`), but should fail closed. Backlog: hardening.
- **Duplicated `observability.py` across the two MCP servers** — separate `uv` packages, no shared
  lib exists today; the SC-004 fix had to be applied twice. Backlog: consolidate if a shared lib
  emerges.
- **`evaluate_turns` emits breach metrics as a side effect of a summarizer** — double-counts if
  ever re-run over the same turns. Low; backlog.
- **`agent.runs` metric double-counts on HITL resume** (supervisor re-enters on `/run` resume).
  Metric-accuracy only; backlog.
- **`/resume` proxies the upstream body with no status check** (error bodies mislabeled as SSE);
  **`ui-action-tools` `dispatched` Set never cleared** (a legitimately-repeated navigation is
  dropped + unbounded growth — note the Set was an intentional dedup fix, so a run-scoped key is the
  right change); **`/run` approval audit reads a `body`-wrapped shape CopilotKit doesn't send** (the
  SC-002 audit on the `/run` path likely never fires — already a known follow-up per the T037 note).
  All robustness polish; backlog.

### Step 2 — Security review (`/security-review`)

Ran the security-review methodology (identification sub-agent over the new auth/token/sanitizer
surface, confidence-filtered at ≥8). **No finding at or above the reporting bar.** Verified sound:
auth ordering (`requireAuth` → `requireMcUser` before any side effect on all four new routes),
token custody (ephemeral, re-minted per run/resume, TTL-capped, status-only failure logs),
UI-snapshot sanitization (strict structural allowlist; no values/PII survive), per-user Redis key
isolation, OPA + token-capture fail-closed.

**One sub-threshold item (MEDIUM, confidence 6) for the backlog**: `thread_id` is client-supplied
and not bound to `user.id` on the `/run` and `/resume` routes. A user could resume another user's
checkpointed thread and see that proposal's **preview** (collection/movie names). Cross-user
*writes* remain blocked — the subject token is re-minted from the resuming user's session, so
mc-service DAC 404s. **Recommendation**: namespace `thread_id` with `user.id` at the BFF.

### Step 3 — Unused files/directories

**None found.** No committed caches/temp/`.bak`/empty (non-`__init__`) files; every new
`bff-server`/`utils`/`hooks` module is imported by production code. The only unreferenced code is
the `recordAgentCost`/`addAgentCostMicros` pair — intentionally staged for the unfinished SC-011
cost-ceiling wiring (see Part 3), not dead-file cruft, so it was left in place.

---

## Part 2 — Learning

### Bugs / non-compliance / fixes encountered

1. **OTel exception recording is a credential-leak vector** (the headline finding). The team's
   SC-004 discipline ("name-only spans", no httpx auto-instrumentation) correctly anticipated
   *attribute* leaks but missed that OTel records the **exception message + status description** by
   default — and an httpx error stringifies a URL that, for TMDB, carries the API key. The static
   leak-scan structurally cannot see runtime exception recording.
2. **Vault resolution on an async hot path** — the secrets module is correct in isolation, but
   wiring it into a per-call `async` tool re-introduced blocking I/O on the event loop.
3. **A pre-flight enforcement function whose accrual counterpart has no caller** (SC-011) — the cost
   ceiling looks implemented (the enforce function exists and is wired) but is a silent no-op
   because nothing ever records cost.

### What the artifacts could have done to prevent these — improvements applied

- **`tasks.md` T030b SC-004 carry-over note** anticipated framework-`DEBUG`-header logging but
  **not** OTel exception recording. **Applied**: added an explicit carry-over note with the rule
  *"any `start_as_current_span` around credential-bearing I/O MUST disable exception recording"*,
  and collapsed a verbatim-duplicated note line.
- **`CLAUDE.md`** had no durable guidance on the OTel exception-recording vector or the
  Vault-hot-path caching rule. **Applied**: added a `>`-callout under the agent observability
  section capturing both rules.
- **`tasks.md` SC-011 + T027** over-claimed the cost ceiling as done. **Applied**: flipped SC-011
  `[X]`→`[~]`, annotated T027 and the Completion Checklist with the inert-cost-ceiling finding and
  the follow-up.
- **`spec.md` status** was still `Draft` for a completed feature. **Applied**: set to
  `Implemented` with the SC-011 caveat.
- **Task-marker drift**: T028a and T042 were `[~]` though their gating follow-ons (T057/T059;
  T044/T046) completed. **Applied**: flipped both to `[X]` (T028a route list updated to include
  `ui-action`).
- **Project memory** (`project_mcm_observability_sc008` + `MEMORY.md` index) updated with the two
  fixes, the durable OTel rule, and the SC-011 gap correction.

A constitution-level addition was considered (a generic "telemetry must not record exception
messages around credential-bearing I/O" principle) but kept at the CLAUDE.md/task level — it is a
concrete framework gotcha, not a new governing principle; the existing §Agent Security / SC-004
"no token in traces" requirement already governs it, and this review tightens the *how*.

---

## Part 3 — Spec Alignment (`/speckit-analyze`)

Coverage is excellent: every FR-001…FR-022 and SC-001…SC-011 maps to ≥1 completed task; tasks.md
carries full RED/GREEN TDD checkpoints, a platform-parity table, and a completion checklist. The
analysis surfaced:

| ID | Severity | Finding | Action |
|----|----------|---------|--------|
| C1 | **HIGH** | SC-011 cost-ceiling enforcement inert (`recordAgentCost` no production caller) — only the rate-limit half of FR-020a holds | **RESOLVED 2026-06-09** — `/run` accrues `AGENT_ESTIMATED_TURN_COST_USD` per billable turn via `recordEstimatedTurnCost`, so the ceiling now trips; SC-011 → `[X]`. Real LangFuse figure remains a future refinement. |
| C2 | MEDIUM | spec.md `Status: Draft` for a completed feature | **Fixed** → `Implemented`. |
| I1 | LOW | T028a/T042 markers lagged their completed follow-ons | **Fixed** → `[X]`. |
| S1 | MEDIUM | `thread_id` not user-bound (cross-user preview disclosure; writes DAC-blocked) | **RESOLVED 2026-06-09** — `enforceAgentThreadOwnership` (Redis `SET NX` claim) on `/run` + `/resume`; cross-user thread → 403, no run. |
| D1 | LOW | duplicated MCP `observability.py` | Backlog (no shared lib today). |

No constitution MUST violations. The one standing deviation (per-handler `requireAuth` vs
Centralized Access Control, due to the `@expo/server` middleware gap) remains documented with its
compensating control (the T028a route-auth regression test). The OTel-leak fix *strengthens*
SC-004/FR-016 compliance.

---

## Follow-up backlog (prioritized)

**Done in this review (2026-06-09):**

- ✅ **SC-011 cost ceiling** — `recordEstimatedTurnCost` accrues `AGENT_ESTIMATED_TURN_COST_USD`
  per billable `/run` turn so `enforceAgentCostCeiling` trips (TDD: `recordEstimatedTurnCost`
  test). Real per-turn LangFuse figure remains a future refinement (gateway → BFF pipe).
- ✅ **`thread_id` ↔ user binding** — `enforceAgentThreadOwnership` (Redis `SET NX` claim, TTL =
  session window) on `/run` + `/resume`; a cross-user `thread_id` → `ForbiddenError` 403, no run.
  Closes the cross-user resume preview-disclosure (TDD: `agent-thread-owner` + `extractThreadId`
  tests). Also confirmed the `/run` SC-002 approval audit **does** match (the agent-resume test
  captures a real CopilotKit resume body with `body.threadId`), so the earlier "audit never fires"
  worry is refuted.

**Remaining:**

1. **Async LLM calls** — offload `model.invoke` in the curator/organizer nodes
   (`asyncio.to_thread`/`ainvoke`) so the gateway event loop isn't blocked under concurrency.
2. **`subject_user_id` fail-closed** on empty `sub`; **`ui-action-tools` dispatched-Set** run-scoping.
3. **Real per-turn cost** — pipe the LangFuse per-turn figure from the gateway back to the BFF and
   replace the fixed estimate in `recordAgentCost`.
4. Robustness polish: `/resume` upstream status check; consolidate the duplicated MCP
   `observability.py`; make `evaluate_turns`/`agent.runs` metric emission single-count.

---

## Verification

- `pnpm nx test web-api-mcp` → 9/9 · `pnpm nx test movie-mcp` → 9/9 · `pnpm nx test movie-assistant`
  → 301/301 (incl. the SC-004 leak scan over all 3 src trees).
- `pnpm nx lint web-api-mcp` / `movie-mcp` → clean (ruff + mypy strict).
- Follow-up pass: `pnpm nx test mcm-app` → 922/922 (incl. the new `recordEstimatedTurnCost`,
  `agent-thread-owner`, and `extractThreadId` tests); `tsc --noEmit` + `pnpm nx lint mcm-app` clean.
- New regression tests: `test_tool_span_never_records_an_exception_message_into_the_span`
  (both MCP servers); `recordEstimatedTurnCost`, `enforceAgentThreadOwnership` (4 cases),
  `extractThreadId`.

## Follow-up implementation notes (2026-06-09)

- **Cost ceiling (SC-011)**: `config/env.ts` adds `AGENT_ESTIMATED_TURN_COST_USD` (default 0.01);
  `agent-rate-limiter.ts` adds `recordEstimatedTurnCost`; `run+api.ts` calls it on each billable
  POST after the pre-flight checks. Bounds session spend (≈ ceiling ÷ estimate turns) in every
  config; replace with the real LangFuse figure when piped from the gateway.
- **Thread ownership**: `cache-service.ts` adds `claimAgentThreadOwner` (Redis `SET key user EX ttl
  NX` → returns the owner); `agent-thread-owner.ts` adds `enforceAgentThreadOwnership`
  (ForbiddenError 403 on mismatch, no-op on absent threadId, fail-closed on Redis error);
  `agent-resume.ts` adds `extractThreadId`. Wired into `run+api.ts` (POST) and `resume+api.ts`
  before any gateway call. First use of a thread claims it for the user; a later cross-user request
  is rejected.

---

## Addendum — Containerized agent E2E validation + first-class capability (2026-06-09)

Validating the impl-review fixes against the dev-container BFF surfaced that the **agent E2E was
only ever run against a host-process gateway + Metro** — and a probe of "can it run fully
containerized?" turned into a deep integration debug that found **three more real bugs that broke
the committed containerized agent stack**, then closed them and made the stack a repeatable,
committed capability. (Commits `9ec5daa` → `23adc48`.)

### What was wrong (and is now fixed)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | **HIGH (stack-breaking)** | **MCP DNS-rebinding 421.** The MCP SDK's `FastMCP` auto-enables Host validation for its default localhost host; `allowed_hosts` then 421-rejects a Docker **service-name** Host (`http://movie-mcp:8000/mcp`). Every gateway→MCP call failed → enrich/writes silently broke. This is why the committed `--profile agents` stack **never worked end-to-end** and agent E2E was always run with host MCP servers on `localhost`. | `transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False)` in **both** `server.py` (internal Docker-network-only servers; gateway is the sole caller). Committed `9ec5daa`. |
| 2 | **HIGH** | **Tool-free gateway.** The committed `agents`-profile gateway set **no** `WEB_API_MCP_URL`/`MOVIE_MCP_URL`, so `production_nodes_enabled` was false and it silently served the tool-free graph; and a **stale `agent-gateway:latest`** (missing `runtime_nodes.py`) ran old tool-free code. | Compose: gateway gets both MCP URLs + token-exchange creds (`${env}`) + the `agent-mcp` network. Deploy script force-rebuilds the image. |
| 3 | MEDIUM (observability) | **Gateway app-logger silently dropped.** uvicorn configures only its own loggers, so `logging.getLogger(__name__)` records (the "MCP-backed (production)" line + node errors) never reached the container log — prod errors were invisible. | `create_app` now calls `logging.basicConfig` (level via `AGENT_LOG_LEVEL`). |

### Confirmations (not bugs)

- My **SC-011 cost-ceiling fix proved correct live** — it tripped at exactly `$0.50` once the shared
  E2E test user accrued 50 turns (`AGENT_ESTIMATED_TURN_COST_USD` × 50) in the 24 h window. The
  agent E2E therefore relaxes the cost/rate guards (`compose.agent-e2e.yaml`) so they don't gate an
  agent-flow run — the guards work; they're just not what that suite tests.
- My **thread-ownership fix produced 0 false 403s** under real E2E traffic (single user owns its own
  threads); the cost-accrual + thread-claim Redis keys were observed populated live.
- The earlier-flagged "`/run` SC-002 approval audit may never fire" is **refuted** — the agent-resume
  test captures a real CopilotKit resume body with `body.threadId`, matching `extractApprovalDecision`.

### New first-class capability (committed `23adc48`)

Repeatable, automated deploy + test of the containerized production-agent stack (dev-container BFF →
containerized production-node gateway → containerized MCP; **no Metro, no host gateway**):

- `pnpm nx up-agents-prod infrastructure-as-code` (`scripts/agent-stack.mjs`) — builds the 3 images,
  creates the `agent-mcp` network, fetches the gateway client secret via `kc_admin`, runs the
  containers with the production env (host Ollama, MemorySaver), and verifies `/health` +
  `production_nodes_enabled` + MCP reachability. `--down` / `--status` / `--args=--build`.
- `pnpm nx e2e:agents mcm-app` (`scripts/agent-e2e.mjs`) — runs the agent specs **isolated per file**
  against the container, recreating the dev BFF under the limit override; per-spec PASS/FAIL summary.
- Committed compose now runs production nodes (`--profile agents` gaps closed); `agent-mcp` is a
  first-time `docker network create`; `compose.agent-e2e.yaml` carries the E2E limit relaxation.
- Cross-platform note: `spawnSync('pnpm', …)` ENOENTs on Windows (it's `pnpm.cmd`) — the scripts use
  `shell: process.platform === 'win32'`.

### Result

**All six agent specs pass green, fully containerized**, run the designed way (isolated per file):
`assistant-add` 2/2, `assistant-add-ambiguous`, `assistant-organize`,
`assistant-organize-update-move`, `assistant-navigate` 2/2, `assistant-context` 2/2 — conclusively
proving the agent E2E is containerizable and Metro was never a requirement (`E2E_AGENT_PRODUCTION=1`
is only a `test.skip` un-gate). The **full parallel** suite remains a separate, pre-existing harness
limitation (10 workers × 1 test user → per-user rate-limit + ~5-min token-expiry `no_token`),
unrelated to containerization.

### New follow-up backlog item

- **`/run` token-refresh under long/parallel runs** — the `no_token` (~5-min access-token expiry,
  CopilotKit `/run` transport vs path-scoped refresh cookie; [[project_agent_run_token_refresh]]) is
  why the full parallel agent suite can't go green. If a parallel agent suite is ever wanted (vs the
  isolated-per-spec norm), this and a longer E2E access-token lifetime would need addressing.
