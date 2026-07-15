# Contract: Realm client-set consistency (US1 / FR-013) & no-literal-secret (FR-004)

**Guarantee**: `dev-realm.json` stays consistent with `ci-realm.json`'s client/user set and contains no literal secret.

## `check-realm-consistency.mjs`

Compares `infrastructure-as-code/docker/keycloak/dev-realm.json` against `ci-realm.json`:

- **PC-1**: both have `realm == "grumpyrobot"`.
- **PC-2**: the set of app `clients[].clientId` in dev-realm equals that in ci-realm (default KC clients — account, admin-cli, broker, realm-management, security-admin-console, account-console — may be compared or explicitly exempted; decide and document in the script).
- **PC-3**: `e2e-test-user` is present in `users[]` in both.
- **PC-4** (`--selftest`): a deliberately mutated fixture (missing client / extra client / missing user) makes the check FAIL, proving it is not trivially green.

Runs in **guardrails** (`--selftest` then real), gating any PR that edits either realm file. (research R-A3)

## No-literal-secret

- **PC-5**: every client secret and the test-user password in `dev-realm.json` is a `${ENV_VAR}` placeholder (regex: no bare secret-shaped value on a `secret`/`credentials` field).
- **PC-6**: `node scripts/secret-scan.mjs` and `node scripts/check-no-inline-secrets.mjs` stay green with `dev-realm.json` committed. (AC4)
- **PC-7**: `git check-ignore infrastructure-as-code/docker/keycloak/dev-realm.json` reports the file is **not** ignored (it is a tracked artifact, like `ci-realm.json`). (research R-G1)
