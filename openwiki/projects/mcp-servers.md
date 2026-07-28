---
type: Service
title: The three scoped MCP servers
description: The three purpose-scoped MCP (Model Context Protocol) servers the Agent Gateway calls as tools — movie-mcp (mc-service proxy), web-api-mcp (outbound TMDB enrichment), and spreadsheet-mcp (file processing) — each with a deliberately narrow identity/network footprint.
resource: docs/MCM-Architecture.md
tags: [mcp, agents, python, fastmcp, scoped-capability]
timestamp: 2026-06-20T21:57:08-04:00
---

# The three scoped MCP servers

`mcp-servers/movie-mcp`, `mcp-servers/web-api-mcp`, and `mcp-servers/spreadsheet-mcp` are stateless,
streamable-HTTP `FastMCP` servers that the [Agent Gateway](/openwiki/projects/agent-gateway.md) calls
as tools. Each server is scoped to exactly one capability and one trust boundary, on purpose — the
design goal is that a compromised or buggy server can only do the one narrow thing it was built for,
never pivot into domain data it wasn't given a route to.

| Server | Purpose | Identity / network footprint |
|---|---|---|
| **movie-mcp** | Thin proxy over [mc-service](/openwiki/projects/mc-service.md)'s REST API — no domain logic of its own, forwards mc-service's shapes and errors verbatim | Carries the caller's own downscoped `aud=mc-service` JWT (see [Auth chain](/openwiki/invariants/auth-chain.md)); reaches mc-service over the backend-only network; never published to clients |
| **web-api-mcp** | Outbound TMDB metadata enrichment (title search, movie details) for the curator flow | Outbound-only — no backend network, no user JWT; the TMDB key is server-side config, never an LLM-visible argument |
| **spreadsheet-mcp** | File processing only: parses an uploaded CSV/`.xlsx` into structured tabs, and builds an export `.xlsx` | Token-free; touches only a transient, single-use Redis handle — no user JWT, no domain network call, never persists a file |

All three run as separate Docker images (`infrastructure-as-code/docker/{movie-mcp,web-api-mcp,
spreadsheet-mcp}/`) and are exercised through Nx (`pnpm nx test:integration <server>`,
`pnpm nx lint <server>` → ruff + mypy, `pnpm nx build <server>` → Docker image). Tool contracts are
pinned per server under `specs/012-multi-agent-mvp/contracts/` and
`specs/014-spreadsheet-import-export/contracts/`.

## Gotchas

- **The identity model is per-server, not uniform.** movie-mcp requires a live per-call user token;
  web-api-mcp and spreadsheet-mcp are deliberately identity-free. Don't assume a shared auth pattern
  when adding a fourth server — decide identity scope from what the server actually touches.
- **DNS-rebinding protection breaks containerized calls unless explicitly disabled.** The MCP SDK
  421-rejects a request whose `Host` header is a Docker service name by default. Both movie-mcp and
  web-api-mcp set `TransportSecuritySettings(enable_dns_rebinding_protection=False)` — omitting it on
  a new server silently breaks every containerized agent flow, not just some of them. See
  [OTel span exception leak](/openwiki/gotchas/otel-span-exception-leak.md) for a related transport
  gotcha specific to web-api-mcp.
- **None of the three servers log at the application level, by design.** This is what the SC-004
  token-leak scan verifies against — movie-mcp's captured JWT and any credential must never reach a
  log line. Adding application logging to any of these servers reopens that leak surface.
- **spreadsheet-mcp never sees a user JWT and never persists a file** — uploads/downloads are
  referenced only by an opaque, short-TTL Redis handle (`import:file:<handle>` /
  `export:file:<handle>`), never by LLM-chosen content or a path. Don't widen its tool signatures to
  accept a raw file path or a JWT "for convenience" — that collapses the scoping this server exists
  to enforce.
- **Rebuild the affected image after any server-source change** — a stale container looks
  indistinguishable from a correctly-degraded tool-free graph on the gateway side (see
  [Agent Gateway](/openwiki/projects/agent-gateway.md) gotchas).

See [Agent Gateway](/openwiki/projects/agent-gateway.md) for how tool calls are dispatched to these
servers (the allowlist → rate-limit → identity → call → guardrail choke point), and
`docs/MCM-Architecture.md`'s "MCP Servers" section plus each server's own README
(`mcp-servers/movie-mcp/README.md`, `mcp-servers/web-api-mcp/README.md`,
`mcp-servers/spreadsheet-mcp/README.md`) for the full tool signatures and environment reference.
