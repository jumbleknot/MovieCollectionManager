---
type: Service
title: Keycloak (Identity and Access Management)
description: The Keycloak IAM instance that handles user authentication, session token issuance, and RFC 8693 token exchange for the entire MCM platform — realm grumpyrobot, three compose variants (dev/CI/prod), and the realm JSON rules that cost a full CI run when broken.
resource: infrastructure-as-code/docker/keycloak/README.md
tags: [auth, keycloak, iam, docker, realm, jwt]
timestamp: 2026-08-11T09:44:23Z
---

# Keycloak (Identity and Access Management)

Keycloak is the identity provider for the entire MCM platform. It runs as a containerized service in
the `auth` Compose stack, deployed under the Komodo `prod-auth` stack in production. It is the only
authority for user identities, OAuth2 token issuance, and the RFC 8693 token exchange that the agent
layer depends on.

**Realm:** `grumpyrobot`. Client roles `mc-user` (default at registration) and `mc-admin`. Users
self-register and are assigned `mc-user` automatically. The realm name is intentional and stable
across environments — do not confuse it with the organization name.

The service exposes port **8099** externally on the host; containers on the shared Docker network
reach it via `keycloak-service:8080` (feature 020 unified the service key and `container_name` to
`keycloak-service`; the old bare `keycloak` name no longer resolves).

See [Authentication and authorization chain](/openwiki/invariants/auth-chain.md) for how every
downstream component enforces the tokens Keycloak issues, and
[Infrastructure-as-code stacks](/openwiki/projects/infrastructure-stacks.md) for how `auth` fits
into the overall stack topology and start-order rules.

## Three realm variants

| File | Used by | Token lifetime |
|------|---------|----------------|
| `dev-realm.json` | Local dev (`compose.dev.yaml` overlay, `--import-realm`) | `accessTokenLifespan: 300` s |
| `ci-realm.json` | CI `app-ci.yml` bring-up | `accessTokenLifespan: 5400` s |
| `prod-realm.json` | Production (`compose.prod.yaml`, rendered via `envsubst`) | Deployment config |

The CI realm uses a 90-minute token lifetime deliberately: Playwright creates a fresh `BrowserContext`
per test, each reloading a `storageState` snapshot taken at global-setup time. With a 300 s token the
snapshot is expired five minutes in, causing every later test to need a refresh — measured at 1.9 s
median against the BFF's per-session limit of 2 refreshes per 30 s, which rejected 35 of 115
attempts. A token that outlives the 75-minute job timeout removes the driver. `dev-realm.json` stays
at 300 s so local development sees realistic expiry; `agent-session-refresh.spec.ts` provides
deliberate refresh coverage by clearing the access cookie explicitly.

## Dev auto-import

On a fresh `keycloak-store-postgres-data` volume, `pnpm nx up-auth infrastructure-as-code` imports
the `grumpyrobot` realm, its app clients, and `e2e-test-user` automatically — no manual import step.
After import, `node scripts/gen-dev-env.mjs` projects client secrets into `frontend/mcm-app/.env.docker`
so the imported realm's secrets equal the dev BFF's secrets by construction. Import is
`IGNORE_EXISTING`: an established volume with an existing realm is untouched.

## Gotchas

**Realm JSON takes NO comments — not even a `_comment` key.** Keycloak's import deserializes realm
files into `RealmRepresentation` with unknown fields **rejected**; an extra key does not get
silently ignored. The container goes unhealthy and every dependent job dies at bring-up:

```text
ERROR: Unrecognized field "_comment_accessTokenLifespan" (class org.keycloak.representations.idm.RealmRepresentation)
ERROR: Failed to run import
```

Measured on app-ci run 1611 (feature 052): a one-line explanatory key cost a full CI run.
`python -c "import json"` says the file is valid — JSON syntax is not the constraint, the Keycloak
schema is. A local parse check proves nothing. `scripts/__tests__/keycloak-realm-schema.test.mjs`
fails on any `_`-prefixed key at any depth. **Document realm settings in the README, not in the JSON.**

**To prove a realm edit actually imports, run the importer against the real image before pushing:**

```bash
mkdir -p /tmp/kcimport && cp ci-realm.json /tmp/kcimport/grumpyrobot-realm.json
docker run --rm \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  -e KEYCLOAK_CLIENT_SECRET=x -e KEYCLOAK_SERVICE_CLIENT_SECRET=x \
  -e AGENT_SUBJECT_TOKEN_CLIENT_SECRET=x -e E2E_TEST_PASSWORD=x -e MCM_BFF_TEST_CLIENT_SECRET=x \
  -v /tmp/kcimport:/opt/keycloak/data/import:ro \
  quay.io/keycloak/keycloak:26.7.0 import --dir /opt/keycloak/data/import
# want: "Realm 'grumpyrobot' imported"
```

Any non-empty placeholder values work for a syntax/schema proof; the `${VAR}` refs are resolved from
container env at import time.

**Removing a client requires removing ALL its references.** Dropping a client from a realm export
(e.g. the test-only `mcm-bff-test`) requires also deleting its `roles.client[<id>]` entry and any
`scopeMappings` — not just the client object. A dangling reference makes `--import-realm` abort in
production mode with `App doesn't exist in role definitions: <id>` and crash-loops `keycloak-service`.

**`${BASE_DOMAIN}` in `prod-realm.json` is rendered by hand with `sed`, not `envsubst`.** Use
`sed 's|${BASE_DOMAIN}|<domain>|g'` — `envsubst` would also expand Keycloak's own `${role_*}` /
`${client_*}` i18n placeholders and corrupt the realm. Verified: 32 such placeholders survive the
`sed` render intact.

**`keycloak-service` can lose `backend-network` on reboot (prod).** Confirmed on 2026-07-06: after a
reboot the container came back attached only to `edge-network` and `keycloak-network`, missing
`backend-network`, which broke `mc-service`'s JWKS discovery (`dns error … Try again`). Fix: a
Komodo `prod-auth` redeploy (NOT a manual `docker network connect` — that is a one-off that the next
reboot can lose). The compose file already declares `backend-network`; a redeploy recreates the
container with the full declared network set durably. Feature 029 additionally makes the intra-stack
`keycloak-network` compose-managed (was `external: true`) so Keycloak can always reach its Postgres
even if the external nets race on reboot.

**The prod admin console port is 19099, not 8099.** Prod and the CI runner share one host under two
rootless Docker daemons publishing into the same port space. CI publishes `127.0.0.1:8099`; a
`0.0.0.0:8099` prod bind overlaps it and crash-looped `prod-auth` for 6 h on 2026-07-06. Feature 029
moved prod Keycloak's admin binding to port 19099 (`KC_HOSTNAME_ADMIN`), disjoint from all CI/dev
ports. See [Published-port reservation](/openwiki/invariants/published-port-reservation.md).

**Bring `auth` up before the `mcm` `app` profile.** `mc-service` fetches Keycloak's JWKS endpoint on
startup to cache the public key for JWT validation. There is no cross-project `depends_on` (removed
in feature 020); the ordering is manual. Starting `--profile app` without Keycloak running causes
`mc-service` to hang.

**Stale-password recovery wipes the DB volume — but no longer drops you into an empty Keycloak.**
After wiping `keycloak-store-postgres-data` and restarting, `up-auth` re-imports the `grumpyrobot`
realm automatically (feature 039). Full recovery: force-remove containers first (or the attached
volume silently blocks the wipe), then wipe the volume, then re-run `gen-dev-secrets.mjs` +
`gen-dev-env.mjs`, then `pnpm nx up-auth`.

**Any confidential Keycloak client whose secret isn't pinned in the realm JSON gets a fresh random
secret on import.** After a new volume import, read the generated client secrets from the Keycloak
admin console and update the matching Komodo Variables before deploying dependent services.
