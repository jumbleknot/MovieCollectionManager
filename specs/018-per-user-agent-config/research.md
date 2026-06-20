# Phase 0 Research: Per-User Movie Assistant Configuration

All technical unknowns below are resolved; no `NEEDS CLARIFICATION` remains. Each decision records what was chosen, why, and the alternatives rejected.

## R1 — Storage placement (PRD open question #4)

**Decision**: A new MongoDB collection `user_agent_config`, accessed by the BFF through a new, BFF-owned Mongo connection (`src/bff-server/mongo-client.ts`). One document per user, `_id = <keycloak userId>`.

> **⚠️ REVISED (implementation-review, 2026-06-19)**: the original decision placed the collection in **mc-service's existing `mc_db` instance**. That is **direct database access across a service boundary** — a constitution §Decoupling violation ("avoid direct database access across service boundaries") — and couples the BFF's deploy/scaling to a backend service's database. **Corrected** to a **dedicated, BFF-owned `mcm-bff-db` instance** (the "Separate BFF-owned database" alternative below, which was wrongly rejected for "operational overhead"). It is a plain standalone `mongod` (single-doc upserts only — no replica set), mirroring the BFF's already-separate Redis. The "only the connection string changes" escape hatch noted in the rejected alternative is exactly what was used. See plan.md §Storage + tasks.md Phase 12.

**Rationale**:
- **Durability** — per-user credentials are permanent settings, not session-TTL data; Redis (the BFF's only store today) has no first-class durability and would conflate the two concerns.
- **Custody belongs in the BFF** — the BFF-Layer principle explicitly assigns "securely store sensitive information like API keys" to the BFF. Storing credentials here is *not* movie-domain logic, so the No-Domain-Logic-in-Frontend rule is not engaged.
- **No hot-path hop** — the run path already executes in the BFF; resolving config is one local Mongo read + in-memory decrypt, vs. a network round-trip if mc-service owned it.
- **Reuse infra** — `mc_db` is already running with a replica set; no new container.

**Alternatives rejected**:
- *mc-service (Rust) owns it* — leaks credential custody into a movie-domain service, adds a hop on every run, and would require the agent's TMDB/model keys to traverse a domain service that has no business seeing them.
- *Redis with no TTL* — possible but abuses a cache as a system-of-record; backup/restore and durability guarantees are weaker.
- *Separate BFF-owned database* — viable for stricter isolation, but a dedicated collection + scoped credentials in the existing instance gives the same least-privilege boundary with less operational overhead. (If stricter isolation is later required, only the connection string changes.)

## R2 — Encryption scheme

**Decision**: **AES-256-GCM** via Node's built-in `crypto` (`createCipheriv('aes-256-gcm', key, iv)`). Per-secret random 12-byte IV; store `iv || authTag || ciphertext` (base64) in the `*Enc` fields. Master key from `AGENT_CONFIG_ENC_KEY` (32 bytes), resolved from **Vault in prod / gitignored env in dev**. Decrypt only transiently in the BFF (FR-013 test, FR-020 per-run mint).

**Rationale**: Authenticated encryption (tamper-evident); no new dependency; key managed separately from the data store (satisfies "Encryption at Rest" + KMS-separation). GCM auth tag detects corruption/tampering on read.

**Alternatives rejected**: `libsodium`/`tweetnacl` (extra dependency for no gain over built-in AES-256-GCM); AES-CBC (no integrity, needs separate HMAC); envelope encryption with per-record DEKs (justified only when key rotation is in scope — it is a deferred follow-up per the spec assumption, so a single master key is sufficient now and the schema leaves room to add a `keyId` later).

## R3 — Live validation probes (FR-012/FR-013, ≤5s — SC-008)

**Decision**: One probe per credential being set/tested, each with a **5-second timeout** (`AbortController`), returning a per-field `{ field, status: 'ok' | { reason } }`:
- **Ollama** → `GET {ollamaBaseUrl}/api/tags` — 200 ⇒ reachable; connection error/non-200 ⇒ fail with a safe reason.
- **Anthropic** → a cheap authenticated call: `GET https://api.anthropic.com/v1/models` with `x-api-key` + `anthropic-version` — 200 ⇒ valid; 401 ⇒ "invalid key"; other ⇒ safe reason. (Avoids spending tokens vs. a `messages` call.)
- **TMDB** → `GET https://api.themoviedb.org/3/authentication` with the v3 key — 200 ⇒ valid; 401 ⇒ "invalid key".

**Rationale**: Cheapest authenticated endpoints that prove the credential works; bounded latency keeps save responsive and gives E2E a deterministic assertion. Failures map to per-field 422 (FR-012); nothing persists on any failure.

**Alternatives rejected**: Anthropic `messages` probe (costs tokens); skipping probes and validating lazily at run time (defeats the whole "tell me immediately" requirement). Probe responses are normalized to safe reasons — raw provider error bodies are never forwarded (Safe Error Responses).

## R4 — Per-run credential injection path (FR-016 spec → FR-020/021/022)

**Decision**: Reuse the **existing header → pure-ASGI-middleware → ContextVar → `config["configurable"]`** bridge. Add:
- BFF: `agent-gateway-client.ts` serializes the resolved (decrypted) per-run config to a new **`X-Agent-Config`** request header (JSON: `{ provider, ollamaBaseUrl?, anthropicKey?, tmdbKey, models? }`).
- Gateway: a new `AgentConfigMiddleware` (mirroring `SubjectTokenMiddleware`) captures the header into a request-local ContextVar in `runtime_context.py`; `IdentityAwareAGUIAgent.prepare_stream` calls a new `inject_agent_config(config, cfg)` to place it under `config["configurable"]` (e.g., `model_provider`, `ollama_base_url`, `anthropic_api_key`, `tmdb_api_key`, model-name overrides if any).
- Nodes: at the `select_model_config` / `build_chat_model` call sites, build the `env`-shaped mapping from `configurable` (falling back to nothing for user-facing runtime) instead of `os.environ`.

**Rationale**: This is the same task-safe mechanism proven for the subject token and UI snapshot (avoids Starlette `BaseHTTPMiddleware` task-leak pitfalls). No new gateway endpoint. The secret rides the request only, never the graph state.

**Alternatives rejected**: A new gateway endpoint (unnecessary; the run already carries per-run context); putting credentials in the run **body** (would be checkpointed — forbidden by SC-004 and the `state.forbid_token_fields` guard).

**Leak-safety**: `X-Agent-Config` values must never be written to checkpoints, `state`, OTel spans, LangFuse traces, or logs. The existing `state.forbid_token_fields` markers and the static `token_leak_scan.py` are extended to cover `anthropic_api_key` / `tmdb_api_key` / `agent_config`. The redaction list in `logger.ts` is extended on the BFF side (FR-024).

## R5 — TMDB key delivery to `web-api-mcp` (the cross-process subtlety)

**Decision**: The gateway, when constructing/using the MCP client for `web-api-mcp` on a per-run basis, attaches the user's TMDB key as a **transport request header** (e.g., `X-TMDB-Key`) on the streamable-HTTP MCP calls. `web-api-mcp/src/server.py` reads it **per request into a ContextVar**; `_tmdb_key()` returns the ContextVar value, with the **env/Vault path removed from the user-facing runtime** (FR-021). DNS-rebinding protection stays disabled (private Docker network, established in 012).

**Rationale**: Keeps the key out of tool arguments (so it never lands in tool-call traces/args), consistent with how the gateway already passes identity. The MCP server stays stateless per request.

**Alternatives rejected**: Passing the key as a tool argument (leaks into tool-call logs/traces); a global per-process key (the very thing being removed); minting yet another token (overkill — TMDB has no token-exchange).

**Open sub-point handled**: prior art (`project_mcm_containerized_agent_stack`) notes the MCP SDK rejects Docker service-name `Host` headers unless `enable_dns_rebinding_protection=False` — already set, so a custom `X-TMDB-Key` header is fine.

## R6 — Default-off gating (FR-001/002) on dock + run

**Decision**: Two enforcement points (defense in depth):
1. **UI gate** — a new `use-assistant-config` hook GETs `/bff-api/agent/config`; `AuthedAssistant` in `(app)/_layout.tsx` mounts the dock only when `enabled === true && hasRequiredProviderCred && hasTmdbKey`. New/disabled/under-configured users see no dock.
2. **Server gate** — `run+api.ts`, after `requireMcUser`, resolves the config and **short-circuits with a typed `assistant_not_configured` response before any gateway call or cost accrual** if not runnable (enabled + provider cred + TMDB key all present). This is authoritative; the UI gate is a UX convenience.

**Rationale**: The server gate guarantees SC-001/SC-002 (zero external calls, zero cost) even if a client bypasses the UI. The presence flags from GET drive both the dock and the form's "configured" indicators without exposing secrets.

**Alternatives rejected**: UI-only gate (a crafted request could still trigger a run/cost); a new "is-runnable" endpoint (the GET non-secret view already carries the needed `enabled` + `has*` flags).

## R7 — Per-user cost ceiling (FR-007, SC-005)

**Decision**: `enforceAgentCostCeiling(userId, ceilingOverrideUsd?)` accepts an optional per-user ceiling. `run+api.ts` passes `config.costLimitUsd ?? undefined`; when `undefined`, the existing `env.agentSessionCostCeilingUsd` default applies unchanged. The Redis accrual key (`agent-cost:{userId}`) and window are unchanged — only the compared ceiling differs.

**Rationale**: Minimal change to a proven mechanism; behavior is identical for users who never set a limit (SC-005). `costLimitUsd` is non-secret and returned by GET.

**Alternatives rejected**: A new per-user budget subsystem (the existing per-user accrual already exists); storing the limit in Redis (it's durable config — belongs in the Mongo document with the rest).

## R8 — Test / golden-cassette harness rework (spec §8, NFR-Sec-1/2/4)

**Decision**:
- **Unit/integration & E2E** — seed the test user's `user_agent_config` row (`provider=ollama` + a TMDB key) from `process.env`/CI secrets at runtime (no key text in any committed artifact).
- **Golden/cassette gate** — unchanged at the `build_chat_model` seam: the runner still forces `MODEL_PROVIDER=anthropic` and pops Ollama overrides by passing an `env`-shaped dict directly to the **pure** `select_model_config`/`build_chat_model`. Because per-run injection only changes the *call site* mapping (configurable vs `os.environ`) and the pure functions keep their `env: Mapping` parameter, the golden harness needs no structural change. Replay stays keyless; cassettes assert no `authorization`/`x-api-key`/key values (NFR-Sec-4).
- **CI secret-scan guard** — a build step greps for key-shaped patterns (`sk-ant-…`, TMDB v3 token shapes) across committed files and fails on a hit (FR-025).

**Rationale**: Preserves the drift-proof golden gate while removing shared-env from the *runtime* path. The pure-function `env` parameter is the seam that lets both the per-run path and the golden harness coexist.

**Alternatives rejected**: Rewriting `select_model_config` to read `configurable` directly (would couple the pure function to LangGraph and break the golden harness's direct calls).

## R9 — Provider switch & clear semantics (from Clarifications)

**Decision** (encodes the session clarifications):
- **Provider switch retains the other provider's stored secret** — switching `provider` only changes the active base provider; a stored `anthropicKeyEnc` is kept so an Ollama user retains escalation (FR-008). The non-active provider's secret is simply unused for the base tier.
- **Clear = disable + wipe secrets, keep non-secret settings** — `DELETE /config` sets `enabled=false`, removes `anthropicKeyEnc`/`tmdbKeyEnc`, and preserves `provider`, `ollamaBaseUrl`, `costLimitUsd`. Re-enabling later requires only re-supplying secrets.

**Rationale**: Matches user expectations recorded in clarification (no forced full reconfigure; escalation key survives a base-provider switch).

## R10 — Escalation availability surfacing (FR-008, PRD open question #2)

**Decision**: The config form derives escalation availability from presence of the Anthropic key: if `provider=ollama` and no Anthropic key is on file, show a non-blocking note ("Escalation to the most capable model needs an Anthropic key — add one to enable it"). The graph already forces the escalation tier to Anthropic; when no Anthropic credential is present in the per-run config, escalation degrades to the base provider rather than erroring (handled in `models.py`/node selection).

**Rationale**: Surfaces the limitation (spec requirement) without blocking Ollama-only use. Exact wording is a UI detail finalized in implementation; the behavior contract is fixed here.
