# Contract: Production Keycloak configuration

**Artifact**: `infrastructure-as-code/docker/keycloak/compose.prod.yaml` (`name: prod-auth`) + `prod-realm.json` + `.env.prod`.

## MUST hold (verifiable)

1. `command` is `start` (production mode), not `start-dev`.
2. `KC_HOSTNAME=https://auth.example.invalid`, `KC_HOSTNAME_BACKCHANNEL_DYNAMIC="true"`, `KC_HTTP_ENABLED="true"`, `KC_PROXY_HEADERS=xforwarded`.
3. The OpenID discovery document fetched over `https://auth.example.invalid/realms/grumpyrobot/.well-known/openid-configuration` reports `"issuer": "https://auth.example.invalid/realms/grumpyrobot"`.
4. The admin console is **not** served on the public `auth.` host; the host port is bound to the tailscale IP only (`<tailscale-ip>:8099:8080`) and `KC_HOSTNAME_ADMIN` is the tailnet URL.
5. The Postgres service publishes **no** host port.
6. `KC_BOOTSTRAP_ADMIN_PASSWORD` is a fail-fast `${VAR:?…}` reference; the DB password is a file-secret (`POSTGRES_PASSWORD_FILE`). No credential literal appears in the file.
7. The dev mailpit service is absent.
8. `--import-realm` is wired and `prod-realm.json` is mounted read-only.
9. Networks include `keycloak-network`, `backend-network`, `edge-network` (all external).

## Verify

- `docker compose -f compose.prod.yaml config` succeeds **only** when required vars are set, and **fails naming the var** when one is unset/blank (FR-020, SC-006).
- `node scripts/check-no-inline-secrets.mjs` and `node scripts/secret-scan.mjs` pass for the file (SC-005).
- `node scripts/check-resource-naming.mjs --section=all` passes (requires `edge-network` allowlisted).
- Post-deploy: `curl https://auth.example.invalid/realms/grumpyrobot/.well-known/openid-configuration` → issuer is the public origin (SC-002); the admin console URL on the public host returns nothing (SC-004).
