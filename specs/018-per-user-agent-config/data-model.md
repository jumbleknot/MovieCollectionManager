# Phase 1 Data Model: Per-User Movie Assistant Configuration

## Entity: User Agent Config

The single per-user record governing whether/how the assistant runs. Stored in MongoDB collection `user_agent_config` (database `mc_db`), owned by the BFF. One document per user.

### Persisted document (at-rest shape)

| Field | Type | Required | Secret | Description |
|---|---|---|---|---|
| `_id` | string | yes | no | Keycloak `userId` (the validated-session subject). Primary key; enforces 1:1 per user. |
| `enabled` | boolean | yes | no | Whether the assistant may run for this user. Defaults conceptually to `false` (absence of doc ⇒ disabled). |
| `provider` | enum `"ollama" \| "anthropic"` | yes | no | Active base model provider. |
| `ollamaBaseUrl` | string \| null | conditional | no | Required (non-secret) when `provider="ollama"`; `null`/absent otherwise. Validated URL shape. |
| `anthropicKeyEnc` | string (base64 GCM blob) | conditional | **yes** | Encrypted Anthropic API key. Required when `provider="anthropic"`. May also be present for an `ollama` user to unlock escalation (retained across provider switch — R9). Absent if never set / wiped. |
| `tmdbKeyEnc` | string (base64 GCM blob) | yes* | **yes** | Encrypted TMDB v3 key. Required to enable/run (clarification: metadata key is a required credential). Absent only when config is cleared/never-configured. |
| `costLimitUsd` | number \| null | no | no | Personal per-user spend ceiling override. `null`/absent ⇒ use global default ceiling. |
| `updatedAt` | string (ISO-8601 UTC) | yes | no | Last write time. |

`*tmdbKeyEnc` is required for the config to be **runnable**; a partially-entered doc may transiently lack it, but `enabled` runnability requires it (FR-002).

Each `*Enc` blob encodes `iv (12B) || authTag (16B) || ciphertext`, base64-encoded. Encrypted with `AGENT_CONFIG_ENC_KEY` (AES-256-GCM). Each blob is additionally bound by GCM **AAD = `${userId}:${field}`** (e.g. `${userId}:tmdbKey`) — the AAD is authenticated by the tag but NOT stored in the blob, so a blob can only be decrypted in the exact (owner, field) context it was sealed in; a cross-user or cross-field mixup fails the auth check rather than silently decrypting (FR-027, review #10). The schema reserves room for a future `keyId` field if envelope/rotation is later added (out of scope — R2).

### Non-secret projection (GET response — FR-011/FR-018)

Never includes any `*Enc` value or plaintext secret:

```jsonc
{
  "enabled": true,
  "provider": "anthropic",
  "ollamaBaseUrl": null,
  "hasAnthropicKey": true,
  "hasTmdbKey": true,
  "costLimitUsd": null,
  "escalationAvailable": true,   // derived: hasAnthropicKey
  "updatedAt": "2026-06-18T00:00:00Z"
}
```

`hasAnthropicKey` / `hasTmdbKey` are presence booleans derived from the existence of the corresponding `*Enc` field. `escalationAvailable = hasAnthropicKey` (R10).

### Per-run resolved config (in-memory only — FR-020, never persisted/logged)

Assembled transiently in the BFF after decrypt, serialized to the `X-Agent-Config` header:

```jsonc
{
  "provider": "anthropic",
  "ollamaBaseUrl": null,
  "anthropicKey": "<plaintext, in-memory only>",
  "tmdbKey": "<plaintext, in-memory only>"
  // model-name overrides intentionally omitted — names stay operator-set (spec assumption)
}
```

This object exists only for the lifetime of one run, never enters graph state, checkpoints, spans, traces, or logs (SC-004 extension).

## Validation Rules (server-side, whitelist — FR-012)

| Rule | Applies to | Enforcement |
|---|---|---|
| `provider ∈ {ollama, anthropic}` | PUT | Reject `400` on unknown provider before any probe. |
| `ollamaBaseUrl` is a well-formed `http(s)` URL | PUT when provider=ollama | Shape check, then live `GET /api/tags` probe. |
| `anthropicKey` validity | PUT when setting it / provider=anthropic | Live `GET /v1/models` probe; `422 {field:"anthropicKey"}` on failure. |
| `tmdbKey` validity | PUT when setting it | Live `GET /authentication` probe; `422 {field:"tmdbKey"}` on failure. |
| `costLimitUsd` is a non-negative number or null | PUT | Type/range check; `400` otherwise. |
| All-or-nothing persistence | PUT | If any probe fails, persist nothing (FR-012). |
| Omitted secret ⇒ unchanged | PUT | A PUT without a secret field leaves the stored `*Enc` intact (FR-014). |
| Runnable ⇒ enabled ∧ provider-cred-present ∧ tmdbKey-present | run gate | Server short-circuit otherwise (FR-002). |

## State Transitions

```text
(no document)                      ── user PUT (valid) ──▶  configured + enabled
   │  assistant disabled, dock hidden, run short-circuits
   │
configured + enabled               ── user disables (PUT enabled=false) ──▶  configured + disabled
   │  dock hidden, run short-circuits; secrets retained
   │
configured (+/- enabled)           ── user DELETE/clear ──▶  cleared (enabled=false, secrets wiped, non-secret kept)
   │  dock hidden; re-enable needs secrets re-supplied (R9)
   │
configured                         ── PUT provider switch ──▶  configured (other provider's secret retained — R9)
   │
configured + enabled + invalid key ── PUT (probe fails) ──▶  unchanged (422, nothing persisted)
```

## Relationships

- **User (Keycloak identity) 1 ── 0..1 User Agent Config**: keyed by `_id = userId`. No document ⇒ brand-new-user disabled state.
- **References (not foreign keys)**: `costLimitUsd` overrides the global `AGENT_ESTIMATED_TURN_COST_USD` ceiling for the same `agent-cost:{userId}` Redis window (no schema link; runtime composition only).
- No relationship to movie-domain entities — this config is auth/BFF-adjacent, deliberately outside mc-service.

## Indexes

- Primary `_id` (userId) — the only access path is by owning user; no secondary index needed. 1:1 cardinality, point reads only.

## Supporting (non-persisted) types

- **Supported Provider** (enum + capability map): `ollama` (requires `ollamaBaseUrl`, base tier only) · `anthropic` (requires key, base + escalation tier). Escalation tier is **always** Anthropic regardless of base provider (FR-008).
- **Credential Validation Result**: `{ field: "ollamaBaseUrl"|"anthropicKey"|"tmdbKey", status: "ok" | { reason: string } }` — produced by probes for both save-time validation and on-demand test (FR-013); never carries the secret value.
