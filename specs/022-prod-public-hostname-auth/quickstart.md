# Quickstart: Production Public-Hostname Authentication

A validation/run guide proving the feature end to end. Details live in [contracts/](./contracts/) and [data-model.md](./data-model.md); this is the runbook to verify, not implementation code.

## Prerequisites

- Repo checked out on branch `022-prod-public-hostname-auth`; Node 24 + pnpm available.
- For local config validation: Docker (Compose v2). For deploy/E2E: the homelab `prod` rootless daemon, a Cloudflare Tunnel, and tailnet access (operator).
- Real prod secret values available to inject (operator/Komodo) — never committed.

## A. Static validation (no deploy — runs anywhere)

```bash
# 1. Naming gate (must pass once edge-network is allowlisted)
node scripts/check-resource-naming.mjs --section=all

# 2. Secret gates (selftest then scan) — must pass with the new prod files present
node scripts/check-no-inline-secrets.mjs --selftest && node scripts/check-no-inline-secrets.mjs
node scripts/secret-scan.mjs --selftest && node scripts/secret-scan.mjs

# 3. Fail-fast proof (RED): with no .env.prod present and a required var unset, `config` aborts
#    naming the first missing var (no silent fallback). Set every var EXCEPT one to prove each.
KC=infrastructure-as-code/docker/keycloak/compose.prod.yaml
docker compose -f "$KC" config   # RED: "required variable BASE_DOMAIN is missing a value: ..."
# GREEN: all vars set AND a throwaway .env.prod present (the env_file must exist) → exit 0
cp infrastructure-as-code/docker/keycloak/.env.prod.example infrastructure-as-code/docker/keycloak/.env.prod
BASE_DOMAIN=example.com KC_ADMIN_BIND_IP=100.64.0.1 KC_HOSTNAME_ADMIN=http://h.tailnet.ts.net:8099 \
  KC_BOOTSTRAP_ADMIN_PASSWORD=x KC_DB_PASSWORD=x PROD_REALM_FILE=/tmp/x.json \
  docker compose -f "$KC" config >/dev/null && echo OK   # expect: OK
rm infrastructure-as-code/docker/keycloak/.env.prod

# 4. Realm export carries no secrets / no dev URIs / no scrubbed domain
node scripts/secret-scan.mjs   # covers prod-realm.json (whole-tree)
grep -nE 'localhost|10\.0\.2\.2|grumpyrobot\.co' infrastructure-as-code/docker/keycloak/prod-realm.json   # expect: no matches
```

**Expected**: gates green; compose `config` fails-then-succeeds around the secret; realm has no secrets/dev URIs.

## B. Regression (existing suites stay green)

```bash
pnpm nx test mcm-app -- --testPathPattern auth      # BFF cookie unit tests: Secure + SameSite=Strict
pnpm nx e2e mcm-app                                  # web E2E login regression (dev-container path)
```

**Expected**: cookie tests assert `Secure`+`SameSite=Strict`; web login E2E passes.

## C. Production deploy verification (operator, post-deploy)

```bash
# Issuer is the PUBLIC origin (SC-002)
curl -s https://auth.${BASE_DOMAIN}/realms/grumpyrobot/.well-known/openid-configuration | grep -o '"issuer":"[^"]*"'
# expect: "issuer":"https://auth.${BASE_DOMAIN}/realms/grumpyrobot"

# Admin console NOT public (SC-004) — expect no admin UI on the public host
curl -sI https://auth.${BASE_DOMAIN}/admin/   # expect: not the admin console (404/redirect), reachable only on the tailnet

# Only app./auth. are public (SC-003) — every other service must not resolve/respond publicly
```

## D. Off-network device login (manual E2E — headline acceptance, SC-001)

1. Build the prod APK: `APK_VARIANT=release EXPO_PUBLIC_BFF_BASE_URL=https://mcm.${BASE_DOMAIN} EXPO_PUBLIC_BFF_NATIVE_URL=https://mcm.${BASE_DOMAIN} EXPO_PUBLIC_KEYCLOAK_NATIVE_URL=https://auth.${BASE_DOMAIN} node frontend/mcm-app/scripts/build-apk.mjs` (values from CI variables in the real pipeline).
2. Install on a real device; disable Wi-Fi (cellular only, no LAN access).
3. Open the app → sign in → confirm redirect to `auth.`, credential entry, callback to `mcm.`, and a protected screen loads.
4. Leave the session idle past the access-token lifetime, make a request → confirm transparent refresh (SC-007).
5. Enter a wrong password repeatedly → confirm temporary lockout (SC-008, brute-force).

**Expected**: full OAuth round-trip succeeds off-network on both mobile and a public-network browser.

## Done

- A + B are green in CI/local; C + D pass on the deployed prod environment. C/D depend on the operator deploy steps (Komodo Stacks, Cloudflare routes, secret injection) documented in `docs/proposals/homelab-setup/` — they are out of this feature's code scope.
