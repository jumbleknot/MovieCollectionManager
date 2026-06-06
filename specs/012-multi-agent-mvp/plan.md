# Implementation Plan: Multi-Agent Conversational Assistant (Phase 1 MVP)

**Branch**: `012-multi-agent-mvp` | **Date**: 2026-06-06 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/012-multi-agent-mvp/spec.md`

## Summary

Deliver the additive **AI Agents layer** (Phase 1 / Orchestration MVP) described by the constitution's *AI Agents Development Principles* and [MCM-Architecture.md §AI Agents Layer](../../docs/MCM-Architecture.md): a conversational, AG-UI-native assistant for movie discovery, enrichment, and collection organization on web + mobile, with every write human-approved and every action scoped to the calling user.

Technical approach (all already mandated by constitution v1.5.1 — **no amendment required for P1**):

- A new **Python LangGraph orchestration project** `agents/movie-assistant/` — a stateful supervisor graph (`supervisor` → `curator` / `organizer` → `approval_gate`) compiled with a **PostgreSQL checkpointer** in a dedicated, isolated `agent-db`, deployed behind the `langgraph-api` **Agent Gateway** container on the private network. The runtime emits **AG-UI events natively**.
- Two **Python MCP Tool Server** containers: `mcp-servers/movie-mcp/` (thin wrapper over the existing `mc-service` REST API, propagating the user's JWT) and `mcp-servers/web-api-mcp/` (outbound-only TMDB metadata lookups, no internal-network access). Invoked through the gateway's **shared in-process MCP client** with **per-agent allowlists**.
- New **Agent Gateway BFF routes** in the existing `mcm-app` BFF (`src/app/bff-api/agent/`) that act as a **secure proxy** (terminate session, supply a run-scoped RFC 8693 subject token, sanitize readable UI state, authorize UI actions, map `userId → threadId`) — **no event-shape translation**.
- **CopilotKit** (`@copilotkit/react-native`) integrated into the universal `mcm-app` client as an **app-wide overlay/dock** providing the AG-UI chat surface, generative-UI rendering (`render_*` tools → existing Components-Layer components), and allowlisted frontend actions (`navigate_*`, `prefill_*`).
- Identity propagated by **OAuth2 Token Exchange (RFC 8693)**: the BFF mints a run-scoped, audience-narrowed subject token per invocation/HITL-resume; the gateway re-exchanges it at tool-call time for a downscoped, `aud=mc-service`, short-TTL JWT. No raw token is ever checkpointed, traced, or logged.
- **Control Tower** wiring: LangFuse (traces, token cost, latency, golden-pair regression gate), OpenSearch (immutable agent audit), OPA (token-exchange + UI-action policy), Unleash (per-agent/tool kill switch + circuit breakers), Vault (LLM/MCP secrets).

`mc-service`, existing BFF routes, existing screens, and the login/session flow are **unchanged** (additive-only — SC-005).

## Technical Context

**Language/Version**:
- Agent layer (orchestration + MCP servers + guardrails): **Python 3.13** (latest stable 3.x), managed by **`uv`** + `pyproject.toml` + committed lockfile.
- Client + BFF agent routes: **TypeScript** on the existing Expo SDK 56 / React Native 0.85 / React 19.2 universal app (Node.js 24.14.1 BFF container).
- `mc-service`: **Rust** — unchanged; referenced read/write target only.

**Primary Dependencies**:
- Orchestration: **LangGraph** (stateful supervisor graph + checkpointer), packaged/served by **`langgraph-api`** (Agent Gateway container) emitting **AG-UI** natively.
- Models: **LangChain chat-model interface** (`langchain-ollama` `ChatOllama` for the default Ollama provider; `langchain-anthropic` for the Claude fallback), provider-abstracted, env-configured via `MODEL_PROVIDER` (see research R1). Ollama itself is a runtime infra dependency (local install or container; setup in [quickstart.md](quickstart.md)). **Default provider: self-hosted Ollama** (`ChatOllama`) in **every** environment including production — `supervisor` → `qwen2.5` (fast/routing), `curator`/`organizer` → `qwen2.5:32b`/`llama3.3:70b` (planning + tool use). **Anthropic Claude is the documented fallback** (Haiku/Sonnet/Opus): switch a node or the whole provider to Claude when the golden-pair gate fails or the p95 latency budget (SC-008) regresses on Ollama; the escalation flag points at Opus 4.8 regardless of base provider. The golden-pair gate runs against whichever provider the target deploy uses. **Billing:** the Claude fallback uses a per-token Console API key (separate from any Claude Max subscription, which is not a programmatic backend).
- Tooling: **MCP** (`mcp` Python SDK); FastMCP-style servers in Docker. `web-api-mcp` → TMDB API via `httpx`.
- Guardrails: **NeMo Guardrails** (Colang; topic/tone/schema at gateway) + **Guardrails AI / Pydantic** (structural output, PII, toxicity at the Python layer).
- Client: **CopilotKit `@copilotkit/react-native`** (AG-UI client, `useRenderTool`, frontend actions). Generative-UI components are existing `mcm-app` Components-Layer components.
- BFF agent routes: existing Expo Router API routes + the existing `@/bff-server/*` utilities (logger, auth, rate-limiter, mc-service-client patterns), plus an AG-UI passthrough proxy.

**Storage**:
- **`agent-db`** — dedicated **PostgreSQL 18.3-alpine3.23** instance (LangGraph checkpointer; conversation threads, working plan, pending proposals). Logically isolated from `mc-db` and Keycloak's Postgres. **No domain data.**
- **Redis** (existing `mcm-redis`) — reused for BFF session + `userId → threadId` mapping + per-user agent rate-limit / cost-ceiling counters.
- **OpenSearch** — append-only agent audit stream.
- MVP uses **no vector store** (pgvector / long-term memory is **P2**, out of scope — research R4).

**Testing**: `pytest` (agent unit + integration, via Nx `@nxlv/python`); Jest (BFF agent-route unit + integration against real gateway/Keycloak/Redis); **Playwright** (web E2E) + **Maestro** (mobile E2E) for the conversational flows; **LangFuse golden-pair regression suite** gating deployment. Integration tests run against **real** MCP servers + real `mc-service` (no mocking — constitution Test Type Integrity).

**Target Platform**: Universal Expo client (web via react-native-web + Android); Linux Docker containers for the agent gateway, MCP servers, and `agent-db`, on the private `backend-network`.

**Project Type**: Additive AI Agents layer over an existing web + mobile + microservice monorepo (Nx polyglot: pnpm/TS + cargo/Rust + uv/Python).

**Performance Goals**: Conversational responsiveness — first AG-UI token streamed promptly; per-turn **p95 latency** within a configured budget (SC-008), tracked in LangFuse. Routing (`supervisor`) on the fast model tier to minimize overhead.

**Constraints**:
- Additive-only: zero changes to existing client screens, login/session flow, or `mc-service` domain logic (SC-005).
- Agent Gateway + `agent-db` reachable **only** from the BFF over the private network — never from clients or the public internet.
- No raw token (subject or exchanged) in `agent-db`, traces, or logs (SC-004); automated scan in the CI/eval gate.
- Subject-token TTL ceiling ≈2–5 min (active segment); exchanged-token TTL ≤60 s, `aud=mc-service` (research R3).
- Single approval batch ≤ ~50 items, overflow chunked (FR-009b); proposals expire at session end (FR-008).

**Scale/Scope**: Single orchestration project, 1 supervisor + 2 specialists + 1 HITL gate; 2 MCP servers; ~5 MCP tools, 3 generative-UI tools, 2 UI-action tool families; per-user isolated threads. Personal-collection scale (tens–hundreds of movies per collection; batch writes bounded to ~50).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

This feature is governed by the **AI Agents Development Principles** (constitution v1.5.1). MVP scope is **Phase 1 only**; the PRD's amendments **A1 (long-term/vector memory)** and **A2 (RL/feedback)** are explicitly **out of scope** and therefore **no constitution amendment is required**.

| Gate | Requirement | Plan compliance |
|---|---|---|
| Additive & Non-Breaking | Existing routes/APIs/domain logic unchanged | New `agents/`, `mcp-servers/`, and `bff-api/agent/` only; `mc-service` untouched; verified by SC-005 (existing E2E stays green). ✅ |
| BFF is the security boundary | BFF sole OAuth2 client; only caller of the gateway; gateway private | Agent Gateway on `backend-network`, no published port; BFF agent routes are the only ingress. ✅ |
| Agents never call backends directly | Chain Agent → MCP → `mc-service` | `movie-mcp` is the only path to `mc-service`; agents have no direct HTTP client to it. ✅ |
| No domain logic in agents | Validation/persistence/authz stay in `mc-service` | MCP servers are thin wrappers; agents only orchestrate/compose. ✅ |
| Identity Propagation (RFC 8693) | Run-scoped subject token; gateway exchanges to downscoped `aud=mc-service` JWT; nothing persisted | BFF mints run-scoped delegation token per invocation/resume; gateway re-exchanges per tool call; token-leak scan (SC-004). ✅ |
| Bounded-context isolation | Agent state in dedicated datastore | `agent-db` isolated Postgres; no domain data. ✅ |
| AG-UI-native; BFF is proxy not translator | Runtime emits AG-UI; BFF does not transform event shapes | `langgraph-api` AG-UI integration; BFF routes proxy stream + enforce security only. ✅ |
| Universal generative UI | Render from shared web+mobile codebase; no RSC/`streamUI` | `render_*` tools map to existing Components-Layer components via CopilotKit `useRenderTool`. ✅ |
| Per-agent tool allowlists | Enforced by config at gateway | `curator` → read/metadata only; `organizer` → writes (HITL-gated); `supervisor` → no domain tools. ✅ |
| HITL gates for writes | Every write/delete pauses for explicit approval; decisions audited | `approval_gate` interrupt; resume on fresh BFF request; OpenSearch audit (FR-006/007, SC-002). ✅ |
| Idempotency for writes | Every state-changing tool call carries an idempotency key; retries safe; dead-letter on exhaustion | Idempotency key per write tool call; approval-time re-validation (FR-009/009a). ✅ |
| Immutable audit logging | Who/what/tools/UI-actions/approvals to append-only stream | OpenSearch append-only; write-only service account. ✅ |
| Agent security: UI-state sanitization & UI-action authz | BFF sole sanitization point (allowlist); UI actions checked against JWT roles | Structural-field allowlist at BFF; `navigate_*` targets authorized against roles. ✅ |
| Prompt-injection defence | Guardrails on all user input + tool/MCP output | NeMo Guardrails + Guardrails AI at gateway/Python layer. ✅ |
| Rate limiting per user & per agent | Cap token spend / abuse beyond per-IP | Per-user request limit + per-user/session cost ceiling in BFF/gateway (FR-020a, SC-011). ✅ |
| Secrets | LLM/MCP creds from Vault at runtime; never in context/logs/source | Vault injection; env-only config. ✅ |
| Agent Clean Architecture / SoC | Orchestration→tool-interfaces; tools sole IO boundary; guardrails + state layers | Directory layout per constitution (graph/state/nodes/tools/guardrails). ✅ |
| Stack conformance | Python+uv, LangGraph, langgraph-api, MCP, CopilotKit, Postgres checkpointer, NeMo/Guardrails AI, LangFuse, OTel, OpenSearch, OPA, Unleash, Vault | Adopted as listed; see Technical Context. ✅ |
| Nx-managed polyglot | All test/lint/build/deploy via Nx targets (`@nxlv/python`) | Agent projects registered with `@nxlv/python`; targets only. ✅ |
| TDD + Test Type Integrity | Tests first; integration uses real MCP + real `mc-service` | TDD checkpoints in tasks.md; no mocking the dependency under integration. ✅ |
| Behavior-Descriptive Identifiers | No `FR-`/`SC-` in identifiers; provenance in comments | Enforced; requirement IDs only in JSDoc/docstring provenance comments. ✅ |

**Known standing tension (documented, not a new violation):** Expo Router has no runtime global middleware (`@expo/server` 0.5.3 ignores `+middleware.ts` — see project memory *expo-server-middleware-gap*), so existing BFF routes enforce auth per-handler via `requireAuth`/`requireMcUser`. The new `bff-api/agent/` routes **follow the same established per-handler pattern** for consistency with the rest of the codebase; centralizing it is tracked as a separate cross-cutting follow-up and is **not** introduced or worsened by this feature. Documented in Complexity Tracking.

**Result: PASS.** No unjustified violations; no amendment required for P1.

## Project Structure

### Documentation (this feature)

```text
specs/012-multi-agent-mvp/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (AG-UI route + MCP tool + gen-UI + UI-action contracts)
│   ├── agent-bff-routes.md
│   ├── movie-mcp-tools.md
│   ├── web-api-mcp-tools.md
│   └── generative-ui-and-actions.md
├── checklists/
│   └── requirements.md  # (from /speckit-specify + /speckit-clarify)
└── tasks.md             # /speckit-tasks output (NOT created here)
```

### Source Code (repository root)

```text
agents/
└── movie-assistant/                     # LangGraph orchestration project (Python, uv)
    ├── pyproject.toml
    ├── langgraph.json                   # graph + AG-UI export config
    ├── Dockerfile                       # langgraph-api Agent Gateway image
    ├── project.json                     # Nx (@nxlv/python) targets
    ├── src/
    │   ├── graph.py                     # Orchestration-Layer: supervisor graph wiring
    │   ├── state.py                     # State-Layer: typed graph state + checkpoint contract
    │   ├── models.py                    # Tiered, env-configured model selection (provider-abstracted)
    │   ├── nodes/
    │   │   ├── supervisor.py            # intent routing only (no domain tools)
    │   │   ├── curator.py               # discovery/enrichment (read-only tools)
    │   │   ├── organizer.py             # collection/movie writes (HITL-gated)
    │   │   └── approval_gate.py         # HITL interrupt + resume
    │   ├── tools/
    │   │   ├── mcp_tools.py             # MCP tool bindings (movie-mcp, web-api-mcp) + per-agent allowlists
    │   │   ├── generative_ui_tools.py   # render_movie_card / render_collection_summary / render_wishlist
    │   │   └── ui_action_tools.py       # navigate_* / prefill_*
    │   ├── proposals.py                 # proposal assembly, idempotency keys, batch chunking, re-validation
    │   └── guardrails/
    │       ├── rails.co                 # NeMo Colang topic/tone rails
    │       └── output_validators.py     # Guardrails AI / Pydantic structural + PII checks
    └── tests/
        ├── unit/
        └── integration/                # real MCP servers + real mc-service (no mocking)

mcp-servers/
├── movie-mcp/                           # thin wrapper over mc-service REST API
│   ├── pyproject.toml
│   ├── Dockerfile
│   ├── project.json
│   ├── src/
│   │   ├── server.py                    # MCP server entry
│   │   └── tools.py                     # get_collection, list_movies, add_movie, update_movie, delete_movie, create_collection
│   └── tests/{unit,integration}/
└── web-api-mcp/                         # outbound-only TMDB metadata lookups
    ├── pyproject.toml
    ├── Dockerfile
    ├── project.json
    ├── src/
    │   ├── server.py
    │   └── tools.py                     # search_title, get_movie_details
    └── tests/{unit,integration}/

frontend/mcm-app/
├── src/
│   ├── app/bff-api/agent/               # Agent Gateway BFF routes (secure proxy)
│   │   ├── run+api.ts                   # POST: start/continue a run; proxies AG-UI stream; supplies subject token
│   │   ├── resume+api.ts                # POST: HITL approve/reject resume (fresh subject token)
│   │   └── ui-state+api.ts             # POST: sanitized readable UI-state snapshot intake
│   ├── bff-server/
│   │   ├── agent-gateway-client.ts      # server-side client to langgraph-api (private network)
│   │   ├── agent-subject-token.ts       # RFC 8693 run-scoped delegation token minting (BFF custody)
│   │   ├── ui-state-sanitizer.ts        # structural-field allowlist
│   │   ├── ui-action-authorizer.ts      # navigate target ↔ JWT-role check
│   │   └── agent-rate-limiter.ts        # per-user request limit + cost ceiling
│   ├── components/agent/                # CopilotKit overlay/dock + generative-UI render adapters
│   │   ├── assistant-dock.tsx           # app-wide overlay entry point (web + mobile)
│   │   └── render-*.tsx                 # adapters mapping render_* tool props to Components-Layer components
│   └── hooks/
│       └── use-assistant.tsx            # CopilotKit wiring, readable-UI-state provider
└── tests/
    ├── app/bff-api/agent/               # BFF agent-route unit tests
    ├── integration/                     # real gateway + Keycloak + Redis
    └── e2e/{web,mobile}/                # assistant conversational flows

infrastructure-as-code/docker/
├── agent-gateway/compose.yaml           # langgraph-api container (private)
├── agent-db/compose.yaml                # isolated PostgreSQL checkpointer + external volume
├── movie-mcp/compose.yaml
└── web-api-mcp/compose.yaml             # outbound-only; no internal-network attach

api-specs/
└── agent-bff-api.yaml                   # OpenAPI for the new BFF agent routes (spec-first)
```

**Structure Decision**: Follows the constitution's mandated agent-layer layout verbatim — `agents/{orchestration}/` for `movie-assistant`, `mcp-servers/{server}/` for `movie-mcp` + `web-api-mcp`, agent BFF routes inside the existing universal `mcm-app` (Frontend BFF-Layer + Components/Hooks layers), and per-service compose files `include:`d by the root `compose.yaml`. Agent state lives in a new isolated `agent-db`. No existing project directory is restructured.

## Complexity Tracking

| Violation / Tension | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| New languages/runtimes in the repo (Python agent layer) | Mandated by constitution AI Agent Stack (Python + LangGraph + MCP); Rust is Backend-Services-only | Implementing agents in Rust/TS would violate the stack and lack the LangGraph/AG-UI/MCP ecosystem. |
| New datastore (`agent-db` Postgres) | Bounded-context isolation for agent checkpoints (mandated) | Reusing `mc-db` would couple agent state to domain data — prohibited. |
| Per-handler auth on new `bff-api/agent/` routes | Expo Router/`@expo/server` 0.5.3 provides no runtime global middleware (known platform gap) | A true centralized gate needs an `@expo/server` bump or an express-layer in `server.js` — tracked as a separate cross-cutting follow-up; this feature stays consistent with all existing BFF routes rather than introducing a one-off divergent mechanism. |

## Phase 0 — Research

See [research.md](research.md). Resolves: model provider/tier selection (R1), TMDB as the external metadata provider (R2), Keycloak RFC 8693 token-exchange + TTL configuration (R3), vector-store deferral to P2 (R4), HITL interrupt/resume mechanism in LangGraph + AG-UI (R5), CopilotKit `@copilotkit/react-native` + Expo SDK 56 integration (R6), idempotency-key + approval-time re-validation strategy (R7), per-user rate-limit + cost-ceiling approach (R8), batch cap + chunking (R9), generative-UI component reuse (R10), agent-db deployment + isolation (R11), guardrails wiring (R12).

## Phase 1 — Design & Contracts

Artifacts: [data-model.md](data-model.md) (graph state, Proposal, ApprovalDecision, EnrichedMovieCandidate, sanitized UI-state snapshot, thread mapping — all agent state, no domain schema changes), [contracts/](contracts/) (AG-UI BFF route contracts; `movie-mcp` + `web-api-mcp` tool schemas; generative-UI + UI-action tool schemas), [quickstart.md](quickstart.md) (compose profiles, env, local run + test loop). Agent context (`CLAUDE.md` SPECKIT marker) updated to reference this plan.
