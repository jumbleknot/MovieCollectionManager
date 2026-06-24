# Contract: Production realm export & OAuth client

**Artifact**: `infrastructure-as-code/docker/keycloak/prod-realm.json` (imported via `--import-realm`).

## MUST hold (verifiable)

1. `realm` is `grumpyrobot`; client `movie-collection-manager` is present with roles `mc-admin` and `mc-user`.
2. `bruteForceProtected: true`.
3. `registrationAllowed: false` (self-registration deferred until real SMTP).
4. `smtpServer` is empty/placeholder — no real mail-server credentials.
5. No real client secrets are present anywhere in the file.
6. The client's **valid redirect URIs** contain `https://mcm.${BASE_DOMAIN}/*` **and** the mobile callback (app-link / custom scheme), and contain **no** dev URIs (`localhost:8099`, `10.0.2.2`).
7. The client's **web origins** contain `https://mcm.${BASE_DOMAIN}` (no wildcard).
8. This file is distinct from the throwaway CI realm (`ci-realm.json`).

## Verify

- `node scripts/secret-scan.mjs` passes for the file (no credential-shaped strings) (SC-005).
- After import: an authenticated login from each client type completes without a redirect loop (FR-017); repeated failed logins lock the account (SC-008); brute-force config is visible in the realm.
- Grep the file for `localhost:8099` / `10.0.2.2` → no matches.
