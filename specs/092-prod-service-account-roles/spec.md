# Spec 092: Record what production's Keycloak needs, and make its absence visible

**Status**: Complete | **Date**: 2026-11-07

## Problem

Production's realm was configured by hand and has drifted from what the BFF needs. CI cannot see this,
because it imports its own realm file. T017 of feature 087 found it, measured on production on 2026-11-07:

- **Service account.** `mcm-bff-service` held `manage-users, view-users, query-groups, query-users`. The
  client lookup answered 403, so account deletion failed for an administrator, and registration would
  create an account and then fail to give it a role. `prod-realm.json` defines no service account at all.
- **Redirect addresses.** `movie-collection-manager` allowed only `/auth-callback` and
  `mcm-app://native-auth-callback`. Keycloak answers 400 `Invalid parameter: redirect_uri` for
  `/bff-api/account/delete` and `mcm-app://account-delete-callback`, so no account can reach the deletion
  sign-in, and for `/login?verified=true`. `/bff-api/auth/init` is meant to register these, but it needs
  `manage-clients`, which production has never held.
- **No trace.** `assignMcUserRole` never checked the role assignment's result, and the register route logged
  nothing on failure.

The operator corrects the running realm by hand. This feature stops a rebuild losing it, and stops the next
failure being silent.

## Requirements

- **FR-001**: `prod-realm.json` MUST define the service account with exactly `view-users`, `view-clients`
  and `manage-users`. `manage-clients` MUST NOT be granted: it would let the BFF edit any client.
- **FR-002**: `prod-realm.json` MUST list every address `/bff-api/auth/init` registers for
  `movie-collection-manager`, in place of the `https://mcm.${BASE_DOMAIN}/*` wildcard.
- **FR-003**: A guard MUST fail if `prod-realm.json` loses any of these, or if `/bff-api/auth/init` starts
  registering an address `prod-realm.json` does not list.
- **FR-004**: `assignMcUserRole` MUST fail if any Keycloak step is refused.
- **FR-005**: The register route MUST log a server-side failure, without the request body. It MUST NOT log a
  refusal the caller caused.

## Success criteria

- **SC-001**: A fresh import of the rendered `prod-realm.json`, on 26.8.1 and 26.8.2, lets the service
  account perform registration's calls and count administrators, and refuses it a write to a client.
- **SC-002**: The same import accepts each listed redirect address and refuses an unlisted one.
- **SC-003**: After the operator's correction, production's Keycloak accepts `/bff-api/account/delete`.

## Out of scope

- Removing an account left without a role when registration fails part-way.
- The misleading message when deletion is refused, tracked as a backlog item.
- Changing `/bff-api/auth/init`, which stays as it is for dev and CI. In production, with every address
  listed, it finds nothing to add and attempts no write.
