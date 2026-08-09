---
type: Architecture
title: AI Agents layer architecture (features 012/014/018/040/047)
description: The call chain, token-custody model, and per-user config design for MCM's additive conversational assistant — how identity flows from mcm-app through the BFF and Agent Gateway to mc-service without the agent ever holding the user's session token.
resource: docs/runbooks/agent-layer.md
tags: [architecture, agents, langgraph, ag-ui, token-exchange]
timestamp: 2026-08-09T00:00:00+00:00
---

# AI Agents layer architecture (features 012/014/018/040/047)

This page covers the *architectural shape* of the AI Agents layer — the call chain, its security
boundary, and how per-user state and config are threaded through it. For the
[Agent Gateway](/openwiki/projects/agent-gateway.md) service itself (its MCP servers, tool-invocation
chokepoint, and env-scoped model provider), see that page. Both cite the same canonical source,
`docs/runbooks/agent-layer.md`; see also [System overview](/openwiki/architecture/system-overview.md) for
where the agent layer sits relative to `mc-service`.

## Call chain and security boundary

```
mcm-app (CopilotKit) → mcm-bff (secure proxy; sole OAuth2 client)
  → agent-gateway → supervisor → specialist agent → shared MCP client
  → [RFC 8693 token exchange → downscoped, aud=mc-service, short-TTL JWT]
  → movie-mcp → mc-service (RBAC + DAC unchanged) → mc-db
```

The defining design choice is **AG-UI-native**: the LangGraph runtime emits AG-UI events natively,
and `mcm-bff` hosts the CopilotKit runtime bridge (`CopilotRuntime` + the AG-UI `HttpAgent`, a
vendored `ExperimentalEmptyAdapter` — no LLM call or orchestration in the BFF) rather than a
hand-rolled per-event translation layer. The Agent Gateway and its `agent-db` (LangGraph checkpoint
store) are private-network only; only the BFF ever reaches them. See
[Auth chain](/openwiki/invariants/auth-chain.md) for how this fits the rest of the system's identity
flow.

## Token custody: why a "run-scoped delegation token", not the session token

The BFF never hands the gateway the user's actual session token. Instead:

1. At run handoff, the BFF performs its own OAuth2 Token Exchange (RFC 8693) to mint a **short-TTL,
   run-scoped, audience-narrowed** delegation token and passes that to the gateway as an ephemeral,
   non-checkpointed value.
2. At tool-call time, the gateway's **single shared, in-process MCP client** exchanges that token
   again for a **downscoped, `aud=mc-service`** token, attached only to that call.
3. A paused (HITL) run holds **no token at all** — only checkpointed graph state plus
   `userId`/`threadId`. Because every resume is itself an authenticated BFF request, the BFF always
   supplies a fresh subject token on resume, so pause duration never matters.

This is why raw tokens (subject or exchanged) must never be written to checkpointed state, traces,
or logs — the pause-robustness property depends on tokens never outliving a single active run
segment.

## Per-user agent config (feature 018): opt-in, bring-your-own-credentials

The assistant is **off by default** and shares no shared model or TMDB credentials. Each user opts
in from the Profile screen and supplies their own provider credential (Ollama base URL or an
Anthropic key) and TMDB key. These are AES-256-GCM-encrypted at rest in the BFF's own
`mcm-bff-db` (physically separate from `mc-db` — see
[Secrets management](/openwiki/invariants/secrets-management.md)) and decrypted only transiently, in
memory, per run — never returned to the client, logged, or persisted to a checkpoint. The
CopilotKit dock only mounts for a config that is actually runnable (enabled + provider credential +
TMDB key); an un-opted-in user cannot trigger a billable run.

## Conversation stages and generative UI (features 040/047)

Multi-turn flows (navigate, organize, import, add-with-ownership-question) park a `*_stage` value
on graph state so the *next* turn is guarded back into the owning node — otherwise a bare
follow-up answer ("yes", a bare collection name) gets re-classified as an unrelated intent and the
flow silently derails. Feature 047 extended the add flow into a chain: `awaiting_ownership` →
`awaiting_media` → `awaiting_ripped` → `awaiting_rip_quality` → proposal. Three distinct
generative-UI selection components exist; see `docs/runbooks/agent-layer.md` for the exact
node/tool/testID mapping before touching any of them:

| Tool | Component / testID | Used by |
|---|---|---|
| `render_selection` | `selection-options` | navigator `_clarify`, import picks, search scope, US4 ownership Yes/No |
| `render_disambiguation` | `disambiguation-options` | curator's ambiguous movie-candidate list only |
| `render_multi_select` (047) | `multi-select-options` | US4 media-format / rip-quality toggle lists |

## Observability and audit are opt-in Control Tower profiles

LangFuse, OTel/Grafana, OPA, and Unleash run under `--profile observability`; the OpenSearch audit
sink runs under its own, separate `--profile audit`. Every one of these is env-gated and no-op when
unconfigured — the agent layer must work in a plain dev environment with none of them running.

## Gotchas

- **A paused run's safety depends on tokens never being checkpointed.** If a future change adds any
  token value to `agent-db`-persisted state, it defeats the entire "pause length is irrelevant"
  design goal described above — treat any PR that touches checkpoint serialization as auth-review
  sensitive.
- **Stage-continuation guards must be paired with a state-reset.** Every `*_stage` guard
  (`search_stage`, `organize_stage`, `import_stage`, `navigate_stage`, `add_stage`) has a matching
  `_STATE_RESET` — a finished flow that skips its reset can leak stage state into a later, unrelated
  turn.
- **Adding a stage means updating BOTH `graph.py`'s guard AND `curator.py`'s passthrough set.** A
  stage-continuation guard keeps the turn in the flow, but the curator still runs first. It must
  PASS THROUGH for every ownership stage — otherwise a bare reply (`"yes"`, `"Selected: DVD"`)
  finds no movie, clears `candidate`, and drops the member mid-flow. Missing the curator passthrough
  produces a reset on exactly the turn you forgot.
- **An ANSWER to a pending question is never a new command.** The escape hatch "a clear new command
  leaves the flow" is only safe if the guard resolves the reply against the pending question
  **BEFORE** consulting the classified intent. Without that ordering a prose-like answer
  (`"Selected: none"`) classifies as `query`/`search` and the in-progress flow is silently
  discarded. **This bug is provider-dependent** — it passes on local Ollama and fails on Anthropic
  in CI; a green local run proves nothing. The import guard already has the safe shape; **`navigate_stage`
  does NOT** — check it before extending the navigate flow.
- **`render_selection` vs. `render_disambiguation` vs. `render_multi_select` — pick the right one.**
  The US4 ownership Yes/No and navigation collection-choice buttons are BOTH `render_selection`;
  `render_disambiguation` is *only* the curator's ambiguous movie-candidate list; `render_multi_select`
  is *only* the 047 media-format/rip-quality toggles. Picking the wrong selector silently matches
  nothing.
- **The import-handle indirection exists because checkpoint bloat timed out large imports.** A
  parsed spreadsheet is stashed once in spreadsheet-mcp's transient store and only the small opaque
  `import_handle` is checkpointed across clarification turns — re-serializing the whole parsed
  workbook per turn was the actual cause of a prior "it timed out" failure on large imports.
- **Vault is a foundational platform secret store, not part of the Control Tower**, and it holds
  only shared infrastructure secrets (the gateway's Keycloak OAuth client secret, the BFF's master
  encryption key) — never user, model-provider, or TMDB credentials, which are per-user by design
  (see the per-user config section above).
- **The generic degrade reply (`"Sorry — I couldn't complete that just now."`) has exactly two
  sources; the circuit breaker has exactly one input.** `_degrade_node` is reachable only through
  the supervisor's model call (classifier raised, or breaker already open). The other three degrade
  sites are specialist-model failures. `ErrorRateBreaker` is fed by exactly ONE signal:
  `circuit.record(...)` in the supervisor — a tool failure, MCP outage, or rate-limit breach records
  nothing. **An open breaker therefore always means the supervisor's model call is failing.** The
  navigator can neither emit this message nor raise; a generic reply on a navigate turn is never
  the navigator's.
- **A control gated on a stage is unreachable from the TERMINAL step of the flow it exits (050 /
  item #149).** The mirror image of the guard rule above, and it shipped to a member. 047 gave the
  web search card a Cancel button that posts the canonical `exit search`; the search node honoured
  that control under `if stage and …`. But the card is the flow's *last* step, and `_web_card`
  returns `_SEARCH_RESET` **before** rendering it — so by the time the button is on screen there is
  no stage, the guard is false by construction, and the value fell through to the fresh-search branch
  as a movie **title**. The member who pressed Cancel was answered with *"I couldn't find "exit
  search" in your "Wish List" collection. Want to look elsewhere?"* — plus a real `list_movies`
  read, a `render_selection` that re-offered the search, and `search_stage` left at
  `awaiting_pick`. It did not fail neutrally: it put the member back INSIDE the flow they were
  leaving, capturing their next message too.
  The trap is that "universal control" is ambiguous — comments asserted the node "already treats it
  as a universal control", which was true across *stages* and false at *no stage*. **Ask
  specifically: is this control offered anywhere the flow has already been cleared?** If yes, it
  cannot be stage-gated.
  Two rules fell out of the fix:
  - **A cancel is routed BEFORE `classifier(messages)` in `graph.py`**, not after — mirroring
    `is_cancel_import`. Not only because a model might classify it away (provider-dependent, exactly
    as the ownership-guard bug was), but because a classifier *exception* returns `degraded` before
    any routing runs at all: a provider outage would answer "get me out of here" with "Sorry — I
    couldn't complete that just now." An escape hatch that needs a healthy LLM is not an escape hatch.
  - **A stage-free route matches EXACTLY** (whole message, trimmed, case-folded) — never a
    substring, which would hijack a real title like *"How to Exit Search a Building"*, and never
    the bare synonyms (`cancel`, `never mind`), which belong just as much to the import and organize
    flows. Those stay scoped to a live stage, where the stage itself establishes intent.
- **A node-level test passing does NOT mean the graph-level path works.** Calling a node function
  directly bypasses every supervisor guard and every stage-continuation check. **If a change
  touches routing, a guard, or a `*_stage`, drive `build_graph(...)` — not the node.**
- **Writing a `build_runtime_graph(..., force=True)` test? Stub EVERY model seam, and assert the
  test reached its subject.** `RuntimeNodeConfig` carries three separate extraction seams:
  `extract` (curator/search), `plan` (organizer), and `query_extract` (query). Stubbing only
  `extract` leaves the other two on their real model-backed defaults, which raise and degrade the
  turn before any tool call — so the test passes while exercising nothing. Also set
  `spreadsheet_mcp_url` — without it the import/export nodes answer "isn't available right now"
  and never read anything.
- **Watch the SKIP COUNT, not just the pass count.** The agent integration tier silently skips
  whatever MCP server is down, and a skipped test reads as a pass. Run with
  `MCM_REQUIRE_LIVE_STACK=1` to escalate a non-allowlisted skip to a failure naming the unreachable
  server.

See `docs/runbooks/agent-layer.md` for the full node/intent table, the containerized E2E procedure and its
three durable gotchas (DNS-rebinding protection, missing MCP URLs, per-user rate limits), and the
complete observability/audit environment-variable reference.
