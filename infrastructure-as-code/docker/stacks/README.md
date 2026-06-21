# Stack env files

Feature 021 (externalize-compose-secrets) removed every clear-text credential from the tracked
Docker Compose files. Each secret is now a fail-fast `${VAR:?…}` interpolation reference; the real
per-machine values live in gitignored per-stack `.env` files generated from committed templates.

## Files

| File | Tracked? | Purpose |
|---|---|---|
| `<stack>.env.example` | ✅ committed | Placeholder template. `NAME=<generate:KIND>` for minted values; `NAME=literal` for deterministic fixtures. |
| `<stack>.env` | ❌ gitignored | Generated real values. Compose reads it via the stack's `include` `env_file:` and the Nx target `--env-file`. **Never commit.** |

`<stack>` ∈ `auth`, `mcm`, `audit`, `observability`.

## Generate / rotate

```bash
node scripts/gen-dev-secrets.mjs                        # mint every missing <stack>.env (idempotent)
node scripts/gen-dev-secrets.mjs --force                # rotate ALL (overwrite)
node scripts/gen-dev-secrets.mjs --force --stack=auth   # rotate one stack
```

- **Idempotent**: a stack whose `.env` already exists is skipped (your running stacks keep their values) unless `--force`.
- **Fixtures stay fixed**: `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `LANGFUSE_INIT_PROJECT_SECRET_KEY` are copied verbatim even under `--force` — the agent gateway + feature-012 SC-008 verify test authenticate against those exact values.
- **Generation kinds** (`research.md` R4): `b62-32` / `b62-48` (URL- & shell-safe base62), `hex-64` (32-byte hex), `complex-16` (upper+lower+digit+special, URL/shell-safe charset), `unleash-admin` (`*:*.`+b62-40), `unleash-client` (`default:development.`+b62-40).

## Fail-fast

If a required value is unset/blank, `docker compose up`/`config` aborts naming the var, e.g.:

```
required variable KC_BOOTSTRAP_ADMIN_PASSWORD is missing a value: set in stacks/auth.env (run: node scripts/gen-dev-secrets.mjs)
```

## Guardrails

- `.gitignore` ignores `*.env` but carves out `!*.env.example` so templates stay tracked.
- `scripts/check-no-inline-secrets.mjs` (CI: `naming-gate.yml`) fails the build if any literal credential is re-inlined into a tracked compose file. Run locally: `node scripts/check-no-inline-secrets.mjs` (and `--selftest`).

See [`docs/runbooks/local-dev.md`](../../../../docs/runbooks/local-dev.md) and `specs/021-externalize-compose-secrets/` for the full design.
