# Implementation Plan: Assistant add fidelity — the real rating, and the children's question

**Branch**: `059-assistant-add-fidelity` | **Date**: 2026-08-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/059-assistant-add-fidelity/spec.md`

## Summary

Two literals the assistant writes into every movie it adds are replaced by values it actually
obtained: the film's US certification (looked up, US1 / item #163) and the member's children's-movie
answer (asked, US2 / item #162). Both land in `to_movie_payload`
(`agents/movie-assistant/src/proposals.py:167`), which currently hardcodes `"rated": "NR"` and
`"childrens": False`.

Technically the work is three thin slices:

1. **web-api-mcp** — `get_movie_details` requests `append_to_response=release_dates` on the call it
   already makes, extracts the first non-empty US certification, validates it against the product's
   rating vocabulary, and returns it as a new `rated` field on the enriched candidate (`None` when
   absent or unrecognised).
2. **movie-assistant** — `to_movie_payload` takes the candidate's rating and a new `childrens`
   keyword instead of the two literals; a new `awaiting_childrens` stage becomes the chain's first
   question, registered in the three sets that describe the chain; the answer rides on the
   `ProposalItem` so it survives the approval pause.
3. **Tests** — deterministic behaviour (mapping, payload values, stage transitions) in merge-blocking
   unit tiers; the conversational flow and the named "Secret Life of Pets 2 → PG" proof in the
   existing `@model-decision` E2E, which must also be *updated* because the extra question changes
   the turn sequence five existing tests walk.

No mc-service change, no schema change, no migration, no frontend change ([research.md](./research.md) R7).

## Technical Context

**Language/Version**: Python 3.13 (`agents/movie-assistant`, `mcp-servers/web-api-mcp`);
TypeScript 5.x for the Playwright E2E specs only. No Rust change.

**Primary Dependencies**: httpx (TMDB client), LangGraph (the stage machine), pydantic
(`EnrichedMovieCandidate`, `ProposalItem`), pytest, Playwright.

**Storage**: None added. `rated: Option<UsaRating>` and `childrens: bool` already exist on the movie
document and are already persisted and editable.

**Testing**: pytest via Nx (`nx test web-api-mcp`, `nx test movie-assistant`,
`nx test:integration movie-assistant`), Playwright via `node scripts/agent-e2e.mjs`.

**Target Platform**: Linux containers (agent gateway + MCP servers); the app is universal web +
Android, untouched here.

**Project Type**: Additive change inside the existing AI Agents layer of the monorepo.

**Performance Goals**: No additional external round trip per add — the certification is appended to
the request already being made (FR-002a). Latency of an assistant add is unchanged.

**Constraints**: proving the certification against real TMDB required fixing where it can run, not
documenting where it cannot. TMDB is now on the dev-container allowlist and the real-TMDB suite runs
here (research R4a, measured); CI enrolls the same suite with skip-escalation (R4b). Neither tier of
this feature is hand-run.

**Scale/Scope**: ~4 production files, ~6 test files, plus three environment files (firewall
allowlist, its verifier, the CI integration step). No new service, tool, or dependency.

## Constitution Check

*GATE: passed before Phase 0, re-checked after Phase 1 design. No violations; Complexity Tracking is
therefore omitted.*

| Principle | Assessment |
|---|---|
| **Additive and Non-Breaking** | Passes. Both new parameters default to today's behaviour, so the import and organize callers are untouched (FR-007, FR-015). No existing route or API changes. |
| **No Domain Logic in Agents** | Passes. Validating a certification against the vocabulary mc-service publishes is shaping a payload, not owning a rule — mc-service remains the authority and still rejects an invalid value. Cross-field rules (formats only when owned, qualities only when ripped) stay where 047 left them, in mc-service. |
| **Agents Never Call Backend Services Directly** | Passes. The chain stays Agent → MCP server → TMDB / mc-service; nothing new is called from a node. |
| **Identity Propagation** | Passes. The TMDB key remains per-user, forwarded as `X-TMDB-Key` per request; this feature adds no credential and no shared key. |
| **HITL Approval Gates** | Passes, and is load-bearing: the children's answer is checkpointed on the `ProposalItem` (research R9), so an approval arriving turns later still applies what the member chose. FR-018a keeps the approval surface itself unchanged. |
| **Secrets / logging** | Passes. No new value is logged. The observability module already disables exception recording on TMDB spans because the URL carries the key (`observability.py:54-55`); appending a query parameter does not change that posture. |
| **Test-Driven Development** | Passes — every task is RED-then-GREEN, and the RED for the certification mapper is a unit test that fails because the field does not exist. |
| **Test Type Integrity (NON-NEGOTIABLE)** | Passes, and dictated the test strategy. A stubbed httpx transport is permitted at the **unit** tier and prohibited under `tests/integration/`; the integration suite stays real-TMDB. See research R4 — this is the reason the gate is unit-tier rather than integration-tier. |
| **Code coverage ≥70%, ruff clean, typed** | Applies as normal; `nx lint movie-assistant` and `nx lint web-api-mcp` must both be run, not just `test` (a tier missed this way cost this repository eight ruff findings once already). |

## Project Structure

### Documentation (this feature)

```text
specs/059-assistant-add-fidelity/
├── plan.md              # This file
├── research.md          # Phase 0 — the verified premises, including two corrections
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── web-api-mcp-get-movie-details.md   # the enriched candidate's new `rated` field
│   └── add-question-chain.md              # the stage machine, before and after
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 — created by /speckit-tasks, not here
```

### Source code (repository root)

```text
mcp-servers/web-api-mcp/
├── src/tools.py                       # get_movie_details: append_to_response + certification
└── tests/
    ├── unit/test_certification.py     # NEW — the merge-blocking mapper coverage (stubbed transport)
    └── integration/test_tmdb.py       # extended — real TMDB, runs where egress exists

agents/movie-assistant/
├── src/
│   ├── proposals.py                   # to_movie_payload: rated from candidate, childrens param;
│   │                                  # EnrichedMovieCandidate.rated; ProposalItem.childrens;
│   │                                  # build_add_proposal passes it through
│   ├── graph.py                       # _OWNERSHIP_STAGES += awaiting_childrens (NOT _MULTI_SELECT_STAGES)
│   └── nodes/
│       ├── curator.py                 # local _OWNERSHIP_STAGES mirror += awaiting_childrens
│       ├── organizer.py               # _ask_childrens + the new first transition; chain entry moves
│       └── approval_gate.py           # thread childrens into to_movie_payload at apply time
└── tests/unit/
    ├── test_proposals.py              # extended — payload values
    ├── test_approval_gate.py          # extended — the answer survives apply
    └── test_organizer_add_chain.py    # NEW or extended — stage transitions incl. abandonment

frontend/mcm-app/tests/e2e/web/
├── agent-add-ownership.spec.ts        # UPDATED (5 tests walk the old sequence) + new coverage
└── agent-add-external-link.spec.ts    # UPDATED — same add flow, same shifted sequence

# Environment — so the real-TMDB proof runs automatically in both environments (research R4a/R4b)
.devcontainer/
├── init-firewall.sh                   # DONE — api.themoviedb.org allowlisted (shell/OUTPUT chain)
└── verify/verify-firewall-allowlist.sh # DONE — asserts TMDB reachable; a lost entry fails here
.forgejo/workflows/app-ci.yml          # TODO — enroll web-api-mcp in the integration step,
                                       # with skip-escalation so an absent key cannot read green
docs/runbooks/devcontainer.md          # DONE — records why the old "do NOT allowlist" is superseded
```

**Structure Decision**: The existing monorepo layout is used unchanged. The feature is confined to
the AI Agents layer (`agents/`, `mcp-servers/`) plus the Playwright specs that exercise it; no new
project, package, or directory is introduced.

## Phase 1 design decisions

### The certification path (US1)

`get_movie_details` gains one query parameter and one extraction step. The extraction is a pure
function — given TMDB's release-dates block, return a validated rating or `None` — so it is testable
without any transport at all, which is what makes the merge-blocking unit coverage cheap and exact.

Three rules, all from the spec, all pure:

- first non-empty US certification wins (FR-003a);
- a value outside `{G, PG, PG-13, R, NC-17, NR, Unrated}` yields `None` (FR-006), never an error;
- `None` reaches the payload as `"rated": null`, with the key present (research R5).

`EnrichedMovieCandidate` gains `rated: str | None = None`, defaulting so every existing construction
site keeps working. `to_movie_payload` reads it instead of the literal.

### The question chain (US2)

The chain gains one stage at the front:

```text
before:  [collection?] → awaiting_ownership → [yes] awaiting_media → awaiting_ripped → [yes] awaiting_rip_quality → proposal
after:   [collection?] → awaiting_childrens → awaiting_ownership → [yes] awaiting_media → awaiting_ripped → [yes] awaiting_rip_quality → proposal
```

The collection question keeps its position ahead of everything (FR-008a). The new stage is
registered in `graph._OWNERSHIP_STAGES` and `curator._OWNERSHIP_STAGES` and **not** in
`_MULTI_SELECT_STAGES`; research R6 records what each omission would break. The answer is carried on
`ProposalItem.childrens` (research R9) and applied by `approval_gate`.

### Test strategy — what gates a merge, and what does not

| Behaviour | Tier | Runs where |
|---|---|---|
| Certification extraction: certified film, no US entry, empty string, unrecognised value, multiple US entries | unit (`nx test web-api-mcp`, stubbed transport) | **every PR — blocks merge** |
| `to_movie_payload` emits `rated: null` not `"NR"`, and the member's `childrens` value | unit (`nx test movie-assistant`) | **every PR — blocks merge** |
| Stage transitions incl. the new entry stage, re-ask on an unparseable answer, abandonment | unit (`nx test movie-assistant`) | **every PR — blocks merge** |
| The answer survives the HITL pause and reaches the payload | unit (`nx test movie-assistant`) | **every PR — blocks merge** |
| `get_movie_details` against real TMDB: the live shape, and "Secret Life of Pets 2" → `PG` | integration (`nx test:integration web-api-mcp`) | this devcontainer (**enabled** — R4a) and CI (**enrolled**, skip-escalated — R4b) — **blocks merge** |
| "Secret Life of Pets 2" → PG end to end; the question appears first from card and typed add; abandonment adds nothing | E2E `@model-decision` | `main` pushes and dispatch — **non-blocking** |

Nothing in this feature is hand-run. The integration row was originally going to be a manual step
because TMDB was unreachable from the dev-container shell and unenrolled in CI; both were fixed
rather than documented around (R4a, R4b), which is why the row now says "blocks merge" in two
environments instead of "run it yourself sometime".

The two Python rows are not redundant with each other. The stub covers shapes no real film exhibits
(and runs offline in milliseconds); the live run is the only thing that notices if TMDB changes the
shape the stub is built on. Dropping either leaves a real hole — research R4 tabulates which.

## Post-design constitution re-check

Re-evaluated after the Phase 1 artifacts: no new violations. The design adds no tool, no credential,
no stored field, no domain rule, and no frontend surface; it removes two fabricated values. The only
constitutional tension examined in depth — mocking TMDB — is resolved by placing the stub in the
unit tier where §Test Type Integrity permits it, and leaving `tests/integration/` real.

## Complexity Tracking

Not applicable — the Constitution Check records no violations.
