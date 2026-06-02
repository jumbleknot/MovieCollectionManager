# Phase 1 Data Model: Full-Repo Review Remediation

This feature changes **validation rules, field-mutation rules, and key-lifetime rules** on existing entities. No new persisted entity is introduced and **no schema/index migration** is required (the movie uniqueness index is untouched — #2 is out of scope).

---

## Movie (`movies` collection / mc-service Domain + Adapters)

| Field | Change | Rule |
|---|---|---|
| `title` | Validation added | MUST be non-empty (trimmed) on create and update (FR-022). |
| `language` | Validation added | MUST be non-empty (trimmed) on create and update (FR-022). |
| `createdAt` | Mutation rule | **Immutable after creation** — an update MUST preserve the original value; only `updatedAt` changes (FR-013). |
| `updatedAt` | Unchanged | Set to now on every write. |
| `externalIds[].url` | Validation added | If present, scheme MUST be `http` or `https`; other schemes rejected at create/update (FR-001). |
| `externalIds[]` (system, uniqueId) | Validation enforced | Non-empty required parts + no duplicate `(system, uniqueId)` pairs, now enforced on the wire/create-update path (previously bypassed by serde `Deserialize`) (FR-002). |

**Validation placement**: Domain-Layer Specifications (`HttpUrlSpec`, `RequiredStringSpec`, existing duplicate check) invoked by the `create_movie` / `update_movie` Application-Layer handlers. No domain invariant is bypassable via the DTO path after this change.

---

## ExternalIdentifier (Domain value object)

- `url: Option<String>` — when `Some`, MUST pass `HttpUrlSpec` (scheme ∈ {`http`, `https`}).
- `system`, `unique_id` — MUST be non-empty (already in `new()`, now also enforced when constructed from deserialized DTO input).
- Validation is enforced regardless of construction path (constructor **or** serde deserialization).

---

## Collection (`movie_collections` / mc-service)

- `isDefault` — at most one default per owner (existing invariant), now maintained **atomically**:
  - Setting a collection as default MUST validate the target exists and is owned by the caller **before** clearing the current default (FR-014).
  - A combined PATCH (set-default + other field changes) is all-or-nothing: any failure leaves the prior default unchanged (FR-015).
  - Implemented via a MongoDB transaction (replica-set; same pattern as cascade delete).

---

## Session (Redis, BFF)

| Aspect | Change | Rule |
|---|---|---|
| Key TTL | Corrected | TTL = remaining absolute lifetime (`expiresAt - now`, seconds), refreshed on activity — a backstop **≥** policy, never below it (FR-010/011). |
| Idle expiry | Unchanged authority | Enforced in `getValidSession` against the configured idle window; breach → delete + `null` (fail-safe, FR-012). |
| Absolute expiry | Unchanged authority | Enforced in `getValidSession` against `expiresAt`; breach → delete + `null`. |
| Concurrent cap | Corrected | Active session count MUST NOT exceed the configured maximum even under simultaneous logins (atomic eviction-to-cap) (FR-018). |
| Corrupt value | Hardened | A value that fails `JSON.parse` is treated as no session (return `null`, delete key) — never an unhandled error (FR-021). |
| Side-effects | Access rule | Session lookup/mutation/termination only after authentication, only on the caller's own session (FR-004/005). |

---

## Rate-Limit Identity (Redis counters, BFF)

- **Login/logout identity**: derived from the trusted-proxy forwarding header when the peer is a configured trusted proxy; otherwise the connection remote address. Never the shared `'unknown'` bucket (FR-007/008).
- **Registration**: throttled per source (IP-derived as above) **in addition to** the existing per-email limit, so varying the email cannot grant unlimited registrations from one source (FR-009).
- Thresholds/windows themselves are unchanged.

---

## Pagination Cursor (movie list, mc-service)

- A malformed/undecodable cursor MUST yield a `400` problem response, not a silent restart at page 1 (FR-019). The decode function returns a typed error consumed by the list handler.

---

## PasswordStrength (client util)

- `score` MUST stay within its documented `0–4` range for all inputs (return the clamped value, not the raw passed-criteria count) (FR-020). `checks` and `label` unchanged.
