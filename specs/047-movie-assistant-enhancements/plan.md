# Implementation Plan: Movie Assistant Enhancements & Fixes

**Branch**: `047-movie-assistant-enhancements` | **Date**: 2026-08-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from [specs/047-movie-assistant-enhancements/spec.md](./spec.md)

**Parent**: [PRD-MovieAssistantMoreEnhancements.md](../../docs/proposals/PRD-MovieAssistantMoreEnhancements.md)

## Summary

Five changes to the movie assistant: three defects (navigate-by-collection-name fails, the import
sorting question loops forever, a 2,000+ row import never finishes) and two enhancements (capture
media formats / ripped / rip quality on an owned add, and a cancel action on the web search card).

Most of the work lands in `agents/movie-assistant` (pure-code nodes and resolvers) plus one new
generative-UI component in `frontend/mcm-app`. **Story 4 additionally adds one read endpoint to
mc-service and one thin tool to movie-mcp** — the resolution of [RQ-4](./research.md#rq-4), so the
agent can ask the domain which media formats it accepts instead of hardcoding them. No BFF route
changes. The supervisor's LLM classification is untouched, so **no golden re-record is required** —
every resolver changed here is deterministic pure code, which is the same discipline features 013
and 040 followed.

Three of the five are rooted in the same thing: the assistant reads whole collections page-by-page
when it only needs a name or a handful of rows, and that stopped being viable as the library grew.

> **Honest caveat on Story 1.** I could not confirm a single root cause for the exact message the
> member sees from reading the code alone. `"Sorry — I couldn't complete that just now."` is emitted
> in four places, and the navigator is not one of them — it is pure code with no model call. So the
> reply is arriving either from the supervisor's degrade path (classifier exception or an open
> circuit breaker) or because the request is being classified as something other than `navigate`.
> **[RQ-1](./research.md#rq-1) is a mandatory reproduce-and-diagnose task that must complete before
> Story 1 is coded.** The pagination defect described below is real and worth fixing regardless, but
> the plan does not assume it is the whole story.

## Technical Context

**Language/Version**: Python 3.13 (`agents/movie-assistant` and `mcp-servers/movie-mcp`, `uv`),
TypeScript 5.x / React Native (Expo) for the client component, **Rust edition 2021** for the
mc-service endpoint (Story 4 only).

**Primary Dependencies**: LangGraph supervisor graph, AG-UI via `ag_ui_langgraph`, MCP tool client
(`src/tools/mcp_tools.py`), FastMCP on movie-mcp, `axum` on mc-service,
`@copilotkit/react-native` `useRenderTool` on the client, `@mcm/design-system` `Button`. **No new
runtime dependency in any project.**

**Storage**: No schema change anywhere. Agent state is the existing LangGraph Postgres checkpointer
(`agent-db`); movie data stays in mc-service. The new endpoint is read-only and touches no store —
it serialises a domain enum.

**Testing**: `pytest` via `pnpm nx run movie-assistant:test` (unit) and `:test:integration`;
`cargo test` via `pnpm nx run mc-service:test` plus the authenticated HTTP integration harness built
in features [045](../045-mc-service-http-authz-tests/plan.md)/[046](../046-authenticated-authz-tests/plan.md);
Vitest/RTL for the client component; Playwright for web E2E. Existing spec files map onto four of
the five stories — `agent-navigate-collection.spec.ts`, `agent-import-disambiguate.spec.ts`,
`agent-import.spec.ts`, `agent-add-ownership.spec.ts`, `agent-search.spec.ts`.

**Target Platform**: Web (react-native-web) and Android, served by the Expo app + BFF; the agent
gateway runs as a private-network container.

**Project Type**: Additive change to an existing multi-project monorepo (agent layer + universal
client). Not a new project.

**Performance Goals**: Navigation answer < 5 s p95 for libraries up to 10,000 movies (SC-002); a
2,000-row import completes in < 10 minutes (SC-006) and 5,000 rows completes at all (SC-007);
visible progress at least every 10 s (SC-008).

**Constraints**: Agent tool calls are capped at 30 per 60 s per `(agent, scope)`
(`AgentToolRateLimiter`, default). Movie list reads are keyset-paginated at 50 rows per page. No
domain logic may live in the agent layer. Every write stays behind the HITL approval gate.

**Scale/Scope**: ~10 changed files in `agents/movie-assistant`, 2 new + ~3 changed files in
`frontend/mcm-app`, ~4 new/changed files in `backend/mc-service`, 1 changed file in
`mcp-servers/movie-mcp`, 5 user stories, target ≥ 70 % coverage on new code.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design.*

| Principle | Verdict | Note |
|---|---|---|
| **Additive and Non-Breaking** | PASS | No existing BFF or mc-service route changes behaviour. Story 4 **adds** a new read endpoint; existing routes and clients are untouched. New generative-UI tool is additive; unknown tools are already ignored by older clients. |
| **Agents Never Call Backend Services Directly** | PASS | All reads/writes keep going Agent → movie-mcp → mc-service, including the new metadata read. |
| **No Domain Logic in Agents** | **PASS** (was AT RISK) | Settled by [RQ-4](./research.md#rq-4): the accepted media formats are published by mc-service and fetched through movie-mcp, so the agent owns no domain values. See [contracts/movie-metadata.md](./contracts/movie-metadata.md). |
| **Thin Wrappers Over Existing APIs** (MCP layer) | PASS | `get_movie_metadata` returns the endpoint body unchanged — no transformation, no domain logic. |
| **Clean Architecture** (mc-service) | PASS | The new endpoint follows the existing api → application → domain layering and adds no persistence. |
| **Identity Propagation** | PASS | No change to token custody. New flows reuse the existing per-run subject token. |
| **AG-UI-Native / no BFF translation** | PASS, with a caveat now measured | Progress and multi-select are emitted by the gateway as AG-UI — verified on the wire ([RQ-2](./research.md#rq-2-evidence)). The BFF does **not** proxy AG-UI raw, though: `run+api.ts` bridges via `CopilotRuntime`/`HttpAgent`. That is pre-existing and not introduced here, but it means "no BFF translation" is true of the BFF's own code and not of the runtime it hosts. T049 proves state survives that hop before any UI is built on it. |
| **Universal Generative UI** | PASS | The multi-select is one React Native component rendering on web and Android (FR-020b). No RSC, no `streamUI`. |
| **HITL Approval Gates** | PASS | Ownership answers are collected *before* the proposal is built; the write still passes the gate unchanged. |
| **Idempotency for Writes** | PASS | Existing deterministic idempotency keys are retained, including under the new bounded-concurrency apply. |
| **Rate Limiting** | PASS | Already satisfied — see the correction under Story 3 below. No limiter is weakened. |
| **Per-Agent Tool Allowlists** | PASS | Story 1 needs `search_title` for the navigator, already in `_READ_TOOLS` and its allowlist. Story 4 adds `get_movie_metadata` to `_READ_TOOLS` and to the **organizer only** — least privilege, asserted by a deny test for every other agent. |
| **Role enforcement is a layer** | PASS | The new endpoint sits inside the existing `protected` router and inherits `auth_layer` + `require_app_role`; no per-handler guard is added. |
| **Immutable Audit Logging** | **OPEN** | A 2,000-row import emitting 2,000 audit events was the item deferred at clarify. Resolved by [RQ-5](./research.md#rq-5). |
| **TDD / RED-then-GREEN** | PASS | Every task follows the tasks-template's Verify RED → Verify GREEN pairing. |
| **Golden regression suite** | PASS | No LLM prompt or classification path changes ⇒ no re-record. Asserted as a task, not assumed. |
| **Nx as universal task runner** | PASS | All commands go through `pnpm nx run …`. |
| **Testing tiers** | PASS | Unit + integration in the agent project, component tests + web E2E in the app. |
| **Agent Tooling — dead-letter surfaces failure** | **WAS VIOLATED — fixed by FR-039** | The principle requires an exhausted retry to "surface failure to the user rather than silently dropping it". `invoke_tool` honours it; every **read closure** in `runtime_nodes.py` then discards the outcome and returns `[]` / `0` / a truncated list. Phase 2b applies the same rule to reads. |
| **File-Processing Safety — "no partial result"** | **WAS VIOLATED — fixed by FR-039** | An export builds its spreadsheet from a `break`-truncated read ([runtime_nodes.py:1017](../../agents/movie-assistant/src/runtime_nodes.py#L1017)), so a mid-pagination failure yields a **partial file presented as complete**. This is the most severe of the 13 sites and the only one that is a constitution violation rather than only a correctness bug. |

One item (`Immutable Audit Logging`) is unresolved at Phase 0 and gated on a research question rather
than assumed away. It does not block Stories 1, 2, 4 or 5.

The last two rows were added 2026-08-04, after the [RQ-1 investigation](./research.md#rq-1-evidence)
found pre-existing violations this feature did not introduce. They are recorded here rather than
waved through because the constitution is non-negotiable within a plan's scope: having found them
while working in that code, the choice is to fix them or to declare them — and the export one is
member-facing data loss, so it is fixed (Phase 2b, FR-039).

## Story-by-story approach

### Story 1 — Open a collection by name (P1)

**Confirmed defect** (independent of RQ-1): `navigator.py` reads the *entire* target collection
before it can navigate. `build_navigator` calls `list_movies(cid)` at
[navigator.py:275](../../agents/movie-assistant/src/nodes/navigator.py#L275) purely to check whether
the member also named a movie, and the runtime `list_movies` at
[runtime_nodes.py:389-407](../../agents/movie-assistant/src/runtime_nodes.py#L389-L407) walks up to
200 keyset pages. A 2,500-movie collection is 50 pages — 50 tool calls against a 30-per-60 s cap
that, unlike the import node, the navigator does **not** carry `skip_rate_limit` for. Call 31 returns
`ok=False`, the loop `break`s, and the movie list is silently truncated.

When no collection name matches, `_resolve_movie_across` does this for *every* collection.

**Approach**:

1. **Do not read movies at all when the answer does not need them.** If a collection name resolves
   and the remaining text carries no plausible movie reference, navigate immediately. This alone
   makes FR-001/FR-002 hold for the reported case.
2. **Replace whole-collection pagination with a server-side title search.** `search_title` is
   already in `_READ_TOOLS` and already allowed for the navigator, and `search.py`'s `_owned_matches`
   already demonstrates the pattern. Movie resolution becomes one bounded call per collection instead
   of N pages.
3. **Stop the generic reply standing in for "I couldn't find it"** (FR-004/FR-005) — an unresolvable
   target returns the existing `_clarify` collection buttons with a reason line.
4. Whatever RQ-1 turns up gets folded in here.

**RQ-1 is now answered ([evidence](./research.md#rq-1-evidence)) and it changes point 3's target.**
The navigator can neither emit the generic reply nor raise — on a `navigate` turn that message comes
only from `_degrade_node`, reachable only through the supervisor's model call. So point 3 is not
about improving the navigator's resolution; the two real surfaces are `_degrade_node` (which should
name the failing component instead of being uniformly generic) and the navigator's `_clarify([])`
branch, which today asks *"Which collection would you like to open?"* while offering **nothing**
whenever the collections read failed. The second of those is one instance of the cross-cutting defect
below, and is fixed there.

Point 1's confirmed defect stands and is unchanged — but note it is now proven that fixing it will
**not** remove the reported generic message. They are different bugs.

### Story 2 — The import question loop (P2)

**Confirmed root cause.** The prompt keeps the raw title *including its trailing space* as both the
option label and the resolution key
([import_disambiguation.py:130](../../agents/movie-assistant/src/nodes/import_disambiguation.py#L130)),
and `resolve_option` step 2 matches by `title in low`
([supervisor.py:78-81](../../agents/movie-assistant/src/nodes/supervisor.py#L78-L81)). For
`"Three Billboards Outside Ebbing, Missouri "` the option string is *longer* than the trimmed reply,
so it can never be a substring. Nothing resolves, nothing is recorded, the same question re-fires —
forever, because there is no repeat counter and no escape.

**Approach**:

1. Add a whitespace/case-normalised equality check to `resolve_option` **before** the substring
   check. It is shared by search / organize / navigate / import, so this fixes the same class of
   failure in all four; it is pure code, so no golden re-record.
2. Trim at the source: the article prompt's key and option labels, and every imported text value at
   row-transform time so stored titles carry no surrounding whitespace (FR-011).
3. Add a per-prompt unresolved-reply counter to the import state. After two consecutive
   non-resolving replies, append a "Cancel import" control to the re-offered options (FR-009/FR-010).
4. Add the remaining-decisions count to the question text (FR-008).

### Story 3 — Large imports (P3)

**Correction to the spec's premise, and to what I told you at clarify time.** I said the bulk-write
rate allowance (FR-019a) was new work. It is not — feature 040 already exempts both the import
node's dedup reads and the approval gate's writes from the limiter (`skip_rate_limit=True` at
[runtime_nodes.py:632](../../agents/movie-assistant/src/runtime_nodes.py#L632),
[:647](../../agents/movie-assistant/src/runtime_nodes.py#L647) and
[:996](../../agents/movie-assistant/src/runtime_nodes.py#L996), with the comment recording that a
200-row import once applied only 30 rows). **FR-019a is therefore satisfied by existing behaviour**
and reduces to a regression test plus documentation. FR-019b (tell the member when waiting) is real
but small. That materially shrinks Story 3.

What actually costs the time:

- **Planning is quadratic.** `_plan_writes` calls `match_existing_movie` per row against a linear
  list of existing movies — 2,000 × 2,000 ≈ 4 M normalised comparisons, on the event loop.
  → Build a normalised `(title, year)` index once; planning becomes O(n + m).
- **Applying is strictly sequential.** `apply_proposal` awaits one write per item in a `for` loop
  ([approval_gate.py:125](../../agents/movie-assistant/src/nodes/approval_gate.py#L125)). At
  ~250 ms per round trip, 2,000 rows is ~8 minutes with a single stall pushing it over.
  → Bounded concurrency (`IMPORT_APPLY_CONCURRENCY`, default **8**, overridable by env) for
  `add`/`update` items, with `create_collection` still applied first and its id threaded in.
  Eight comes from the arithmetic, not from feel: at ~250 ms per write, sequential apply of 2,000
  rows is ~500 s — inside SC-006's 10 minutes only if latency never slips, and outside it at
  300 ms. SC-007's 5,000 rows would be ~21 minutes. A bound of 8 gives ~63 s and ~156 s, which is
  headroom rather than a coin flip, while staying far below a write storm against mc-service,
  Mongo and the audit sink. Idempotency keys are per item and already deterministic, so ordering
  within the batch is not load-bearing — asserted by a test, not assumed.
  **Worth knowing before committing to this**: sequential apply *already almost* meets SC-006. The
  concurrency work buys headroom and the 5,000-row case, not an otherwise-impossible target — so
  if it proves risky in review, reverting to sequential is a survivable fallback for 2,000 rows.
- **No progress and no ceiling.** → Reject > 5,000 rows at parse (FR-015); emit progress
  (FR-014/014a/014b) by the mechanism [RQ-2](./research.md#rq-2) selects; persist applied-count so an
  interrupted run can be reported on the next turn (FR-016a/016b).

### Story 4 — Ownership follow-ups (P4)

Extends the existing `awaiting_ownership` stage
([organizer.py:248](../../agents/movie-assistant/src/nodes/organizer.py#L248)) into a short chain:
`awaiting_ownership` → `awaiting_media` → `awaiting_ripped` → `awaiting_rip_quality` → build
proposal. Because the clarification put this on **every** assistant-mediated add, it lives entirely
in the organizer's existing add path — no origin detection.

Needs a new `render_multi_select` generative-UI tool and a matching React Native component with
toggle state and a confirm action (FR-020a/020b), plus a typed-list fallback (FR-036). The selected
values flow into `to_movie_payload`, which today hardcodes `ownedMedia: []` and `ripQuality: []`
([proposals.py:187-191](../../agents/movie-assistant/src/proposals.py#L187-L191)). mc-service already
enforces the two cross-field rules (`OwnedMediaWhenOwnedSpec`, `RipQualityWhenRippedSpec`), so
FR-027 is validated at the correct layer — the agent must not re-implement it.

**The option list is published by the domain, not held by the agent** ([RQ-4](./research.md#rq-4),
resolved). mc-service gains `GET /api/v1/movie-metadata` returning the accepted `MediaFormat`
values, derived from the enum by exhaustive match so adding a variant fails to compile until it is
published. movie-mcp wraps it as a `get_movie_metadata` read tool, allowlisted to the organizer
only. Full design: [contracts/movie-metadata.md](./contracts/movie-metadata.md).

Two consequences worth stating plainly. First, this makes Story 4 a **three-layer** change
(mc-service → movie-mcp → agent) rather than an agent-only one, and it is the only part of this
feature that leaves the agent boundary. Second, the failure path is specified rather than left open:
if the metadata call fails, the assistant **skips** the format question and completes the add with
no formats recorded (FR-028 already permits this) — it must never fall back to a guessed list, which
would put domain values back in the agent and undo the whole point.

The existing `filter-options` endpoint was evaluated and cannot serve this — it returns values
*observed* in a collection, so an empty collection returns nothing.

### Story 5 — Cancel on the web search card (P5)

`_web_card` already clears the search workflow state before rendering, so cancelling is an
acknowledgement and a UI affordance, not a state change. Add a `cancelable` prop to the
`render_movie_card` contract and a Cancel button in `render-movie-card.tsx` that posts the existing
canonical exit value through the same send path the Add button uses. Smallest change of the five.

### Cross-cutting — a failed read is never a complete one (FR-039)

**Confirmed defect**, found while resolving RQ-1 and reproduced in
[evidence/t001_probe.py](./evidence/t001_probe.py). Every read closure in `runtime_nodes.py` collapses
`ToolOutcome(ok=False)` into a value that is indistinguishable from a truthful answer: a list becomes
`[]`, a count becomes `0`, and a paginated read `break`s and returns a partial list as though it were
whole. **13 sites across 7 nodes.** The information needed to do better already exists and is simply
discarded — `invoke_tool` returns a member-appropriate `error` on every failure path.

Three of the 13 are member-visible today:

| Site | Symptom |
|---|---|
| navigator `list_collections` | *"Which collection would you like to open?"* offering none — the member's library reads as empty |
| query `count_movies` | *"You have 0 movies."* |
| import `list_movies` | the preview is built from an empty "what's already there" ⇒ the member **approves a change described wrongly** (see the correction below) |
| export `list_movies` | a truncated spreadsheet, silently — the file looks complete |

**Approach**: a typed `ToolReadError` carrying `ToolOutcome.error`, raised by each own-data read
closure in place of the collapse, and caught **once per node** in the pure node where the reply is
composed. Chosen over a `None` sentinel or a result dataclass because it leaves every seam signature
unchanged — the pure nodes' existing stub closures keep working untouched, a stub that never fails
simply never raises — while making a forgotten case a loud failure rather than a plausible wrong
answer. It also matches the pattern already in the tree: `_details` raises today and the curator
catches it; the improvement is to carry the *specific* message rather than collapsing to the generic
one.

**Correction (2026-08-05, from the T110 live verification).** The first draft of this section said
a failed import dedup read *creates* the duplicates FR-018 forbids. Verified against the live stack
by reverting the closure and re-running: it does not. mc-service's `(title, year)` uniqueness
rejects the duplicate writes, and the stored collection is identical either way. The real defect is
that the import **proceeds on a read it never got** — the preview claims "2 will be added" and the
member is then told "0 imported, 2 already up to date". That is an approval taken against a false
description of the change (FR-037), which is why the fix is still to refuse rather than to guess.
The lesson is recorded because the titles-based assertion that motivated the original claim passed
identically under both versions — it could not have caught anything.

**Prerequisite.** The design assumes every `ToolOutcome.error` is safe to show a member. Six of the
seven are; [mcp_tools.py:308](../../agents/movie-assistant/src/tools/mcp_tools.py#L308) returns
`tool '<name>' is not permitted for <agent>`, a developer string. It becomes a member-safe message
with the detail logged, which makes that assumption an invariant instead.

**Explicitly NOT changed**, and the tasks assert it:

- **External lookups** — curator's `search_movie`, search's `web_search`. "I couldn't find it" is a
  claim about the world, not about the member's library.
- **`get_movie_metadata`** — its failure path deliberately SKIPS the media-format question rather
  than guessing ([RQ-4](./research.md#rq-4), and the "publish domain values, don't copy them" note in
  `docs/runbooks/agent-layer.md`). Converting it would break intended behaviour.

**Sequencing**: the navigator's `list_movies` pagination loop is deleted outright by T015, so it is
not edited in place — the replacement read is written correctly instead. The two fixes are
independent: the pagination work removes the budget exhaustion that *triggered* the navigator
symptom, while this removes the lie, which stays reachable through any transient failure, authz
denial or MCP outage.

## Project Structure

### Documentation (this feature)

```text
specs/047-movie-assistant-enhancements/
├── plan.md              # This file
├── research.md          # Phase 0 — five research questions, two of them gating
├── data-model.md        # Phase 1 — state fields, prompt/decision shapes, payload fields
├── quickstart.md        # Phase 1 — how to validate each story end to end
├── contracts/
│   ├── movie-metadata.md           # NEW mc-service endpoint + movie-mcp tool (RQ-4 resolution)
│   ├── render-multi-select.md      # New generative-UI tool contract
│   ├── render-movie-card.md        # Additive `cancelable` prop
│   └── import-progress.md          # Progress + interrupted-import reporting contract
├── checklists/
│   └── requirements.md  # Spec quality checklist (from /speckit-specify)
└── tasks.md             # Phase 2 — NOT created by /speckit-plan
```

### Source Code (repository root)

```text
backend/mc-service/                    # Story 4 only (RQ-4 resolution)
├── src/
│   ├── api/
│   │   ├── movie_metadata.rs          # NEW — GET /api/v1/movie-metadata handler
│   │   └── router.rs                  # register the route inside `protected`
│   ├── application/dtos/movie_dto.rs  # NEW MovieMetadataDto
│   └── domain/movie.rs                # MediaFormat::all() — exhaustive match, drift-proof
└── tests/                             # authenticated HTTP authz tests (045/046 harness)

mcp-servers/movie-mcp/
└── src/server.py                      # NEW get_movie_metadata read tool (thin wrapper)

agents/movie-assistant/
├── src/
│   ├── graph.py                       # new add_stage values; import unresolved-reply counter
│   ├── proposals.py                   # carry owned_media / ripped / rip_quality into the payload
│   ├── nodes/
│   │   ├── navigator.py               # Story 1 — skip movie reads; bounded title search
│   │   ├── supervisor.py              # Story 2 — normalised match in resolve_option
│   │   ├── import_disambiguation.py   # Story 2 — trim keys/labels; remaining count; cancel control
│   │   ├── import_resolvers.py        # Story 2/3 — trim imported values; indexed dedup match
│   │   ├── import_collection.py       # Story 3 — row ceiling; O(n+m) planning
│   │   ├── approval_gate.py           # Story 3 — bounded-concurrency apply; progress; resume report
│   │   └── organizer.py               # Story 4 — media / ripped / rip-quality stage chain
│   ├── runtime_nodes.py               # Story 1 search_title wiring; Story 3 progress emission;
│   │                                  #   Story 4 get_movie_metadata read + TTL cache
│   └── tools/
│       ├── mcp_tools.py               # allowlist get_movie_metadata for the organizer only
│       └── generative_ui_tools.py     # render_multi_select; render_movie_card cancelable
└── tests/
    ├── unit/                          # per-node pure-code tests (the bulk of the work)
    └── integration/                   # import scale + apply-concurrency + navigate

frontend/mcm-app/
├── src/components/agent/
│   ├── multi-select-options.tsx       # NEW — toggle list + confirm (universal RN)
│   ├── multi-select-options.test.tsx  # NEW
│   ├── render-movie-card.tsx          # Story 5 — Cancel action
│   ├── import-progress.tsx            # NEW or extended — in-place progress line (per RQ-2)
│   └── assistant-dock.tsx             # register the new render tool(s)
└── tests/e2e/web/
    ├── agent-navigate-collection.spec.ts   # Story 1
    ├── agent-import-disambiguate.spec.ts   # Story 2
    ├── agent-import.spec.ts                # Story 3
    ├── agent-add-ownership.spec.ts         # Story 4
    └── agent-search.spec.ts                # Story 5
```

**Structure Decision**: Existing projects only — no new Nx project and no new container. The agent
layer holds the orchestration and the pure resolvers; the universal client holds the one new
component. Stories 1, 2, 3 and 5 stay entirely inside the agent + client boundary.

Story 4 deliberately reaches into `mc-service` and `movie-mcp`, because the alternative was for the
agent to hold domain values. That is a wider change than "additive AI-Agents layer" usually implies,
but it moves *in the constitutionally correct direction*: the domain publishes what it accepts, the
MCP server wraps it thinly, and the agent consumes it. The mc-service addition is a new read-only
endpoint — no existing route, handler, or domain rule changes behaviour.

## Delivery order and PR batching

Per [pull-request-batching](../../openwiki/process/pull-request-batching.md), the repository batches
by default and splits only where a red build would be ambiguous. Three PRs:

The rule ([pull-request-batching](../../openwiki/process/pull-request-batching.md)) is not "are
these related?" but **"if CI goes red, could I tell which change caused it?"** — because there is one
runner, `app-e2e` is ~35 minutes, and every merge invalidates the other branches' base and forces a
full re-run. A stack of N PRs trends toward **O(N²)** runs; four small fixes were measured at
six-plus runs and ~4 hours.

**Two PRs.**

| PR | Stories | Contents |
|---|---|---|
| **A — ready now** | US2, US4, US5 | Import question loop; ownership follow-ups across all three layers (mc-service endpoint → movie-mcp tool → organizer chain + multi-select component); cancel on the search card |
| **B — research-gated** | US1, US3 | Navigate-by-name (after [RQ-1](./research.md#rq-1)); large-import scale, progress and interruption (after [RQ-2](./research.md#rq-2)) |

### Why this boundary and not another

The split falls where two independent lines happen to coincide, which is what makes it cheap:

1. **Readiness.** US1 and US3 cannot start until RQ-1 and RQ-2 are answered. US2, US4 and US5 can
   start today. Batching the ready work means the three shipped fixes are not held hostage to a
   diagnosis.
2. **The one genuinely ambiguous coupling.** US3 changes how the **shared** approval gate applies
   writes (bounded concurrency), and that gate serves add, organize *and* import. If US3 and US4
   landed together, a red `agent-add-ownership.spec.ts` could be either the new ownership chain or
   the concurrency change — unattributable. This is the split that earns its cost, and PR A/PR B
   already puts them apart.

### Why the earlier five-way split was wrong

Recorded because the reasoning matters more than the number:

- **Splitting US4 across two PRs was self-defeating.** An endpoint-only PR carries no story-level
  e2e — the ownership flow only passes once all three layers are in — so it would have burned a full
  `app-e2e` slot proving nothing about the story. It also contradicted this plan's own design: the
  organizer **degrades gracefully** when metadata is unavailable, which is precisely what makes
  same-commit delivery safe. Splitting to protect against an ordering problem the fallback already
  handles is cost with no benefit.
- **Cross-language batching is not ambiguous here.** `mc-service:test`, `movie-mcp:test` and
  `movie-assistant:test` are separate, self-identifying Nx targets. A red unit tier names its layer
  without any help from PR boundaries.
- **Per-story e2e specs disambiguate within a PR.** US2 → `agent-import-disambiguate.spec.ts`,
  US4 → `agent-add-ownership.spec.ts`, US5 → `agent-search.spec.ts`. Three stories in one PR, three
  distinct spec files: a red run still names the story.

### Why not one PR

One PR would hold US2, US4 and US5 behind RQ-1 and RQ-2, and would put US3's shared-gate change
beside US4's add flow — reintroducing the single ambiguity worth splitting on. Two is the floor
here, not a compromise.

### Ordering

**PR A merges before PR B.** US2 fixes the question loop, and a large import cannot be validated
while that loop is live — so US3 depends on US2 having landed. The readiness boundary already
enforces this; it is not an extra constraint.

Run `pnpm nx preflight` before pushing either branch — it catches the offline-knowable failures
without spending a runner slot at all.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Bounded concurrency in the approval-gate apply loop | Sequential writes cannot meet SC-006 for 2,000 rows | Keeping the loop sequential fails the story's headline requirement. Concurrency is bounded and the per-item idempotency keys already make retry-safety independent of ordering. |
| Story 4 changes three projects (mc-service, movie-mcp, agent) rather than one | [RQ-4](./research.md#rq-4) — the accepted media formats are domain data, and the constitution forbids the agent owning them | Hardcoding the four values in the agent (or hardcoding plus a drift test) was rejected by the product owner: both leave domain values in the agent and differ only in how fast the rot is noticed. The wider change is the cost of getting the layering right, and it is additive — a new read-only endpoint, no existing behaviour altered. |

The media-format entry that previously sat here has been **removed**: RQ-4 resolved to publish the
values from the domain, so there is no longer a violation to justify — the `No Domain Logic in
Agents` gate now passes outright.

## Post-design constitution re-check

Re-evaluated after the Phase 1 artifacts were written, and again after RQ-4 was resolved. No gate
moved from PASS to FAIL, and one moved **from AT RISK to PASS**: *No Domain Logic in Agents* is now
satisfied outright rather than justified as a tolerated violation.

One item remains open — audit-event granularity for a bulk import ([RQ-5](./research.md#rq-5)),
confined to Story 3, with the default being to keep per-write events rather than weaken a
NON-NEGOTIABLE control.

Stories 1, 2, 4 and 5 are clear to proceed to `/speckit-tasks`. Story 3 still carries
[RQ-2](./research.md#rq-2) (the in-place progress mechanism), which must be answered before its
progress tasks are coded.
