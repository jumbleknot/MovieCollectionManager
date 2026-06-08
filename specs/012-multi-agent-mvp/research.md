# Phase 0 Research: Multi-Agent Conversational Assistant (Phase 1 MVP)

**Feature**: `012-multi-agent-mvp` | **Date**: 2026-06-06

All decisions below stay within constitution v1.5.2's mandated AI Agent stack; none requires an amendment. Items deferred to `/speckit-clarify` answers and to plan-time config are resolved here.

---

## R1 — Model provider & per-node tiering

**Decision** (revised 2026-06-07 — see "Provider-approach revision" below): Provider-abstracted via the LangChain chat-model interface; provider, model IDs, and tiers are **environment-configured** (`MODEL_PROVIDER`, no hardcoded model in node logic), selected in `src/models.py`. The provider is **scoped by environment**: **self-hosted Ollama** (LangChain `ChatOllama`, host gateway `localhost:11434`) for **dev / test / iterative E2E** — the fast, $0-per-call inner loop — and **Anthropic Claude** for the **golden-pair regression suite *and* production**: the shipped quality/reliability bar, and the gate must validate the *same* model that actually ships. The **escalation tier is always Claude** (Opus 4.8) regardless of base provider.

Per-node tiering (env-overridable). The **dev/test** column is Ollama (pick tool-calling-capable local models); the **golden + prod** column is Claude:

| Node | Tier | Dev/test — Ollama | Golden + prod — Claude | Why |
|---|---|---|---|---|
| `supervisor` | fast | `qwen2.5` | `claude-haiku-4-5` | Routing/classification only; latency-sensitive. |
| `curator` / `organizer` | balanced | `qwen2.5:32b` / `llama3.3:70b` | `claude-sonnet-4-6` | Planning + multi-step tool use + structured tool-arg construction. |
| escalation (flag) | frontier | — (always Claude) | `claude-opus-4-8` (Unleash flag) | Hard reasoning; always Claude frontier, behind a flag, off by default. |

Safety-relevant steps (routing, tool-argument construction) run at **low temperature** with **schema-validated structured/tool-call outputs**. Model/provider errors trip an Unleash circuit breaker and degrade to a "couldn't complete" AG-UI message (FR-018).

**Rationale**: Ollama gives a $0-per-token, in-house, low-latency loop for the high call volume of dev/iteration + test. **Production and the golden-pair gate run on Claude** because (a) the regression gate must exercise the *same* model that ships — gating on Ollama while shipping Claude (or the reverse) validates the wrong model; and (b) Claude meets the prod tool-calling / schema-validated-structured-output reliability + availability bar **without** operating self-hosted GPU/HA inference infra. Cheapest-capable-tier per node still minimizes cost (SC-008: Haiku route → Sonnet plan → Opus escalate). Provider abstraction (R5.2 of PRD) keeps it a per-environment config switch (`MODEL_PROVIDER`), no code change. The escalation tier always points at Claude frontier — the highest-assurance reasoning path when a turn is hard.

**Billing note (NON-OBVIOUS).** The agent layer calls Claude via the **Anthropic Messages API** (`langchain-anthropic`), which requires an **Anthropic API key billed per-token from the Console** — this is **separate from a Claude Max subscription**. A Max plan covers interactive claude.ai / Claude Code use only; it is **not** a programmatic backend for this application and cannot be used to authenticate the agent's model calls. Per-token reference (per 1M): Haiku 4.5 $1 in / $5 out; Sonnet 4.6 $3 / $15; Opus 4.8 $5 / $25.

**Provider is configurable per environment, including production.** Because the abstraction is env-configured (`MODEL_PROVIDER`), the **model provider is swappable in every environment — including production — with no code change**. Both **Anthropic Claude** and **self-hosted Ollama** (LangChain `ChatOllama`) are first-class supported providers. The single invariant is: **the golden-pair regression gate runs against the same model the *target* environment is configured to use** — so it always validates what will actually ship.

| Environment | Provider / models | Notes |
|---|---|---|
| Local dev / iteration | **Ollama** (e.g. `qwen2.5`, `qwen2.5:32b` — tool-calling-capable) | $0 per call; agents make many calls during wiring/iteration; host gateway → `localhost:11434` |
| CI (most runs) | **Recorded LLM responses** (cassette/replay) — zero live calls | Deterministic + free; cassettes record the golden/prod provider (Claude) responses; also removes LLM nondeterminism from the flaky-vs-broken diagnosis |
| Golden-pair regression + pre-merge | **Anthropic Claude** (the prod provider) | The gate must mirror prod — it runs the model that actually ships |
| Production | **Anthropic Claude** (tiered Haiku/Sonnet/Opus) | `MODEL_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` (Console per-token key; future: Vault, T030a) |

**Provider-approach revision (2026-06-07, user-approved).** Originally R1 made **Ollama the default in every environment including production**, with Claude only a fallback. Reconsidered to **Ollama for dev/test only; Claude for the golden-pair regression suite *and* production.** Why Claude for golden + prod (and Ollama for dev/test):

- **Quality bar** — production requires reliable tool-calling + schema-validated structured outputs (R5.4) and routing/planning. Claude meets this consistently; small/medium local models are unreliable and a large-enough local model needs heavy GPU.
- **Gate fidelity** — the golden-pair suite must validate the **shipped** model. With prod on Claude, the gate runs on Claude; gating on Ollama while shipping Claude would test the wrong model.
- **Operations** — Claude needs no self-hosted GPU/HA inference (a single Ollama instance is a SPOF; scaling needs vLLM/TGI + GPU capacity). Claude is the lower-ops path for prod.
- **Latency** — Claude reliably holds the p95 budget (SC-008) under load without an inference-scaling project.
- **Accepted tradeoff** — prod now sends prompts to a third-party API (data egress) instead of in-house Ollama; the per-user rate limit + cost ceiling (R8) caps live-call spend, and the dev/test loop stays in-house on Ollama.

This is **not a constitution deviation**: the constitution pins LangGraph/MCP/LangFuse observability and the mandatory golden-pair deployment gate, **not a model vendor** — so this provider-scoping is a research/plan decision (the gate stays mandatory; only its provider is pinned to prod's = Claude).

**Alternatives considered**: Single mid-tier model for all nodes (rejected — routing overhead/cost on every turn); pinning one frontier model for all nodes (rejected — cost/latency budget risk); **Ollama as the production default with Claude as fallback** (this was the *original* R1 — superseded 2026-06-07: prod quality/ops bar + gate fidelity favour Claude for what ships; Ollama retained for the dev/test inner loop); a golden-pair gate fixed to a vendor *different* from prod (rejected — the gate must mirror the model prod actually runs).

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

**CORRECTION (2026-06-06, T029 client build) — the BFF route is a CopilotKit RUNTIME endpoint, not a raw passthrough.** Read against the installed `@copilotkit/react-native` `CopilotKitNativeProviderProps`: the RN provider takes **`runtimeUrl`** (a CopilotKit *runtime* endpoint) + `credentials` (`"include"` for the HttpOnly session cookie) — it has **no** `agents__unsafe_dev_only` and does **not** consume a raw `@ag-ui/client` `HttpAgent` directly. So:
- The client is `CopilotKitProvider runtimeUrl="/bff-api/agent/run" credentials="include"` + `useAgent({ agentId: "movie_assistant" })`.
- The **BFF route must host the CopilotKit runtime** (`@copilotkit/runtime` `CopilotRuntime` + `LangGraphHttpAgent({ url: <gateway> })`) — this is the framework's **standard library bridge**, NOT the bespoke per-event translation the constitution prohibits (which would be hand-rolled code). The gateway still emits AG-UI natively; the runtime is just the CopilotKit-client adapter in front of it.
- This **supersedes the earlier "raw passthrough" note above** for the CopilotKit RN client (a raw passthrough would only suit a direct `@ag-ui/client` consumer, which the RN provider is not). The agent id (`movie_assistant`) must match the gateway's `LangGraphAGUIAgent` name.

**DONE (T029 server side):** `bff-api/agent/run+api.ts` is now a CopilotKit-runtime endpoint — `CopilotRuntime` + `ExperimentalEmptyAdapter` + `LangGraphHttpAgent({ url: <gateway>/agent/movie-assistant })`, behind the requireAuth→requireMcUser gate (GET+POST). **Verified `@copilotkit/runtime` loads under `@expo/server`** (the route bundles and returns 401 unauth) and T028a auth-guard stays green. **Dep note (minor smell):** `@copilotkit/runtime` eagerly imports its default OpenAI service-adapter, so `openai` + `@ai-sdk/openai` must be installed even though we use `ExperimentalEmptyAdapter` + LangGraph (the other adapters — anthropic/google/groq/langchain — lazy-load and aren't needed). Follow-up: watch for a runtime version that lazy-loads adapters to drop these.

**Still to do (T029 final):** the live web E2E (Playwright) — gateway + BFF + Ollama + Metro up, open the dock, send a message, assert the AG-UI response renders. This also validates CopilotKit rendering under react-native-web (the render smoke test used react-test-renderer, not real RNW DOM) and the runtime `/info` + single-endpoint client behavior.

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

## R13 — Golden-pair cassette/replay mechanism (T032/T063)

**Decision** (2026-06-07): The golden-pair regression gate asserts the agent's **model decisions** — supervisor **intent** classification and curator **entity extraction** ({title, year, collection}) — the two (and only) LLM calls in the compiled graph. A golden pair is `(conversation input → expected model decision)`. The shipped provider (Anthropic Claude, R1) is exercised **live** for the gate; CI **replays recorded responses** deterministically with no key and no live call.

**Mechanism**:
- **Single interception seam = `src/models.build_chat_model`** (both model calls already route through it). `LLM_CASSETTE_MODE` ∈ { *unset*→live (default), `record`, `replay` }. `replay` returns a `ReplayChatModel` that **never imports/instantiates a provider** (so replay needs no `ANTHROPIC_API_KEY` and no provider package); `record` wraps the real model and persists each response; unset is unchanged (zero impact when cassettes are unused). The active cassette is supplied via a `ContextVar` set by `cassette.use(...)` — safe because the golden runner calls the decision functions **synchronously**, not through LangGraph's async per-node tasks (the ContextVar-across-async-task fragility documented for the F2 token path does not apply here).
- **Cassette** = one JSON file per scenario id, entry keyed by `sha256(model_id + serialized_prompt)` → `{content, tool_calls}`. A **replay miss raises `CassetteMissError`** so a prompt change fails loudly (forces a re-record) instead of silently replaying a stale response.
- **Pure decision functions**: the two inline prompt+parse blocks are refactored into `nodes/supervisor.classify_intent(model, messages)` and `nodes/curator.extract_entities(model, messages)` (behaviour-preserving — the graph nodes delegate to them) so the golden runner can target the decision directly with a cassetted/live model.
- **Dataset** = `tests/golden/dataset.json` (JSON, not YAML, to avoid a `pyyaml`/`types-PyYAML` dependency and match the cassette format); a pure `compare_decision(kind, expected, actual, tolerance)` matcher (intent exact; title/collection case-insensitive; year exact). Runner = `tests/integration/test_golden_pairs.py` (pytest, marked `golden`); Nx target `test:golden`. Record once with the key + `LLM_CASSETTE_MODE=record`, commit cassettes; CI runs `replay`.

**Scope note**: these pairs test the **model decision in isolation** — they do **not** touch MCP/`mc-service`/TMDB, so the "keep the dependency-under-integration real" rule is not in tension (only the LLM dimension is cassetted, exactly as T032 mandates; full-stack behaviour is covered by T036/T037/T038). End-to-end-graph golden pairs were rejected (heavy, slow, duplicative of E2E).

**Deferred**: hosting the dataset in **LangFuse** (T030 — the constitution's observability sink; the committed JSON + cassettes are the MVP gate); wiring `test:golden` into a CI workflow (the pytest runner + Nx target are the mechanism); `.ainvoke`/`with_structured_output` cassette support (no current call site uses them).

**Alternatives considered**: cassette at the HTTP layer (rejected — provider-specific, brittle across Ollama/Claude); mocking the agent logic for determinism (rejected — constitution forbids mocking the unit under test; cassettes record real model output instead); golden pairs over the whole graph with real deps (rejected — see scope note).

---

## R14 — Multi-turn conversational-add as a first-class state machine (T069)

**Problem** (root-caused 2026-06-07, systematic-debugging Phase 4.5): the add flow was built/tested only for the single-shot **exact**-title path (T037 "Coherence"). The realistic **ambiguous**-title path (franchises/remakes) spans turns, and every turn-spanning concern was broken or missing — disambiguation was modelled as the implicit flag `match_confidence == "ambiguous"` plus a supervisor `enrich→add` upgrade hack, not as designed state. Four root causes:
- **RC1** — ordinal/positional picks ("the first one", "the 2003 one", "number 2") dead-end: the supervisor only continues a pending add when the reply re-classifies as `enrich` (a re-typed title); a pick classifies as `ambiguous`/`out_of_domain` → `clarify` and stalls. Nothing resolves a pick against the offered `state["options"]`.
- **RC2** — the spoken target collection is dropped on the ambiguous branch: `curator._reply` returns no `target_collection_name`, so "add X to my Favorites" loses "Favorites" before the user picks.
- **RC3** — no real default collection: an unnamed/generic target ("add X to my collection") create-if-missing a collection literally named "my collection" (or `""`). The domain has a real default (`isDefault` flag — mc-service `CollectionDto` → movie-mcp `list_collections` passthrough → frontend FR-009 `collections.find(c => c.isDefault)`), ignored here.
- **RC4** — fragile per-turn overwrite, no lifecycle: `classify_intent`/`extract_entities` read only `messages[-1]`; cross-turn context survives only via a few GraphState fields that are overwritten each turn, and nothing resets `options`/`intent`/`match_confidence` after a completed add (stale state can hijack the next turn).

**Decision**: model the in-progress add as an explicit **stage machine** on `GraphState`, routed by the supervisor, with all tool work staying code-orchestrated (the LLM still only extracts/phrases — picks are resolved deterministically in code, never by an LLM tool call). New/used state fields:
- `add_stage: str` — `"" | "awaiting_pick" | "awaiting_collection"` (the explicit lifecycle, replacing flag-reading).
- `options` (existing) — the offered title matches while `awaiting_pick`.
- `resolved_pick: dict | None` — the chosen option `{sourceId, title, year}` handed from the supervisor to the curator (so the curator fetches **details** for the chosen `sourceId` instead of re-searching and re-ambiguating).
- `target_collection_name` (existing) — preserved across **all** stages (fixes RC2).

**Transitions** (supervisor is the single router; pick resolution + generic-target detection are pure helpers, no tools):
1. New `add` request → curator enrich. `exact` → candidate, `add_stage=""` → organizer. `ambiguous` → `options`, `add_stage="awaiting_pick"`, **target preserved** → END (ask pick). `none` → "couldn't find" → END.
2. Turn while `awaiting_pick`: `resolve_option(text, options)` (ordinal words → index; bare year → option with that year; title substring → matching option). Resolved → `resolved_pick` + `intent="add"` → curator (details-for-pick short-circuit) → organizer. Re-typed title (classifies add/enrich) → curator re-enrich (existing upgrade). Off-topic (organize/out_of_domain) → clear add state, handle normally. Unresolved → re-ask.
3. Organizer target resolution (RC3 + the no-default decision below): exact case-insensitive name match → use it; else if name empty **or** a generic-default phrase (`my collection`, `my list`, `my movies`, `default`, `the collection`) → use the `isDefault` collection; if **no** default exists → emit clarify listing the user's collections + `add_stage="awaiting_collection"` (keep `candidate`, no proposal); else (a specific non-matching name) → create-if-missing (unchanged).
4. Turn while `awaiting_collection`: the reply names a collection → set `target_collection_name`, route to organizer (candidate already in state) → proposal.
5. After approve/reject/decline → reset `add_stage`/`options`/`resolved_pick`/`candidate`/`match_confidence`/`intent` (clean lifecycle — fixes RC4).

**No-default fallback decision** (user, 2026-06-07): when the target is unnamed/generic **and** the user has no `isDefault` collection, the assistant **clarifies** ("Which collection should I add it to?" + lists collections) rather than auto-creating one — never creates an unintended collection. (FR-014 clarify-on-ambiguity already governs this; FR-005b makes the default-resolution explicit.)

**Scope**: picks are resolved deterministically (ordinal/year/title-substring) — LLM-freeform picks ("the one with Johnny Depp") are **out of scope** for this slice (would reintroduce an LLM decision on untrusted text; the user can re-type the title, which the existing `enrich→add` upgrade already handles). Robust multi-turn disambiguation is hardened **in-place as 012 US1 defect** (not a separate feature — user decision 2026-06-07).

**Tested** (TDD): graph-level via the `test_add_flow_graph.py` harness (stub tools + MemorySaver, multi-turn `ainvoke`) for RC1–RC4; web (Playwright) + mobile (Maestro) E2E for the ambiguous path (ambiguous title → pick → approve → added once); golden intent exemplars for ordinal picks re-recorded vs Claude (R13/T032).

**Alternatives considered**: keep patching the flag + supervisor upgrade (rejected — five consecutive one-offs already failed; Phase 4.5 says question the design). LLM-driven pick resolution (rejected — violates the code-orchestration decision; deterministic ordinal/year/title covers the stated cases). Auto-create a default collection on no-default (rejected by the user — clarify instead, never create unintended).

---

## Cross-cutting confirmations

- **Additive-only** verified by keeping all changes in new `agents/`, `mcp-servers/`, `bff-api/agent/`, `components/agent/`, `hooks/use-assistant.tsx`, and new compose files — `mc-service` and existing routes/screens untouched (SC-005; existing E2E regression must stay green).
- **Audit**: every tool call, UI action, and approval decision → OpenSearch append-only stream with `userId`/`threadId`, never PII or tokens.
- **Nx**: `movie-assistant`, `movie-mcp`, `web-api-mcp` registered via `@nxlv/python`; all test/lint/build/deploy through Nx targets.
- **TDD**: integration tests run against **real** MCP servers + real `mc-service` (no mocking the dependency under integration); LangFuse golden-pair suite gates deployment.
