# Contract: Public Registration-Status + Register Enforcement (Item 1)

## GET /bff-api/auth/registration-status  (PUBLIC — unauthenticated)

**Route file**: `frontend/mcm-app/src/app/bff-api/auth/registration-status+api.ts`
**Auth**: none. **Purpose**: let the signed-out `(auth)` screens decide whether to show the "Create Account" entry point (they have no session and cannot call the admin-gated endpoint).

**Request**: no body, no cookie required.

**200 OK**
```json
{ "allowed": true }
```
- Reads `app_settings`; returns `{ "allowed": true }` when the setting is on or the document is absent (default), `{ "allowed": false }` when disabled.
- **Exposes exactly one boolean** — no `updatedBy`/`updatedAt`/other settings (least-privilege public surface).

**Notes**: safe to call from an unauthenticated context; must not require or leak session data; must not error-out the login screen (on an unexpected store error, prefer returning `{ allowed: true }`-with-logged-warning OR a handled error the client treats as "show the link" — the *authoritative* block is server-side at register).

---

## POST /bff-api/auth/register — enforcement change

**Route file**: `frontend/mcm-app/src/app/bff-api/auth/register+api.ts`
**Change**: at the top of `_post()`, **before** `createUser`, read `app_settings`. If `allowSelfRegistration === false`:
- Return **403** with a typed error (FORBIDDEN-style) and a clear user-facing message ("Self-registration is currently disabled.").
- Emit `logger.audit('registration_refused_disabled', { ip })`.
- Do **not** call the Keycloak Admin API / create any user.

When enabled: existing behavior (validate → rate-limit → `createUser` → `assignMcUserRole` → `sendVerificationEmail` → 201) is unchanged.

**Fail-closed**: an unexpected error reading the setting on this path must not silently allow registration — surface an error (refuse) rather than proceed.

---

## Contract tests (author first — TDD)

Public status:
- 200 `{ allowed:true }` with no document (default).
- 200 `{ allowed:false }` after admin disables; `{ allowed:true }` after re-enable.
- Response body contains **only** `allowed` (no other keys).
- Callable with no session cookie.

Register enforcement:
- 403 + audit when disabled; no Keycloak user created (assert against real Keycloak in integration — user absent).
- 201 (existing happy path) when enabled.
- Enforcement is independent of the client (a direct POST is refused even though the UI would have hidden the link).
