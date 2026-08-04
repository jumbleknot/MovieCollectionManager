---
type: Service
title: Agent Gateway (LangGraph)
description: The Python LangGraph supervisor graph that powers the MCM conversational assistant, served over AG-UI and reachable only from the BFF. Orchestrates tool calls to three scoped MCP servers; owns no domain data itself.
resource: docs/runbooks/agent-layer.md
tags: [langgraph, python, mcp, agent, ai]
timestamp: 2026-08-04T01:18:20+00:00
---

# Agent Gateway (LangGraph)

`agents/movie-assistant` is a LangGraph supervisor graph (compiled entrypoint `src/graph.py:graph`)
served over AG-UI via FastAPI (`src/gateway.py`). It is reachable only from the
[BFF](/openwiki/projects/bff.md)'s `bff-api/agent/*` routes — the gateway itself performs no
end-user authentication; the BFF is the security boundary in front of it. It owns no movie data; it
orchestrates calls to three scoped MCP servers on the user's behalf. The LLM is deliberately kept
narrow: it only classifies intent, extracts entities, and phrases replies — all MCP tool selection
and argument construction is code-orchestrated, never left to the model.

The [three scoped MCP servers](/openwiki/projects/mcp-servers.md), reached over the MCP streamable-HTTP transport:

- **movie-mcp** — fronts [mc-service](/openwiki/projects/mc-service.md) for domain reads/writes.
  Every call needs a per-call, per-user downscoped token (see
  [Auth chain](/openwiki/invariants/auth-chain.md)).
- **web-api-mcp** — outbound-only metadata enrichment (TMDB); carries no user JWT, but forwards a
  per-run API key out-of-band via a header set from a context variable — never an LLM-visible
  argument.
- **spreadsheet-mcp** — scoped, token-free file processing for import/export; files are referenced by
  an opaque transient-store handle, never LLM-chosen content.

Both `MOVIE_MCP_URL` and `WEB_API_MCP_URL` must be set for the gateway to compile the real,
tool-backed graph (`production_nodes_enabled`); `SPREADSHEET_MCP_URL` is optional and import/export
degrade gracefully without it. Every tool call funnels through one choke point
(`tools/mcp_tools.invoke_tool`): per-agent allowlist (deny-by-default) → rate limiting → identity/
token acquisition → the MCP call → output guardrail validation.

Multi-turn flows park a `*_stage` value on graph state so follow-up turns are guarded back into the
owning node. The add flow runs an ownership follow-up chain (`awaiting_ownership` →
`awaiting_media` → `awaiting_ripped` → `awaiting_rip_quality`) that collects every ownership
answer before building a single Proposal — the member approves one complete change, not a series
of edits. Media-format and rip-quality options are driven by a `get_movie_metadata` read from
movie-mcp (which publishes mc-service's `GET /api/v1/movie-metadata`), never hardcoded in the
agent. The generative-UI surface has three components: `render_selection` (collection/scope/
ownership Yes-No and search scope/cancel), `render_disambiguation` (curator's movie candidates),
and `render_multi_select` (media-format and rip-quality toggle lists in the ownership chain).

Model provider is environment-scoped: `MODEL_PROVIDER` selects `ollama` (dev/test default) or
`anthropic` (used for the golden-pair CI gate and production), with per-node overrides
(`SUPERVISOR_MODEL`, `SPECIALIST_MODEL`, `ESCALATION_MODEL`) and a hard-pinned Anthropic escalation
tier regardless of base provider. A per-run "bring-your-own-credentials" overlay lets an individual
user's request swap provider/credentials without touching the shared process env.

## Gotchas

- **DNS-rebinding protection breaks containerized MCP calls.** The MCP SDK 421-rejects a request
  whose `Host` header is a Docker service name (its default DNS-rebinding protection). Both
  movie-mcp and web-api-mcp set `TransportSecuritySettings(enable_dns_rebinding_protection=False)` —
  without it, the containerized agent stack never works end to end.
- **Missing either MCP URL degrades silently, not loudly.** If `MOVIE_MCP_URL` or `WEB_API_MCP_URL`
  is unset, the gateway compiles a tool-free graph instead of failing — there is no error, the
  assistant just can't do anything domain-related. Also rebuild the gateway image after any source
  change; a stale image running old code looks identical to a correctly-degraded tool-free graph.
- **OTel span exception recording can leak a credential.** `start_as_current_span(...)` defaults to
  recording the exception message and setting error status from it, which embeds `str(exc)` —
  including the TMDB API key riding along in the URL as a query param — into the exported trace on
  any web-api-mcp error. Any span wrapping credential-bearing I/O must explicitly disable exception
  recording.
- **Never trust a streamed "done" for agent writes in tests.** The completion message can arrive
  before the underlying mc-service write actually lands (the summary is generated ahead of the
  write). An agent-write E2E test must poll the resource, or teardown can race the still-in-flight
  write.
- **Switching model provider mid-run must drop stale per-node model pins.** Otherwise a node can end
  up requesting a model id that doesn't exist under the new provider and fail with a 404.
- **Adding a multi-turn stage requires updating BOTH `graph.py` and `curator.py`.** The stage guard
  in `graph.py` keeps the turn in the right flow, but `curator.py` must also pass through for every
  ownership stage — if it doesn't, a bare "yes" or "DVD" answer runs entity extraction, finds no
  movie, clears `candidate`, and drops the member back to "What movie would you like me to look
  up?" mid-flow. Feature 040 added the passthrough for `awaiting_ownership` only; feature 047 had
  to widen it for three more stages. Missing the curator half is silent until that specific turn.
- **Whitespace in a resolver key is a resolution bug, not cosmetic.** The import article-loop fix
  (feature 047) found that `_article_prompt` stored a raw cell value (including its trailing space)
  as the resolution key, while `resolve_option` matched with `title in low` — a substring test that
  a longer label can never pass. The rule that came out of it: normalise in the shared resolver
  (`resolve_option`), not the individual caller, AND trim at the source when a value is used as a
  dictionary key — a per-caller fix would have left the other three call sites (search, organize,
  navigate) with the same class of failure.
- **Media-format values must come from mc-service, never from a hardcoded agent-side list.**
  `mc-service` publishes `GET /api/v1/movie-metadata`; `movie-mcp` wraps it as
  `get_movie_metadata`; the organizer derives its toggle list from that response.
  `MediaFormat::all()` is an exhaustive `match` — adding a new variant fails to compile until it is
  published, so the list cannot silently rot. A hardcoded `const` array in the agent compiles
  happily and drifts; a per-request process-wide cache is safe only because this response contains
  no user data.

See [Auth chain](/openwiki/invariants/auth-chain.md) for how the gateway's tool-call tokens are
minted and scoped, and `docs/runbooks/agent-layer.md` for the full node/intent map, the containerized E2E
procedure, and the observability (Control Tower) integration.
