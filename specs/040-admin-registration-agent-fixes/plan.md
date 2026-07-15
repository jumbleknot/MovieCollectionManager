# Implementation Plan: Admin Registration Control + Agent Add/Import/Navigate Reliability

**Branch**: `040-admin-registration-agent-fixes` | **Date**: 2026-07-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/040-admin-registration-agent-fixes/spec.md`

## Summary

Four independent slices bundled into one feature, spanning two layers:

- **US3 / Item 1 (auth-admin)** — an mc-admin can disable user self-registration app-wide. New single-document `app_settings` store (mirroring the per-user `agent-config-store.ts`), a `requireMcAdmin`-gated `bff-api/admin/settings` (GET/PATCH), a public `bff-api/auth/registration-status` (GET) for the signed-out screens, server-side enforcement at the top of `register+api.ts`, and a new mc-admin-only settings screen plus conditional hiding of the "Create Account" link.
- **US4 / Item 2 (agent)** — the add-from-TMDB flow gains an `awaiting_ownership` stage (Yes/No) before the approval card, threads the chosen `owned` boolean through `to_movie_payload()` (removing the hardcoded `owned:True`), and emits `navigate_to_movie` after a successful add by capturing the created `movieId` from the add outcome.
- **US2 / Item 3 (agent)** — spreadsheet-import reliability: (1) re-ask instead of silently abandoning on an unparsed clarification answer, (2) a graceful-degradation wrapper so the import node always surfaces an outcome, (3) `skip_rate_limit=True` on the `_finalize` existing-movie reads, (4) store a transient handle to the parsed spreadsheet instead of re-checkpointing the whole dataset each clarification turn.
- **US1 / Item 4 (agent)** — navigate-to-collection routing: (a) a stateful `navigate_stage` mirroring search/add/import with bare stage-anchored disambiguation buttons and a continuation guard so a tap actually navigates; (b) an intent-classifier prompt change so "navigate to &lt;collection&gt; collection" routes to `navigate`, with the `us7-intent-search-navigate.json` golden cassette re-recorded under human approval.

The design was fully settled during brainstorming; this plan records the concrete code anchors and the TDD/testing approach. No constitution deviations are expected.

## Technical Context

**Language/Version**: TypeScript (React Native Expo, strict; Node.js BFF via Expo Router API routes) for the frontend + BFF; Rust (Axum, edition per workspace) for mc-service; Python 3.13 (`uv`, LangGraph) for the agent gateway + MCP servers.

**Primary Dependencies**: Expo Router, Axios (BFF client), MongoDB Node driver (BFF `app_settings`), Keycloak Admin API (existing registration path); `axum-keycloak-auth`, MongoDB (mc-service — no schema change beyond existing `owned`); LangGraph, CopilotKit/AG-UI, `medi-rs`-independent Python nodes, openpyxl (spreadsheet-mcp).

**Storage**: New single-document MongoDB collection `app_settings` (BFF-owned, via the existing `getDb()` in `mongo-client.ts`); existing `movie_collections`/`movies` (mc-service) unchanged; agent `GraphState` (checkpointed in `agent-db`) gains a few small stage fields — no raw tokens ever checkpointed (constitution §Identity Propagation).

**Testing**: Jest (BFF unit + integration), Playwright (web E2E), Maestro (mobile E2E) for US1/US3/US4; `cargo test` (mc-service unit — only if a backend change is needed, expected none beyond confirming `owned` passthrough); pytest (agent unit + integration under `agents/movie-assistant/tests/` and `mcp-servers/*/tests/`) for US1/US2/US4; golden cassette re-record for Item 4(b).

**Target Platform**: Web (React Native Web) + Android (Expo) clients; Linux containers for BFF, mc-service, agent gateway, MCP servers.

**Project Type**: Multi-service monorepo (frontend + BFF, Rust backend service, Python agent layer) orchestrated by Nx + pnpm + cargo + uv.

**Performance Goals**: Import remains responsive across many clarification turns on a 200+ row / 10+ comma-title spreadsheet (no full-dataset re-serialization per turn); existing-movie dedup reads complete without rate-limit throttling. No new latency budget for the admin toggle (single-doc read/write).

**Constraints**: No clear-text secrets (constitution §Secrets Management). Agent Items 2 & 3 stay OFF the golden surface (no new intents; pure code over existing intents). Item 4(b) is the only golden-surface change → re-record + human approval (FR-023). Rebuild agent gateway + MCP images after any agent-source change (stale image = old code). BFF cookie-only client auth (no bearer from client). Public `registration-status` endpoint exposes exactly one boolean.

**Scale/Scope**: ~1 new BFF store module + 2 BFF route groups + 1 admin screen + login-screen conditional (Item 1); ~1 new agent stage + payload/nav wiring (Item 2); 4 import-path edits (Item 3); navigator stage + classifier/golden change (Item 4). Single developer, TDD, web+mobile E2E parity for user-facing stories.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies | Compliance approach | Status |
|---|---|---|---|
| **AI Assistant Constraints — Behavior-Descriptive Identifiers** | All items | No `FR-###`/`US#` in identifiers; provenance recorded in a JSDoc/comment. New names describe behavior (`appSettingsStore`, `registrationStatus`, `awaiting_ownership`, `navigate_stage`). Storage keys (`app_settings`, `allowSelfRegistration`), env-var names, and stable E2E selectors are the exempt external-contract cases and get a justifying comment. | PASS |
| **Security — Least Privilege** | Item 1 | Admin write gated by `requireMcAdmin` (first production use); public read exposes a single boolean only; enforcement is server-side (client hiding is convenience only). No new secrets. | PASS |
| **Security — Identity Propagation (agent)** | Items 2–4 | No change to token custody; subject-token → downscoped exchange path is untouched; no raw tokens written to `GraphState`/logs/traces. New stage fields hold only UI/routing state. | PASS |
| **API-First Design** | Item 1 | New BFF routes are contract-first (documented in `contracts/`), typed request/response, RFC-style error bodies via the shared handler. | PASS |
| **TDD (NON-NEGOTIABLE) + Test Type Integrity** | All items | Tests authored first (RED → GREEN). Unit tests may mock externals; integration tests hit real Mongo/Keycloak/mc-service/MCP (no mocking the dependency under integration); E2E drives the real stack. Import (Item 3) has pre-existing behavior tests to extend. | PASS |
| **Logging & Monitoring** | Item 1 (+ agent) | BFF uses `@/bff-server/logger` (no `console.*`); `logger.audit` on setting change and on registration refusal (userId=Keycloak UUID, never email/username); redaction preserved. Agent uses `tracing`/structured logging; import failure messages are user-facing, not secret-bearing. | PASS |
| **Frontend — Design System & Separation of Concerns** | Items 1, 2, 4 | Admin screen composed from the existing design system (no ad-hoc styles); logic in hooks, not components; `NoAutoFillInput` rule N/A (no new credential fields — toggle only). BFF cookie-only auth unchanged. | PASS |
| **Agent Architecture — AG-UI-Native, Separation of Concerns, Python** | Items 2–4 | All agent changes are Python in the agent layer; mapping/dedup/routing stay pure code; only model-decision surfaces are golden. Item 2 ownership Yes/No and Item 4 disambiguation reuse the existing `render_selection` generative-UI surface (no bespoke transport). | PASS |
| **Golden-surface discipline** | Item 4(b) only | Classifier prompt change → re-record `us7-intent-search-navigate.json` + human approval before merge (FR-023). Items 2 & 3 add no intent and touch no cassette. | PASS |

**Result**: No violations. Complexity Tracking left empty.

## Project Structure

### Documentation (this feature)

```text
specs/040-admin-registration-agent-fixes/
├── plan.md              # This file
├── spec.md              # Feature spec (/speckit-specify)
├── research.md          # Phase 0 — decisions + anchors
├── data-model.md        # Phase 1 — app_settings entity, movie.owned, GraphState fields
├── quickstart.md        # Phase 1 — per-story validation scenarios
├── contracts/           # Phase 1 — BFF endpoints + agent interaction contracts
│   ├── bff-admin-settings.md
│   ├── bff-registration-status.md
│   └── agent-interactions.md
├── checklists/
│   └── requirements.md  # spec quality checklist (done)
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root) — real paths this feature touches

```text
frontend/mcm-app/src/
├── bff-server/
│   ├── app-settings-store.ts            # NEW — single-doc app_settings store (mirror agent-config-store.ts)
│   ├── mongo-client.ts                  # EDIT — add getAppSettingsCollection() helper
│   ├── role-check.ts                    # (uses existing requireMcAdmin — first prod use)
│   └── logger.ts                        # (audit events)
├── app/bff-api/
│   ├── admin/settings+api.ts            # NEW — GET/PATCH, requireMcAdmin-gated
│   └── auth/
│       ├── registration-status+api.ts   # NEW — public GET { allowed }
│       └── register+api.ts              # EDIT — 403 + audit when disabled
├── app/(app)/admin/settings.tsx         # NEW — mc-admin-only toggle screen
├── screens/auth/login-screen.tsx        # EDIT — hide "Create Account" when disabled
├── hooks/
│   ├── use-app-settings.ts              # NEW — admin read/write hook
│   └── use-registration-status.ts       # NEW — public status hook (signed-out)
└── components/auth-guard.tsx / protected-route.tsx  # (admin-role guard wiring)

frontend/mcm-app/tests/e2e/web/admin-registration.spec.ts        # NEW (US3)
frontend/mcm-app/tests/e2e/mobile/*.yaml                          # NEW admin flows (US3)
frontend/mcm-app/tests/e2e/web/agent-add-ownership.spec.ts        # NEW (US4)
frontend/mcm-app/tests/e2e/web/agent-navigate-collection.spec.ts  # NEW/extend (US1)

agents/movie-assistant/src/
├── proposals.py                         # EDIT — to_movie_payload(owned=...) not hardcoded True
├── nodes/organizer.py                   # EDIT — awaiting_ownership stage in _add
├── nodes/approval_gate.py               # EDIT — capture movieId, emit navigate_to_movie; import graceful-degradation
├── nodes/navigator.py                   # EDIT — navigate_stage + bare stage-anchored buttons
├── nodes/supervisor.py                  # EDIT — classifier prompt (Item 4b) + navigate continuation
├── graph.py                             # EDIT — navigate_stage/import continuation guards + state fields + reset dicts
├── runtime_nodes.py                     # EDIT — import handle instead of full import_context; skip_rate_limit on reads
└── nodes/import_collection.py / import_disambiguation.py  # EDIT — re-ask on unparsed answer

agents/movie-assistant/tests/
├── unit/ (test_navigator, test_routing, test_search, test_organizer, test_import_*, test_approval*)  # EXTEND
├── integration/test_import_flow.py                                                                   # EXTEND
└── golden/cassettes/us7-intent-search-navigate.json                                                  # RE-RECORD (Item 4b)

backend/mc-service/  # No change expected (owned already defaults false + honored); confirm via existing tests
```

**Structure Decision**: Multi-service monorepo (frontend+BFF / Rust backend / Python agent layer). Item 1 lives entirely in the frontend+BFF surface; Items 2–4 live entirely in the Python agent layer. mc-service is expected to need no change (its `owned` handling already honors the passed boolean) — verified, not modified.

## Complexity Tracking

> No Constitution Check violations — no entries.
