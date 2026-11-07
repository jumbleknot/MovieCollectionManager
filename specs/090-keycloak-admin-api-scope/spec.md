# Spec 090: The BFF's service account keeps Admin API access on Keycloak 26.8.2

**Status**: Complete. **Input**: PR #950 is red, and the cause also reaches production.

## Problem

Keycloak 26.8.2 requires a token for the Admin REST API to carry the new `kc-admin-api` client scope.
Keycloak gives that scope to `admin-cli` and `security-admin-console`, but not to our own clients. So
the BFF's `mcm-bff-service` token is refused with 401, logged as
`Expected audience not available in the token`.

Upgrading does not repair this. A realm moved from 26.8.1 to 26.8.2 gains the scope, and the client
still gets 401. In production that stops user lookup, registration, verification email, forced logout
and the last-administrator check, none of which CI's fresh-import stack would reveal.

## Requirements

- **FR-001**: `ci-realm.json`, `dev-realm.json` and `prod-realm.json` MUST define `kc-admin-api` and
  assign it to `mcm-bff-service` as a default scope. Referencing it without defining it does not work:
  import logs `Referenced client scope 'kc-admin-api' doesn't exist. Ignoring`.
- **FR-002**: A script MUST make the same change on a running realm, for realms that already exist.
  It MUST change nothing unless given `--apply`, MUST reject unknown arguments, and MUST be safe to
  run again.
- **FR-003**: The script MUST work on 26.8.1, so production is ready before Keycloak is upgraded.
- **FR-004**: A guard MUST fail if any realm file loses the scope or the assignment.
- **FR-005**: The Keycloak README MUST say when to run the script. A realm without the scope must not
  reach 26.8.2.

## Success criteria

- **SC-001**: A fresh import of each changed file gives 200 on the Admin API on 26.8.2, and on 26.8.1.
- **SC-002**: A realm on 26.8.1, after the script, gives 200 on the Admin API before and after the
  upgrade to 26.8.2, with one `kc-admin-api` scope.
- **SC-003**: PR #950 is green once rebased on this change.

## Out of scope

- Other clients. Only `mcm-bff-service` calls the Admin API with a service account here.
- Running the script on production. It cannot sign in as an admin with two-factor, so the operator assigns
  the scope in the console straight after the upgrade instead (T006).
