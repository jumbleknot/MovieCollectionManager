---
type: Architecture
title: AI Agents layer architecture (features 012/014/018/040)
description: The call chain, token-custody model, and per-user config design for MCM's additive conversational assistant — how identity flows from mcm-app through the BFF and Agent Gateway to mc-service without the agent ever holding the user's session token.
resource: docs/runbooks/agent-layer.md
tags: [architecture, agents, langgraph, ag-ui, token-exchange]
timestamp: 2026-08-03T01:06:06+00:00
---

# AI Agents layer architecture (features 012/014/018/040)

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

## Conversation stages and generative UI (feature 040)

Multi-turn flows (navigate, organize, import, add-with-ownership-question) park a `*_stage` value
on graph state so the *next* turn is guarded back into the owning node — otherwise a bare
follow-up answer ("yes", a bare collection name) gets re-classified as an unrelated intent and the
flow silently derails. Two distinct generative-UI selection components exist
(`render_selection` vs. `render_disambiguation`) and are easy to swap by mistake; see
`docs/runbooks/agent-layer.md` for the exact node/tool/testID mapping before touching either.

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
- **`render_selection` vs. `render_disambiguation` is a real trap for anyone writing agent E2E
  tests.** The US4 ownership Yes/No and navigation collection-choice buttons are BOTH
  `render_selection` (kind `control`/`movie`/`collection`); `render_disambiguation` is *only* the
  curator's ambiguous movie-candidate list. Picking the wrong selector silently matches nothing.
- **The import-handle indirection exists because checkpoint bloat timed out large imports.** A
  parsed spreadsheet is stashed once in spreadsheet-mcp's transient store and only the small opaque
  `import_handle` is checkpointed across clarification turns — re-serializing the whole parsed
  workbook per turn was the actual cause of a prior "it timed out" failure on large imports.
- **Vault is a foundational platform secret store, not part of the Control Tower**, and it holds
  only shared infrastructure secrets (the gateway's Keycloak OAuth client secret, the BFF's master
  encryption key) — never user, model-provider, or TMDB credentials, which are per-user by design
  (see the per-user config section above).

See `docs/runbooks/agent-layer.md` for the full node/intent table, the containerized E2E procedure and its
three durable gotchas (DNS-rebinding protection, missing MCP URLs, per-user rate limits), and the
complete observability/audit environment-variable reference.
