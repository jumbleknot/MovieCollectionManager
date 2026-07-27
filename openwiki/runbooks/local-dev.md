---
type: Runbook
title: Local dev infrastructure & environment variables
description: How the four independently operable Compose stacks (auth, mcm, audit, observability) are bootstrapped, credentialed, and brought up/down for local development — and the load-bearing ordering and credential-rotation gotchas that break a fresh box if skipped.
resource: docs/runbooks/local-dev.md
tags: [docker-compose, local-dev, secrets, keycloak, runbook]
timestamp: 2026-07-14T21:56:11-04:00
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

See [Nx as the task runner](/openwiki/invariants/nx-task-runner.md) for why every stack lifecycle
command goes through an Nx target rather than a bare `docker compose` invocation, and
[Published-port reservation](/openwiki/invariants/published-port-reservation.md) for the convention
that keeps these dev ports from colliding with production. Full stack/profile tables, the
credential-generator scripts' exact behavior, and the Keycloak realm-reseed recovery procedure:
`docs/runbooks/local-dev.md`.
