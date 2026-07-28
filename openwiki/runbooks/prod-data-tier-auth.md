---
type: Runbook
title: Production data-tier authentication (MongoDB SCRAM)
description: Enabling SCRAM authentication on the two production MongoDB stores without data loss — replica-set keyfile auth for the movie store, standalone SCRAM-only for the BFF store — using a pre-create-users sequence to avoid an unhealthy window.
resource: docs/runbooks/prod-data-tier-auth.md
tags: [production, mongodb, auth, security, runbook]
timestamp: 2026-07-05T22:07:24-04:00
---

# Production data-tier authentication (MongoDB SCRAM)

Turns on SCRAM authentication for both production MongoDB stores — the movie store (a single-member
replica set, so it additionally needs a keyfile for member auth) and the BFF store (standalone, SCRAM
only, no keyfile) — during a scheduled, bounded maintenance window. Brief service unavailability is an
accepted tradeoff; zero-downtime rolling cutover is explicitly not required. This is deployed the same
way as the rest of prod: merge triggers Komodo ResourceSync, not a manual `docker` command against the
host.

## Gotchas

- **Pre-create the app/root users while the store is still unauthenticated, before merging the
  auth-enabled compose.** `createUser` works against an unauthenticated `mongod` and the users persist
  on the data volume; doing this first means the redeploy that flips auth on reconnects immediately
  with users that already exist, with no unhealthy window and no localhost-exception timing to get
  right. The alternative (localhost-exception cutover after auth is already on) is the fallback path,
  not the recommended one.
- **Seed the Komodo Variables for both stores before merging.** The compose uses fail-fast `${VAR:?}`
  interpolation, so a missing secret aborts the deploy outright rather than starting unauthenticated —
  consistent with the posture in [Secrets management](/openwiki/invariants/secrets-management.md).
- **The keyfile only applies to the movie store.** The BFF store is standalone and needs SCRAM
  credentials only, never a keyfile — conflating the two setups is a common source of an unnecessary
  extra step or a misconfigured mount.
- **A verified pre-window backup is the rollback plan, not a full scratch-environment rehearsal.**
  Auth flags never mutate data, so reverting the compose change alone restores the unauthenticated
  state; a volume-level restore from backup is only needed if a genuinely separate problem is detected.
- **The keyfile permission check is defense-in-depth, not incidental.** `mongod` refuses to start with a
  too-open keyfile; the entrypoint re-materializes it at the correct restrictive permission on every
  clean start, so a manually widened keyfile self-heals on the next redeploy rather than needing manual
  repair.
- **A fresh-volume bootstrap (disaster recovery / new host) is a different procedure from the
  populated-volume cutover** — the replica set must be initiated after auth is already enabled, using an
  authenticated connection, not before.

Full prerequisite steps, exact baseline/verification commands, the localhost-exception fallback
procedure, and the fresh-volume bootstrap appendix: `docs/runbooks/prod-data-tier-auth.md`.
