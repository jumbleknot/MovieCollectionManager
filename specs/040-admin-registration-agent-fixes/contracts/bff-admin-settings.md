# Contract: Admin Settings API (Item 1)

**Route file**: `frontend/mcm-app/src/app/bff-api/admin/settings+api.ts`
**Auth**: `requireAuth(headers)` → `requireMcAdmin(user)` (first production use). Non-admin → 403; unauthenticated → 401.
**Content-Type**: `application/json`. Errors follow the shared typed-error shape (RFC 9457-compatible where applicable).

---

## GET /bff-api/auth/../admin/settings

Read the global application settings (admin only).

**Request**: no body. Session cookie required.

**200 OK**
```json
{
  "allowSelfRegistration": true,
  "updatedBy": "b1f2...uuid" ,
  "updatedAt": "2026-07-15T12:00:00.000Z"
}
```
- On a fresh deploy with no document: `{ "allowSelfRegistration": true, "updatedBy": null, "updatedAt": null }`.

**401** — no/invalid session. **403** — authenticated but not `mc-admin`. Both the 401 and 403 paths MUST emit a `logger.audit` access-denied/auth-failure event (FR-007) — either here or centrally in `requireAuth`/`requireMcAdmin` (confirm which).

---

## PATCH /bff-api/auth/../admin/settings

Change the self-registration setting (admin only).

**Request**
```json
{ "allowSelfRegistration": false }
```
- `allowSelfRegistration` REQUIRED, boolean. Any other/missing/non-boolean value → 400.

**200 OK** — returns the updated settings (same shape as GET), with `updatedBy` = the admin's Keycloak UUID and a fresh `updatedAt`.

**Side effects**:
- Upserts the `app_settings` `"global"` document.
- Emits `logger.audit('admin_setting_changed', { setting:'allowSelfRegistration', value, userId, ip })`.

**400** — invalid body. **401** — no session. **403** — not `mc-admin`.

---

## Contract tests (author first — TDD)

- 401 when unauthenticated (GET + PATCH) — and an audit event is emitted.
- 403 when authenticated as a non-admin (`mc-user`) (GET + PATCH) — and an audit event is emitted.
- 200 GET returns default `{ allowSelfRegistration:true, updatedBy:null, updatedAt:null }` when no doc.
- 200 PATCH `{false}` persists and returns `allowSelfRegistration:false` with `updatedBy`=admin UUID; a follow-up GET reflects it.
- 400 PATCH with a non-boolean / missing field.
- Audit event emitted on PATCH (assert via logger spy / captured output).

Integration tests run against **real Mongo + real Keycloak** (admin + non-admin tokens); test docs cleaned in `afterAll`; isolated key/namespace.
