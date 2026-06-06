# Phase 0 Research: Multi-Agent Conversational Assistant (Phase 1 MVP)

**Feature**: `012-multi-agent-mvp` | **Date**: 2026-06-06

All decisions below stay within constitution v1.5.1's mandated AI Agent stack; none requires an amendment. Items deferred to `/speckit-clarify` answers and to plan-time config are resolved here.

---

## R1 — Model provider & per-node tiering

**Decision**: Provider-abstracted via the LangChain chat-model interface; provider, model IDs, and tiers are **environment-configured** (`MODEL_PROVIDER`, no hardcoded model in node logic), selected in `src/models.py`. **Default provider: self-hosted Ollama** (LangChain `ChatOllama`) in every environment including production; **Anthropic Claude is the documented fallback** — switch to it when Ollama cannot meet the quality bar (tool-calling/structured-output reliability) or the p95 latency budget (SC-008). The golden-pair suite is the trigger: if it fails or latency regresses on the Ollama model, escalate that node (or the whole provider) to Claude.

Default tiering per graph node (env-overridable; Ollama defaults shown, Claude fallback in parentheses — pick tool-calling-capable Ollama models):

| Node | Tier | Default model — Ollama (Claude fallback) | Why |
|---|---|---|---|
| `supervisor` | fast | `qwen2.5` (`claude-haiku-4-5`) | Routing/classification only; latency-sensitive. |
| `curator` / `organizer` | balanced | `qwen2.5:32b` / `llama3.3:70b` (`claude-sonnet-4-6`) | Planning + multi-step tool use + structured tool-arg construction — needs a larger local model for reliable tool-calling. |
| escalation (flag) | frontier | `claude-opus-4-8` (Unleash flag) | Hard reasoning; escalates to Claude frontier regardless of base provider, behind a flag, off by default. |

Safety-relevant steps (routing, tool-argument construction) run at **low temperature** with **schema-validated structured/tool-call outputs**. Model/provider errors trip an Unleash circuit breaker and degrade to a "couldn't complete" AG-UI message (FR-018).

**Rationale**: Ollama default keeps inference in-house at zero per-token cost and strengthens data residency; Claude is the proven-quality escape hatch when a local model underperforms. Cheapest-capable-model per node minimizes cost (SC-008). Provider abstraction (R5.2 of PRD) keeps the switch a config change. The escalation tier always points at Claude frontier because that is the highest-assurance reasoning path when a turn is hard.

**Billing note (NON-OBVIOUS).** The agent layer calls Claude via the **Anthropic Messages API** (`langchain-anthropic`), which requires an **Anthropic API key billed per-token from the Console** — this is **separate from a Claude Max subscription**. A Max plan covers interactive claude.ai / Claude Code use only; it is **not** a programmatic backend for this application and cannot be used to authenticate the agent's model calls. Per-token reference (per 1M): Haiku 4.5 $1 in / $5 out; Sonnet 4.6 $3 / $15; Opus 4.8 $5 / $25.

**Provider is configurable per environment, including production.** Because the abstraction is env-configured (`MODEL_PROVIDER`), the **model provider is swappable in every environment — including production — with no code change**. Both **Anthropic Claude** and **self-hosted Ollama** (LangChain `ChatOllama`) are first-class supported providers. The single invariant is: **the golden-pair regression gate runs against the same model the *target* environment is configured to use** — so it always validates what will actually ship.

| Environment | Default provider / models | Notes |
|---|---|---|
| Local dev / iteration | **Ollama** (e.g. `qwen2.5`, `llama3.1` — tool-calling-capable) | $0 per call; agents make many calls during wiring/iteration |
| CI (most runs) | **Recorded LLM responses** (cassette/replay) — zero live calls | Deterministic + free; also removes LLM nondeterminism from the flaky-vs-broken diagnosis |
| Golden-pair regression + pre-merge | **Whatever the target deploy runs** (Claude *or* Ollama) | The gate must mirror prod — it tracks the prod provider, not a fixed vendor |
| Production | **Default: self-hosted Ollama**; **Claude is the fallback** (tiered Haiku/Sonnet/Opus) | Ship on Ollama; switch the node (or whole provider) to Claude if the golden-pair gate fails or p95 latency regresses |

**When to switch production from Ollama to Claude (the fallback trigger):**

- **Quality bar** — production requires reliable tool-calling + schema-validated structured outputs (R5.4) and routing/planning. Large local models (`qwen2.5:32b`/`72b`, `llama3.3:70b`) can meet it; small models are unreliable. The **golden-pair suite run against the prod Ollama model is the gate** — if it fails, switch the affected node (or the whole provider) to Claude rather than shipping degraded quality.
- **Latency** — if the Ollama deployment can't hold the p95 latency budget (SC-008) under load, switch to Claude (or scale the inference tier — Ollama suits moderate load; vLLM/TGI scale higher).
- **Infrastructure** — Ollama prod needs adequate GPU capacity and high availability (a single instance is a SPOF). If that infra isn't in place, Claude is the lower-effort path with no self-hosting to operate.
- **Cost** — infra/ops (Ollama, default) vs per-token (Claude). Self-hosting typically wins at sustained volume; Claude can be cheaper at low/bursty volume.
- **Data residency** — the Ollama default keeps user data in-house (no third-party API egress), strengthening the privacy posture; switching to Claude trades that for hosted quality/latency.

This is **not a constitution deviation** either way: the constitution pins LangGraph/MCP/LangFuse observability, **not a model vendor**. The per-user rate limit + cost ceiling (R8) caps live-call spend regardless of provider.

**Alternatives considered**: Single mid-tier model for all nodes (rejected — routing overhead/cost on every turn); pinning one frontier model (rejected — cost/latency budget risk); **Claude as the production default** (rejected — chose Ollama default for zero per-token cost + data residency, with Claude as the quality/latency fallback); **hard-coding either provider as the only production option** (rejected — the abstraction makes prod genuinely swappable both ways); a golden-pair gate fixed to one vendor regardless of prod (rejected — the gate must mirror the model prod actually runs, which is how the Ollama→Claude fallback decision is made).

---

## R2 — External movie-metadata provider

**Decision**: **TMDB (The Movie Database) REST API** via the outbound-only `web-api-mcp` server, called with `httpx`. API key injected from **Vault** at runtime; **no internal-network access** from this container.

**Rationale**: TMDB has a free, well-documented REST API with search + rich details (title, year, overview, genres, poster, external IDs), aligning with the existing `mc-service` movie schema and the PRD's `search_title` / `get_movie_details` tools. IMDB has no comparable free public API (licensing/scraping concerns).

**Alternatives considered**: OMDb (thinner data, stricter free quota); IMDB direct (no open API); web scraping (prohibited — fragile, ToS risk, and violates the outbound-only-no-internal-network scoping intent of a clean metadata fetch).

**Constraint surfaced**: `web-api-mcp` must not attach to `backend-network`; only egress to TMDB. Rate/quota handled with backoff; "not found"/ambiguous results returned as typed tool responses (spec edge cases), never fabricated.

---

## R3 — Identity propagation: Keycloak RFC 8693 token exchange + TTLs

**Decision**: Two-stage exchange exactly as MCM-Architecture.md §Token Custody prescribes:

1. **BFF mints a run-scoped subject token** (its own RFC 8693 exchange) — audience-narrowed, carrying an **agent-origin marker** claim, short TTL — and supplies it to the gateway as an **ephemeral, non-checkpointed run value** on each run invocation and each HITL resume. Never the user's full session access token.
2. **Gateway re-exchanges at tool-call time** for a **downscoped, `aud=mc-service`, short-TTL** access token; `movie-mcp` forwards it unchanged; `mc-service` validates and applies RBAC + DAC unchanged. **OPA** authorizes the exchange ("may this agent act for this user against this audience?").

**TTLs** (deployment config, finalized here): subject-token TTL sized to p99 active segment with a **hard ceiling of 3 min** (within the architecture's 2–5 min band); exchanged-token TTL **≤60 s**, set on the `mc-service` audience client in Keycloak. In-memory `(user, audience)` cache bounded by the exchanged-token TTL; **nothing persisted to disk**, nothing checkpointed.

**Keycloak setup**: enable **standard token exchange** (Keycloak 26.5) in the `jumbleknot` realm; the Agent Gateway is a **confidential** requester client; downscoping is via the `audience` filter (no impersonation). A new `mc-service`-audience client governs exchanged-token lifespan.

**Rationale**: Decouples token lifetime from run/HITL-pause length (a paused run holds no token); keeps the most-exposed component (model-driven gateway) holding only a minimized credential; gives `mc-service`/OPA a distinct agent-originated signal for the HITL-write policy. Directly satisfies SC-004 (no raw token leak).

**Alternatives considered**: Forwarding the user's session token to backends (rejected — violates least privilege + Identity Propagation principle); impersonation tokens (rejected — Keycloak 26.5 standard exchange has none; downscoping is the mechanism); long-lived service token for the agent (rejected — ambient privilege bypassing user-scoped access control is prohibited).

---

## R4 — Vector store / long-term memory

**Decision**: **None in MVP.** Per-user semantic long-term memory (pgvector on `agent-db`) is **Phase 2** and requires constitution amendment **A1**; explicitly out of scope (spec Out of Scope). Short-term memory is the LangGraph checkpointer in `agent-db` only.

**Rationale**: Keeps the MVP additive with no new governance change; avoids premature datastore/embedding decisions. The PRD sequences memory as P2.

**Alternatives considered**: Building pgvector now (rejected — needs A1 amendment + privacy/right-to-forget design; out of MVP scope and would expand the security surface).

---

## R5 — HITL interrupt / resume in LangGraph + AG-UI

**Decision**: Use LangGraph's **`interrupt()` / checkpoint-and-resume** at the `approval_gate` node. On reaching a write, the graph **interrupts**, the runtime emits an **AG-UI approval-request event** (carrying the proposal preview), and the run state is checkpointed to `agent-db`. The paused run **holds no token**. The client renders the approval prompt (single batch, per-item visible — clarify round 1). On approve/reject, the BFF issues a **fresh authenticated `resume+api` request supplying a new subject token**; the runtime re-hydrates the checkpoint and either executes the writes (with idempotency keys + re-validation) or discards. Abandoned proposals expire when the session ends (FR-008) — a session-end sweep marks pending threads expired.

**Rationale**: Native LangGraph mechanism; satisfies "resumable across arbitrarily long pauses with no token held" and the audit/approval requirements. AG-UI-native — no BFF event translation.

**Alternatives considered**: Holding the run/token in memory during the pause (rejected — token-lifetime coupling, fragility, leak risk); a separate approval queue outside the graph (rejected — duplicates state, breaks single-source checkpoint, complicates resume).

---

## R6 — CopilotKit `@copilotkit/react-native` + Expo SDK 56

**Decision**: Integrate **CopilotKit `@copilotkit/react-native`** into `mcm-app` as an **app-wide overlay/dock** (`components/agent/assistant-dock.tsx`, wired in `hooks/use-assistant.tsx`), mounted high in the app layout so it is reachable from any screen (clarify round 1). Generative UI uses **`useRenderTool`** mapping `render_*` tool props to **existing Components-Layer components** (reused, not new server-rendered UI). Frontend actions (`navigate_*`, `prefill_*`) use CopilotKit action primitives, dispatched only for **allowlisted** actions. The client posts a **sanitized readable UI-state** snapshot (current screen, loaded collection/movie id, active filter keys) for context-aware "this" resolution (US3).

**Rationale**: Constitution mandates CopilotKit as the universal client; `useRenderTool` keeps rendering identical on web + mobile (no RSC/`streamUI`). Overlay placement satisfies the clarified UI decision and US3 context resolution.

**Risks / to validate in spike**: `@copilotkit/react-native` compatibility with RN 0.85 / React 19.2 new-arch (bridgeless) and react-native-web; AG-UI transport (SSE/WebSocket) through the Expo Router BFF proxy on web + Android (recall: native uses `EXPO_PUBLIC_*` URLs + `adb reverse`). Generative-UI components must avoid native-only modules that break web (and vice-versa). A thin transport/render spike precedes full wiring.

**SPIKE VALIDATED (2026-06-06, T029 spike) — gateway + BFF transport.** Confirmed against a live gateway (uvicorn + `ag_ui_langgraph`) with the real graph + Ollama:
- The gateway **emits standard AG-UI protocol events natively** over HTTP — observed `RUN_STARTED`, `STEP_STARTED/FINISHED`, `TEXT_MESSAGE_START/CONTENT/END` (token deltas), and `STATE_SNAPSHOT`. So the constitution's "runtime emits AG-UI natively; BFF does not translate" is satisfied.
- **The BFF route is therefore a RAW AG-UI passthrough proxy** (the implemented T028 `run+api.ts`) — **NOT** a `@copilotkit/runtime` Node bridge and **no** `LangGraphHttpAgent`/`copilotRuntime*` translation. The older CopilotKit "runtime URL → CopilotRuntime → LangGraphHttpAgent" pattern (Next.js docs) is **rejected** here because our gateway is already AG-UI-native; adding a runtime would be the bespoke-translation chokepoint the constitution prohibits.
- **`@copilotkit/react-native` installs** (T007) and bundles `@ag-ui/client` (the AG-UI HTTP client), confirming the client can consume AG-UI directly.

**Still to confirm when wiring the overlay (T029 UI):** the exact `CopilotKitProvider` / `@ag-ui/client` `HttpAgent` config that points the RN client at the BFF AG-UI route (`/bff-api/agent/run`) rather than a CopilotKit runtime, and the SSE transport behavior on react-native-web. The server transport itself is proven.

**Alternatives considered**: Hand-rolled AG-UI client (rejected — reinvents CopilotKit, violates stack); web-only chat first (rejected — SC-001 requires web+mobile parity); BFF as a `@copilotkit/runtime` endpoint (rejected — see spike: gateway is AG-UI-native, so a runtime bridge is unnecessary translation).

---

## R7 — Idempotency keys & approval-time re-validation

**Decision**: Each write tool call (`add_movie`, `update_movie`, `delete_movie`, `create_collection`) carries a deterministic **idempotency key** derived from `(threadId, proposalId, itemId)` so an approved-then-retried write applies **at most once** (FR-009, SC-006). At approval time the `organizer` **re-validates each item against current domain state** via a read (`get_collection` / `list_movies`): items that are now-duplicate or whose target no longer exists are **skipped and reported**; still-valid items proceed; the batch is **not** aborted wholesale and conflicting writes are **not** forced (FR-009a, SC-010). `mc-service`'s existing E11000 duplicate handling and 404s are the backstop; the agent surfaces them rather than masking them.

**Rationale**: Combines client-retry safety (idempotency) with state-drift safety (re-validate) — the two clarified failure modes. Reuses `mc-service`'s existing uniqueness + ownership guarantees (no new domain logic).

**Alternatives considered**: Rely only on `mc-service` duplicate errors (rejected — noisy UX, doesn't pre-empt drift reporting); abort whole batch on any drift (rejected — clarify chose non-fatal per-item); store dedup ledger in agent-db (unnecessary — deterministic key + upstream uniqueness suffice for MVP).

---

## R8 — Per-user rate limit + cost ceiling

**Decision**: Enforce two guards (FR-020a, SC-011): a **per-user request rate limit** at the BFF agent routes (reuse the existing Redis-backed `rate-limiter` pattern, keyed per authenticated `userId` — distinct from the per-IP login limiter) and a **per-user/session cost ceiling** tracked from LangFuse per-turn token cost, accumulated in Redis; exceeding either returns a friendly "try again later" AG-UI message and performs **no** action. Also enforce the constitution's per-agent limits at the gateway.

**Rationale**: Models invoke paid LLMs; unbounded turns are an abuse/cost risk. Reuses existing infra (Redis + rate-limiter) for the request limit; LangFuse already tracks cost so the ceiling is observable and enforceable.

**Open config**: concrete thresholds (requests/min/user, cost ceiling/session) are env-configured and tuned against observed p95 cost; defaults set conservatively at implementation.

**Alternatives considered**: Observability-only (rejected — clarify chose a hard cap); per-IP only (rejected — collapses users behind a proxy, clarify chose per-user).

---

## R9 — Batch cap & chunking

**Decision**: A single approval batch is capped at **50 items** (configurable; aligned with `mc-service`'s movie pagination batch size); larger organize requests are split by the `organizer`/`proposals.py` into **sequential batches**, each independently previewed and approved (FR-009b). The cap is surfaced to the user when chunking occurs.

**Rationale**: Keeps the approval preview reviewable and writes bounded; reuses the domain's existing batch sizing. Matches clarify round 2.

**Alternatives considered**: No cap (rejected — unreviewable previews, unbounded write bursts); much smaller cap (rejected — excessive approval friction for common reorganizations).

---

## R10 — Generative-UI component reuse

**Decision**: `render_movie_card`, `render_collection_summary`, `render_wishlist` return **structured props only**; the client maps them to **existing `mcm-app` Components-Layer components** through `components/agent/render-*.tsx` adapters via `useRenderTool`. No new server-rendered UI; "wishlist" renders with the same collection component (it is a user-named collection — clarify round 3).

**Rationale**: Universal Generative UI principle (web + mobile from one codebase); avoids RSC/`streamUI`. Reuse keeps visual consistency with the forms-based UI.

**Alternatives considered**: New bespoke chat-only card components (rejected — duplicates UI, drifts from app look); server-streamed components (prohibited by constitution).

---

## R11 — `agent-db` deployment & isolation

**Decision**: New **PostgreSQL 18.3-alpine3.23** container `agent-db` in `infrastructure-as-code/docker/agent-db/compose.yaml`, on `backend-network`, with its own **external named volume** (e.g. `agent-db-data`, declared `external: true` so `include:` doesn't prefix it — same pattern as `mc-service_mc-db-data`). First-time setup adds the volume to the documented `docker volume create` list. LangGraph checkpointer schema initialized on gateway startup. Reachable only by the Agent Gateway.

**Rationale**: Bounded-context isolation (mandated); mirrors the established external-volume convention in CLAUDE.md so naming/teardown behavior is consistent.

**Alternatives considered**: Reuse Keycloak's or `mc-db` (rejected — couples agent state to other bounded contexts); SQLite (rejected — not the mandated checkpointer store; no container parity).

---

## R12 — Guardrails wiring

**Decision**: **NeMo Guardrails (Colang)** at the gateway for topic confinement (movie-collection domain only — FR-005), tone, and dialog rails; **Guardrails AI + Pydantic** at the Python layer for structural output validation of tool-args and proposals, plus PII/toxicity checks. All **user input and all tool/MCP output** pass through guardrails before entering/leaving agent context (prompt-injection defence). Readable UI state is sanitized at the **BFF** (sole sanitization point) via an explicit structural-field allowlist before it reaches the prompt.

**Rationale**: Mandated controls; topic rails enforce the out-of-domain decline; structural validation backs the schema-validated tool calls from R1.

**Alternatives considered**: Prompt-only guardrails (rejected — not enforceable/auditable); sanitizing UI state on the client only (rejected — BFF must be the authoritative sanitization point per Agent Security).

---

## Cross-cutting confirmations

- **Additive-only** verified by keeping all changes in new `agents/`, `mcp-servers/`, `bff-api/agent/`, `components/agent/`, `hooks/use-assistant.tsx`, and new compose files — `mc-service` and existing routes/screens untouched (SC-005; existing E2E regression must stay green).
- **Audit**: every tool call, UI action, and approval decision → OpenSearch append-only stream with `userId`/`threadId`, never PII or tokens.
- **Nx**: `movie-assistant`, `movie-mcp`, `web-api-mcp` registered via `@nxlv/python`; all test/lint/build/deploy through Nx targets.
- **TDD**: integration tests run against **real** MCP servers + real `mc-service` (no mocking the dependency under integration); LangFuse golden-pair suite gates deployment.
