# Implementation Plan: Spreadsheet Import & Export (Movie Assistant)

**Branch**: `014-spreadsheet-import-export` | **Date**: 2026-06-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/014-spreadsheet-import-export/spec.md`

## Summary

Two related deliverables:

1. **Optional movie language (US1)** — relax the mandatory `language` field across mc-service (domain → application → adapters → API) and the frontend add/edit form so a movie can be created or edited with no language. Backward-compatible: existing movies keep their language; the API still accepts `language` when supplied. This is a prerequisite enabler for import (spreadsheet rows may lack a language).

2. **Assistant-driven spreadsheet import & export (US2–US4)** — additive AI-agent capability. The user uploads a CSV/`.xlsx` (web), and the movie assistant inspects tabs, matches each tab to a collection, maps columns by confidence (high→auto, medium→ask, low→ignore), normalizes trailing English sorting articles, splits `|`-delimited multi-values, dedups against existing movies, shows a **preview**, and on confirmation creates/updates movies **best-effort per movie** through the existing `movie-mcp` tools. Export produces a single multi-tab `.xlsx` (one tab per selected collection, multi-values pipe-delimited) that the user downloads. All choices are AG-UI disambiguation buttons; the bulk write is HITL-gated.

The agent layer stays **additive and domain-logic-free**: spreadsheet parse/build is a new scoped-capability MCP server (`spreadsheet-mcp`); all movie reads/writes go through `movie-mcp` → mc-service with the user's propagated identity. Import/export are new supervisor intents with dedicated nodes; web is the MVP target (mobile import/export is a documented follow-on; optional-language ships on both platforms).

## Technical Context

**Language/Version**:
- Backend (mc-service): Rust (existing edition/toolchain), Axum + medi-rs + mongodb.
- Frontend/BFF (mcm-app): TypeScript, React Native + Expo SDK 56 (RN 0.85, React 19.2), Expo Router API routes (Node 24), CopilotKit `@copilotkit/react-native`.
- Agent + MCP: Python 3.13, `uv`, LangGraph, MCP SDK, Pydantic.

**Primary Dependencies**:
- New: `spreadsheet-mcp` (Python) using `openpyxl` for `.xlsx` read/write and the stdlib `csv` for CSV read (no pandas — keep the image light). See research R2.
- Reused: `movie-mcp` (`create_movie`, `update_movie`, `list_movies`, `list_collections`) and the existing supervisor/approval-gate/AG-UI patterns from features 012–013.

**Storage**:
- MongoDB `mc_db` (unchanged schema; `language` becomes optional/`Option<String>`).
- Transient upload store for the in-flight import file (short TTL), keyed by an opaque handle — see research R3. Agent checkpoint state (`agent-db`) never stores file bytes.

**Testing**: `cargo test`/integration via Nx (mc-service); Jest unit + Playwright web E2E + Maestro mobile (mcm-app); `pytest` unit/integration + LLM golden-pair cassettes (agent + MCP). All via Nx targets.

**Target Platform**: Web for import/export (US2–US4); web + Android for optional language (US1).

**Project Type**: Polyglot monorepo — Backend Service (Rust) + Universal Frontend/BFF (Expo) + AI Agent layer (Python/LangGraph + MCP).

**Performance Goals**: Import has no fixed size cap; processed in chunks with visible progress (FR-021b), reusing mc-service cursor pagination for reads and chunked sequential writes (≤50-per-batch pattern from US2 organize). Writes carry idempotency keys.

**Constraints**: Agent layer additive & non-breaking; BFF is the sole caller of the Agent Gateway and the sanitisation/authorisation point; preview-then-confirm before any write (FR-020); best-effort per-movie writes (FR-021a); update-without-blanking (FR-019); web-first scope.

**Scale/Scope**: Personal collections; sample fixture `docs/test-data/sample-movies.xlsx` (one data tab `Sample` + helper tabs to be ignored) is the canonical import test artifact.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment | Status |
|---|---|---|
| **Agent layer Additive & Non-Breaking** | New intents/nodes/tools/BFF routes/MCP server only; existing agent + app routes unchanged. | PASS |
| **Backward-compatible API change (US1)** | Making `language` optional is non-breaking: existing clients that send it still work; existing data retains it. OpenAPI updated in `api-specs/mc-service-api.yaml`. | PASS |
| **Agents never call backend directly / No domain logic in agents** | Movie create/update/list go through `movie-mcp` → mc-service. Spreadsheet parse/build is a scoped-capability tool (no backend/network IO). Column-mapping/article reasoning is orchestration, not domain rules. | PASS |
| **Identity Propagation (RFC 8693)** | Import/export run under the user's run-scoped subject token like existing flows; writes carry the propagated JWT. No file bytes or tokens in checkpoint state/logs/traces. | PASS |
| **HITL for writes** | Bulk import write routes through the existing approval-gate (preview-then-confirm); tab exclusion handled at the gate. | PASS |
| **Idempotency for writes** | Each create/update carries an idempotency key; failed rows retry w/ backoff then surface in the summary (best-effort). | PASS |
| **Scoped Capability MCP** | `spreadsheet-mcp` is file-processing only — no internal network, no backend calls, ephemeral. | PASS |
| **BFF as secure proxy, not translator** | New BFF routes only terminate session, propagate identity, stash/serve the transient file, sanitise UI state, authorise UI actions. No event-shape translation, no domain logic. | PASS |
| **Clean Architecture (mc-service)** | Optional-language change flows through all four layers consistently (domain entity, DTOs, DAO, handlers); validation specification updated, not bypassed. | PASS |
| **TDD + Test Type Integrity** | Tests-first; integration tests run against real MCP/mc-service/Keycloak (no mocking the integrated dep); golden cassettes gate the LLM dimension. | PASS |
| **Platform Parity Table** | Web import/export scenarios mapped; mobile import/export marked N/A with the documented web-first justification; optional-language covered on both. | PASS (documented N/A) |
| **Golden-pair regression** | New `import`/`export` intents + classify_intent prompt change → re-record cassettes (delete stale first), verify on runtime model (qwen2.5) AND Claude gate. | PASS |
| **Security / logging / audit** | Import/export are audit-logged (who/what/counts); uploaded file content and tokens never logged; rate limits per-user apply. | PASS |
| **API-First / OpenAPI** | mc-service language delta + new BFF agent routes documented in `api-specs/`; MCP tool schemas in `contracts/`. | PASS |

No unjustified violations. The only net-new structural component is the `spreadsheet-mcp` server — justified below (file IO must be a tool; alternative of BFF-side parsing rejected as it thickens the proxy and blocks agent iteration). Gate **passes**.

## Project Structure

### Documentation (this feature)

```text
specs/014-spreadsheet-import-export/
├── plan.md              # This file
├── spec.md              # Feature specification (+ Clarifications)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── spreadsheet-mcp-tools.md
│   ├── bff-agent-routes.md
│   └── mc-service-language-delta.md
├── checklists/
│   └── requirements.md  # /speckit-specify output
└── tasks.md             # /speckit-tasks output (NOT created here)
```

### Source Code (repository root)

```text
backend/mc-service/src/                      # US1 — optional language (all four layers)
├── domain/movie.rs                          #   language: Option<String> + constructor
├── application/
│   ├── dtos/movie_dto.rs                     #   Create/Update/Response DTOs: optional language
│   └── commands/{create_movie.rs,update_movie.rs}  # drop RequiredString check on language
└── adapters/mongodb/daos/movie_dao.rs        #   Option<String> + serde default (existing docs)

frontend/mcm-app/src/
├── components/movie-form.tsx                 # US1 — language no longer required
├── components/{movie-list-item,movie-detail,movie-list,column-selector,movie-sort-control}.tsx  # US1 — render absent language
├── types/collection.ts                       # US1 — language?: string
├── components/agent/request-import-file.tsx  # US2 — type-to-start: inline Choose/Cancel file picker (web)
├── components/agent/import-preview.tsx        # US2/US4 — confirm-once summary preview (per-tab counts + exclude toggles)
├── components/agent/render-import-report.tsx  # US2 — collapsible post-import report (skipped + failed rows)
├── components/agent/ui-action-tools.tsx       # US3 — download_export UI-action effect (export download)
├── hooks/use-spreadsheet-import.ts           # US2 — upload + run + progress
├── utils/pick-file.ts                         # US2 — web file-chooser helper
└── app/bff-api/agent/
    ├── import-upload+api.ts                  # stash transient file, return handle
    └── export-download+api.ts                # serve generated workbook

agents/movie-assistant/src/
├── nodes/import_collection.py                # US2/US4 — orchestrate parse→map→preview→write
├── nodes/import_resolvers.py                 # US2 — pure-code column/article/dedup/compose resolvers
├── nodes/import_disambiguation.py            # US4 — tab/column/article disambiguation (pure-code picks)
├── nodes/export_collection.py                # US3 — pure shapers (movie→row, build/select tabs)
├── nodes/supervisor.py                       # + import/export intents (classify_intent)
├── tools/spreadsheet_tools.py                # MCP tool bindings (parse/build) + reuse movie tools
└── runtime_context.py / runtime_nodes.py     # import/export run state + node wiring (no standalone state.py)

mcp-servers/spreadsheet-mcp/                  # NEW scoped-capability MCP server
├── pyproject.toml
├── Dockerfile
└── src/server.py                             # parse_spreadsheet, build_workbook (openpyxl + csv)

api-specs/
└── mc-service-api.yaml                        # US1 language-optional delta
```

**Structure Decision**: Polyglot web-app + backend-service + agent-layer structure (constitution Monorepo Directory Structure). US1 lands in the existing mc-service Clean-Architecture layers and the existing frontend Components/Hooks/Types layers. Import/export adds one new MCP server (`mcp-servers/spreadsheet-mcp/`), two new agent nodes + tool module, two new BFF agent routes, and web-only dialog components/hooks — all additive.

## Complexity Tracking

| Decision | Why Needed | Simpler Alternative Rejected Because |
|----------|------------|--------------------------------------|
| New `spreadsheet-mcp` server | File parse/build is IO; the constitution requires agents to perform IO only through tools, and parsing is a distinct scoped capability (no backend/network). | BFF-side parsing rejected — it thickens the "secure proxy, not translator" BFF and prevents the agent from iterating over parsed structure during column-mapping/disambiguation. |
| Transient upload store (short-TTL handle) | The file must reach the parse tool without being checkpointed (large, non-domain) or logged. | Passing base64 bytes in run/checkpoint state rejected — violates "no file bytes in checkpointed state," bloats traces, and risks the size cap. |
