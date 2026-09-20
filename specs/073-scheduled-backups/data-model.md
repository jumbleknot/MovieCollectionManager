# Phase 1 Data Model: Per-user scheduled collection backups

**Feature**: 073 | **Date**: 2026-09-20 | **Plan**: [plan.md](./plan.md)

Three new collections in the **BFF** MongoDB, plus one new field on the existing per-user agent
config document, plus the artifact written to the user's own storage.

> **Standing constraint**: the BFF's Mongo is a **standalone instance, not a replica set**
> (`mongo-client.ts`). There are **no multi-document transactions**. Every state change below is a
> single-document atomic update, and nothing spans two documents.

---

## `backup_destinations`

Where a user's backups may be written. One document per destination; a user may have several.

| Field | Type | Notes |
| --- | --- | --- |
| `_id` | string (uuid) | Destination id |
| `userId` | string | Keycloak subject. **Always** from the validated session, never request input (FR-034). Indexed. |
| `type` | `'s3' \| 'webdav'` | Selects the driver |
| `label` | string | User-facing, 1–64 chars |
| `endpoint` | string | Base URL. Re-validated by the resolving guard at **every** use (FR-005) |
| `bucket` | string? | `s3` only |
| `region` | string? | `s3` only, default `us-east-1` (MinIO ignores it; SigV4 requires one) |
| `pathStyle` | boolean | `s3` only, default `true` — MinIO and most self-hosted stores need it |
| `basePath` | string? | Key/path prefix; default `mcm-backups` |
| `accessKeyId` | string? | `s3` only. Not secret, stored plain |
| `username` | string? | `webdav` only. Not secret, stored plain |
| `secretEnc` | string | **AES-256-GCM blob.** S3 secret key or WebDAV app password. AAD `${userId}:backupDestinationSecret:${_id}` |
| `lastTestedAt` | ISO string? | |
| `lastTestResult` | `'ok'` \| `{ reason }`? | Normalised; never carries an upstream body |
| `createdAt` / `updatedAt` | ISO string | |

**Indexes**: `{ userId: 1 }`, and `{ userId: 1, label: 1 }` unique — two destinations with the same
label are a usability trap when choosing one in a job.

**Validation**: `endpoint` must be `http(s)` and pass the resolving guard. `type` decides which of
the two field groups is required — enforced by a discriminated `zod` union, so an `s3` document can
never carry a `username`.

**Never returned to the client**: `secretEnc`. The read projection excludes it at the store layer,
so a route cannot leak it by forgetting to strip it.

---

## `backup_jobs`

What to back up, where, how often, how many to keep.

| Field | Type | Notes |
| --- | --- | --- |
| `_id` | string (uuid) | Job id |
| `userId` | string | Owner. Indexed |
| `destinationId` | string | → `backup_destinations._id` |
| `label` | string | |
| `collectionIds` | string[] | mc-service collection ids. Empty = **all** the user's collections at run time |
| `schedule` | `Schedule`? | Absent ⇒ on-demand only |
| `keepLast` | int | 1–365, default 7 |
| `enabled` | boolean | |
| `nextRunAt` | ISO string? | Recomputed on save and after each run. **Indexed** — the tick's only query |
| `claimedAt` | ISO string \| null | Non-null ⇒ a run is in flight. Reclaimable once older than the run-timeout ceiling |
| `lastRun` | `RunSummary`? | Denormalised copy of the newest run, so the list view is one query |
| `createdAt` / `updatedAt` | ISO string | |

### Embedded `Schedule`

| Field | Type | Notes |
| --- | --- | --- |
| `frequency` | `'daily' \| 'weekly' \| 'monthly'` | No raw cron (FR-016) |
| `hour` / `minute` | int | 0–23 / 0–59, local to `timeZone` |
| `weekday` | int? | 1–7, ISO (Mon=1). `weekly` only |
| `dayOfMonth` | int? | 1–31. `monthly` only. **Clamps** to the month's last day — never skips a month |
| `timeZone` | string | IANA name, validated against the runtime's zone list. A property of the **job**, not the device |

### Embedded `RunSummary`

`{ runId, status: 'success' | 'failed' | 'partial', startedAt, finishedAt, movieCount,
collectionCount, artifactBytes, failureReason?, pruneFailureReason? }`

**Indexes**: `{ userId: 1 }`, and `{ nextRunAt: 1, enabled: 1 }` for the tick.

### The atomic claim

The single-document update that makes exactly-once true without transactions:

```
findOneAndUpdate(
  { _id, enabled: true, nextRunAt: { $lte: now },
    $or: [{ claimedAt: null }, { claimedAt: { $lt: reclaimBefore } }] },
  { $set: { claimedAt: now } },
  { returnDocument: 'after' }
)
```

Returns the document to exactly one caller; every other instance gets `null`. The `$or` is what stops
an instance killed mid-run wedging its job forever.

---

## `backup_runs`

Append-only history. Written as independent documents precisely because no transaction can tie a run
record to its job.

| Field | Type | Notes |
| --- | --- | --- |
| `_id` | string (uuid) | Run id |
| `userId` / `jobId` | string | Indexed together |
| `trigger` | `'manual' \| 'scheduled'` | |
| `status` | `'running' \| 'success' \| 'failed' \| 'partial'` | |
| `startedAt` / `finishedAt` | ISO string | |
| `artifactKey` | string? | Set only on success — an unset key is why a failed run is unlistable as a version (FR-014) |
| `artifactBytes` | int? | Compressed size |
| `collectionCounts` | `{ collectionId, name, movieCount }[]` | What SC-002 is verified against |
| `failureReason` | string? | Safe, user-facing. Never an upstream body |
| `prunedCount` / `pruneFailureReason` | int? / string? | Separate from run status (FR-027) |

**Indexes**: `{ userId: 1, jobId: 1, startedAt: -1 }`. TTL index expiring documents after 180 days —
history is diagnostic, not a record of account.

---

## Extension to the existing per-user document

The offline token is **one per user**, not per job — a user consents once, and revocation is a single
act (FR-023).

| Field | Type | Notes |
| --- | --- | --- |
| `offlineRefreshEnc` | string? | AES-256-GCM blob. AAD `${userId}:offlineRefresh`. Never returned, never logged |
| `offlineGrantedAt` | ISO string? | |

Held on the existing `user_agent_config` document rather than a new collection, so "wipe this user's
secrets" stays one operation.

**Lifecycle**: written only by the consent callback; read only by the runner; `$unset` **after** a
successful `revokeToken(..., 'refresh_token')` — in that order, so a failed revocation does not
orphan a live token with no local record that it exists.

---

## The artifact (at the user's own storage)

**Key**: `<basePath>/<jobId>/<ISO-8601 timestamp>.json.gz`

ISO-8601 sorts lexicographically, which is what makes retention "sort and delete the tail" and what
makes a job's artifacts structurally distinguishable from anything else at that destination (FR-011).

**Body**: gzip of

```json
{
  "manifest": {
    "formatVersion": 1,
    "createdAt": "2026-09-20T03:00:00.000Z",
    "jobId": "...",
    "collections": [{ "id": "...", "name": "...", "movieCount": 128 }],
    "totalMovieCount": 128,
    "sha256": "<hex over the canonical JSON of `collections` below>"
  },
  "collections": [
    {
      "id": "...", "name": "...", "description": "...",
      "movies": [{ "title": "...", "...": "...", "externalIdentifiers": [...] }]
    }
  ]
}
```

**Integrity**: `sha256` covers the **uncompressed, canonically serialised** `collections` array —
not the compressed bytes — so the check survives a change of compression level and still catches a
bad decompression. Verified before any write on restore (FR-031).

**`formatVersion`**: an integer. Restore refuses anything it does not recognise rather than
best-effort parsing (FR-032).

---

## State transitions

**Run**: `running` → `success` | `failed` | `partial`. Only `success` sets `artifactKey` and only
`success` triggers pruning (FR-025/FR-026).

**Job schedule**: `absent` → `pending consent` → `enabled` → `disabled`. The transition into
`enabled` requires a stored offline token; the transition out of it revokes that token when no other
enabled job needs it.

**Destination**: `created` → `tested` → `in use` → `deleted`. Deletion wipes `secretEnc` and disables
every referencing job rather than leaving it pointed at nothing (FR-006).
