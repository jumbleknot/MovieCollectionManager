# Data model: self-service account deletion

**Feature**: 076-account-deletion · **Date**: 2026-09-24

This feature creates **one** new persisted structure — a short-lived pending request in Redis. Every
other entity it touches already exists and is only destroyed. That asymmetry is the point: a
deletion feature that introduced durable state would be suspicious.

---

## 1. New: `PendingAccountDeletion`

A user's in-progress intent, parked server-side while they are away at the identity provider.

**Store**: Redis. **Key**: `account:delete:pending:{userId}`. **TTL**: 300 seconds (FR-011).
**Access**: park on challenge, *take* single-use on callback (`GETDEL` semantics, mirroring
`takeBackupConsentRequest`).

| Field | Type | Notes |
|---|---|---|
| `state` | string | 16 random bytes, base64url. CSRF: compared on the callback. |
| `codeVerifier` | string | 40 random bytes, base64url. **Never leaves the server** on the web path. |
| `redirectUri` | string | Stashed, not recomputed — both OAuth legs must present an identical value or the exchange fails `invalid_grant` (research R2). |
| `authTimeFloor` | number | Unix seconds. The `auth_time` of the session that requested deletion. The step-up's `auth_time` must exceed this, so reusing the original login cannot satisfy the step-up. |
| `requestedAt` | number | Unix seconds. Belt-and-braces against a Redis TTL that did not fire. |

**Validation rules**

- `state` must match exactly, or the callback is refused (FR-010).
- The record is consumed on read. A second callback with the same code finds nothing and is refused
  (FR-010: "already been used once").
- Absence means no request is pending — refuse and tell the user to start again from Settings
  (FR-012).

**Lifecycle**

```
(none) ──challenge──▶ pending ──callback, checks pass──▶ consumed ──▶ deletion runs
                         │                    │
                         │                    └──checks fail──▶ consumed, refused, nothing destroyed
                         └──300s elapse──▶ expired (FR-011, FR-012)
```

Note that a *failed* callback still consumes the record. A proof that did not satisfy the checks
must not be retryable against the same pending request.

**Not persisted, deliberately**: the user's email address. FR-031 forbids retaining it, and there is
nothing to send (backlog item #551).

---

## 2. New: `StepUpProof` (transient, never stored)

The verified result of the exchange. Exists only as a value inside the callback handler's stack for
the duration of the request.

| Field | Source | Check applied |
|---|---|---|
| `sub` | ID token | Must equal the session's userId (FR-010). |
| `auth_time` | ID token | Must be present, within 300s of now, and `> authTimeFloor` (FR-009, FR-010). **Absent is a refusal**, never a pass. |
| `access_token` | token response | Used for the mc-service collection deletes (research R4). |
| `refresh_token` | token response | Revoked in a `finally`, on both the success and the failure path. |

`amr` is deliberately absent from this table: T001 measured the live realm and Keycloak does not
emit it for this client, so there is nothing to record.

**Why it is never stored**: it is proof of a moment. Persisting it would create exactly the kind of
reusable standing credential this feature exists to destroy.

---

## 3. Existing entities, and what happens to each

Enumerated from the accessors in research R7, not from memory. The **order** column is the
destruction sequence and is normative — see plan.md.

| Order | Entity | Where it lives | Operation | Retry-safe because |
|---|---|---|---|---|
| 1 | Standing permission | `user_agent_config.offlineRefreshEnc` + Keycloak | Revoke at IdP, then `$unset` | `revokeOfflineToken` returns early when none is stored |
| 1 | Backup destinations | Mongo | `deleteMany({ userId })` | Matches zero the second time |
| 1 | Backup jobs | Mongo | `deleteMany({ userId })` | Same |
| 1 | Backup runs | Mongo | `deleteMany({ userId })` | Same |
| 2 | Collections + movies | mc-service / Mongo | `DELETE /api/v1/collections/{id}` per collection | **`404` must be treated as success** — written, not inherited |
| 3 | Agent config document | Mongo `user_agent_config` | `deleteOne({ _id: userId })` | Matches zero the second time |
| 4 | Cached user profile | Redis | delete | Unconditional |
| 4 | Agent UI snapshot | Redis | delete | Unconditional |
| 4 | Agent import file reference | Redis | `clearAgentImportFile` | Unconditional |
| 4 | Pending backup consent | Redis | take | Unconditional |
| 5 | Sessions | Redis | `terminateAllSessions` | No-op on zero sessions |
| 5 | IdP SSO session | Keycloak | `logoutUserSessions` | Idempotent |
| 6 | The account | Keycloak | `deleteUser` | **`404` must be treated as success** — written, not inherited |

### Steps 1 and 3 are one constraint, not two

The standing permission is stored **inside** the agent config document as `offlineRefreshEnc`.
Deleting that document (step 3) before revoking the permission (step 1) destroys the only record of
a token still live at Keycloak, leaving nothing in this system that knows it exists. That is backlog
item #544's failure reintroduced in a worse form, because no user remains to notice. FR-022 states
the rule; this table's ordering enforces it.

### Explicitly untouched

| Entity | Why |
|---|---|
| Backup artifacts at the user's destination | The user's property, at storage they own (FR-023). The pipeline must not construct a destination driver at all. |
| Agent-gateway LangGraph checkpoints | `graph.py:579` resolves to `MemorySaver()` — in-process, never persisted. There is nothing at rest to purge. |
| Agent thread-owner claims | Keyed by `thread_id`, not by user, so not enumerable by user. They carry the session's absolute TTL and expire on their own; the value is an opaque userId, not personal data. |
| Audit entries | The one sanctioned exception to FR-024. Retained 90 days per the constitution. |

---

## 4. Audit events

Written synchronously before the operation they record is treated as complete (constitution, Log
Delivery Guarantee). Every one carries `userId` and client IP; none carries a credential, token,
session id, or the user's name or email (FR-037).

| Event | When | Extra fields |
|---|---|---|
| `account_deletion_requested` | Challenge issued | — |
| `account_deletion_reauth_rejected` | Any step-up check fails | `reason` (one of: `no_pending`, `state_mismatch`, `subject_mismatch`, `stale_auth`, `missing_auth_time`) |
| `account_deletion_refused_last_admin` | FR-013 refusal | — |
| `account_deletion_failed` | Any pipeline step throws | `step` (the ordered step number/name) |
| `account_deletion_completed` | The account is gone | `collectionsDeleted` count |

`reason` and `step` are enumerated rather than free-text so a failure can be counted, and so no
message from a downstream system leaks into the audit stream.
