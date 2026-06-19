# AI Agent Layer (features 012 + 014)

> Reference for the additive conversational assistant. **Read this + `agents/movie-assistant/README.md` + `specs/012-multi-agent-mvp/HANDOFF.md` before any agent work.** Loaded on demand — not part of the always-on CLAUDE.md core.

## Overview (feature 012 — `agents/movie-assistant` + `mcp-servers/{movie-mcp,web-api-mcp}`)

Additive conversational assistant: a LangGraph supervisor graph served over AG-UI (the **Agent
Gateway**), reached only through the BFF; two stateless MCP servers (movie-mcp → mc-service,
web-api-mcp → TMDB). Python 3.13 + `uv`, run via Nx (`@nxlv/python`).

> **Feature 014 — spreadsheet import/export** added a THIRD scoped MCP server
> **`mcp-servers/spreadsheet-mcp`** (file processing only: `parse_spreadsheet`/`build_workbook`
> over a transient, single-use Redis handle; token-free; `enable_dns_rebinding_protection=False`
> like the others) and two supervisor intents **`import`** + **`export`** → nodes
> `import_collection` (US2/US4: parse → pure-code column/article/dedup resolution + US4 button
> disambiguation → HITL `Proposal` batches; never blanks, idempotent) and `export_collection`
> (US3: multi-tab `.xlsx` → `download_export` UI-action). BFF routes `agent/import-upload`
> (multipart → transient store → `X-Import-File` header bridge) + `agent/export-download` (stream,
> ownership-scoped, single-use). Import/export are **web-first** (mobile is a documented scope
> exception); US1 made movie `language` optional end-to-end (import must pass an absent language
> through, never inject a default). The `import`/`export` intents are the ONLY golden surface —
> all mapping/normalization/dedup/pick logic is pure code. **Rebuild `spreadsheet-mcp:latest`
> alongside `agent-gateway:latest`+`mcm-bff:latest` before agent E2E** (the runner recreates, never
> rebuilds). **E2E lesson (T056): an agent-write E2E must POLL the resource until the write lands —
> never trust the streamed "done" message (it precedes the mc-service write, and afterEach teardown
> races the orphaned write into a correct-but-confusing 404).** See
> `specs/014-spreadsheet-import-export/`.
>
> **Implementation-review lessons (2026-06-14):** (1) **An MCP server must reuse ONE backend/Redis
> client** (movie-mcp pattern) — `spreadsheet-mcp/src/store.py` built a fresh `redis.from_url` per
> tool call (leaked pools); cache a process-shared lazy client. (2) **Export cells carry a
> formula-injection guard**: `builder._cell` escapes a leading `= + - @ \t \r` with an apostrophe
> and `parser._cell_to_str` strips exactly that guard, so the SC-004 round-trip stays symmetric and
> a legit leading apostrophe ("'71") survives. (3) **`language` is normalized empty/whitespace → None
> at the create/update command boundary** (absence ≠ empty string) — the filter-options empty-string
> exclusion is then defense-in-depth, not load-bearing. (4) **BFF file uploads reject by
> `Content-Length` BEFORE buffering** the body (the transient-store size guard runs only after
> `arrayBuffer()`). (5) **Editing a test fixture (`docs/test-data/sample-movies.xlsx`) MUST re-run
> the consuming projects' unit + lint** — the "updated sample data" commit bumped the sheet 200→204
> rows and left `spreadsheet-mcp` unit RED + two `E501`s in `test_import_flow.py` unfixed (the Final
> Validation Checklist wasn't run for that quick commit). Counts asserted in tests are
> fixture-derived; a data edit invalidates them.

```bash
pnpm nx test movie-assistant                              # unit (incl. the SC-004 token-leak scan)
pnpm nx test movie-assistant -- -m leak_scan              # token-leak scan in isolation
pnpm nx test:integration movie-assistant                  # vs REAL Keycloak/MCP/mc-service/Ollama (skips if absent)
LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant   # golden model-decision gate (keyless, CI)
LLM_CASSETTE_MODE=record pnpm nx test:golden movie-assistant   # re-record vs Claude (needs ANTHROPIC_API_KEY)
pnpm nx lint movie-assistant                              # ruff + mypy   (same targets for movie-mcp / web-api-mcp)
```

**Models are env-scoped (research R1): Ollama (`qwen2.5`/`qwen2.5:32b`) for dev/test/iterative
E2E; Anthropic Claude for the golden gate + production** (`MODEL_PROVIDER=anthropic`). The host
gateway runs on the Metro loopback `127.0.0.1:8123` with production nodes when `WEB_API_MCP_URL`
+ `MOVIE_MCP_URL` are set (see HANDOFF "How to bring the agent stack up"); the full containerised
stack is `docker compose --profile agents up -d` (needs the `ollama-models`/`agent-db-data`
volumes + a ~19 GB model pull — a one-time provisioning step). The gateway is private-network
only (the BFF is the sole caller).

## Containerized agent E2E

**Containerized agent E2E (automated, no Metro/host gateway) — `pnpm nx up-agents-prod
infrastructure-as-code` + `pnpm nx e2e:agents mcm-app`.** A committed light stack (host Ollama +
MemorySaver; `scripts/agent-stack.mjs` + `scripts/agent-e2e.mjs`) runs the agent flows against
the **dev-container BFF + containerized production gateway + containerized MCP**. `up-agents-prod`
builds the 3 images, creates the `agent-mcp` network (`docker network create agent-mcp` is now a
first-time-setup step), fetches the gateway client secret from Keycloak admin (`kc_admin`), and
verifies production nodes. Default provider is Ollama; **`MODEL_PROVIDER=anthropic node
scripts/agent-stack.mjs`** deploys the gateway against Claude instead (haiku-4-5 / sonnet-4-6
defaults, key from env or `.env.local`; don't pass the Ollama model IDs or they 404 at Anthropic).
**Three durable gotchas it codifies (all were real blockers — see
`specs/012-multi-agent-mvp/quickstart.md` "Containerized production-agent stack"):** (1) the MCP
SDK 421-rejects a Docker service-name `Host` (DNS-rebinding protection) — both MCP servers set
`transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False)`, **without
which the `--profile agents` stack never worked end-to-end**; (2) `production_nodes_enabled` needs
BOTH `WEB_API_MCP_URL` + `MOVIE_MCP_URL` or the gateway silently serves the tool-free graph — and
**rebuild `agent-gateway:latest` after any agent-source change** (a stale image runs old code,
e.g. without `runtime_nodes.py` → tool-free); (3) run agent specs **isolated per file**, not the
parallel suite — 10 workers + one test user trip the per-user rate-limit + ~5-min token-expiry
(`no_token`); `compose.agent-e2e.yaml` relaxes the cost-ceiling/rate-limit on the dev BFF (the
cost ceiling **works** and accrues per-user over the session window — SC-011 — it just must not
gate an agent-flow run).

## Observability (Control Tower, SC-008) — opt-in `--profile observability`

LangFuse v3
(per-turn cost/latency), `grafana/otel-lgtm` (OTel → Tempo/Prometheus/Loki/Grafana), and Vault
(dev) stand up via `docker compose --profile observability up -d` (LangFuse :3030, Grafana
:3002, OTLP :4317/:4318, Vault :8200). **OPA** (agent authz — token-exchange + ui-action policies
in `infrastructure-as-code/opa/policies/`, served with `--watch`; env `OPA_URL`; unset = fall
back to allow / TS authorizer) and **Unleash** (feature flags `mcm.agent.kill-switch`,
`mcm.agent.frontier-escalation`, `mcm.agent.degrade`, all default-off; SDK URL =
`UNLEASH_URL` + `/api`, token `UNLEASH_API_TOKEN`; unset = falls back to env flags
`AGENT_KILL_SWITCH` etc.) also run under `--profile observability` (:8181 and :4242
respectively). All gateway instrumentation is **env-gated → no-op by default** (SC-005
additive): `LANGFUSE_*`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `VAULT_ADDR/TOKEN`, `OPA_URL`,
`UNLEASH_URL`/`UNLEASH_API_TOKEN`, the `AGENT_PER_TURN_COST_BUDGET_USD`/`AGENT_TURN_LATENCY_BUDGET_MS`
budgets, and `AGENT_ERROR_RATE_*` (the error-rate circuit breaker). Verify SC-008 live (needs the
profile + `ANTHROPIC_API_KEY`): `MODEL_PROVIDER=anthropic ANTHROPIC_API_KEY=… LANGFUSE_PUBLIC_KEY=pk-lf-mcm-dev-0000000000000000 LANGFUSE_SECRET_KEY=sk-lf-mcm-dev-0000000000000000 pnpm nx test:integration movie-assistant -- -k observability_sc008`.
See `agents/movie-assistant/.env.local.example` for all the vars.

## Audit (Control Tower) — separate `--profile audit`

OpenSearch (append-only agent audit sink,
index `mcm-agent-audit`) is **not** part of `--profile observability` — it runs under its own
profile: `docker compose --profile audit up -d` (HTTPS `:9200`, self-signed). **Heap is pinned to
1 GB via `OPENSEARCH_JAVA_OPTS=-Xms1g -Xmx1g`** in
`infrastructure-as-code/docker/opensearch/compose.yaml` — required to prevent the 4 GB default
from OOM-killing the container on a dev box. First-time setup: `docker volume create
opensearch-data` then `bash infrastructure-as-code/docker/opensearch/init-audit-user.sh`
(idempotent; creates the write-only `agent-audit` role + user: can index, cannot read/delete).
Env: `OPENSEARCH_URL`, `OPENSEARCH_USERNAME`, `OPENSEARCH_PASSWORD` — all env-gated; when unset,
the Python `src/audit_sink.py` and BFF `audit-sink.ts` log audit events only (no OpenSearch
write). `OPENSEARCH_INSECURE_TLS=true` — opt-in BFF flag (default OFF, never set in production):
when truthy + `OPENSEARCH_URL` is `https://`, the BFF uses `node:https` with
`rejectUnauthorized: false` for the audit POST (scoped to that one request, never touches
`NODE_TLS_REJECT_UNAUTHORIZED` globally) — required for the dev self-signed cert.
Not part of the normal dev stack — config-deployable only.

> **SC-004 + OTel spans — "name-only" is necessary but NOT sufficient.** `start_as_current_span(...)` defaults `record_exception=True` AND `set_status_on_exception=True`; **both embed `str(exc)`** into the exported span (an `exception` event message + the status description). An `httpx.HTTPStatusError` (from `raise_for_status` on a 4xx/5xx) stringifies the request URL — and web-api-mcp's TMDB key rides that URL as `?api_key=…`, so the credential reached the trace on any TMDB error. The static token-leak scan (T031) **cannot** see this (it's runtime exception recording, not a logged variable). The MCP `tool_span` wrappers therefore pass `record_exception=False, set_status_on_exception=False` (regression-tested via an in-memory span exporter). **Rule: any `start_as_current_span` around credential-bearing I/O MUST disable exception recording.** Likewise, resolve Vault-backed secrets (`hvac` is sync/blocking) ONCE at startup and cache them — never per async tool call (it stalls the event loop). (implementation-review 2026-06-09.)

## Agent-layer testing gates (constitution §Evaluation + §Agent Security)

- The **golden-pair regression suite gates agent deployment** — `LLM_CASSETTE_MODE=replay
  pnpm nx test:golden movie-assistant` is the mergeable, keyless CI gate (replays recorded Claude
  responses; drift → `CassetteMissError`); a live-Claude record run is the pre-deploy gate.
- The **SC-004 token-leak scan** must pass — it runs inside `pnpm nx test movie-assistant`
  (AST-scans the agent + both MCP source trees for any logged token-named variable).
- Integration tests run against **real** MCP servers + real `mc-service` (never mock the
  dependency under integration); CI cassettes **only** the LLM dimension (T032).
- **E2E for agent flows must navigate IN-APP, never deep-load a collection before driving the
  dock** (a fresh deep-load of a non-home route resets the CopilotKit agent — research R15).
- CI: `.github/workflows/agent-gates.yml` runs lint + unit (leak-scan) + golden replay on every
  push/PR touching the agent or MCP source.
- **Mobile agent E2E runs in CI, not locally** — see [runbooks/android-emulator.md](runbooks/android-emulator.md).
