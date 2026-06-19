# PRD — HashiCorp Vault: Operator Secret Store

**Status:** Draft · **Date:** 2026-06-19 · **Owner:** Steven Watson

> **Relationship to other docs.** This PRD defines the *what* and *why* of Vault's role in MCM. Architecture
> context lives in [MCM-Architecture.md](MCM-Architecture.md); the per-user credential model that scopes Vault
> down lives in [PRD-PerUserAgentConfig.md](PRD-PerUserAgentConfig.md) and `specs/018-per-user-agent-config/`.
> A `spec.md` / `plan.md` / `tasks.md` set may be generated from this PRD under `specs/` per the SDD workflow.

---

## 1. Summary

HashiCorp Vault is an **optional operator-secret store**. It holds ONLY **shared infrastructure secrets** that
belong to the *operator/deployment*, not to any user. After feature 018 (per-user, bring-your-own credentials)
and the 2026-06-19 "no fallbacks" decision, Vault's scope is deliberately narrow:

- **It MUST hold** (when enabled) the secrets that the *system itself* presents to other machines — chiefly the
  Agent Gateway's Keycloak OAuth client secret, and (recommended) the BFF master encryption key.
- **It MUST NOT hold** any user-facing credential — no model-provider API key, no TMDB key, no Ollama URL. Those
  are **per-user**, encrypted at rest by the BFF, and injected per-run. There is **no shared fallback** for them
  anywhere (env or Vault); their absence fails closed.

Vault is **off by default**: it is a `--profile observability` container, and secret resolution falls back to the
process environment when `VAULT_ADDR` / `VAULT_TOKEN` are unset. The system runs fully without it.

## 2. Background & motivation

Originally (features 012/014) the agent layer was configured **process-globally**: a single operator-supplied
`ANTHROPIC_API_KEY` and a single `TMDB_API_KEY` served every user, resolved through `resolve_secret(name, env)`
(Vault-preferred, env-fallback). Feature 018 made the assistant **opt-in and bring-your-own**: each user supplies
and stores their own provider + TMDB credentials (encrypted in MongoDB by the BFF, decrypted transiently and
injected per run). FR-021 requires that *all previously shared, operator-supplied model/metadata credential paths
be removed from the user-facing runtime*.

The 2026-06-19 review + decision finished that removal: the **TMDB** and **Anthropic** Vault/env *fallbacks were
deleted entirely*. The per-request `X-TMDB-Key` header is the sole TMDB source; the per-run env overlay (driven by
the user's stored key) is the sole Anthropic source. A call that reaches a provider with no per-user credential now
**raises a configuration error** rather than silently using a shared key.

That leaves Vault with one legitimate job: storing the **operator's own** machine secrets. This PRD specifies
exactly which keys those are.

## 3. Scope

### 3.1 Secrets Vault SHALL store (operator/infrastructure)

| Secret | Consumer | Code path today | Vault status |
| --- | --- | --- | --- |
| `AGENT_GATEWAY_CLIENT_SECRET` | Agent Gateway → Keycloak | `resolve_secret("AGENT_GATEWAY_CLIENT_SECRET", env)` in [token_exchange.py](../agents/movie-assistant/src/tools/token_exchange.py) | **REQUIRED when Vault is enabled.** The gateway's confidential-client secret for RFC 8693 token exchange (downscoping the user's subject token per tool call). A genuine machine credential. |
| `AGENT_CONFIG_ENC_KEY` | BFF | Read from env in [env.ts](../frontend/mcm-app/src/config/env.ts) (`optionalEnv('AGENT_CONFIG_ENC_KEY', '')`) | **RECOMMENDED.** The AES-256-GCM master key that encrypts **every** user's stored credentials at rest — the single highest-value secret in the system. The BFF does not call Vault directly; in production this env var SHOULD be **injected from Vault** by the deployment platform (e.g. Vault Agent / sidecar / CSI). |

### 3.2 Secrets that MAY be centralized in Vault (deployment hygiene, not required by code)

These are not read through `resolve_secret` today; they are conventional deployment secrets that an operator MAY
choose to source from Vault via env injection for a single source of truth:

- Keycloak **confidential-client secret** (BFF login/token exchange) and **service-account secret** (Admin API).
- Datastore credentials: MongoDB (BFF `MONGO_URL` creds, mc-service `MC_DB_URL`), Redis password, Keycloak's
  PostgreSQL password.
- Control Tower credentials: LangFuse public/secret keys, the OpenSearch write-only audit account, the Unleash
  API token.

### 3.3 Secrets Vault SHALL NOT store (per-user — never shared)

These are **user-owned** and live ONLY as per-user, BFF-encrypted records in MongoDB (`user_agent_config`),
decrypted transiently and injected per run. They MUST NEVER be placed in Vault, env, or any shared store, and have
**no fallback**:

- A user's **model-provider API key** (e.g. their `ANTHROPIC_API_KEY`).
- A user's **TMDB v3 key**.
- A user's **Ollama base URL** (non-secret, but still per-user config, not operator config).

> **Why no fallback?** A shared model/TMDB key would re-introduce exactly what 018 removed: one operator paying for
> and gating everyone's usage, and a cross-user credential blast radius. With the fallbacks gone, a missing per-user
> credential is a loud configuration error, not a silent shared-key spend.

## 4. Functional requirements

- **FR-V1**: When `VAULT_ADDR` **and** `VAULT_TOKEN` are both set, `resolve_secret(name, env)` SHALL read `name`
  from Vault KV v2 (mount `secret`, path `movie-assistant`); otherwise it SHALL read `name` from the environment.
- **FR-V2**: `resolve_secret` SHALL be **fail-open to env and never crash** on a Vault error (timeout, auth, missing
  key), and SHALL **never log a secret value** (SC-004 / leak scan).
- **FR-V3**: The only secret the agent runtime resolves through Vault SHALL be `AGENT_GATEWAY_CLIENT_SECRET`. No
  user/model/TMDB credential SHALL be resolved through `resolve_secret` (the `web-api-mcp` `secrets.py` module and
  its `hvac` dependency were removed; `models.py` no longer calls `resolve_secret` for the model key).
- **FR-V4**: The BFF master encryption key `AGENT_CONFIG_ENC_KEY` SHALL be sourced from a secret store in production
  (Vault-injected env recommended) and SHALL NEVER be committed. A missing key SHALL fail lazily on first use of the
  config store (it MUST NOT silently default to a usable value).
- **FR-V5**: There SHALL be **no shared/operator TMDB or model-provider key** in the user-facing runtime, and no env
  or Vault fallback for them. A provider/metadata call with no per-user credential SHALL fail closed with a clear
  configuration error (TMDB: `_tmdb_key()` raises; Anthropic: `resolve_anthropic_key()` returns `None`).
- **FR-V6**: Vault SHALL be optional and profile-gated; the system SHALL run in dev/test/CI with env-only secrets
  and Vault absent.

## 5. Vault layout (when enabled)

- Engine: **KV v2**, mount point `secret`.
- Path `secret/movie-assistant` — keys consumed by the agent runtime:
  - `AGENT_GATEWAY_CLIENT_SECRET` — **(required)**.
- Recommended additional material the deployment platform injects as env (not necessarily under the same path):
  - `AGENT_CONFIG_ENC_KEY` — the BFF master encryption key.

Dev container ([infrastructure-as-code/docker/observability/compose.yaml](../infrastructure-as-code/docker/observability/compose.yaml)):
`hashicorp/vault:1.18` in `-dev` mode under `--profile observability`, root token `mcm-dev-root-token`, on
`127.0.0.1:8200`. Dev mode is in-memory and unsealed — **never** a production posture.

## 6. Non-goals

- **Master-key rotation / envelope encryption** for `AGENT_CONFIG_ENC_KEY` (re-encrypting stored user secrets on
  rotation) is acknowledged future work, out of scope here (the at-rest schema reserves room for a `keyId`).
- **Migrating the BFF to call Vault's API directly** — env injection from Vault is the recommended pattern; a native
  `hvac`-style client in the BFF is out of scope.
- Centralizing the §3.2 deployment secrets in Vault is **optional** and a deployment decision, not a code change.

## 7. Acceptance criteria

- **AC-1**: With Vault enabled and `AGENT_GATEWAY_CLIENT_SECRET` seeded, the gateway performs token exchange using
  the Vault value; with Vault disabled, it uses the env value. (Covered by the agent `secrets.py` unit tests +
  the live token-exchange integration test.)
- **AC-2**: With no per-user TMDB key on a request, a `web-api-mcp` tool call **raises** (no env/Vault fallback) —
  `mcp-servers/web-api-mcp/tests/unit/test_tmdb_key.py::test_tmdb_key_raises_when_no_per_request_key`.
- **AC-3**: `resolve_anthropic_key` consults **no** Vault/secret store and returns `None` when no per-run key is
  present — `agents/movie-assistant/tests/unit/test_agent_config_injection.py::test_resolve_anthropic_key_uses_only_the_per_run_key_no_fallback`.
- **AC-4**: A secret-shaped string never appears in any committed file (secret-scan guard) and no secret is logged
  (leak scan) — existing 018 gates.
- **AC-5**: The architecture doc and diagram represent Vault as an optional operator-secret store (this change set).
