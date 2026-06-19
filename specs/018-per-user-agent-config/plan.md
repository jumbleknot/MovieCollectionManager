# Implementation Plan: Per-User Movie Assistant Configuration

**Branch**: `018-per-user-agent-config` | **Date**: 2026-06-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/018-per-user-agent-config/spec.md`

## Summary

Make the movie assistant **opt-in and bring-your-own-everything**: disabled by default for every new user, with **no shared model** and **no shared movie-metadata (TMDB) key** in the user-facing runtime. Each user enables the assistant and supplies their own provider credentials (Ollama base URL **or** Anthropic key) plus their own TMDB key from a new **Movie Assistant** section on the Profile screen. Credentials are **validated live on save** (≤5s probes, per-field 422), stored **AES-256-GCM-encrypted** in a new BFF-owned MongoDB collection scoped per user, and injected **per-run, in-memory only** into the existing LangGraph `config["configurable"]` channel — reusing the established header → ASGI-middleware → ContextVar bridge. Secrets never leave the server, never appear in reads, logs, spans, traces, checkpoints, or source control.

Technical approach in one line: **a new BFF→Mongo credential store + four `bff-api/agent/config` routes + an `X-Agent-Config` per-run header**, with the Python model/TMDB resolution switched from `os.environ` to per-run `configurable`, and the dock + `run+api.ts` gated on a resolved-and-enabled config.

## Technical Context

**Language/Version**: TypeScript (BFF, Expo Router API routes; Node `node:24.14.1-alpine3.23`) · Python 3.13 (agent gateway + MCP servers, via `uv`). No Rust/mc-service change.

**Primary Dependencies**: Node `crypto` (AES-256-GCM, built-in — no new crypto dep); `mongodb` Node driver (**new BFF dependency**); existing `axios`/`fetch` for live probes; LangGraph + AG-UI/CopilotKit (gateway); `@mcm/design-system` + Tamagui (Profile UI); existing Vault client seam (`resolve_secret`) for the master key in prod.

**Storage**: New MongoDB collection `user_agent_config` in the existing `mc_db` instance, accessed **directly by the BFF** via its own scoped Mongo credentials (BFF holds no Mongo connection today — this is a deliberate new dependency). Secrets stored as AES-256-GCM blobs (iv + auth tag + ciphertext). Redis remains the per-user cost/rate/thread store (unchanged).

**Testing**: Jest (BFF unit + `tests/integration` real-dependency: Mongo round-trip, live probes) · Playwright (web E2E, dev-container path) · Maestro (mobile E2E, CI) · `pytest` (Python agent unit + integration + golden cassette gate) · existing `design-system-compliance.test.ts` R1–R7 scan · existing `AGENT_ROUTES` route-coverage auth test · existing static token-leak scan (extended).

**Target Platform**: Web (React Native Web) + Android (Expo), BFF in Node container, gateway + MCP in Python containers.

**Project Type**: Multi-experience web/mobile app (Expo) with a BFF-Layer + an additive Python agent layer. Existing monorepo directories; no new project.

**Performance Goals**: Live credential probes (save-time validation + test-connection) return within **≤5s** each or time out with an actionable failure (SC-008). Config GET is a single indexed Mongo read. Per-run config injection adds one Mongo read + one in-memory decrypt to the run hot path (no extra network hop to the gateway — rides the existing request).

**Constraints**: Decrypted secrets are **per-run, in-memory only** — never persisted to checkpoints/Postgres state, OTel spans, LangFuse traces, or logs (extends SC-004 discipline to user keys). GET never returns secret values. No secret-shaped literal may be committed (CI secret-scan guard). Master key never logged, sourced only from Vault(prod)/gitignored env(dev).

**Scale/Scope**: One config document per user (1:1). Two supported providers. Four new BFF routes, one new BFF→Mongo module, one encryption module, one Profile UI section + hook, one new per-run header end-to-end (BFF → gateway middleware → ContextVar → `configurable` → models.py + web-api-mcp). Test/golden harness reworked to seed a config row instead of relying on shared env.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| **Secrets Management** (no secrets in source/config/VCS; Vault/env; rotation) | ✅ PASS | Master key `AGENT_CONFIG_ENC_KEY` via Vault(prod)/gitignored env(dev); per-user keys encrypted at rest; CI secret-scan guard (FR-025); cassettes assert no key material. Key rotation strategy is an acknowledged follow-up (spec assumption), not in scope. |
| **Encryption at Rest** (AES-256; key managed separately via KMS) | ✅ PASS | AES-256-GCM; master key held in Vault/env, **separate** from the Mongo data store; iv+tag stored with ciphertext (standard GCM envelope). |
| **Input Validation** (server-side, whitelist, early) | ✅ PASS | `PUT /config` validates provider enum, URL shape, and cost-limit type server-side before any probe; live probes confirm credential validity; nothing persisted on failure. |
| **Centralized Access Control** (new endpoint protected without per-handler code) | ⚠️ PASS-with-control | Expo Router has no runtime global middleware (known gap: `expo-server-middleware-gap`). Compensating control: every new route uses `requireAuth`+`requireMcUser`, **and** is added to the `AGENT_ROUTES` allowlist exercised by `agent-route-auth.integration.test.ts`, which fails CI if a route is unprotected. Consistent with all prior agent routes. |
| **Deny by Default / Least Privilege** | ✅ PASS | Assistant off until explicitly enabled+configured (FR-001/002). BFF Mongo credential scoped to the `user_agent_config` collection only. Config strictly caller-scoped — userId from validated session, never request body (FR-017). |
| **BFF-Layer: Secure Credential Handling** | ✅ PASS | Storing per-user API keys encrypted is squarely the BFF-Layer's "securely store sensitive information like API keys" responsibility — not movie-domain logic, so **No-Domain-Logic-in-Frontend is not violated**. BFF already externalizes state to Redis; adding a durable encrypted store is in-character. |
| **Logging & Monitoring** (structured, redaction, audit, no secrets) | ✅ PASS | Redaction list extended (FR-024); audit on create/update/delete/test (FR-019) by userId only; no secret material in any log/span/trace (FR-022). |
| **TDD** (RED→GREEN, checkpoint format, platform parity, seeded fixtures, afterEach teardown) | ✅ PASS | All test tasks follow `docs/templates/feature-test-tasks-template.md`; platform parity table mandatory; E2E seeds config rows from env/CI secrets (NFR-Sec-2); afterEach BFF teardown. |
| **Integration Test Real-Dependency** | ✅ PASS | Mongo encrypt→store→read→decrypt round-trip against a real Mongo; live probes against real Ollama/TMDB; the 422 branch uses a deliberately-bad credential (real failure), not a mock. |
| **Frontend Design System** (compose from `@mcm/design-system`, pass R1–R7) | ✅ PASS | New Movie Assistant section built from DS components/tokens; must pass `design-system-compliance.test.ts`; `NoAutoFillInput` for all fields (registration exclusion N/A). |
| **Accessibility (WCAG 2.2 AA), stable testIDs** | ✅ PASS | DS components carry AA contrast (per 016/017); stable `testID`s for Playwright/Maestro; `axe` already gates web. |

**Verdict**: PASS. No unjustified violations. The one ⚠️ is a pre-existing platform gap with an established compensating control; no new debt is introduced.

## Project Structure

### Documentation (this feature)

```text
specs/018-per-user-agent-config/
├── plan.md              # This file (/speckit-plan output)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── bff-agent-config-api.md       # GET/PUT/POST-test/DELETE /bff-api/agent/config
│   └── per-run-config-channel.md     # X-Agent-Config header → configurable contract
├── checklists/
│   └── requirements.md  # (from /speckit-specify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
frontend/mcm-app/
├── src/
│   ├── app/bff-api/agent/config/
│   │   ├── index+api.ts                 # NEW: GET (non-secret view), PUT (validate+upsert), DELETE
│   │   └── test+api.ts                  # NEW: POST /config/test (probe stored creds)
│   ├── app/bff-api/agent/run+api.ts     # EDIT: load config, short-circuit if not runnable,
│   │                                    #       inject X-Agent-Config, apply per-user cost ceiling
│   ├── bff-server/
│   │   ├── agent-config-store.ts        # NEW: BFF→Mongo client + CRUD for user_agent_config
│   │   ├── agent-config-crypto.ts       # NEW: AES-256-GCM encrypt/decrypt (Node crypto)
│   │   ├── agent-config-probes.ts       # NEW: live validation probes (Ollama/Anthropic/TMDB, ≤5s)
│   │   ├── agent-config-service.ts      # NEW: orchestration (validate→encrypt→upsert; resolve-for-run)
│   │   ├── agent-gateway-client.ts      # EDIT: add agentConfig → X-Agent-Config header
│   │   ├── agent-rate-limiter.ts        # EDIT: enforceAgentCostCeiling accepts per-user ceiling override
│   │   ├── logger.ts                    # EDIT: extend redaction (anthropicKey, tmdbKey, *Enc, enc key)
│   │   └── mongo-client.ts              # NEW: shared BFF Mongo connection (lazy singleton)
│   ├── components/
│   │   ├── profile-display.tsx          # EDIT: add Movie Assistant config section (or extract sub-component)
│   │   └── agent/movie-assistant-config.tsx  # NEW: the config form (toggle/provider/fields/save/test)
│   ├── app/(app)/_layout.tsx            # EDIT: AuthedAssistant gated on resolved enabled config
│   ├── hooks/use-assistant-config.tsx   # NEW: fetch/save/test config; expose enabled+presence flags
│   └── config/env.ts                    # EDIT: add MONGO_* + AGENT_CONFIG_ENC_KEY
├── tests/
│   ├── app/bff-api/agent/config/*.test.ts   # NEW: route unit tests
│   ├── integration/agent-config-*.integration.test.ts  # NEW: Mongo round-trip + live probes
│   ├── integration/agent-route-auth.integration.test.ts # EDIT: add new routes to AGENT_ROUTES
│   └── e2e/web/assistant-config.spec.ts     # NEW: enable/configure/save/test/disable + gating
│   └── e2e/mobile/assistant-config*.yaml    # NEW: Maestro parity flows

agents/movie-assistant/src/
├── agui_identity.py        # EDIT: inject_agent_config(config, agent_cfg) → configurable
├── gateway.py              # EDIT: AgentConfigMiddleware (X-Agent-Config header → ContextVar)
├── runtime_context.py      # EDIT: agent-config ContextVar (request-local, never logged)
├── models.py               # EDIT: build per-run env-mapping from configurable at call sites
└── runtime_nodes.py        # EDIT: thread per-run model config + tmdb key from configurable

mcp-servers/web-api-mcp/src/
└── server.py               # EDIT: read per-request TMDB key from transport header → ContextVar
                            #       (env/Vault path removed from user-facing runtime)
```

**Structure Decision**: No new project. The feature extends three existing units — the **Expo BFF-Layer** (`frontend/mcm-app/src/bff-server` + `bff-api/agent/config`), the **Python gateway** (`agents/movie-assistant`), and the **web-api MCP server** (`mcp-servers/web-api-mcp`). Storage is BFF-owned (new `mongo-client.ts` + `agent-config-store.ts`), explicitly **not** mc-service, because per-user credential custody is a BFF-Layer responsibility, not movie-domain logic. The per-run credential path reuses the proven `X-*` header → ASGI-middleware → ContextVar → `config["configurable"]` bridge already used for the subject token and UI snapshot.

## Complexity Tracking

> No constitution violations require justification. One deliberate new dependency is recorded for visibility (not a violation):

| Decision | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| BFF gains a direct MongoDB dependency | Durable, per-user, encrypted credential storage scoped to the BFF's credential-custody role | **Redis** (current BFF store) has no first-class durability for long-lived config and conflates session-TTL data with permanent settings. **mc-service** owns the movie domain, not auth/BFF-adjacent credentials — routing user keys through it would leak credential custody into a domain service and add a network hop on the run hot path. |
| New per-run `X-Agent-Config` header (vs. extending an existing one) | Keeps credential payload distinct from identity (subject token) and UI snapshot; single-purpose middleware is easy to audit for leak-safety | Overloading the subject-token or UI-snapshot header would mix concerns and complicate the SC-004 leak scan boundaries. |

## Post-Implementation Review Decisions (2026-06-19)

A high-effort review drove the following design decisions (full task list: tasks.md Phase 11):

- **All model stages read per-run config (FR-028).** The provider/key overlay (`runtime_env`) was previously consumed only by the specialist nodes; the supervisor/intent-classifier still read `os.environ`. The supervisor node now binds `agent_config_scope` from `config["configurable"]` and the classifier builds from the per-run env — so a single mechanism feeds **every** model build. Provider-specific model-id pins (`SUPERVISOR_MODEL`/`SPECIALIST_MODEL`) are dropped from the overlay on a provider switch so the new provider's defaults apply.
- **Per-user credential precedence + fail-closed (FR-029/FR-030).** A per-run user key beats the Vault/static fallback (`resolve_anthropic_key`; mirrors the per-request TMDB override); an Ollama-only run drops the shared `ANTHROPIC_API_KEY` from its overlay; web-api-mcp `_tmdb_key()` raises rather than issue an unauthenticated call.
- **SSRF egress policy (FR-026): block metadata/link-local, allow private/loopback.** "Bring your own Ollama" requires private/loopback to work, so a blanket private-range block was rejected. The guard blocks only link-local + cloud-metadata, offers an opt-in `AGENT_OLLAMA_ALLOWED_HOSTS` allow-list for hardened deployments, and sets `redirect:'manual'` on probes. Enforced at save AND probe.
- **At-rest AAD binding (FR-027).** GCM AAD = `${userId}:${field}` makes a stored blob non-portable across users/fields — chosen over leaving the tag context-free because it closes a store-mixup disclosure with no schema change (feature unreleased → no migration).
- **One header-context middleware factory.** The four gateway per-run channels (subject token / UI snapshot / import file / agent config) collapse to one factory so the SC-004 reset-in-`finally` discipline lives in a single audited place. web-api-mcp's lone `TmdbKeyMiddleware` is left standalone (separate package; nothing to dedup against).
