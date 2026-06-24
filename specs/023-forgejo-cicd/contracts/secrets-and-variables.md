# Contract: Secrets & Variables

Inventory of every credential/config value the pipeline needs, and **which store** holds it. The governing rule: **nothing here is ever committed to git** (constitution §Secrets Management). CI values live in Forgejo Actions; prod values live in Komodo/Vault; the two stores are separate (FR-018).

## Forgejo Actions — Secrets (CI, encrypted)

| Secret | Used by | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | app-ci | agent flows in CI (anthropic provider, avoids Ollama pull) |
| `E2E_TEST_USER` | app-ci | Maestro/Playwright login (must match `ci-realm.json` user) |
| `E2E_TEST_PASSWORD` | app-ci | login password for the test user |
| `KEYCLOAK_CLIENT_SECRET` | app-ci | fills `frontend/mcm-app/.env.docker` (throwaway CI value) |
| `KEYCLOAK_SERVICE_CLIENT_SECRET` | app-ci | service-account client secret (throwaway CI value) |
| `COOKIE_SECRET` | app-ci | BFF session cookie secret (throwaway CI value) |
| `KC_DB_PASSWORD` (CI) | app-ci | Keycloak DB; also written to `secrets/keycloak_db_password.txt` |
| `FORGEJO_REGISTRY_TOKEN` | cd-deploy | `docker login` to the Forgejo OCI registry |
| `KOMODO_WEBHOOK_AUTH` | cd-deploy | auth for the Komodo Stack redeploy webhook/API |
| `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` | app-ci, cd-deploy | Nx remote cache auth |

## Forgejo Actions — Variables (CI, non-secret)

| Variable | Value kind | Purpose |
|---|---|---|
| `REGISTRY` | host:port | Forgejo OCI registry host (no literal in YAML) |
| `NS` | string | registry namespace/owner |
| `REGISTRY_USER` | string | registry login user |
| `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` | URL | Nx cache server endpoint |
| `MODEL_PROVIDER` | `anthropic` | agent provider in CI |
| `KOMODO_WEBHOOK_URL` | URL | Stack redeploy endpoint (host topology, not a secret but kept out of YAML) |

## Komodo / Vault — Prod secrets (never in CI store, never in git)

| Secret | Stack | Purpose |
|---|---|---|
| `BASE_DOMAIN` | all prod | real public domain (injected at deploy; never committed) |
| `KC_DB_PASSWORD` (prod) | prod-auth | Keycloak Postgres password (+ matching `secrets/keycloak_db_password.txt`) |
| `KC_BOOTSTRAP_ADMIN_PASSWORD` | prod-auth | first-run bootstrap admin (retired after named-admin+2FA) |
| BFF cookie/session secrets | prod-app | prod `COOKIE_SECRET`, client secrets |
| client secrets | prod-app | `movie-collection-manager` prod client secret |

## Rules

1. Every value above is referenced by name (`${{ secrets.X }}` / `${{ vars.X }}` / `${VAR:?…}`), never inlined. The `secret-scan` + `check-no-inline-secrets` gates (run in `guardrails`) enforce this on every push.
2. A required **prod** secret that is unset MUST abort the deploy naming the variable (`${VAR:?set in <store>}`), never fall back (FR-019).
3. `ci-realm.json`'s embedded secrets are **throwaway CI values** only; they are not the prod client secrets (which live in Komodo/Vault).
4. Host/topology variables (`REGISTRY`, `KOMODO_WEBHOOK_URL`, cache server) are kept in the variable store — not committed — to honor the no-infra-literal rule even though they are not secrets.
