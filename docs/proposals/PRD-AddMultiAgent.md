# PRD: Add Multi-Agent Layer — Conversational Movie Collection Assistant

**Status**: Draft proposal
**Author**: agent-layer initiative (derived from the constitution's *AI Agents Development Principles* and [MCM-Architecture.md §AI Agents Layer](MCM-Architecture.md#L147))
**Related**: [MCM-Architecture.md §AI Agents Layer (AG-UI-Native)](MCM-Architecture.md#L147), [.specify/memory/constitution.md §AI Agents Development Principles](../.specify/memory/constitution.md#L390), [PRD-CleanDAC.md](PRD-CleanDAC.md) (DAC enforced for all agent-driven writes), [project_agent_token_propagation](../.specify/memory/constitution.md)

> **Scope of this document.** High-level product requirements for the **first** multi-agent feature. It is intentionally above the SDD `spec.md` level — it sets goals, role, scope, and the cross-cutting design considerations the user asked for (orchestration, short- and long-term memory, tools, model, reinforcement learning). The formal feature spec is produced by running this through `/speckit-specify docs\PRD-AddMultiAgent.md`. Where a consideration **extends the current constitution** (long-term/vector memory; reinforcement learning), it is called out explicitly in [Constitution Alignment & Required Amendments](#constitution-alignment--required-amendments) — those are governance changes, not silent additions.

---

## Problem & Opportunity

Today users manage movie collections through forms: create a collection, add a movie, fill metadata fields, search/filter. Discovery and enrichment are manual. The product already ships the substrate an assistant needs — an authenticated BFF, a domain service (`mc-service`) with RBAC + per-collection DAC, and a documented AG-UI-native agent architecture — but no assistant exists yet.

The opportunity is a **conversational assistant** that lets a user say *"find the rest of the Dune films and add them to my Sci-Fi collection"* or *"filter my wishlist to 1980s"* and have an agent plan it, call the right domain tools, render results inline, and route every write through a human-approval gate — acting strictly as the user, enforcing the same RBAC/DAC, on both web and mobile.

---

## Goal — Role & Scope

### Goal

Deliver an **additive** AI Agents layer that provides a natural-language, AG-UI-native assistant for movie discovery, enrichment, and collection organization, without modifying any existing client, BFF, or `mc-service` domain logic.

### Role

The assistant is a **domain-bounded orchestrator**, not a domain authority:
- It **reasons, plans, and composes** calls to existing capabilities through MCP tools.
- It **never owns domain logic** — all validation, persistence, and authorization stay in `mc-service` ([constitution §No Domain Logic in Agents](../.specify/memory/constitution.md#L401)).
- It **acts strictly as the calling user** via a run-scoped delegation token (RFC 8693 exchange), so it can never exceed the user's RBAC/DAC ([MCM-Architecture.md §Token Custody & Propagation](MCM-Architecture.md#L167)).
- It is **safe by construction**: every write/delete is HITL-gated; behavior is observable, policy-gated, and kill-switchable.

### In Scope (MVP — Phase 1)

Two specialist agents under a routing supervisor (matching the architecture's named nodes):

| Agent | Responsibility | Primary tools |
|---|---|---|
| **Curator** | Discover and enrich movie metadata; propose additions | `web-api-mcp` (TMDB/IMDB lookups) — read-only |
| **Organizer** | Reorganize collections and wishlists; add/update/remove movies | `movie-mcp` (wraps `mc-service`) — **writes HITL-gated** |

Plus the three AG-UI capabilities already documented ([MCM-Architecture.md §Three Agent-UI Capabilities](MCM-Architecture.md#L177)):
1. Agent controls UI (allowlisted frontend actions, e.g. pre-fill add-movie form).
2. Agent reads sanitized UI state (knows the current collection so "add this" resolves the target).
3. Agent renders generative UI inline (`render_movie_card`, `render_collection_summary`, `render_wishlist`).

### Out of Scope (this feature)

- Anything outside the movie-collection domain (no general chat, web browsing beyond the metadata MCP, code execution).
- Autonomous writes — **no** write or delete ever bypasses the HITL gate.
- Cross-user or admin actions on behalf of others; the agent's authority is exactly the calling user's.
- Multi-tenant "shared agent memory" across users (each user's memory is isolated — see Long-Term Memory).
- Online/production reinforcement learning that mutates behavior unsupervised (see Reinforcement Learning — explicitly deferred and gated).

---

## Consideration 1 — Orchestration (sequence of operations to achieve the goal)

**Requirement.** A LangGraph **stateful supervisor graph**, compiled with a persistent checkpointer and deployed behind the `langgraph-api` Agent Gateway on the private network ([constitution §Technology Stack](../.specify/memory/constitution.md#L455)).

Operation sequence for a typical turn:

1. **Ingest** — BFF proxies the user turn as an AG-UI stream to the gateway, attaching the run-scoped delegation token and `userId → threadId` mapping.
2. **Route** — `supervisor` classifies intent and routes to a specialist, a UI/generative tool, or the HITL gate. It calls **no** domain tools itself.
3. **Plan & act** — the chosen specialist (curator/organizer) reasons over short-term memory + retrieved long-term memory, then calls MCP tools through the gateway's shared in-process MCP client (per-agent allowlist).
4. **Gate writes** — any `mc-service` write/delete routes through `approval_gate`, which **pauses** the run and emits an AG-UI approval request; the run holds no token while paused.
5. **Resume** — on user approval (a fresh authenticated BFF request supplying a fresh delegation token), the gateway re-hydrates the checkpoint and executes the write with an idempotency key.
6. **Render & stream** — results stream back as AG-UI events; generative-UI tools render inline; the audit log records the decision.

Requirements:
- **R1.1** Supervisor routes only; specialists are the sole tool callers.
- **R1.2** Tool naming is fixed by category so the BFF routes results without inspecting orchestration internals: MCP tools (`get_collection`, `add_movie`, …), generative-UI (`render_*`), UI-action (`navigate_*`, `prefill_*`).
- **R1.3** Every write tool call carries an idempotency key and is HITL-gated and audited.
- **R1.4** The graph is resumable across arbitrarily long HITL pauses (checkpoint in agent-db; no token held during pause).

---

## Consideration 2 — Short-Term Memory (relevance within a session)

**Requirement.** Session/thread state is the **LangGraph checkpointer persisted in the dedicated `agent-db` (PostgreSQL)** — conversation turns, the working plan, tool results, and the current AG-UI/UI-state snapshot for the active `threadId`.

- **R2.1** Short-term memory is scoped to a single `threadId` (one user conversation) and is **bounded-context isolated** from domain data ([constitution §Bounded-Context Isolation](../.specify/memory/constitution.md#L403)).
- **R2.2** It maintains in-session relevance: prior turns, the resolved target collection from sanitized UI state, pending proposals awaiting approval, and partial plans across HITL pauses.
- **R2.3** Raw tokens (subject or exchanged) are **never** written to checkpointed state, traces, or logs.
- **R2.4** Context-window management: long threads are summarized/compacted into a running thread summary rather than replaying every turn verbatim (keeps prompt size and cost bounded).
- **R2.5** Retention: session checkpoints have a configurable TTL/expiry; expired threads are purged. Agent state is not domain data and is not subject to domain retention rules.

---

## Consideration 3 — Long-Term Memory (learn & evolve over time — vector DB)

> **Extends the current constitution.** The constitution defines `agent-db` for *checkpoints* (short-term) but does not yet define a long-term/semantic memory store. This section proposes one; adopting it requires the amendment noted in [Constitution Alignment](#constitution-alignment--required-amendments).

**Requirement.** A **per-user, semantic long-term memory** that lets the assistant personalize and improve recommendations across sessions — e.g. learned genre/era preferences, disliked suggestions, naming conventions for collections, "already declined this film."

- **R3.1 Store.** A vector store for embeddings + metadata. **Recommended default: `pgvector` on the existing `agent-db` PostgreSQL** — reuses standardized infra, preserves bounded-context isolation, avoids a new datastore. A dedicated vector DB (Qdrant/Weaviate) is an alternative only if scale/recall demands it; decided at plan time.
- **R3.2 Isolation & privacy.** Memory is **namespaced per `userId`**; one user's memory must never surface in another user's run. No PII beyond what is necessary; entries are user-inspectable and user-deletable (right-to-forget). Long-term memory is agent state, **not** domain data, and must not duplicate `mc-service` as a source of truth.
- **R3.3 Write path.** Durable memories are written **deliberately** (e.g. a `remember_preference` tool, or a post-turn reflection step), not by dumping every message. What is remembered and why must be explainable.
- **R3.4 Read path.** Relevant memories are **retrieved by semantic similarity** and injected into the specialist's context at plan time, scoped and ranked; retrieval is observable in traces.
- **R3.5 Authority boundary.** Long-term memory may bias *suggestions* but must never bypass RBAC/DAC or substitute for live domain reads — the current collection state always comes from `mc-service`.
- **R3.6 Lifecycle.** Memories support update/decay/eviction so stale or corrected preferences don't persist indefinitely.

---

## Consideration 4 — Tools (tasks beyond text generation)

**Requirement.** All non-text actions are performed via **MCP tools** exposed by isolated Python Docker MCP servers, invoked through the gateway's shared in-process MCP client with **per-agent allowlists** ([constitution §MCP Tool Layer](../.specify/memory/constitution.md#L444)).

| Tool class | Examples | Identity / safety |
|---|---|---|
| **Domain (movie-mcp)** | `get_collection`, `list_movies`, `add_movie`, `update_movie`, `delete_movie` | Carries run-scoped delegation token → `mc-service` enforces RBAC/DAC; **writes HITL-gated + idempotency key** |
| **External metadata (web-api-mcp)** | `search_title`, `get_movie_details` (TMDB/IMDB) | Outbound only; **no** internal-network access; read-only |
| **Generative UI** | `render_movie_card`, `render_collection_summary`, `render_wishlist` | Renders existing `mcm-app` components inline via AG-UI |
| **UI actions** | `navigate_*`, `prefill_*` | Allowlisted; BFF authorizes against the user's roles; UI actions affecting unsaved state are HITL-gated |
| **Memory** | `remember_preference`, `recall_preferences` | Per-user namespaced; never cross-user |

Requirements:
- **R4.1** Tools are the only way agents affect the world; no agent has ambient privilege or a service identity that bypasses user-scoped access control.
- **R4.2** Per-agent allowlists are enforced at the gateway (curator cannot call write tools; organizer's writes are gated).
- **R4.3** Each tool has a typed schema, bounded inputs, and explicit error semantics surfaced back to the planner.
- **R4.4** Risk-tiered tools above a configured threshold route through HITL regardless of class.

---

## Consideration 5 — AI Model

> The constitution mandates LangGraph orchestration and LangFuse cost/latency observability but does not pin a specific model; this section sets the model strategy.

**Requirement.** A **tiered, provider-abstracted** model strategy selected per graph node, configured via environment, swappable without code change (LangChain chat-model interface).

- **R5.1 Tiering.** Use the cheapest model that meets each node's bar:
  - `supervisor` (routing/classification) → **fast tier** (e.g. Claude Haiku 4.5).
  - `curator`/`organizer` (planning + tool use) → **balanced tier** (e.g. Claude Sonnet 4.6).
  - Escalation path to a **frontier tier** (e.g. Claude Opus 4.8) for hard reasoning, behind a flag.
- **R5.2 Configurability.** Model IDs and tiers are env/flag-configured (Unleash); no hardcoded model in agent logic. Default to the latest available tier for each band.
- **R5.3 Cost & latency governance.** LangFuse tracks per-step token cost and latency; budgets/alerts gate regressions ([constitution §Evaluation & LLM Observability](../.specify/memory/constitution.md#L462)).
- **R5.4 Determinism for safety-relevant steps.** Routing and tool-argument construction use low temperature; structured/tool-call outputs are schema-validated.
- **R5.5 Failure handling.** Model/provider errors trip circuit breakers (Unleash kill switch) and degrade gracefully to a "couldn't complete" AG-UI message — never a silent or unauthorized action.

---

## Consideration 6 — Reinforcement Learning (learn from feedback)

> **Extends the current constitution and is the most safety-sensitive area. Framed as a deferred, human-gated improvement loop — NOT online/autonomous RL.**

**Requirement.** Capture human-feedback signals and use them for **offline, human-reviewed improvement**. The product must never self-modify its behavior in production without human approval ([constitution §HITL](../.specify/memory/constitution.md#L423) and the "no autonomous self-modification" safety posture).

- **R6.1 Signal capture.** Record implicit/explicit reward signals: HITL approve/reject decisions, user edits to agent proposals before approval, accepted vs. declined suggestions, thumbs up/down, task completion. Stored as a preference dataset (agent state, per-user isolated, PII-minimized).
- **R6.2 Offline use only (Phase 3).** Signals feed: (a) the LangFuse **golden-pair regression suite**, (b) curated few-shot exemplars in long-term memory, and (c) optionally a future **preference-tuning (e.g. DPO) fine-tune** of a specialist model — all produced and reviewed **offline**, gated by the mandatory eval suite before any deployment.
- **R6.3 No online RL in production.** No policy is updated live from production reward without a human-in-the-loop review and the standard deployment gate. Online/continuous RL is explicitly **out of scope** for the foreseeable roadmap and would require its own PRD + constitution amendment + threat model.
- **R6.4 Auditability.** Any behavior change attributable to feedback is traceable to its dataset and approval; reversible via Unleash and model/version pinning.
- **R6.5 Bias & safety review.** Feedback-driven changes are evaluated for over-fitting to a vocal minority and for safety regressions before rollout.

---

## User Scenarios (illustrative)

1. **Enrich & add (curator + HITL).** "Add the original *Blade Runner* to my Sci-Fi collection." → curator looks up canonical metadata, proposes a movie card, organizer drafts the write, HITL gate asks the user to confirm, on approval the movie is added and rendered inline.
2. **Organize (organizer + HITL).** "Review my wishlist for anything I've marked as owned, add them to my default collection and remove them from wishlist." → organizer plans a batch of updates/removals, each batch surfaced for approval before execution.
3. **Personalize over time (long-term memory).** After the user declines several horror suggestions, later "recommend something for tonight" avoids horror without being told again — and the user can inspect/delete that learned preference.
4. **Context-aware reference (short-term + UI state).** While viewing collection *X*, "add this to my wishlist" resolves the target from sanitized UI state without asking.

---

## Success Criteria (measurable, technology-agnostic)

1. A user can add, enrich, and organize movies entirely through conversation on **both web and mobile**, with identical behavior.
2. **100%** of agent-initiated writes/deletes pass through an explicit human approval before execution; **0** writes occur without a recorded approval.
3. The agent never performs an action the user couldn't perform directly — verified by RBAC/DAC tests where a non-authorized user's agent run is denied (404) exactly as the direct API is.
4. No raw user token is ever found in checkpoints, long-term memory, traces, or logs (automated scan in the eval/CI gate).
5. A user can view and delete their long-term memories; deleted memories never resurface in later runs.
6. The golden-pair regression suite gates every deployment; a quality regression blocks release.
7. Adding the agent layer requires **zero** changes to existing client routes, BFF routes, or `mc-service` domain logic (additive-only verified by the existing E2E regression staying green).
8. Per-turn cost and p95 latency stay within configured budgets, visible in observability.

---

## Constitution Alignment & Required Amendments

**Already aligned (no change needed):**
- Additive & non-breaking; BFF remains the security boundary and sole OAuth2 client; agents never call backends directly; no domain logic in agents; identity propagation via run-scoped delegation token (RFC 8693, never the full session token); bounded-context isolation of agent state; AG-UI-native with the BFF as a secure proxy; LangGraph + MCP + HITL + LangFuse + OPA/Unleash/Vault + OpenSearch audit.

**Requires a constitution amendment before/with implementation:**
- **A1 — Long-term/semantic memory store (Consideration 3).** The constitution defines `agent-db` for checkpoints only. Amend to recognize a per-user, bounded-context-isolated long-term memory (default `pgvector` on `agent-db`), with privacy/right-to-forget requirements.
- **A2 — Feedback-driven improvement & RL posture (Consideration 6).** Add an explicit principle: feedback may drive **offline, human-reviewed** improvement gated by the eval suite; **online/autonomous RL in production is prohibited** without a dedicated PRD, amendment, and threat model.
- **A3 — Model strategy (Consideration 5).** Optional: codify the tiered, provider-abstracted, env-configured model selection and cost-governance expectation (currently implied by the observability principle, not stated).

These amendments are **MAJOR/MINOR governance changes** and must be made via an explicit constitution update (not inside the feature), per the project's SDD discipline.

---

## Sequencing (suggested phases)

| Phase | Delivers | New constitution dependency |
|---|---|---|
| **P1 — Orchestration MVP** | Supervisor + curator + organizer; MCP tools; short-term memory (checkpointer); AG-UI three capabilities; HITL gate; RFC 8693 delegation token; LangFuse/OPA/Unleash wiring | none (all already in constitution) |
| **P2 — Long-term memory** | Per-user pgvector memory; remember/recall tools; personalization; right-to-forget | **A1** |
| **P3 — Feedback loop** | Signal capture; offline eval/curation; optional preference fine-tune; all human-gated | **A2** |

MVP scope is **P1 only**. P2 and P3 are separate features, each preceded by its constitution amendment.

---

## Open Questions (for `/speckit-clarify`)

1. **AI Models**: confirm what AI models will be used.
2. **Vector store**: `pgvector` on `agent-db` (recommended) vs. a dedicated vector DB — decided by expected memory volume and recall needs.
3. **Long-term memory write policy**: explicit `remember_preference` tool only, vs. an automatic post-turn reflection step (or both).
4. **Delegation-token TTLs**: confirm the active-segment ceiling (≈2–5 min subject; ≤60 s exchanged) against real curator fan-out (enriching many titles in one turn).
5. **Model tiers**: confirm the specific Claude tiers per node and the escalation flag policy.
6. **HITL batching UX**: per-item approval vs. a single approval for a batch of writes (and how that surfaces in AG-UI on mobile).

## Next Step

Run `/speckit-specify docs\PRD-AddMultiAgent.md` to produce the Phase-1 feature spec. Before P2/P3, land constitution amendments **A1** and **A2** respectively.
