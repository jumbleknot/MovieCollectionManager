# Phase 0 Research: Externalize Docker Compose Credentials

## R1 — Does a per-stack `.env` reach the `include`d component files? (mechanism risk)

**Decision**: Use Docker Compose `include:` **long syntax** with an explicit `env_file:` on each entry, pointing at the single per-stack `.env`. Also pass `--env-file` on the CLI (Nx target) as a belt-and-braces default. Verify empirically with the pinned Compose version before relying on either alone.

**Rationale**: The stacks are thin aggregators that `include:` the component files where every credential lives:

```yaml
include:
  - ../keycloak/compose.yaml
  - ../vault/compose.yaml
```

Compose resolves an included file's interpolation relative to the included file's own `project_directory` (its directory) and its own `.env` by default — a top-level `--env-file` does **not** reliably propagate interpolation into included models across all Compose versions. The long-syntax `env_file` attribute pins the interpolation source explicitly:

```yaml
include:
  - path: ../keycloak/compose.yaml
    env_file: ./auth.env
  - path: ../vault/compose.yaml
    env_file: ./auth.env
```

This keeps the "one `.env` per stack" goal (no per-component-dir fragmentation, no duplicated shared vars like `AGENT_DB_PASSWORD` across `agent-db/` and `agent-gateway/`).

**Verification task (in tasks.md)**: `docker compose -p auth -f stacks/auth.compose.yaml --env-file stacks/auth.env config` must render every `${VAR}` resolved (no `WARN[…] The "X" variable is not set`). This is the deterministic check; run per stack.

**Alternatives considered**:
- *Top-level `--env-file` only* — rejected: include-scope propagation is version-dependent and unverified; would silently leave included vars unset.
- *Per-component-directory `.env`* — rejected: fragments a stack's secrets across directories and duplicates shared values (drift risk), defeating the single-source goal.

**Open caveat to confirm during impl**: whether include-level `env_file` *also* injects those vars into every service's container environment (leakage of, e.g., the unleash token into the postgres container env). If it does and that is undesirable, fall back to keeping interpolation-only variables out of `env_file` and rely on `--env-file` for pure interpolation. Decide based on `docker compose config` output.

## R2 — `${VAR}` interpolation vs Docker `_FILE` secrets (why we pivoted)

**Decision**: `${VAR:?msg}` interpolation for all in-scope credentials. (The user initially preferred `_FILE`; the inventory showed it cannot cover the majority.)

**Rationale**: Of ~25 credential occurrences, only the handful of plain server-password env vars on `_FILE`-aware images (postgres, minio) can natively read a secret file. The rest are:
- embedded in **connection-string URLs** (`DATABASE_URL`, `AGENT_DB_URL`) — no `_FILE`;
- in **`command:`** (`redis-server --requirepass …`), **`healthcheck:`** (`curl -u admin:…`, `redis-cli -a …`), or one-shot **`entrypoint:`** scripts (minio-init, unleash-seed) — no `_FILE`;
- app env vars with **no `_FILE` variant** (langfuse `NEXTAUTH_SECRET`/`SALT`/`ENCRYPTION_KEY`/`INIT_*`, unleash `INIT_*_API_TOKENS`, keycloak `KC_BOOTSTRAP_ADMIN_PASSWORD`, opensearch `OPENSEARCH_INITIAL_ADMIN_PASSWORD`, vault `VAULT_DEV_ROOT_TOKEN_ID`).

Even the `_FILE`-capable postgres passwords are *also* needed in plaintext on the client side (inside `DATABASE_URL`), so `_FILE` on the server alone does not remove the plaintext. Compose `${VAR}` interpolation expands uniformly in `environment`, `command`, `healthcheck`, `entrypoint`, and URL strings — one mechanism, full coverage.

**Note on existing precedent**: `keycloak-store-postgres` already uses `POSTGRES_PASSWORD_FILE` + a `secrets:` file (`secrets/keycloak_db_password.txt`, gitignored). It is already compliant and **out of scope** — left unchanged. Its known pain (the password must be duplicated between the secret file and `.env.local`) is itself an argument for the single-variable `${VAR}` approach for the new work; we do not retrofit it to avoid churn on a working service.

## R3 — Fail-fast (`${VAR:?}`) vs default (`${VAR:-}`)

**Decision**: `${VAR:?<where to set it>}` for every secret — no inline default.

**Rationale**: `${VAR:-plaintext}` would re-introduce the literal into the tracked file, defeating the purpose (and the gate flags it). `${VAR:?msg}` makes Compose abort with a clear message when unset, so a stack cannot start with an empty/placeholder credential (spec FR-002, AC4). The message points at the generator + stack `.env`.

## R4 — Generator design & per-variable format constraints

**Decision**: `scripts/gen-dev-secrets.mjs` reads each committed `*.env.example`, and for every variable whose template value is a `<generate:KIND>` placeholder, mints a value of that KIND; fixed (deterministic) values in the template are copied verbatim. Writes the gitignored `<stack>.env`. Idempotent: skips a stack whose `.env` already exists unless `--force`; shared variables (same name across stacks, e.g. none currently cross stacks except by design) are generated once and reused.

**Generation kinds** (driven by the placeholder in `.env.example`):
| KIND | Used for | Rule |
|------|----------|------|
| `b62-32` | URL-embedded + command/healthcheck passwords (PG, clickhouse, redis, minio, agent-db) | 32 chars `[A-Za-z0-9]` — **URL-safe** (no `@:/?#%`), shell-safe |
| `b62-48` | app secrets not in URLs (langfuse SALT, NEXTAUTH_SECRET, INIT_USER_PASSWORD, vault root token) | 48 chars base62 |
| `hex-64` | langfuse `ENCRYPTION_KEY` | exactly 64 hex chars (32 bytes) — image requirement |
| `complex-16` | Keycloak / OpenSearch admin passwords | 16 chars with ≥1 upper, lower, digit, special from a URL-free set (these are not used inside URLs) |
| `unleash-admin` | `INIT_ADMIN_API_TOKENS` + seed Authorization | literal `*:*.` + `b62-40` |
| `unleash-client` | `INIT_CLIENT_API_TOKENS` | literal `default:development.` + `b62-40` |
| *fixed* | langfuse `INIT_PROJECT_PUBLIC_KEY` / `INIT_PROJECT_SECRET_KEY` | copied verbatim (deterministic fixtures) |

**Rationale**: URL-embedded passwords MUST avoid characters that break URL parsing (`@ : / ? # %`) or shell quoting in `command`/`healthcheck` — base62 guarantees this. The complexity-constrained admin passwords are never placed in a URL, so they may use special characters their images require. `ENCRYPTION_KEY` has a hard 32-byte-hex format. Randomness varies by `node:crypto.randomBytes`; the `--force` path supports rotation.

**Idempotency**: re-running without `--force` preserves existing values (spec AC2) so a developer's running stacks keep working. `--force` regenerates (rotation / reset).

**Alternatives considered**: a `.ps1` + `.sh` pair (rejected — `.mjs` is cross-platform and matches every existing `scripts/*.mjs`); committing pre-filled dev values (rejected by the user — relocates plaintext into a tracked file).

## R5 — Gate script & CI wiring

**Decision**: New `scripts/check-no-inline-secrets.mjs`, structured exactly like `check-resource-naming.mjs` (parse tracked compose YAML with the `yaml` dep, walk services, exit non-zero with offending file + key on any violation; `--selftest` like `secret-scan.mjs`). Wire it into CI by **adding a step to the existing `naming-gate.yml`** and broadening that workflow's path filter to include `infrastructure-as-code/docker/stacks/*.compose.yaml`, the new script, and `*.env.example`.

**Detection rule**: for a known set of secret-shaped keys (`*PASSWORD*`, `*SECRET*`, `*TOKEN*`, `*_AUTH`, `*ROOT_TOKEN*`, `*ACCESS_KEY*`) and for password-bearing connection URLs (`scheme://user:<pw>@host`), the value MUST be a pure `${VAR...}` reference (optionally with the `:?...` modifier) and MUST NOT contain an inline `:-` default. A literal value (including inside a URL, `command`, `healthcheck`, or `entrypoint` string) fails. Allowlist non-secret keys that legitimately contain these substrings (e.g. `*_USER`, `ACCESS_KEY_ID` set to a non-secret like `minio`, deterministic `INIT_PROJECT_PUBLIC_KEY`) — explicitly enumerated, mirroring the naming gate's `NAME_ALLOWLIST`.

**Why complementary to `secret-scan.mjs`**: `secret-scan.mjs` (feature 018) hunts real-key *shapes* (Anthropic/TMDB) anywhere in the tree. This gate asserts a *structural* property of compose files (secret keys use indirection). They catch different failures; both run in CI.

**Rationale**: reuses the proven gate pattern, the `yaml` parser already vendored as a root dep (feature 019 lesson: `yaml` must be a root dep for the frozen-install CI), and the existing pnpm/node CI setup in `naming-gate.yml`.

**Alternatives considered**: a brand-new standalone workflow (viable; rejected to avoid duplicating the pnpm/node setup — a single step in `naming-gate.yml` is leaner, and both gates already trigger on compose changes).

## R6 — Comment-embedded credentials

**Decision**: Sanitize credential values that appear in **comments**, not just in key/value pairs — e.g. `opensearch/compose.yaml` documents `admin: Mcm-dev-Audit-1!` and `agent-audit: Mcm-dev-AuditWriter-1!` in a header comment. Replace the literal values with references to the env var / generator.

**Rationale**: a plaintext credential in a tracked comment is still a committed secret and still trips scanners. The structural gate keys off `key: value` lines and will not by itself catch a comment, so this is handled by explicit edit + verified by `git grep` for the known strings during the history-scrub prep (R7). The `agent-audit` writer account is provisioned at runtime (not a compose env var), so only its documentation string is in scope here.

## R7 — Git history scrub (Phase D, separate)

**Decision**: After Phases A–C merge, run `git filter-repo --replace-text replacements.txt` on a fresh mirror clone, where `replacements.txt` maps each known historical literal → `***REMOVED***`; then force-push and notify collaborators that existing clones / open PRs must re-clone or rebase.

**Rationale**: removing secrets from the working tree leaves them recoverable from history (spec US3). The generator mints fresh values, so the historical literals are already dead defaults — low risk, but scrubbing closes the scanner finding for past commits. Sequenced last and kept independent so it never blocks the working-tree fix.

**Inputs the scrub needs**: the exhaustive list of historical literal strings (e.g. `agent`, `langfuse`, `clickhouse`, `redis`, `miniosecret`, `Mcm-dev-Audit-1!`, `Mcm-dev-AuditWriter-1!`, `mcm-dev-langfuse-nextauth-secret`, `mcm-dev-langfuse-salt`, the 64-hex encryption key, `mcm-dev-password`, `mcm-dev-unleash-admin-token`, `mcm-dev-unleash-client-token`, `change_me`, `mcm-dev-root-token`). Short common words like `agent`/`redis` are too generic for a blanket history replace — scope those replacements to their `KEY=value` context to avoid corrupting unrelated history. The deterministic fixtures (`pk-lf-…`/`sk-lf-…0000…`) are NOT scrubbed (kept as fixtures).

**Alternatives considered**: BFG Repo-Cleaner (equivalent; `git filter-repo` is the maintained, recommended tool). Leaving history as-is (rejected by the user).

## Resolved unknowns

All Technical Context items are resolved; no remaining `NEEDS CLARIFICATION`. The single empirical verification (R1 include/env-file scoping) is captured as an explicit `docker compose config` task rather than an open question, because both candidate mechanisms (per-include `env_file`, CLI `--env-file`) are known and the task picks whichever renders fully-resolved on the pinned Compose version.
