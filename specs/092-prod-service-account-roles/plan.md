# Plan 092: Record what production's Keycloak needs

**Spec**: [spec.md](./spec.md)

## Approach

Realm files apply only when a realm is first created, so `prod-realm.json` changes nothing on the running
production realm. The operator's console changes do that, and this records them.

## Measured

Throwaway containers, starting from production's measured roles, on 26.8.1 and 26.8.2:

| Roles added | Client lookup | Role members | Write to a client |
|---|---|---|---|
| None | 403 | Not reached | Not reached |
| `query-clients` | 200, empty list | Not usable | Not usable |
| `view-clients` | 200 | 200 | 403 |

`query-clients` looks like the smaller grant, but it would have moved the failure to `Client not found`.

## Known limit

With `view-clients`, the service account can read `mc-admin` and assign it, because `manage-users` allows the
assignment. CI and dev work the same way. So the BFF's service credential can make an account an
administrator, and it should be protected accordingly.

## Rollback

Revert the merge. Existing realms are unaffected, because realm files apply only on first creation. The
stricter checks then go too, and registration goes back to failing silently if a step is refused.
