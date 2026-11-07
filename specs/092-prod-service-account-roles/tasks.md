# Tasks 092: Record what production's Keycloak needs

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

- [X] **T001** Add `scripts/__tests__/keycloak-service-account-roles.guard.test.mjs` (FR-003).
  **Verify RED**: fails on the unchanged `prod-realm.json`.
- [X] **T002** Add the service account and exact redirect addresses to `prod-realm.json` (FR-001, FR-002).
  **Verify GREEN**: the same test passes.
- [X] **T003** Add `keycloak-assign-role.test.ts` and failure-logging tests to `register+api.test.ts`.
  **Verify RED**: the refused-step and logging cases fail.
- [X] **T004** Check each step in `assignMcUserRole`, and log server-side failures in the register route
  (FR-004, FR-005). **Verify GREEN**: the same tests pass.
- [X] **T005** Prove SC-001 and SC-002 against real Keycloak images, with `prod-realm.json` rendered.
- [ ] **T006** Operator: add the four missing addresses in the console. **Verify** (SC-003): production's
  Keycloak accepts `/bff-api/account/delete`. **Quote** the result.
- [ ] **T007** Open the PR and get green CI. **Quote** the run numbers.

## Evidence

| Task | Result | Run |
|---|---|---|
| T001 RED | On the unchanged `prod-realm.json`: `fail 3`, `pass 2`, `must define the mcm-bff-service service account`, and the address list differs | Local |
| T002 GREEN | `pass 15`, `fail 0`, with `keycloak-realm-schema.test.mjs` and `keycloak-admin-api-scope.guard.test.mjs` | Local |
| T003 RED | `Tests: 4 failed, 8 passed`: three refused steps in `assignMcUserRole`, and the failure log | Local |
| T004 GREEN | `Tests: 15 passed`, with `register-enforcement.test.ts` | Local |
| T005, SC-001 | Rendered `prod-realm.json`, fresh import on 26.8.1 and 26.8.2. Roles `manage-users, view-users, view-clients, query-clients, query-groups, query-users`. Create user 201, client lookup 200, role read 200, assign `mc-user` 204, count `mc-admin` 200, write to a client 403 | Local |
| T005, SC-002 | On both versions: all six listed addresses 200, `/not-listed` 400 | Local |
| T006, before | Production, 2026-11-07: `/auth-callback` 200. `/bff-api/account/delete`, `mcm-app://account-delete-callback`, `/login?verified=true`: 400 `Invalid parameter: redirect_uri` | Read-only request to production's Keycloak |
| T006, after | | |
| T007 | | |
