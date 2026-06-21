# Quickstart / Validation Guide: Externalize Docker Compose Credentials

Runnable scenarios that prove the feature works end-to-end. Run from the repo root (PowerShell primary; Bash equivalents noted). See [data-model.md](./data-model.md) for the variable registry and [contracts/](./contracts/) for the gate + manifest contracts.

## Prerequisites

- Docker Desktop running; the external networks/volumes from the standard first-time setup ([docs/runbooks/local-dev.md](../../docs/runbooks/local-dev.md)).
- `pnpm install` done (provides the `yaml` dep the gate uses).

## Scenario 1 — Gate is RED before, GREEN after (TDD core, FR-008/SC-005)

```bash
# BEFORE externalization — expect exit 1 and a list of inline literals:
node scripts/check-no-inline-secrets.mjs ; echo "exit=$?"   # exit=1

# Detector selftest — always GREEN once the gate is written:
node scripts/check-no-inline-secrets.mjs --selftest ; echo "exit=$?"   # exit=0

# AFTER the compose edits + env wiring — expect exit 0:
node scripts/check-no-inline-secrets.mjs ; echo "exit=$?"   # exit=0
```

**Expected**: RED lists ~25 occurrences across the 6 component files; GREEN is silent + exit 0.

## Scenario 2 — One-command setup produces complete local values (FR-005/SC-003)

```bash
# Clean state: no <stack>.env present (only the committed *.env.example).
node scripts/gen-dev-secrets.mjs

# Expect: auth.env, mcm.env, audit.env, observability.env created under
# infrastructure-as-code/docker/stacks/, each key from its template filled.
```

**Verify gitignore boundary (FR-006)**:

```bash
git check-ignore infrastructure-as-code/docker/stacks/auth.env          # prints the path (ignored)
git ls-files infrastructure-as-code/docker/stacks/auth.env.example      # prints the path (tracked)
```

**Verify idempotency (AC2)** — second run preserves values:

```bash
sha1sum infrastructure-as-code/docker/stacks/auth.env > /tmp/before
node scripts/gen-dev-secrets.mjs            # logs "auth: skipped (exists)"
sha1sum infrastructure-as-code/docker/stacks/auth.env > /tmp/after
diff /tmp/before /tmp/after                  # no difference
```

**Verify rotation** — `--force` regenerates randomized vars but keeps fixtures:

```bash
node scripts/gen-dev-secrets.mjs --force --stack=observability
grep LANGFUSE_INIT_PROJECT_PUBLIC_KEY infrastructure-as-code/docker/stacks/observability.env
# still pk-lf-mcm-dev-0000000000000000 (fixture unchanged); other values differ from before.
```

## Scenario 3 — Interpolation fully resolves across `include`d files (R1/FR-007)

```bash
# Every ${VAR} must resolve — no "variable is not set" warnings:
docker compose -p auth          -f infrastructure-as-code/docker/stacks/auth.compose.yaml          --env-file infrastructure-as-code/docker/stacks/auth.env          config >NUL
docker compose -p mcm           -f infrastructure-as-code/docker/stacks/mcm.compose.yaml           --env-file infrastructure-as-code/docker/stacks/mcm.env           --profile app config >NUL
docker compose -p audit         -f infrastructure-as-code/docker/stacks/audit.compose.yaml         --env-file infrastructure-as-code/docker/stacks/audit.env         --profile audit config >NUL
docker compose -p observability -f infrastructure-as-code/docker/stacks/observability.compose.yaml --env-file infrastructure-as-code/docker/stacks/observability.env --profile observability config >NUL
```

**Expected**: each `config` renders with exit 0 and **no** `WARN[…] The "X" variable is not set` lines. (PowerShell: redirect to `$null` instead of `>NUL`.)

**Negative check (FR-002/AC4)** — a missing value fails fast:

```bash
# Temporarily blank one required var → bring-up must abort with the :? message naming the var.
docker compose -p auth -f infrastructure-as-code/docker/stacks/auth.compose.yaml config
# (run without --env-file) → error: "KC_BOOTSTRAP_ADMIN_PASSWORD: set it in stacks/auth.env"
```

## Scenario 4 — Stacks come up healthy on generated values (SC-004)

```bash
pnpm nx up-auth infrastructure-as-code
pnpm nx up-mcm  infrastructure-as-code           # bring auth up first (manual ordering)
pnpm nx up-audit infrastructure-as-code
pnpm nx up-observability infrastructure-as-code
pnpm nx ps infrastructure-as-code                # all expected containers healthy
```

**Cross-service auth checks** (the shared-variable contract holds):
- LangFuse web reaches its postgres/clickhouse/redis/minio (web container healthy, no auth errors in logs).
- OpenSearch healthcheck (`-u admin:$OPENSEARCH_INITIAL_ADMIN_PASSWORD`) passes → container healthy.
- agent-gateway connects to `movie-assistant-store-postgres` using `AGENT_DB_PASSWORD` (gateway starts; checkpointer writes succeed).

## Scenario 5 — Existing E2E unaffected (SC-007)

```bash
# Dev-container web E2E path (deterministic baseline) — unchanged result expected:
pnpm nx docker-build mcm-app
docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml --profile bff-nonsecure up -d
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app
```

**Expected**: same green baseline as before externalization (the app path does not touch the changed observability/audit secrets; mcm app infra uses generated values transparently).

## Scenario 6 — History scrub (Phase D, after merge — coordinated)

Not part of the routine dev loop. Run on a fresh mirror clone:

```bash
git clone --mirror <repo> repo-scrub && cd repo-scrub
# replacements.txt maps each historical literal → ***REMOVED*** (see research R7)
git filter-repo --replace-text ../replacements.txt
git push --force --mirror
```

**Verify (SC-006)**: `git log -p -S '<historical literal>'` returns nothing for each scrubbed string. Notify collaborators to re-clone / rebase open PRs.

## Done-when

- Scenario 1 GREEN after edits; Scenario 2 boundaries + idempotency hold; Scenario 3 resolves with zero unset-variable warnings; Scenario 4 all stacks healthy; Scenario 5 matches the pre-change E2E baseline; Scenario 6 deferred to the coordinated post-merge step.
