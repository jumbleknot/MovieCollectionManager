# Quickstart: Multi-Agent Conversational Assistant (Phase 1 MVP)

**Feature**: `012-multi-agent-mvp` | Local dev + test loop for the additive AI Agents layer. PowerShell is the default shell (bash also available).

> The agent layer is **additive**. The existing Metro / BFF / `mc-service` / Keycloak / Redis / Mongo loop (CLAUDE.md) is unchanged and is the prerequisite substrate. Start that first.

---

## One-time setup (per machine)

Add the new isolated agent-state volume to the existing volume-create list:

```powershell
docker volume create agent-db-data
```

### Ollama (dev/test model provider) — one-time setup

Ollama is the `MODEL_PROVIDER` for **dev / test / iterative E2E** (research R1, revised 2026-06-07 — the golden-pair suite + production run on Anthropic Claude). For local agent work it must be running before the agent gateway starts. Install once, pull the tiered models, and start the server.

```powershell
# 1. Install Ollama (Windows installer) — or `winget install Ollama.Ollama`
#    macOS/Linux: `curl -fsSL https://ollama.com/install.sh | sh`
# 2. Start the server (listens on 127.0.0.1:11434). The Windows app autostarts it;
#    to run explicitly:
ollama serve
# 3. Pull the tiered models (IDs match the .env.local model vars below):
ollama pull qwen2.5          # supervisor (fast/routing)
ollama pull qwen2.5:32b      # curator/organizer (planning + tool-calling)
# (llama3.3:70b is an alternative specialist model if you have the VRAM)
# 4. Verify it answers:
ollama run qwen2.5 "reply OK"
```

Notes:

- **Hardware:** `qwen2.5` (7B) runs on modest hardware; `qwen2.5:32b` needs a capable GPU (~20 GB VRAM) or it will be slow on CPU. If your dev machine can't host the 32b specialist, set `SPECIALIST_MODEL=qwen2.5` (smaller, less reliable tool-calling) for wiring — quality is validated by the golden-pair suite on Claude (the prod provider), not by the dev Ollama model.
- **Tool-calling:** pick models that support tool/function calling (the `qwen2.5` family and `llama3.3` do) — the agents depend on it.
- **Python dependency:** `langchain-ollama` is declared in `agents/movie-assistant/pyproject.toml` (managed by `uv`); `src/models.py` builds `ChatOllama(base_url=OLLAMA_BASE_URL, model=…)` when `MODEL_PROVIDER=ollama`.
- **Reachability:** the agent gateway runs in Docker, so its `OLLAMA_BASE_URL` must reach the host Ollama — use `http://host.docker.internal:11434` from the container (host-run dev BFF/tests use `http://localhost:11434`). Containerizing Ollama instead is optional; if you do, attach it to `backend-network` and point `OLLAMA_BASE_URL` at the service name.

Secrets (Vault-injected in deployed envs; local `.env.local` for dev):

- `agents/movie-assistant/.env.local` — `AGENT_DB_URL`, `KEYCLOAK_URL`, `KEYCLOAK_REALM=jumbleknot`, gateway confidential-client id/secret (token exchange), `LANGFUSE_*`, model provider + IDs/tiers (`MODEL_PROVIDER` [default `ollama`], `OLLAMA_BASE_URL`, `SUPERVISOR_MODEL`, `SPECIALIST_MODEL`, `ESCALATION_MODEL`; `ANTHROPIC_API_KEY` only when falling back to Claude — see "Model provider per environment" below), `UNLEASH_*`, `OPA_URL`, `OPENSEARCH_URL`.
- `mcp-servers/web-api-mcp/.env.local` — `TMDB_API_KEY` (outbound only).
- `frontend/mcm-app/.env.local` — agent BFF additions: `AGENT_GATEWAY_URL` (mode-dependent — see below), `KEYCLOAK_URL` (mode-dependent — reuses the existing BFF value), per-user agent rate-limit + cost-ceiling thresholds, subject-token client id/secret.

> `.env` files: no inline comments on value lines (CLAUDE.md).

Keycloak (one-time, **mode-independent** — covers both Metro and container): enable **standard token exchange** in the `jumbleknot` realm; register the Agent Gateway as a **confidential** requester client; add an `mc-service`-audience client with a short exchanged-token TTL (≤60 s). See research R3.

### Model provider per environment (cost control)

The model layer is provider-abstracted (research R1), so the **provider is an env switch — no code change**. The Anthropic Messages API is billed per-token from the Console and is **separate from any Claude Max subscription** (Max is not a programmatic backend). To avoid per-token spend on high-volume dev/test loops:

| Environment | `.env.local` | Notes |
|---|---|---|
| Local dev / iteration | `MODEL_PROVIDER=ollama`, `OLLAMA_BASE_URL=http://localhost:11434`, models e.g. `qwen2.5` | $0 per call; run `ollama serve` + `ollama pull qwen2.5` first. Pick a tool-calling-capable model. |
| CI (most runs) | recorded-response/cassette mode (no live calls) | Deterministic + free; also removes LLM nondeterminism from flaky-vs-broken diagnosis. |
| Golden-pair regression + pre-merge | **`MODEL_PROVIDER=anthropic`** + tiered Claude (`ANTHROPIC_API_KEY`) | Gate must mirror prod — it runs Claude, the shipped model. |
| Production | **`MODEL_PROVIDER=anthropic`** + tiered Claude (`claude-haiku-4-5`/`claude-sonnet-4-6`/`claude-opus-4-8`; `ANTHROPIC_API_KEY`, Vault-injected) | Claude is the prod provider (revised 2026-06-07); Ollama is dev/test only. See research R1. |

`MODEL_PROVIDER` defaults to `ollama` in code, which is correct for **dev/test**; the **golden-pair suite + production set `MODEL_PROVIDER=anthropic`** and require `ANTHROPIC_API_KEY` (Console per-token key; Vault-injected in deployed envs, T030a). Claude is the prod provider because it meets the prod tool-calling/structured-output + availability bar without self-hosting GPU/HA inference, and the gate must validate the shipped model (research R1, revised 2026-06-07). The per-user rate limit + cost ceiling caps live-call spend.

### Token exchange across serving modes (Metro vs dev container) — READ THIS

Three actors touch Keycloak/the gateway and they resolve URLs differently. The realm config above is shared; only base-URL resolution and gateway reachability differ by mode.

| Actor | Runs in | `KEYCLOAK_URL` | Reaches gateway via |
|---|---|---|---|
| **Metro BFF** | host (`@expo/server` dev) | `http://localhost:8099` | loopback dev port (below) |
| **Dev-container BFF** (`mcm-bff-dev`) | Docker, `backend-network` | `http://keycloak-service:8080` | `http://agent-gateway:8000` |
| **Agent gateway** (`langgraph-api`) | Docker, `backend-network` (always — never under Metro) | `http://keycloak-service:8080` | n/a |

**1. The issuer pin is mandatory for exchange to work in both modes (feature-007 reuse).** Keycloak MUST keep `KC_HOSTNAME=http://localhost:8099` + `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`. The BFF mints the subject token over the host/internal path and the gateway re-exchanges it over the Docker path; the pin makes every token carry `iss=localhost:8099` regardless of which path issued it, so the subject token validates at the exchange endpoint and the downscoped `aud=mc-service` token validates at `mc-service`. **Without the pin, token exchange fails `invalid issuer`** — the same failure class as the 007 refresh bug. No new Keycloak hostname work is needed *if* that pin is already present; verify it is.

**2. `AGENT_GATEWAY_URL` is mode-dependent, and Metro needs a loopback port.** The gateway is private (never client/public-reachable). In **container-BFF** dev the BFF is on `backend-network` and uses internal DNS `http://agent-gateway:8000` — the gateway publishes **no** host port. In **Metro** dev the BFF runs on the **host** and cannot reach an unpublished container, so the `agents` compose profile must publish the gateway on a **loopback-only** port (`127.0.0.1:8123:8000`, NOT `0.0.0.0`) and Metro's `.env.local` sets `AGENT_GATEWAY_URL=http://127.0.0.1:8123`. Binding to `127.0.0.1` keeps it non-public and BFF-only, satisfying the constitution's "gateway never reachable from clients or the public network."

**3. The gateway's own Keycloak URL is always the Docker-internal one** (`keycloak-service:8080`) since the gateway only ever runs as a container — independent of how the BFF is served.

**4. Native mobile is unaffected by the gateway URL** — the native client only ever talks to the BFF (AG-UI over the BFF proxy); gateway reachability is a BFF-side concern. Mobile still requires the `localhost:8099` issuer pin (already the case for login).

---

## Compose profiles (new)

Per-service compose files under `infrastructure-as-code/docker/` are `include:`d by the root `compose.yaml`. Proposed new profile:

| Profile | Adds |
|---|---|
| `--profile agents` | `agent-db` (isolated Postgres), `agent-gateway` (langgraph-api, private), `movie-mcp`, `web-api-mcp`, `ollama` (default model provider) |

`infrastructure-as-code/docker/ollama/compose.yaml` (`include:`d by the root compose):

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    networks: [backend-network]          # reachable by agent-gateway as http://ollama:11434
    volumes:
      - ollama-models:/root/.ollama       # persist pulled models across restarts
    # GPU passthrough (NVIDIA) — omit on a CPU-only host (much slower for 32b):
    deploy:
      resources:
        reservations:
          devices:
            - { driver: nvidia, count: all, capabilities: [gpu] }
    profiles: [agents]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "ollama", "list"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  ollama-models:
    external: true
    name: ollama-models                   # external + explicit name → no mcm_ prefix (matches the volume convention)
```

One-time (alongside the other `docker volume create` commands): `docker volume create ollama-models`. The agent gateway sets `OLLAMA_BASE_URL=http://ollama:11434` and `depends_on: ollama: { condition: service_healthy }`.

> **Models still need pulling into the container** — the image ships empty. After the service is up: `docker compose exec ollama ollama pull qwen2.5` and `… pull qwen2.5:32b` (persisted in the `ollama-models` volume, so this is one-time). Or, to avoid GPU/throughput contention in the container, **point `OLLAMA_BASE_URL` at a host Ollama** (`http://host.docker.internal:11434`) and skip the `ollama` service entirely — both paths are supported; the container service is the turnkey default.

Run the full agent stack on top of the app stack:

```powershell
# backend substrate + mc-service + keycloak (existing)
docker compose --profile app --profile keycloak up -d
# add the agent layer (includes ollama)
docker compose --profile agents up -d
# pull models into the ollama container (one-time; persisted in the volume)
docker compose exec ollama ollama pull qwen2.5
docker compose exec ollama ollama pull qwen2.5:32b
docker compose ps
```

Network rules:
- `agent-gateway`, `agent-db`, `movie-mcp`, `ollama` → `backend-network` (private); `agent-db` and `ollama` publish **no** host port (the gateway reaches Ollama as `http://ollama:11434`).
- `agent-gateway` publishes **no** host port for **container-BFF** dev (internal DNS only). For **Metro** dev, publish it **loopback-only** (`127.0.0.1:8123:8000`) so the host-run BFF can reach it — never `0.0.0.0`, never public. See "Token exchange across serving modes" above.
- `web-api-mcp` → **no** internal network; egress to TMDB only.

---

## Nx targets (via `@nxlv/python`)

All operations through Nx (never raw uv/pytest as the primary path):

```powershell
pnpm nx test movie-assistant              # pytest unit
pnpm nx test:integration movie-assistant  # real movie-mcp + real mc-service (no mocking)
pnpm nx lint movie-assistant              # ruff + mypy/pyright
pnpm nx build movie-assistant             # langgraph-api Docker image
pnpm nx test movie-mcp ; pnpm nx test web-api-mcp
pnpm nx test mcm-app                      # BFF agent-route unit tests
pnpm nx test:integration mcm-app          # BFF ↔ real gateway/Keycloak/Redis
```

---

## Manual smoke (US1 — enrich & add with HITL)

1. Bring up app + keycloak + agents profiles; start Metro (`cd frontend/mcm-app ; pnpm start`, press `w`).
2. Log in; open the **assistant dock** (app-wide overlay, reachable from any screen).
3. Type: `Add the original Blade Runner to my Sci-Fi collection`.
4. Expect: streamed reply, a `render_movie_card` preview, and an **approval-request** (nothing written yet — verify via the collection screen).
5. Approve → movie added (same as the add-movie form) + inline confirmation. Reject → unchanged.
6. Retry the same approved add → still **one** movie (idempotency).
7. Ask to add to a non-existent collection → preview shows **create collection + add movie**; approve applies both.

---

## Verification gates (before "done")

- `pnpm nx test:integration movie-assistant` green against **real** MCP + `mc-service`.
- **Token-leak scan** (CI/eval): no subject/exchanged token in `agent-db`, traces, or logs (SC-004).
- **LangFuse golden-pair regression suite** green (gates deployment); per-turn cost + p95 latency within budget (SC-008).
- **Existing web E2E regression** (`pnpm nx e2e mcm-app`) stays green — proves additive-only (SC-005). Required even though this adds a layer (feature-011 lesson: backend/layer changes still need the full client E2E path).
- New assistant E2E flows pass on **both** web (Playwright) + mobile (Maestro) — SC-001 parity (Platform Parity Table in tasks.md).
- Audit stream records every approval (SC-002); RBAC/DAC denial parity test (SC-003); abandoned-proposal expiry (SC-007); rate/cost cap (SC-011).

---

## Teardown / reset

```powershell
docker compose --profile agents down          # stop agent layer (keep agent-db-data volume)
```

The isolated `agent-db-data` volume persists checkpoints across restarts; remove it manually only to wipe agent state. The app/keycloak substrate is unaffected.
