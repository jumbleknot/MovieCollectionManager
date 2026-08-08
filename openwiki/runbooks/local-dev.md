---
type: Runbook
title: Local dev infrastructure & environment variables
description: How the four independently operable Compose stacks (auth, mcm, audit, observability) are bootstrapped, credentialed, and brought up/down for local development — and the load-bearing ordering, credential-rotation, and missing-.env.local gotchas that break a fresh box or test run if skipped.
resource: docs/runbooks/local-dev.md
tags: [docker-compose, local-dev, secrets, keycloak, runbook]
timestamp: 2026-08-07T00:00:00Z
---

# Local dev infrastructure & environment variables

Local/test infrastructure is split into four independently operable named Compose stacks —
`auth`, `mcm`, `audit`, `observability` — each its own Compose project under
`infrastructure-as-code/docker/stacks/`, brought up/down individually via Nx targets
(`up-auth`, `up-mcm`, `up-audit`, `up-observability`, and their `down-*` counterparts). Every
credential in every stack is externalized to a `${VAR:?…}` interpolation reference — no clear-text
secret lives in a tracked Compose file (see [Secrets management](/openwiki/invariants/secrets-management.md)).
Two one-time generator scripts (`scripts/gen-dev-secrets.mjs`, `scripts/gen-dev-env.mjs`) mint
per-machine stack credentials and seed the dev Keycloak realm before any stack is first brought up.

## Gotchas

- **Bring `auth` up before the `mcm` `app` profile.** mc-service fetches Keycloak JWKS on startup
  and there is no cross-stack `depends_on` — the ordering is manual. `--profile app` without
  Keycloak already running just hangs.
- **A password-on-first-init credential (Postgres/OpenSearch/MinIO) is baked into its data volume
  on first boot and ignores later env changes.** Rotating one for real requires regenerating the
  `.env` (`--force`) *and* recreating the service against a fresh volume — otherwise the container
  keeps the volume's original password and auth fails silently.
- **`docker compose down --volumes` only wipes transient volumes.** All three persistent, externally
  named data volumes survive a `down --volumes` by design; wiping real data requires removing the
  external volumes manually.
- **Each stack is its own Compose project now — `down` on one no longer tears down the others.**
  The old single-project aggregator is retired to a pointer; treat each stack's lifecycle target as
  independent.
- **`--profile` flags must precede `up`/`down`** with Docker Compose v2 — a flag placed after the
  subcommand is silently ignored.
- **The `--profile agents` (heavy, Postgres-checkpointer) gateway variant needs its Keycloak client
  secret fetched live from a running Keycloak** — there is no committed source for it, and without
  it the gateway starts but every tool call fails closed (chat works, add/query/organize don't).
- **A credential skip that says "missing credential(s): KEYCLOAK_SERVICE_CLIENT_SECRET" means
  `frontend/mcm-app/.env.local` does not exist — not that the stack is unavailable.** Before
  concluding an environment cannot run the integration suite, run `node scripts/gen-dev-env.mjs`;
  it now creates the file when absent and reports `CREATED .env.local (was absent)`. The suite
  goes from errors to pass. See the full detect/resolve table below.

## Credential-skip diagnosis (feature 048)

**Symptom.** An integration suite reports skips — or, under `MCM_REQUIRE_LIVE_STACK=1`, a wall of
errors — whose reason mentions credentials: `missing credential(s): KEYCLOAK_SERVICE_CLIENT_SECRET`,
or the older wording `ROPC / service-account creds not set — needs the live stack`.

**The wrong conclusion, and why it is tempting.** On 2026-08-07 this produced 38 errors and the
conclusion *"this leg cannot be run in this dev container; CI is where it gets proven."* Every
individual signal supported it — the stack was up, the tests were untouched, the message said "needs
the live stack". It was still wrong. The cause was **one absent gitignored file**, and one command
fixed it: the suite went from 13 passed / 38 errors to **51 passed, 0 failed**.

**The mechanism.** `scripts/gen-dev-env.mjs` writes four env files. `frontend/mcm-app/.env.local` is
*surgically synced* so a developer's own Metro keys survive — and, before feature 048, `syncEnvFile`
returned early when that file did not exist. So the three realm client secrets landed in `.env.docker`
but never in `.env.local`, which is the file `kc_admin.cfg()` actually reads. The generator then
advised copying `.env.example`, **which does not exist in this repository**, sending the reader after
a missing file rather than at the real cause.

**Detect → resolve.**

| Check | Command | Meaning |
|---|---|---|
| 1. Does the file exist? | `ls -la frontend/mcm-app/.env.local` | Absent ⇒ this is your problem |
| 2. Does it carry the secret? | `cut -d= -f1 frontend/mcm-app/.env.local` | `KEYCLOAK_SERVICE_CLIENT_SECRET` must appear |
| 3. Fix | `node scripts/gen-dev-env.mjs` | Now **creates** the file when absent and reports `CREATED .env.local (was absent)` |
| 4. If step 3 errors | `node scripts/gen-dev-secrets.mjs` then re-run step 3 | `stacks/auth.env` had not been minted yet |
| 5. Confirm | `MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration movie-assistant -- -m "not golden"` | Expect **0 failed** |

Never print a secret's value to check it — compare **key names** (`cut -d= -f1`) only.

**The general rule this is an instance of.** Before concluding *"this cannot run in this environment"*,
identify the specific missing input and check whether a generator, a `.env` file, or a documented
command supplies it. "Cannot run here" retires a whole test tier on the strength of one unread error
message, and it is indistinguishable from a genuine environment limit until someone checks. In this
repo the credential skips now name the variable, the file they are read from, and the command that
fixes them — if you meet one that does not, that message is itself the bug (048 FR-024).

**Which absences are still legitimate.** `--profile observability` (LangFuse, Vault, otel-lgtm,
Unleash), `--profile audit` (OpenSearch) and OPA are not brought up by `app-e2e` either; those skips
are expected and allow-listed. A healthy local run of the agent integration suite is **51 passed,
11 skipped, 0 failed**.

See [Nx as the task runner](/openwiki/invariants/nx-task-runner.md) for why every stack lifecycle
command goes through an Nx target rather than a bare `docker compose` invocation, and
[Published-port reservation](/openwiki/invariants/published-port-reservation.md) for the convention
that keeps these dev ports from colliding with production. Full stack/profile tables, the
credential-generator scripts' exact behavior, and the Keycloak realm-reseed recovery procedure:
`docs/runbooks/local-dev.md`.
