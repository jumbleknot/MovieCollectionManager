# Data Model: BFF Auth Fail-Closed Hardening (085)

Redis is the only store touched. See research R3 for why there are two keys.

## Session record — `session:{sessionId}` (unchanged shape)

| Field | Type | Rule |
|---|---|---|
| `sessionId` | UUID v4 string | The opaque reference. It reaches the client only as the `mcm_session_id` cookie. |
| `userId` | Keycloak `sub` | The owner. A token whose `sub` differs is refused (FR-006). |
| `createdAt` | epoch ms | |
| `lastActivityAt` | epoch ms | Slid by every successful `requireAuth`. The write is `SET … XX`, so it never re-creates a deleted record. |
| `expiresAt` | epoch ms | `createdAt + SESSION_ABSOLUTE_TIMEOUT_MS`. Key TTL = remaining absolute lifetime. |

**Liveness, checked in this order on every authenticated request:**
1. **Missing:** `SESSION_NOT_FOUND`.
2. **Absolute:** `now > expiresAt` gives `SESSION_ABSOLUTE_TIMEOUT` and deletes both keys (FR-012).
3. **Idle:** `now - lastActivityAt > SESSION_IDLE_TIMEOUT_MS` gives `SESSION_IDLE_TIMEOUT` and
   deletes both keys (FR-023).
4. **Tokens key missing or undecryptable:** `SESSION_NOT_FOUND` and deletes the record. This is
   the state of every session created before the rollout (FR-022).

## Session tokens — `session-tokens:{sessionId}` (new)

Stored value: `{"v":1,"blob":"<base64 iv‖tag‖ciphertext>"}`. The plaintext of `blob` (JSON) is:

| Field | Type | Source |
|---|---|---|
| `accessToken` | JWT | Keycloak `access_token` |
| `refreshToken` | opaque | Keycloak `refresh_token` |
| `accessExpiresAt` | epoch ms | `now + expires_in·1000` at issue |
| `refreshExpiresAt` | epoch ms | `now + refresh_expires_in·1000` at issue |

**Sealing:**
- The cipher is AES-256-GCM via `encryptSecret`/`decryptSecret` (`agent-config-crypto.ts`), with
  the key `AGENT_CONFIG_ENC_KEY`.
- The AAD is `sessionTokensAad(sessionId, userId)`, which is `${sessionId}:${userId}:sessionTokens`.
- The TTL is the same as the session record's, and it is reset whenever the tokens are written.

**Rules:**
- Written only at login (create) and renewal, the latter under `session-renew:{sessionId}`.
- Deleted together with the record on logout, eviction, absolute expiry, idle expiry, a rejected
  renewal, an owner mismatch and account deletion (FR-020).
- Never logged, never audited, and never returned in a response body or `Set-Cookie` (FR-016,
  FR-017).

## Renewal lock — `session-renew:{sessionId}` (new)

`SET NX EX 15`, with a random holder id. It is released with `releaseLockIfHeld`, the existing
compare-and-delete EVAL. A loser waits for the tokens key to advance (research R4).

## Per-user session index — `user-sessions:{userId}` (unchanged)

Eviction (`evictOldestSession`) and `terminateAllSessions` now delete the tokens key as well.

## State transitions

```text
                login (code+PKCE)            renewal ok (sub matches)
   (none) ───────────────────────▶ LIVE ◀──────────────────────────┐
                                    │  │                             │
          request within limits ────┘  └── access ≤ 30 s from expiry ┘
                                    │
   logout / evict / absolute / idle / renewal rejected / owner mismatch / account deleted
                                    ▼
                                 DELETED   (both keys gone; the cookie is cleared on the response)

   renewal transient (network, timeout, 5xx) ── stays LIVE, the request gets 503
```

## Client-held state after this feature

| Where | Holds |
|---|---|
| Web cookie jar | `mcm_session_id` only (`HttpOnly; SameSite=Strict; Path=/`, `Secure` outside development) |
| Android cookie jar | the same single cookie |
| Android SecureStore | the opaque session id as a startup hint (unchanged, and permitted by the constitution) |
