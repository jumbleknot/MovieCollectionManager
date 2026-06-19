# Contract: Per-Run Config Channel (BFF → Gateway → Nodes/MCP)

Defines how a user's decrypted credentials reach the running graph for exactly one run, without ever being persisted or logged. Reuses the existing identity-bridge mechanism (subject token / UI snapshot).

## Hop 1 — BFF `run+api.ts` → Gateway (`X-Agent-Config` header)

After `requireMcUser`, `run+api.ts`:
1. Resolves the caller's config via `agent-config-service.resolveForRun(userId)`:
   - Reads the Mongo doc; if **not runnable** (not `enabled`, or missing required provider cred, or missing `tmdbKey`) → respond `200` with typed body `{ type: "assistant_not_configured" }` (or 409) and **return before any gateway call / cost accrual** (FR-002, SC-001/002).
   - Else decrypts the needed secrets in memory and returns the per-run config object.
2. Applies the per-user cost ceiling: `enforceAgentCostCeiling(userId, config.costLimitUsd ?? undefined)` (R7).
3. Passes the per-run config to `createMovieAssistantAgent({ subjectToken, uiSnapshot, importFile, agentConfig })`, which serializes `agentConfig` to the `X-Agent-Config` request header (JSON).

`X-Agent-Config` JSON payload:
```jsonc
{ "provider": "anthropic", "ollamaBaseUrl": null, "anthropicKey": "…", "tmdbKey": "…" }
```

**Leak rules**: this header value must never be logged by the BFF (redaction list extended — FR-024) and never echoed in any response.

## Hop 2 — Gateway middleware → ContextVar → `config["configurable"]`

- New `AgentConfigMiddleware` (pure ASGI, mirroring `SubjectTokenMiddleware`) reads `X-Agent-Config`, parses it, and sets a request-local ContextVar in `runtime_context.py`. Pure-ASGI (not Starlette `BaseHTTPMiddleware`) for task-safe propagation.
- `IdentityAwareAGUIAgent.prepare_stream` calls new `inject_agent_config(config, cfg)` → places values under `config["configurable"]`:
  - `model_provider`, `ollama_base_url`, `anthropic_api_key`, `tmdb_api_key`.
- No-op when the header is absent (preserves SC-005 additivity for any non-user-facing path).

## Hop 3a — Nodes: model build from `configurable`

At each `build_chat_model`/`select_model_config` call site in `runtime_nodes.py`, assemble the `env`-shaped mapping from `configurable` (provider, base URL, key, model names) **instead of `os.environ`** for the user-facing runtime. The **pure** `select_model_config(node, env)` / `build_chat_model(spec, env)` signatures are unchanged — only the mapping source changes. Escalation tier remains forced to Anthropic; if no `anthropic_api_key` is present in the per-run config, escalation degrades to the base provider (R10), never erroring.

**Golden harness unaffected**: `test_golden_pairs.py` keeps calling the pure functions with its own `env` dict (forces `anthropic`, pops Ollama overrides) — see research R8.

## Hop 3b — `web-api-mcp`: TMDB key from per-request header

- The gateway attaches the user's TMDB key as `X-TMDB-Key` on the MCP streamable-HTTP requests to `web-api-mcp` for that run.
- `web-api-mcp/src/server.py` reads `X-TMDB-Key` per request into a ContextVar; `_tmdb_key()` returns the ContextVar value. The env/Vault TMDB path is **removed from the user-facing runtime** (FR-021).
- The key is never placed in tool arguments (stays out of tool-call traces/args).

## Invariants (apply to every hop)

- **In-memory, per-run only** (FR-020/022): the plaintext provider key and TMDB key exist only for the run's duration; never written to checkpoints, agent Postgres state, OTel spans, LangFuse traces, or logs.
- **Static enforcement**: `state.forbid_token_fields` markers and `token_leak_scan.py` extended to cover `anthropic_api_key` / `tmdb_api_key` / `agent_config`.
- **No new endpoint**: everything rides the existing `/run` request and the existing MCP transport.
