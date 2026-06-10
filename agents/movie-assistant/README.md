# movie-assistant — Agent Gateway (feature 012)

The conversational assistant's orchestration runtime: a **LangGraph** supervisor graph served
over **AG-UI** (FastAPI + `ag_ui_langgraph`). It is an **additive** layer — it owns no domain
data and never bypasses the existing access controls; every write is human-approved and executed
as the user's own downscoped identity.

**Spec is the source of truth:** [`specs/012-multi-agent-mvp/`](../../specs/012-multi-agent-mvp/)
— `spec.md` (FRs/SCs), `plan.md`, `research.md` (R1–R15), `tasks.md`, `contracts/`. Read
`HANDOFF.md` first for current state.

## Pipeline

```
CopilotKit dock → BFF /bff-api/agent/run (mints a run-scoped RFC 8693 subject token)
  → AG-UI gateway (this project) → supervisor.classify_intent (LLM, routing only)
  → curator (enrich via web-api-mcp/TMDB) → organizer (resolve target, build Proposal)
  → approval_gate (HITL interrupt) → approve → resume (fresh token) → movie-mcp → mc-service
```

**Code-orchestrated tools (key decision):** the LLM only *extracts entities / plans* (typed
structured output) and phrases replies — it never selects MCP tools or forges write args. Code
drives every MCP call through the single `tools/mcp_tools.invoke_tool` choke point (allowlist →
rate-limit → identity → guardrails). Generative UI (`render_*`) is the only LLM-emitted tool
surface, rendered client-side.

## Layout (`src/`)

| Path | Role |
|---|---|
| `graph.py` | Compiled supervisor graph + `GraphState`; routing, HITL interrupt/resume, kill-switch + degrade nodes |
| `runtime_nodes.py` | Production node factory (real MCP-backed curator/organizer/approval_gate); gateway-gated |
| `nodes/` | `supervisor` (intent), `curator` (enrich), `organizer` (target + Proposal), `approval_gate` (HITL apply) |
| `tools/` | `mcp_tools.invoke_tool` (choke point), `identity`/`token_exchange`/`opa` (RFC 8693 downscoping), `agent_rate_limit` |
| `guardrails/` | NeMo Colang rails + Pydantic/PII output validators (T019) |
| `proposals.py` / `state.py` | Proposal model + deterministic idempotency keys; checkpoint no-token invariant |
| `agui_identity.py` / `runtime_context.py` | Subject-token + `ui_snapshot` bridge (header → ContextVar → `config["configurable"]`) |
| `session_expiry.py` / `kill_switch.py` | Session-end proposal sweep (FR-008); kill switch (FR-019) |
| `eval/` | Golden-pair cassette harness (`cassette.py`) + SC-004 token-leak scanner (`token_leak_scan.py`) |

Tool schemas + per-agent allowlists: `contracts/movie-mcp-tools.md`,
`contracts/web-api-mcp-tools.md`, `contracts/generative-ui-and-actions.md`.

## Models (env-scoped — research R1)

Dev/test iterate on **Ollama** (`qwen2.5` / `qwen2.5:32b`); the golden-pair gate + **production**
run on **Anthropic Claude** (`MODEL_PROVIDER=anthropic`: supervisor→haiku, specialists→sonnet,
escalation→opus). Switch is env-only (`src/models.py`). Config: `.env.local` (gitignored) — see
`.env.local.example` for `MODEL_PROVIDER`, `OLLAMA_BASE_URL`, model ids, `KEYCLOAK_*`,
`AGENT_GATEWAY_CLIENT_*`, `AGENT_KILL_SWITCH`, etc.

## Commands (Nx — run from repo root)

```bash
pnpm nx test movie-assistant                 # unit tests (incl. the SC-004 token-leak scan)
pnpm nx test movie-assistant -- -m leak_scan # the token-leak scan in isolation
pnpm nx test:integration movie-assistant     # integration vs REAL deps (Keycloak/MCP/mc-service/Ollama); skips if absent
LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant   # golden gate, keyless (CI)
LLM_CASSETTE_MODE=record pnpm nx test:golden movie-assistant   # re-record vs Claude (needs ANTHROPIC_API_KEY)
pnpm nx lint movie-assistant                 # ruff + mypy
pnpm nx build movie-assistant                # agent-gateway Docker image
```

CI: `.github/workflows/agent-gates.yml` runs lint + unit (leak-scan) + golden replay on every
push/PR touching the agent or MCP source.

## Control Tower (OPA / Unleash / OpenSearch)

All three are **env-gated and additive** (SC-005) — no-op when their env vars are unset. Never part
of the default dev stack.

| Service | Profile | Port | Purpose | Env vars |
| --- | --- | --- | --- | --- |
| **OPA** | `--profile observability` | `:8181` | Agent authz via Rego (token-exchange + ui-action) | `OPA_URL` |
| **Unleash** | `--profile observability` | `:4242` | Feature flags: kill-switch / frontier-escalation / degrade (all default-off) | `UNLEASH_URL`, `UNLEASH_API_TOKEN` |
| **OpenSearch** | `--profile audit` | `:9200` (HTTPS, self-signed) | Append-only agent audit sink (`mcm-agent-audit` index) | `OPENSEARCH_URL`, `OPENSEARCH_USERNAME`, `OPENSEARCH_PASSWORD` |

**OPA** — when `OPA_URL` is set, the gateway's token-exchange authz and the BFF's ui-action authz
evaluate against Rego policies in `infrastructure-as-code/opa/policies/` (`agent_token_exchange.rego`,
`agent_ui_action.rego`). When unset, those paths fall back to allow / the TypeScript authorizer.

**Unleash** — when `UNLEASH_URL` is set, the gateway reads flags from the Unleash server. When unset,
it falls back to the env flags (`AGENT_KILL_SWITCH`, `AGENT_DEGRADE`, etc.). Dev client token:
`default:development.mcm-dev-unleash-client-token`. SDK URL = base + `/api` (e.g.
`http://localhost:4242/api`).

**OpenSearch** — `--profile audit` is a separate profile (NOT `--profile observability`). First-time
setup:

```bash
docker volume create opensearch-data
docker compose --profile audit up -d
bash infrastructure-as-code/docker/opensearch/init-audit-user.sh
```

The `init-audit-user.sh` script creates the write-only `agent-audit` role and user idempotently
(can index, cannot read/delete). **Heap is pinned to 1 GB** via `OPENSEARCH_JAVA_OPTS=-Xms1g -Xmx1g`
in the compose file — required to prevent the 4 GB default from OOM-killing the container on a dev
box. When `OPENSEARCH_URL` is unset, the Python `src/audit_sink.py` and BFF `audit-sink.ts` log
audit events only (no OpenSearch write).

See `.env.local.example` for all vars.

## Run locally (host gateway, production nodes)

Bring up the agent stack per `HANDOFF.md` ("How to bring the agent stack up"): movie-mcp `:8766`
+ web-api-mcp `:8765` + the host gateway on `127.0.0.1:8123` with `WEB_API_MCP_URL`+`MOVIE_MCP_URL`
set (production nodes) + Ollama + Keycloak/Redis/mc-service. The gateway is **private-network only**
— reachable solely from the BFF (the security boundary).
