# Contract: BFF Agent Config API

Base path: `/bff-api/agent/config` (Expo Router API routes; server-side BFF only).

**Common to all routes**:
- Auth: `requireAuth(headers)` → `requireMcUser(user)` (401 / 403). The owning user is `user.id` from the validated session — **never** read from the request body (FR-017).
- Each route is registered in the `AGENT_ROUTES` allowlist exercised by `tests/integration/agent-route-auth.integration.test.ts` (compensating control for the no-global-middleware gap).
- Errors flow through `handleMcApiError(err, action)` → RFC-9457-style problem responses; security headers via `securityHeaders()`.
- Audit: create/update/delete/test emit `logger.audit(...)` with `userId` only, no secret material (FR-019).
- No secret value is ever returned to the client, in any route (FR-018).

---

## GET `/bff-api/agent/config`

Returns the non-secret view (FR-011/FR-018). If no document exists, returns the disabled default.

**200**:
```jsonc
{
  "enabled": false,
  "provider": "ollama",
  "ollamaBaseUrl": null,
  "hasAnthropicKey": false,
  "hasTmdbKey": false,
  "costLimitUsd": null,
  "escalationAvailable": false,
  "updatedAt": null
}
```
(`updatedAt: null` and all-false flags denote a brand-new/unconfigured user.)

**401/403**: unauthenticated / not an mc-user.

---

## PUT `/bff-api/agent/config`

Validate-on-save (FR-012) then encrypt + upsert (FR-013). A secret field omitted from the body leaves the stored secret unchanged (FR-014).

**Request** (all fields optional except where provider makes them required):
```jsonc
{
  "enabled": true,
  "provider": "anthropic",
  "ollamaBaseUrl": "http://localhost:11434",  // required when provider=ollama
  "anthropicKey": "sk-ant-…",                  // secret; omit to keep existing
  "tmdbKey": "…",                              // secret; omit to keep existing
  "costLimitUsd": 0.50                          // or null to use default
}
```

**Validation order**: (1) shape/enum/type checks (`400` on malformed `provider`/`costLimitUsd`/URL shape); (2) live probes (≤5s each) for every credential **being set** and for the credentials the chosen provider requires; (3) on all-pass, encrypt secrets + upsert + set `updatedAt`.

**200**: the non-secret view (same shape as GET) reflecting the saved state.

**422** (probe failure — nothing persisted, FR-012):
```jsonc
{
  "type": "about:blank",
  "title": "Credential validation failed",
  "status": 422,
  "errors": [
    { "field": "anthropicKey", "reason": "Authentication failed (invalid key)" },
    { "field": "tmdbKey", "reason": "Authentication failed (invalid key)" }
  ]
}
```

**400**: malformed body (unknown provider, non-URL `ollamaBaseUrl`, negative/non-numeric `costLimitUsd`). **401/403** as above.

---

## POST `/bff-api/agent/config/test`

Re-run the probes against the **already-stored, server-side-decrypted** credentials (FR-013/FR-015). No request body needed; no secret entered or returned.

**200**:
```jsonc
{
  "ollama": "ok",                                  // present only if provider=ollama / baseUrl on file
  "anthropic": { "reason": "invalid key" },        // present only if an anthropic key is on file
  "tmdb": "ok"                                     // present only if a tmdb key is on file
}
```
Each value is `"ok"` or `{ "reason": "<safe message>" }`. Credentials not on file are omitted.

**409** (or `422`) when there is nothing to test (no stored credentials) — implementation picks one; documented in quickstart. **401/403** as above.

---

## DELETE `/bff-api/agent/config`

Clear semantics (FR-016, clarification R9): set `enabled=false`, wipe `anthropicKeyEnc`/`tmdbKeyEnc`, **keep** `provider`/`ollamaBaseUrl`/`costLimitUsd`.

**200**: the non-secret view reflecting the cleared state (`enabled=false`, `hasAnthropicKey=false`, `hasTmdbKey=false`, non-secret settings preserved).

**401/403** as above.
