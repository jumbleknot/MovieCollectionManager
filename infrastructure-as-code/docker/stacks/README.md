# Stack env files

Feature 021 (externalize-compose-secrets) removed every clear-text credential from the tracked
Docker Compose files. **Not every secret is a fail-fast `${VAR:?…}` reference.** Most are, but:

- the BFF (`bff/compose.yaml`) loads `frontend/mcm-app/.env.docker` with `env_file:`;
- web-api-mcp (`web-api-mcp/compose.yaml`) loads `mcp-servers/web-api-mcp/.env.local` with `env_file:`;
- the agent gateway keeps `AGENT_GATEWAY_CLIENT_SECRET` as an optional `${…:-}`, so it can come up
  without token exchange. `scripts/check-no-inline-secrets.mjs` allowlists it by name.

The real per-machine values for the `${VAR:?…}` references live in gitignored per-stack `.env` files
generated from committed templates.

## Profiles gate services, not stacks

No stack is profile-gated as a whole. `auth` and `mcm` each have services that start with no profile:

| Stack | Starts with no profile | Needs a profile |
|---|---|---|
| `auth` | `keycloak-service`, `keycloak-store-postgres`, `keycloak-mailpit` | Vault (`vault`) |
| `mcm` | the test infra: `mc-service-store-mongo` + its rs-init, `mcm-bff-cache-redis`, `mcm-bff-store-mongo` | mc-service (`app`), the BFF (`bff-secure` / `bff-nonsecure`), the agent layer (`agents`; the gateway also `agents-metro`) |
| `audit` | nothing | every service (`audit`) |
| `observability` | nothing | every service (`observability`) |

The profile assignments live in the component compose files, not in these stack files.

## Files

| File | Tracked? | Purpose |
|---|---|---|
| `<stack>.env.example` | ✅ committed | Placeholder template. `NAME=<generate:KIND>` for minted values; `NAME=literal` for deterministic fixtures. |
| `<stack>.env` | ❌ gitignored | Generated real values. Compose reads it via the stack's `include` `env_file:` and the Nx target `--env-file`. **Never commit.** |

`<stack>` ∈ `auth`, `mcm`, `audit`, `observability`.

This README lists no keys. Each stack's keys, and the generation kind of each minted one, are in its
`<stack>.env.example`, which is the single source for both.

## Generate / rotate

```bash
node scripts/gen-dev-secrets.mjs                        # mint every missing <stack>.env (idempotent)
node scripts/gen-dev-secrets.mjs --force                # rotate ALL (overwrite)
node scripts/gen-dev-secrets.mjs --force --stack=auth   # rotate one stack
```

- **Idempotent, and back-filling**: in a stack whose `.env` already exists, every key it already defines keeps its value (your running stacks keep working). Keys the template has gained since are seeded into it, so a new key never needs `--force`, which rotates everything.
- **Fixtures stay fixed**: `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `LANGFUSE_INIT_PROJECT_SECRET_KEY` are copied verbatim even under `--force` — the agent gateway + feature-012 SC-008 verify test authenticate against those exact values.
- **Generation kinds** (`research.md` R4): `b62-32` / `b62-48` (URL- & shell-safe base62), `hex-64` (32-byte hex), `complex-16` (upper+lower+digit+special, URL/shell-safe charset), `unleash-admin` (`*:*.`+b62-40), `unleash-client` (`default:development.`+b62-40).

## Fail-fast

If a required value is unset/blank, `docker compose up`/`config` aborts naming the var, e.g.:

```
required variable KC_BOOTSTRAP_ADMIN_PASSWORD is missing a value: set in stacks/auth.env (run: node scripts/gen-dev-secrets.mjs)
```

## Guardrails

- `.gitignore` ignores `*.env` and `*.env.*`, and carves out `!infrastructure-as-code/docker/stacks/*.env.example` so these templates stay tracked. The carve-out is scoped to this directory, so other deliberately ignored `*.env.example` files stay ignored.
- `scripts/check-no-inline-secrets.mjs` (CI: the `naming` job in `guardrails.yml`) fails the build if any literal credential is re-inlined into a tracked compose file. Run locally: `node scripts/check-no-inline-secrets.mjs` (and `--selftest`).

See [`docs/runbooks/local-dev.md`](../../../../docs/runbooks/local-dev.md) and `specs/021-externalize-compose-secrets/` for the full design.
