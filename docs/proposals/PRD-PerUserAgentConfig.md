# PRD — Per-User Movie Assistant Configuration

**Status:** Draft · **Date:** 2026-06-18 · **Owner:** Steven Watson

> **Relationship to other docs.** This PRD defines the *what* and *why*. Architecture context lives in
> [MCM-Architecture.md](MCM-Architecture.md) and [docs/agent-layer.md](agent-layer.md); the testing rules it must
> satisfy live in [MCM-Testing-Strategy.md](MCM-Testing-Strategy.md) and [CLAUDE.md](../CLAUDE.md). A `spec.md` /
> `plan.md` / `tasks.md` set will be generated from this PRD under `specs/` per the SDD workflow.

---

## 1. Summary

The movie assistant becomes **opt-in and bring-your-own-everything**. It is **disabled by default for every new
user**, there is **no shared model** (each user supplies their own provider credentials, e.g. `OLLAMA_BASE_URL`
or `ANTHROPIC_API_KEY`), and there is **no shared `TMDB_API_KEY`** (each user supplies their own). Users enable,
configure, validate, and test the assistant from a new section on the **Profile screen**. Per-user configuration —
including API keys — is **stored encrypted, scoped to that one user, and persists across sessions**.

## 2. Background & motivation

Today the agent layer is configured **process-globally via environment variables** read at gateway startup:

- Model provider/selection: `MODEL_PROVIDER`, `OLLAMA_BASE_URL`, `ANTHROPIC_API_KEY`, `SUPERVISOR_MODEL`,
  `SPECIALIST_MODEL`, `ESCALATION_MODEL` — resolved in `agents/movie-assistant/src/models.py`.
- TMDB access: `TMDB_API_KEY` — resolved once in `mcp-servers/web-api-mcp/src/server.py`.

This means a single operator-supplied model and a single operator-supplied TMDB key serve **all** users. That is
unacceptable for a multi-user product: it forces the operator to pay for and manage everyone's model/TMDB usage,
gives every user the same (possibly absent) capability, and offers no per-user opt-in. The agent gateway is already
a **shared, long-running singleton** that accepts **per-run** identity/context through `config["configurable"]`
(subject token, `user_id`, UI snapshot), so per-user model/credential injection is architecturally feasible without
a new gateway endpoint.

## 3. Goals

- **G1** — Assistant is **off by default** for new users; it only runs after the user explicitly enables and
  configures it.
- **G2** — **No shared model and no shared TMDB key.** Remove all shared-environment credential paths from the
  user-facing runtime; each user brings their own.
- **G3** — Users select a supported **provider** (Ollama or Anthropic) and set provider-specific config, plus their
  own TMDB key, from the **Profile screen**.
- **G4** — Per-user config and secrets are **encrypted at rest, scoped to one user, and persist across sessions**.
- **G5** — Credentials are **validated before saving** (live probe), and an already-saved key can be **re-tested**
  from the Profile screen **without re-entering it**.
- **G6** — **No API key ever lands in a file that could be committed to GitHub** (fixtures, cassettes, snapshots,
  test scripts, `.env` checked in, logs).

## 4. Non-goals

- No new model providers beyond **Ollama** and **Anthropic** (the currently supported set). The data model is
  extensible for later providers, but adding them is out of scope here.
- No team/shared/org-level config sharing — config is strictly per individual user.
- No billing/quota/cost-accounting changes beyond what already exists (the user now pays their own provider
  directly via their own key).
- No changes to the agent's *capabilities* (intents, tools, graph). This feature is purely **how the assistant is
  enabled and credentialed per user**.
- No migration of existing shared-env deployments to per-user rows beyond the test/golden harness (there is no
  production user base relying on shared config).

## 5. Users & stories

- **As a new user**, I see the assistant is off, and the app does not call any model on my behalf until I turn it on.
- **As a user**, I open Profile, enable the Movie Assistant, choose **Ollama** and enter my Ollama base URL **or**
  choose **Anthropic** and enter my Anthropic API key, and enter my own TMDB API key.
- **As a user**, when I save, the app tells me immediately if a credential is wrong (per-field error) instead of
  failing mid-conversation.
- **As a user**, I can click **Test connection** later to confirm my already-saved key still works, without
  re-typing it.
- **As a user**, I can disable the assistant; the dock disappears and no agent runs occur.
- **As an operator**, I never hold users' model/TMDB credentials in shared env, and no user's secret can leak into
  source control or logs.

## 6. Functional requirements

### 6.1 Default state & gating

- **FR-1** New users have **no** `user_agent_config` record → assistant **disabled**. The assistant dock
  (`AuthedAssistant`) does **not** mount/open while disabled.
- **FR-2** An agent run is only possible when the caller's config exists **and** `enabled = true` **and** the
  required credentials for the chosen provider are present. Otherwise the BFF **short-circuits** the run with a typed
  `assistant_not_configured` response — **no gateway call, no cost**.

### 6.2 Configurable fields (per user)

- **FR-3** `enabled: boolean`.
- **FR-4** `provider: "ollama" | "anthropic"`.
- **FR-5** Provider-specific fields:
  - Ollama → `ollamaBaseUrl` (e.g. `http://localhost:11434`). *(Plaintext config, not a secret.)*
  - Anthropic → `anthropicKey` *(secret)*.
- **FR-6** `tmdbKey` *(secret)* — the user's own TMDB v3 API key, required for any TMDB-backed capability
  (enrich/search/details).
- **FR-6a** `costLimitUsd: number | null` — a **per-user spend ceiling** that overrides the existing global
  default. When `null`/unset, the runtime falls back to the **current** global ceiling (`AGENT_ESTIMATED_TURN_COST_USD`
  and its `agent-cost:{identifier}` budget window) so behaviour is unchanged for users who never touch it. The
  per-run cost guard uses `costLimitUsd ?? globalDefault`; exceeding it short-circuits the run with the existing
  cost-ceiling response, now keyed per user. Since each user pays their own provider, this caps their own spend.
- **FR-7** Escalation note: the agent's escalation tier is **always an Anthropic (Claude) model**. Escalation is
  therefore only available to a user who has an Anthropic key on file. A user on Ollama may optionally also supply an
  Anthropic key to unlock escalation; if no Anthropic key is present, escalation is unavailable for that user and the
  graph degrades to the user's base provider. This is surfaced in the UI, not silently failed.

### 6.3 Profile screen UI

- **FR-8** New **"Movie Assistant"** section in `frontend/mcm-app/src/components/profile-display.tsx` containing:
  enable/disable toggle, provider picker, provider-specific field(s), TMDB key field, an optional **cost limit
  (USD)** field (empty = use default), **Save**, and **Test connection** controls.
- **FR-9** Secret fields (Anthropic key, TMDB key) are **write-only**: the UI shows a *“configured”* indicator and
  the masked/empty input, **never the stored value**. Use `NoAutoFillInput` (per the project password-manager rule)
  for all fields except where the registration exclusion applies (N/A here).
- **FR-10** Editing/saving is platform-parity across web and mobile (Playwright + Maestro coverage).

### 6.4 BFF API (new routes under `bff-api/agent/config`)

- **FR-11** `GET /bff-api/agent/config` → returns **non-secret** view:
  `{ enabled, provider, ollamaBaseUrl, hasAnthropicKey, hasTmdbKey, costLimitUsd, updatedAt }`.
  **Never returns secret values.** (`costLimitUsd` is not a secret; `null` means "using default".)
- **FR-12** `PUT /bff-api/agent/config` → **validate-on-save**:
  - Run live probes for whatever is being set: Ollama `GET {ollamaBaseUrl}/api/tags`; Anthropic a cheap
    authenticated call; TMDB `GET /authentication` (or `/configuration`) with the supplied key.
  - On any failure → `422` with per-field `{ field, reason }`; nothing is persisted.
  - On success → **encrypt secrets** and **upsert** the record.
  - A `PUT` that omits a secret field leaves the stored secret unchanged (allows editing non-secret fields without
    re-entering keys).
- **FR-13** `POST /bff-api/agent/config/test` → runs the same probes against the **already-stored, server-side-
  decrypted** credentials and returns per-provider status `{ ollama?, anthropic?, tmdb?: "ok" | { reason } }`.
  **The secret is never sent to the client in either direction.** Powers the **Test connection** button for a saved
  key.
- **FR-14** `DELETE /bff-api/agent/config` → clears the record (or sets `enabled=false` and wipes secrets) for the
  caller.
- **FR-15** All routes enforce `requireAuth` then `requireMcUser`, are strictly **caller-scoped** (the `userId` comes
  from the validated session, never from the request body), and emit audit events on create/update/delete/test
  (`logger.audit`), with **no secret material** in any log line.

### 6.5 Per-run credential injection (runtime)

- **FR-16** `frontend/mcm-app/src/app/bff-api/agent/run+api.ts` loads the caller's `user_agent_config`, decrypts the
  needed secrets **in memory only**, and passes provider + credentials to the gateway through the existing
  `config["configurable"]` channel (the same mechanism as subject token / UI snapshot). No new gateway endpoint.
- **FR-17** `agents/movie-assistant/src/models.py` (`select_model_config` / model build) and
  `mcp-servers/web-api-mcp/src/server.py` (`_tmdb_key`) read provider/model/credentials from the **per-run
  `configurable`**, not from process env. **All user-facing shared-env credential paths are removed.**
- **FR-18** Decrypted secrets are **per-run, in-memory only** — never written to LangGraph checkpoints, the agent
  Postgres state, OTel spans, LangFuse traces, or logs (extends the existing SC-004 token-leak discipline to the
  user's keys).

## 7. Data & security design

### 7.1 Storage

- **Store:** a new **MongoDB collection `user_agent_config`** accessed by the **BFF** via a new BFF→Mongo client.
  (The BFF does not touch Mongo today; this introduces that dependency deliberately — chosen over Redis-no-TTL for
  true durability and over mc-service because this is auth/BFF-adjacent, not movie-domain.)
- **Document shape:**
  ```jsonc
  {
    "_id": "<keycloak userId>",
    "enabled": true,
    "provider": "anthropic",
    "ollamaBaseUrl": "http://localhost:11434",   // null when provider=anthropic
    "anthropicKeyEnc": "<AES-256-GCM blob>",      // absent if not set
    "tmdbKeyEnc": "<AES-256-GCM blob>",           // absent if not set
    "costLimitUsd": null,                          // null = use global default ceiling
    "updatedAt": "2026-06-18T00:00:00Z"
  }
  ```

### 7.2 Encryption

- Secrets are encrypted with **AES-256-GCM** (authenticated encryption; store IV + auth tag with the ciphertext)
  **before** the document is written. Decryption happens **only** transiently in the BFF when minting a per-run
  config (FR-16) or running a saved-key test (FR-13).
- The master key comes from **`AGENT_CONFIG_ENC_KEY`** — supplied via **Vault in production** and local env in
  development. The key is **never** committed (see §9) and **never** logged.
- Plaintext secrets are **never persisted** and **never returned** to the client (GET exposes only `has*` flags).

### 7.3 Secret hygiene — no keys in source control (G6)

- **NFR-Sec-1** `AGENT_CONFIG_ENC_KEY` and any per-user API keys used by tests are sourced **only** from gitignored
  local env / CI secret store — **never** literals in code, fixtures, cassettes, snapshots, or checked-in `.env`.
- **NFR-Sec-2** Test/golden harness seeds `user_agent_config` rows from `process.env` / CI secrets at runtime
  (see §8), so no real key text exists in any committed test artifact.
- **NFR-Sec-3** The logger redaction list is extended to cover the new secret fields (`anthropicKey`, `tmdbKey`,
  `anthropicKeyEnc`, `tmdbKeyEnc`, `AGENT_CONFIG_ENC_KEY`); existing redaction of `token`/`secret`/`authorization`
  already applies.
- **NFR-Sec-4** A CI guard (grep/secret-scan, e.g. key-shaped `sk-ant-` / TMDB-token patterns) fails the build if a
  key-shaped string is committed. Cassettes recorded for the golden gate must contain **no** authorization headers
  or key values (assert during record).

## 8. Testing strategy (per MCM-Testing-Strategy.md / CLAUDE.md)

- **Shared-env model paths are removed everywhere**, so the test, integration, and golden-cassette harnesses
  **seed a `user_agent_config` row** for their user instead of relying on env:
  - Unit/integration & web/mobile E2E: seed the E2E test user with `provider=ollama` (+ TMDB key) from env/CI secrets.
  - Golden/cassette gate: seed an Anthropic-configured row from a CI secret; replay remains keyless (cassettes carry
    no key material — NFR-Sec-4).
- **TDD**: tests written → approval → RED → implement → GREEN, per task template.
- **Integration (real collaborators)**: BFF↔Mongo encryption round-trip (encrypt→store→read→decrypt yields original;
  ciphertext ≠ plaintext); `PUT` validation probes against real Ollama/TMDB (and a stubbed-failure path for the 422
  branch); `POST /config/test` against a stored key.
- **E2E (web Playwright + mobile Maestro)** — required for this feature:
  - New user → assistant disabled → dock hidden.
  - Enable + configure (Ollama) + save → dock appears → an agent run succeeds.
  - Save with a bad key → per-field 422 surfaced, nothing persisted.
  - Test connection on a saved key (no re-entry) → status shown.
  - Disable → dock disappears, run short-circuits.
- **Security assertions**: `GET` never returns secret values; logs/spans/traces/checkpoints contain no key material;
  CI secret-scan guard green.
- Web E2E runs via the **dev-container** path (rebuild image after src changes); mobile agent flows run in CI.

## 9. Configuration & env summary

| Variable | Where | Purpose | Notes |
|---|---|---|---|
| `AGENT_CONFIG_ENC_KEY` | BFF | AES-256-GCM master key for per-user secrets | Vault (prod) / local env (dev); **never committed** |
| `MONGO_*` (BFF) | BFF | BFF→Mongo connection for `user_agent_config` | New BFF dependency |
| ~~`MODEL_PROVIDER`, `OLLAMA_BASE_URL`, `ANTHROPIC_API_KEY`~~ | gateway | **Removed** from user-facing runtime | Replaced by per-run `configurable` |
| ~~`TMDB_API_KEY`~~ | web-api-mcp | **Removed** from user-facing runtime | Replaced by per-run `configurable` |
| `SUPERVISOR_MODEL` / `SPECIALIST_MODEL` / `ESCALATION_MODEL` | gateway | Model *names* per tier | May remain operator-set defaults; **credentials** are per-user |

> Whether the per-tier **model names** stay operator-set or become user-overridable is an open question (§11). The
> **credentials** are unconditionally per-user.

## 10. Success criteria

- **SC-1** A brand-new user has the assistant disabled and triggers zero model/TMDB calls until they opt in.
- **SC-2** No shared model or shared TMDB key path exists in the user-facing runtime (verified by code + a run with
  no env credentials set, which still works for a configured user and short-circuits for an unconfigured one).
- **SC-3** Per-user config + secrets persist across sessions and restarts (durable Mongo; decrypt round-trip green).
- **SC-4** Save rejects invalid credentials with a per-field error; **Test connection** validates a saved key with
  no re-entry.
- **SC-4a** A user who sets no cost limit gets the existing global ceiling unchanged; a user who sets one has runs
  short-circuited at their own ceiling.
- **SC-5** No API key appears in any committed file, log, span, trace, or checkpoint (secret-scan + assertions green).
- **SC-6** Web + mobile E2E for enable/configure/save/test/disable all green.

## 11. Open questions

1. **Model-name overrides:** do users pick only the *provider/credentials*, or also override per-tier **model
   names** (`SUPERVISOR_MODEL` etc.)? Default assumption: provider + credentials only; model names stay
   operator-set defaults.
2. **Escalation UX:** exact wording/affordance for "escalation needs an Anthropic key" when a user is Ollama-only
   (FR-7).
3. **Key rotation / `AGENT_CONFIG_ENC_KEY` rotation:** re-encrypt strategy if the master key rotates (envelope
   encryption vs. re-wrap job) — likely a follow-up.
4. **Mongo placement:** `user_agent_config` in `mc_db` vs. a separate BFF-owned database/credentials.
```
