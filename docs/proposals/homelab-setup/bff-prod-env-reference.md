# DRAFT — prod BFF env reference (feature 022 promotion)

> ⚠️ **SUPERSEDED** — promoted to `infrastructure-as-code/docker/bff/.env.prod.example`. The
> TODO(022) split is resolved there: non-secret config (`KEYCLOAK_URL`, `KEYCLOAK_REALM`, …) is
> inlined in `compose.prod.yaml`; this template carries only `BASE_DOMAIN`, the mandatory secrets,
> and the optional agent secret. Kept for proposal history only.

Staged by feature 023 alongside [bff-prod.compose.yaml](./bff-prod.compose.yaml). When feature 022
promotes the compose to `infrastructure-as-code/docker/bff/compose.prod.yaml`, create the committed
template `infrastructure-as-code/docker/bff/.env.prod.example` from the block below (that path IS
un-ignored by `.gitignore` — `!infrastructure-as-code/docker/**/*.env.prod.example`; this `docs/`
copy is a `.md` so the `*.env.*` ignore rule doesn't swallow it).

Keys mirror what the BFF reads (`config/env.ts`, `config/keycloak.ts`, `frontend/mcm-app/.env.docker.example`).
Placeholders only — never commit real values. On the prod host: `cp .env.prod.example .env.prod && chmod 600 .env.prod`.

```ini
# Public base domain (also the Komodo Stack env / Forgejo BASE_DOMAIN var). e.g. example.com
BASE_DOMAIN=<your-public-base-domain>

# ── Keycloak ─────────────────────────────────────────────────────────────────────
# TODO(022): resolve the internal-vs-public split (bff-prod.compose.yaml TODO(022).1).
# The BFF derives KEYCLOAK_ISSUER from KEYCLOAK_URL; prod tokens are issued at https://auth.${BASE_DOMAIN}.
KEYCLOAK_URL=http://keycloak-service:8080
KEYCLOAK_PUBLIC_URL=https://auth.<your-public-base-domain>
KEYCLOAK_REALM=grumpyrobot
KEYCLOAK_CLIENT_ID=movie-collection-manager
KEYCLOAK_CLIENT_SECRET=<prod movie-collection-manager client secret>
KEYCLOAK_SERVICE_CLIENT_ID=mcm-bff-service
KEYCLOAK_SERVICE_CLIENT_SECRET=<prod mcm-bff-service client secret>

# ── Sessions / cookies ───────────────────────────────────────────────────────────
COOKIE_SECRET=<min-32-char random; crypto.randomBytes(32).toString('hex')>
SESSION_IDLE_TIMEOUT_MS=1800000
SESSION_ABSOLUTE_TIMEOUT_MS=86400000
MAX_CONCURRENT_SESSIONS=10

# ── Agent layer (feature 018/012) ──────────────────────────────────────────────────
# AES-256-GCM key for the per-user encrypted agent config store (feature 018). 32-byte hex.
AGENT_CONFIG_ENC_KEY=<32-byte-hex agent config encryption key>
# Subject-token mint (RFC 8693). Leave the secret EMPTY to DISABLE minting until prod-agents is up.
AGENT_SUBJECT_TOKEN_CLIENT_ID=agent-subject-token
AGENT_SUBJECT_TOKEN_CLIENT_SECRET=
AGENT_SUBJECT_TOKEN_AUDIENCE=agent-gateway
```

> `MCM_BFF_IMAGE` (the registry digest) is supplied by the Komodo Stack env / cd-deploy manifest, **not** `.env.prod` — it changes every deploy.
