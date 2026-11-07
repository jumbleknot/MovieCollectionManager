# Plan 090: Keycloak Admin API scope

**Spec**: [spec.md](./spec.md). A realm-data and script change. No application code changes.

## Approach

Measured on isolated containers with `ci-realm.json` and throwaway secrets, 2026-11-06:

| Case | Admin API result |
|---|---|
| 26.8.1, unchanged realm | 200 |
| 26.8.2, fresh import, unchanged realm | 401 |
| 26.8.1 data upgraded to 26.8.2 | 401 |
| 26.8.2, fresh import, file only references the scope | 401, the reference is ignored |
| 26.8.2, fresh import, file defines and assigns the scope | 200 |
| 26.8.1, the same file | 200 |
| 26.8.1 with a plain audience mapper, upgraded to 26.8.2 | 401, although `aud` carries the same URL |
| 26.8.2 upgraded, then scope assigned | 200 |
| 26.8.1, scope created and assigned, then upgraded | 200, one scope, migration unaffected |

The last row means a realm whose admin can sign in with a password can be prepared first, with no window
where admin calls fail. Production cannot, because its admin uses two-factor, so it takes the row above it:
upgrade, then assign the scope in the console. The scope's definition is copied from what 26.8.2 generates,
so the realm files and the migration agree.

## Rollback

Revert the merge. On a realm the script changed, the scope is harmless on 26.8.1. On 26.8.2 it must stay.
