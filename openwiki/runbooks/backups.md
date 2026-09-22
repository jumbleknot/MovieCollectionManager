---
type: Runbook
title: Per-user collection backups (scheduled & on-demand)
description: Feature 073's per-user scheduled/on-demand collection backup system to user-owned S3-compatible or WebDAV storage — versioning, keep-last-N retention, and restore-as-new-collection-only — and the operational gotchas around offline-token auth, the standalone-Mongo claim, and the dev-mode tick gap.
resource: docs/runbooks/backups.md
tags: [backups, feature-073, bff, s3, webdav, keycloak, mongodb, redis, runbook]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T02:14:04.779Z
sources:
  - id: openwiki-source-95a7ed7500d24b0881fc3468
    resource: repo://docs/runbooks/backups.md
  - id: openwiki-source-dbfd6ac37b4380e1b9ca4daa
    resource: repo://frontend/mcm-app/server.js
  - id: openwiki-source-8ff4ea0c4e9c1b88a4c0eee7
    resource: repo://frontend/mcm-app/src/bff-server/audit-sink.ts
  - id: openwiki-source-e37e5da5fa7401fdb7992219
    resource: repo://frontend/mcm-app/src/bff-server/backup-job-store.ts
  - id: openwiki-source-28b3de7a863c75f0b1b6b62c
    resource: repo://frontend/mcm-app/src/bff-server/backup-offline-token.ts
  - id: openwiki-source-0ff64644c3a9837917af5e5d
    resource: repo://frontend/mcm-app/src/bff-server/email-service.ts
  - id: openwiki-source-3bf0ad96857ee228607b018c
    resource: repo://frontend/mcm-app/src/bff-server/redis-lock.ts
  - id: openwiki-source-c1c739d605caccb56fa33851
    resource: repo://specs/073-scheduled-backups/spec.md
generated: { by: "openwiki/0.5.2", at: "2026-09-22T02:14:04.779Z" }
---

# Per-user collection backups (scheduled & on-demand)

Feature 073 (backlog #236) lets a user schedule or trigger on-demand backups of their movie
collections to storage *they* own — an S3-compatible bucket or a WebDAV server — with
versioning, keep-last-N retention, and restore that only ever creates a **new** collection (there
is no code path that overwrites one). The BFF (see [BFF project overview](../projects/bff.md))
owns destination configuration, the scheduler, the run/restore pipeline, and the audit trail. The
authoritative operating manual, including the full environment-variable table and step-by-step
triage/test procedures, is `docs/runbooks/backups.md`; this page distills the load-bearing
gotchas an operator needs before touching the system.

## Gotchas

- **The user owns the credentials and the artifacts, not the operator.** Destination secrets (S3
  secret key, WebDAV app password) are sealed at rest and never echoed back, logged, or returned
  in an error — a destination-probe failure can only report *which kind* of failure occurred,
  never the server's actual reply. The corollary an operator must not "fix": **account deletion
  does not delete the user's stored backup artifacts.** They live at storage the user controls;
  removing them would mean deleting data the system was only trusted to copy.
- **An unattended scheduled run acts as the user, not as a service account.** There is no service
  account and no privileged fallback. The run mints access from a Keycloak **offline token** the
  user granted through an explicit, separate consent round trip. If that grant is revoked or
  missing, the run **fails** — it does not fall back to any other identity.
- **The BFF's MongoDB is a standalone `mongod`: no replica set, no multi-document transactions.**
  Exactly-once scheduling therefore rests on a single-document atomic claim (an atomic
  find-and-update against one job document), not a transaction. The companion Redis leader lock is
  an optimization with a TTL guess baked into it — it reduces redundant scanning across BFF
  instances, but it is **not** the correctness guarantee for exactly-once execution.
- **The run-size ceiling (`BACKUP_MAX_MOVIES` / `BACKUP_MAX_UNCOMPRESSED_BYTES`) exists because a
  run holds the entire artifact in memory rather than streaming it.** This is a deliberate
  trade-off (a stream that fails partway leaves an unrestorable partial object discovered only
  when the user needs it), not an oversight — streaming snapshots are a filed follow-up (see
  Known gaps below).
- **The scheduler tick is `server.js` POSTing to the internal `/bff-api/backups/tick` route over
  loopback with a shared secret**, because `server.js` is CommonJS outside the Metro bundle and
  cannot import `src/bff-server/*` directly. Consequence: **no tick fires under `pnpm start` in
  dev** — this is expected, not a fault to chase. Call the tick route directly instead.
- **Retention's load-bearing safety property is that a failed or partial run prunes nothing.**
  Pruning on the failure path would turn "today's backup didn't happen" into "and yesterday's is
  gone too." Separately, a prune failure never fails the run — it is recorded on its own
  (`pruneFailureReason`, distinct from the run's `failureReason`) because the backup the user
  asked for still succeeded.
- **Revocation ordering on disable/delete is revoke-at-Keycloak-first, forget-locally-second.**
  Reversed, a failed revocation would strand a live, non-expiring offline token with no local
  record left pointing at it to retry the revoke.
- **The audit-sink redaction rule strips any key containing `token` plus an explicit redact
  list — it does not name `secretEnc`, `accessKeyId`, or a destination password.** Those fields
  are kept out of the audit trail by construction (they are simply never placed on the audited
  object), not because the token-matching rule happens to catch them, and this is asserted against
  real secret values in tests rather than assumed. See also
  [Secrets management](../invariants/secrets-management.md) for the broader redaction posture and
  [Auth chain](../invariants/auth-chain.md) for how the offline-token grant fits the rest of the
  BFF's session/token model.

## Known gaps

- **No account-deletion route exists yet.** `tearDownUserBackups(userId)` is implemented and
  tested, but nothing calls it — there is no deletion endpoint and no `deleteUser` path in the
  Keycloak client. Whoever builds account deletion must wire this in.
- **Streaming snapshots are not implemented.** The size/count ceiling stands in for streaming
  until that follow-up lands.
- **Failure notification is in-app only.** There is no outbound email channel — the existing
  email service only drives Keycloak account flows, so notifying a user by email would require
  building a new channel.
